// FILE: ExternalAutoImporter.ts
// Purpose: Periodic auto-import of NEW external sessions from already-imported folders
//   (design doc docs/plans/external-session-preview-bulk-auto-import.md §5). Each sweep
//   reads the revisioned server settings (opt-in, takes effect without restart), reuses
//   the discovery handler from listExternalSessionsRoute (60s cache included — no extra
//   scan pressure), derives already-imported folders from the discovery join, and
//   imports watermark-eligible sessions through the batch route's handler — no third
//   copy of import orchestration. First run per folder only SEEDS the watermark (no
//   backfill); per-folder failures advance the watermark and back off exponentially
//   (5m -> 15m -> 1h -> 6h cap). Every failure is log-only; the task never crashes.
// Layer: Orchestration background task
// Exports: makeExternalAutoImportSweep (testable sweep), ExternalAutoImporterLive.

import type {
  OrchestrationExternalSession,
  OrchestrationImportExternalThreadsInput,
  OrchestrationImportExternalThreadsResult,
} from "@synara/contracts";
import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";
import { Cause, Duration, Effect, FileSystem, Layer, Option, Path, Schedule } from "effect";

import { ExternalAutoImportState } from "../../persistence/Services/ExternalAutoImportState";
import type { ExternalAutoImportStateShape } from "../../persistence/Services/ExternalAutoImportState";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry";
import { ProviderService } from "../../provider/Services/ProviderService";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings";
import {
  autoImportStateAfterRun,
  autoImportStateForWatermarkAdvance,
  deriveAlreadyImportedFolders,
  planAutoImportFolder,
} from "../externalAutoImport";
import { makeImportExternalThreadsHandler } from "../importExternalThreadsRoute";
import { makeListExternalSessionsHandler } from "../listExternalSessionsRoute";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine";
import {
  ExternalAutoImporter,
  type ExternalAutoImporterShape,
} from "../Services/ExternalAutoImporter";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery";

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : "Import failed.";
}

export interface ExternalAutoImportSweepDeps {
  readonly listExternalSessions: (input: {
    readonly forceRefresh?: boolean;
  }) => Effect.Effect<
    { readonly sessions: ReadonlyArray<OrchestrationExternalSession> },
    unknown,
    never
  >;
  readonly importExternalThreads: (
    input: OrchestrationImportExternalThreadsInput,
  ) => Effect.Effect<OrchestrationImportExternalThreadsResult, unknown, never>;
  readonly autoImportState: ExternalAutoImportStateShape;
  readonly serverSettings: ServerSettingsShape;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
}

/** One auto-import sweep. Never fails: per-folder errors are logged and skipped. */
export const makeExternalAutoImportSweep = (deps: ExternalAutoImportSweepDeps) => {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const normalize = (cwd: string) => normalizeWorkspaceRootForComparison(cwd, { platform });

  return Effect.gen(function* () {
    // The setting is read every sweep so toggling it takes effect without a restart.
    const settingsSnapshot = yield* deps.serverSettings.getSnapshot.pipe(
      Effect.mapError((cause) => new Error(errorMessage(cause))),
    );
    if (!settingsSnapshot.settings.externalSessions.autoImportEnabled) {
      return;
    }

    const { sessions } = yield* deps.listExternalSessions({});
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();

    const sessionsByFolder = new Map<string, OrchestrationExternalSession[]>();
    for (const session of sessions) {
      const cwd = session.cwd?.trim() ?? "";
      if (cwd.length === 0) continue;
      const folderCwd = normalize(cwd);
      const bucket = sessionsByFolder.get(folderCwd);
      if (bucket) {
        bucket.push(session);
      } else {
        sessionsByFolder.set(folderCwd, [session]);
      }
    }

    const folders = deriveAlreadyImportedFolders(sessions, { platform });
    // Folders are processed sequentially too: each import batch already serializes its
    // own items, and the sweep must never fan out provider processes.
    for (const folderCwd of folders) {
      const stateOption = yield* deps.autoImportState.getFolderState(folderCwd).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("external auto-import failed to read folder state", {
            folderCwd,
            cause,
          }).pipe(Effect.as(Option.none())),
        ),
      );
      const previous = Option.getOrNull(stateOption);
      const folderSessions = sessionsByFolder.get(folderCwd) ?? [];
      const plan = planAutoImportFolder({
        folderCwd,
        sessions: folderSessions,
        state: previous,
        nowMs,
      });
      if (plan.inCooldown) {
        continue;
      }

      const upsert = (state: Parameters<typeof deps.autoImportState.upsertFolderState>[0]) =>
        deps.autoImportState.upsertFolderState(state).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("external auto-import failed to persist folder state", {
              folderCwd,
              cause,
            }),
          ),
        );

      // First tick for the folder: seed the watermark from the current snapshot and
      // import NOTHING — no backfill of pre-existing stock.
      if (plan.seeded) {
        yield* upsert({
          folderCwd,
          lastSeenUpdatedAt: plan.maxSeenUpdatedAt,
          lastImportAt: null,
          lastError: null,
          consecutiveFailures: 0,
          cooldownUntil: null,
        });
        continue;
      }

      if (plan.sessionsToImport.length === 0) {
        if (
          previous &&
          plan.maxSeenUpdatedAt &&
          plan.maxSeenUpdatedAt !== previous.lastSeenUpdatedAt
        ) {
          yield* upsert(
            autoImportStateForWatermarkAdvance({
              previous,
              folderCwd,
              maxSeenUpdatedAt: plan.maxSeenUpdatedAt,
            }),
          );
        }
        continue;
      }

      const result = yield* deps
        .importExternalThreads({
          items: plan.sessionsToImport.map((session) => ({
            provider: session.provider,
            externalId: session.externalId,
            ...(session.cwd?.trim() ? { cwd: session.cwd.trim() } : {}),
            ...(session.title?.trim() ? { title: session.title.trim().slice(0, 120) } : {}),
          })),
        })
        .pipe(
          // A wholesale batch failure (e.g. the engine is unavailable) is recorded like
          // per-item failures: the folder backs off instead of crashing the sweep.
          Effect.catch((cause) =>
            Effect.succeed({
              results: plan.sessionsToImport.map((session) => ({
                externalId: session.externalId,
                status: "failed" as const,
                error: errorMessage(cause),
              })),
            }),
          ),
        );

      const firstFailure = result.results.find((entry) => entry.status === "failed");
      yield* upsert(
        autoImportStateAfterRun({
          previous: previous ?? {
            lastSeenUpdatedAt: null,
            consecutiveFailures: 0,
            cooldownUntil: null,
          },
          folderCwd,
          maxSeenUpdatedAt: plan.maxSeenUpdatedAt,
          nowIso,
          nowMs,
          failureMessage: firstFailure ? (firstFailure.error ?? "Import failed.") : null,
        }),
      );
      if (firstFailure) {
        yield* Effect.logWarning("external auto-import recorded folder failures", {
          folderCwd,
          error: firstFailure.error ?? "Import failed.",
        });
      }
    }
  });
};

export interface ExternalAutoImporterLiveOptions {
  readonly sweepIntervalMs?: number;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
}

const makeExternalAutoImporter = (options?: ExternalAutoImporterLiveOptions) =>
  Effect.gen(function* () {
    const providerAdapterRegistry = yield* ProviderAdapterRegistry;
    const providerService = yield* ProviderService;
    const providerSessionDirectory = yield* ProviderSessionDirectory;
    const serverSettings = yield* ServerSettingsService;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const autoImportState = yield* ExternalAutoImportState;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = options?.platform ?? process.platform;

    // The sweep shares the discovery handler (with its 60s cache and per-provider
    // timeouts) and the batch import handler (dedup, sequential, project-once-per-cwd)
    // — no third copy of either machinery.
    const listExternalSessions = makeListExternalSessionsHandler({
      providerAdapterRegistry,
      providerSessionDirectory,
      serverSettings,
      projectionThreadSessionRepository,
    });
    const importExternalThreads = makeImportExternalThreadsHandler({
      fileSystem,
      orchestrationEngine,
      path,
      platform,
      projectionSnapshotQuery,
      providerAdapterRegistry,
      providerService,
      providerSessionDirectory,
      serverSettings,
      projectionThreadSessionRepository,
      // project.create falls back to the provider-reported absolute cwd as-is here;
      // the WS route additionally realpath-canonicalizes user-typed paths, which
      // discovered session cwds do not need.
    });

    const sweep = makeExternalAutoImportSweep({
      listExternalSessions,
      importExternalThreads,
      autoImportState,
      serverSettings,
      ...(options?.now ? { now: options.now } : {}),
      platform,
    });

    const runSweepSafely = sweep.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("external auto-import sweep failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const start: ExternalAutoImporterShape["start"] = () =>
      Effect.forkScoped(
        runSweepSafely.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
      ).pipe(Effect.asVoid);

    return { start } satisfies ExternalAutoImporterShape;
  });

export const makeExternalAutoImporterLive = (options?: ExternalAutoImporterLiveOptions) =>
  Layer.effect(ExternalAutoImporter, makeExternalAutoImporter(options));

export const ExternalAutoImporterLive = makeExternalAutoImporterLive();
