// FILE: listExternalSessionsRoute.ts
// Purpose: Lists provider-native sessions persisted outside Synara (Codex/Claude) and
//   joins them with existing import bindings; resolves a thread's external session id.
// Layer: Orchestration query handler
// Exports: makeListExternalSessionsHandler, makeGetThreadExternalSessionHandler.

import {
  type OrchestrationExternalSession,
  type OrchestrationExternalSessionProvider,
  type OrchestrationGetThreadExternalSessionInput,
  type OrchestrationGetThreadExternalSessionResult,
  type OrchestrationListExternalSessionsInput,
  type OrchestrationListExternalSessionsResult,
} from "@synara/contracts";
import { providerStartOptionsFromServerSettings } from "@synara/shared/serverSettings";
import { Effect, Option } from "effect";

import {
  listClaudeSessions as listClaudeSessionsDefault,
  type ClaudeSessionSummary,
} from "../claudeSessionDiscovery";
import type { ProjectionThreadSessionRepositoryShape } from "../persistence/Services/ProjectionThreadSessions";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type {
  ProviderSessionDirectoryReadError,
  ProviderSessionDirectoryShape,
} from "../provider/Services/ProviderSessionDirectory";
import type { ServerSettingsShape } from "../serverSettings";
import {
  buildExternalSessionIndex,
  externalSessionIndexKey,
  extractExternalSessionId,
  resumeCommandForExternalSession,
} from "./externalSessions";

const EXTERNAL_SESSIONS_CACHE_TTL_MS = 60_000;
export const EXTERNAL_SESSION_DISCOVERY_TIMEOUT_MS = 20_000;
const DEFAULT_DISCOVERY_PROVIDERS: ReadonlyArray<OrchestrationExternalSessionProvider> = [
  "claudeAgent",
  "codex",
];

export interface ListExternalSessionsHandlerOptions {
  readonly providerAdapterRegistry: ProviderAdapterRegistryShape;
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
  readonly serverSettings: ServerSettingsShape;
  readonly projectionThreadSessionRepository: ProjectionThreadSessionRepositoryShape;
  readonly listClaudeSessions?: () => Promise<ReadonlyArray<ClaudeSessionSummary>>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

function nonEmptyOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveRequestedProviders(
  providers: ReadonlyArray<OrchestrationExternalSessionProvider> | undefined,
): ReadonlyArray<OrchestrationExternalSessionProvider> {
  if (!providers || providers.length === 0) {
    return DEFAULT_DISCOVERY_PROVIDERS;
  }
  return [...new Set(providers)].sort();
}

function sortSessionsByUpdatedAtDesc(
  sessions: ReadonlyArray<OrchestrationExternalSession>,
): ReadonlyArray<OrchestrationExternalSession> {
  return [...sessions].sort((a, b) => {
    if (a.updatedAt === null && b.updatedAt === null) return 0;
    if (a.updatedAt === null) return 1;
    if (b.updatedAt === null) return -1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function makeListExternalSessionsHandler(options: ListExternalSessionsHandlerOptions) {
  const listClaudeSessionsImpl = options.listClaudeSessions ?? listClaudeSessionsDefault;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? EXTERNAL_SESSION_DISCOVERY_TIMEOUT_MS;
  // Discovery results are cached pre-join: importedThreadId is re-joined from fresh
  // bindings on every call so a new import shows up even on a cache hit.
  const discoveryCache = new Map<
    string,
    { readonly expiresAtMs: number; readonly sessions: ReadonlyArray<OrchestrationExternalSession> }
  >();

  const listCodexSessions = Effect.gen(function* () {
    const adapter = yield* options.providerAdapterRegistry.getByProvider("codex");
    if (!adapter.listExternalThreads) {
      return [] as ReadonlyArray<OrchestrationExternalSession>;
    }
    // Honor a configured custom Codex binary/home for the discovery app-server,
    // same as thread-bound sessions (providers.codex.binaryPath in server settings).
    const settingsSnapshot = yield* options.serverSettings.getSnapshot;
    const providerOptions = providerStartOptionsFromServerSettings(settingsSnapshot.settings);
    const result = yield* adapter.listExternalThreads({ providerOptions });
    return result.threads.map(
      (thread): OrchestrationExternalSession => ({
        provider: "codex",
        externalId: thread.id,
        cwd: nonEmptyOrNull(thread.cwd),
        title: nonEmptyOrNull(thread.preview),
        updatedAt: thread.updatedAt ?? null,
        createdAt: thread.createdAt ?? null,
        source: nonEmptyOrNull(thread.source),
        importedThreadId: null,
      }),
    );
  });

  const listClaude = Effect.tryPromise({
    try: () => listClaudeSessionsImpl(),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((sessions) =>
      sessions.map(
        (session): OrchestrationExternalSession => ({
          provider: "claudeAgent",
          externalId: session.sessionId,
          cwd: nonEmptyOrNull(session.cwd),
          title: nonEmptyOrNull(session.title),
          updatedAt: session.updatedAt ?? null,
          createdAt: session.createdAt ?? null,
          source: null,
          importedThreadId: null,
        }),
      ),
    ),
  );

  // A hung provider (e.g. a discovery app-server that never answers) must degrade
  // exactly like a failed one: log and return an empty list so the other provider's
  // sessions still reach the client within `timeoutMs`.
  const tolerateProviderFailure = <E>(
    provider: OrchestrationExternalSessionProvider,
    effect: Effect.Effect<ReadonlyArray<OrchestrationExternalSession>, E>,
  ): Effect.Effect<ReadonlyArray<OrchestrationExternalSession>> =>
    effect.pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : Effect.logWarning("external session discovery timed out for provider", {
              provider,
              timeoutMs,
            }).pipe(Effect.as([] as ReadonlyArray<OrchestrationExternalSession>)),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("external session discovery failed for provider", {
          provider,
          cause,
        }).pipe(Effect.as([] as ReadonlyArray<OrchestrationExternalSession>)),
      ),
    );

  const discover = (
    providers: ReadonlyArray<OrchestrationExternalSessionProvider>,
  ): Effect.Effect<ReadonlyArray<OrchestrationExternalSession>> =>
    Effect.all(
      providers.map((provider) =>
        tolerateProviderFailure(provider, provider === "codex" ? listCodexSessions : listClaude),
      ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((results) => results.flat()));

  return Effect.fnUntraced(function* (
    body: OrchestrationListExternalSessionsInput,
  ): Effect.fn.Return<OrchestrationListExternalSessionsResult, never, never> {
    const providers = resolveRequestedProviders(body.providers);
    const cacheKey = providers.join(",");
    const nowMs = now();

    let discovered: ReadonlyArray<OrchestrationExternalSession> | undefined;
    if (!body.forceRefresh) {
      const cached = discoveryCache.get(cacheKey);
      if (cached && cached.expiresAtMs > nowMs) {
        discovered = cached.sessions;
      }
    }
    if (!discovered) {
      discovered = yield* discover(providers);
      discoveryCache.set(cacheKey, {
        expiresAtMs: nowMs + EXTERNAL_SESSIONS_CACHE_TTL_MS,
        sessions: discovered,
      });
    }

    const bindings = yield* options.providerSessionDirectory.listBindings().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to load provider bindings for external session join", {
          cause,
        }).pipe(Effect.as([])),
      ),
    );
    // Durable import identity lives on the thread's own projection row
    // (provider_thread_id), surviving session-lifecycle binding cleanup; union it
    // with live bindings (pre-migration imports) so importedThreadId stays correct.
    const durableSessions = yield* options.projectionThreadSessionRepository
      .listProviderThreadIds()
      .pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            provider: row.providerName,
            externalId: row.providerThreadId,
            threadId: row.threadId,
          })),
        ),
        Effect.catch((cause) =>
          Effect.logWarning("failed to load imported session mappings for external session join", {
            cause,
          }).pipe(Effect.as([])),
        ),
      );
    const index = buildExternalSessionIndex(bindings, durableSessions);
    const sessions = discovered.map((session) => ({
      ...session,
      importedThreadId:
        index.get(externalSessionIndexKey(session.provider, session.externalId)) ?? null,
    }));

    return { sessions: [...sortSessionsByUpdatedAtDesc(sessions)] };
  });
}

export interface GetThreadExternalSessionHandlerOptions {
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
}

export function makeGetThreadExternalSessionHandler(
  options: GetThreadExternalSessionHandlerOptions,
) {
  return Effect.fnUntraced(function* (
    body: OrchestrationGetThreadExternalSessionInput,
  ): Effect.fn.Return<
    OrchestrationGetThreadExternalSessionResult,
    ProviderSessionDirectoryReadError,
    never
  > {
    const bindingOption = yield* options.providerSessionDirectory.getBinding(body.threadId);
    if (Option.isNone(bindingOption)) {
      return null;
    }
    const binding = bindingOption.value;
    if (binding.provider !== "codex" && binding.provider !== "claudeAgent") {
      return null;
    }
    const externalId = extractExternalSessionId(binding.provider, binding.resumeCursor);
    if (!externalId) {
      return null;
    }
    return {
      provider: binding.provider,
      externalId,
      resumeCommand: resumeCommandForExternalSession(binding.provider, externalId),
    };
  });
}
