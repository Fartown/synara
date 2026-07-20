// FILE: importExternalThreadsRoute.ts
// Purpose: Batch import of external Codex/Claude sessions ("Import all" per sidebar
//   group). Fully server-driven per item: dedup by (provider, externalId) -> resolve or
//   create the target project (once per distinct cwd per batch) -> create the thread ->
//   run the SAME import core as single import (externalSessionImport.ts) -> on failure
//   delete the just-created thread so no empty shells linger. Strictly sequential with
//   per-item failure isolation; the batch itself only fails for invalid input
//   (empty / >50 items).
// Layer: Orchestration command handler
// Exports: makeImportExternalThreadsHandler, ImportExternalThreadsError.

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  IMPORT_EXTERNAL_THREADS_MAX_BATCH_SIZE,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationExternalSessionProvider,
  type OrchestrationImportExternalThreadsInput,
  type OrchestrationImportExternalThreadsItem,
  type OrchestrationImportExternalThreadsItemResult,
  type OrchestrationImportExternalThreadsResult,
} from "@synara/contracts";
import {
  isWorkspaceRootWithin,
  normalizeWorkspaceRootForComparison,
} from "@synara/shared/threadWorkspace";
import { Data, Effect, Option } from "effect";

import {
  lookupAlreadyImportedThreadId,
  makeExternalSessionImportRunner,
  type ExternalSessionImportRunnerOptions,
} from "./externalSessionImport";

export class ImportExternalThreadsError extends Data.TaggedError("ImportExternalThreadsError")<{
  readonly message: string;
}> {}

function batchError(message: string): ImportExternalThreadsError {
  return new ImportExternalThreadsError({ message });
}

export interface ImportExternalThreadsHandlerOptions extends ExternalSessionImportRunnerOptions {
  /**
   * Same realpath-based canonicalization the WS dispatch normalizer applies to
   * project.create (wsRpc.ts). Injectable so tests can assert the raw cwd flow.
   */
  readonly canonicalizeProjectWorkspaceRoot?: (
    workspaceRoot: string,
    options?: { readonly createIfMissing?: boolean },
  ) => Effect.Effect<string, unknown>;
  readonly now?: () => string;
}

/** Minimal project view needed to target a thread.create at a cwd. */
interface ResolvedImportProject {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
}

function defaultModelSelectionForProvider(
  provider: OrchestrationExternalSessionProvider,
): ModelSelection {
  return provider === "claudeAgent"
    ? { provider: "claudeAgent", model: DEFAULT_MODEL_BY_PROVIDER.claudeAgent }
    : { provider: "codex", model: DEFAULT_MODEL_BY_PROVIDER.codex };
}

// Same naming rule as the web's single-import flow (Sidebar.tsx handleImportExternalSession).
function importedThreadTitle(item: OrchestrationImportExternalThreadsItem): string {
  const sessionTitle = item.title?.trim() ?? "";
  if (sessionTitle.length > 0) return sessionTitle;
  const suffix = item.externalId.trim().slice(-8);
  return item.provider === "claudeAgent"
    ? `Imported Claude session${suffix ? ` ${suffix}` : ""}`
    : `Imported Codex thread${suffix ? ` ${suffix}` : ""}`;
}

// Same project title rule as the web's createOrRecoverProjectFromPath: folder basename.
function projectTitleFromWorkspaceRoot(workspaceRoot: string): string {
  return workspaceRoot.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? workspaceRoot;
}

export function makeImportExternalThreadsHandler(options: ImportExternalThreadsHandlerOptions) {
  const runExternalSessionImport = makeExternalSessionImportRunner(options);
  const now = options.now ?? (() => new Date().toISOString());
  const canonicalize =
    options.canonicalizeProjectWorkspaceRoot ??
    ((workspaceRoot: string) => Effect.succeed(workspaceRoot.trim()));

  const listActiveProjects = () =>
    options.projectionSnapshotQuery.getSnapshot().pipe(
      Effect.map(
        (snapshot): ReadonlyArray<ResolvedImportProject> =>
          snapshot.projects
            .filter((project) => project.deletedAt === null && project.kind === "project")
            .map((project) => ({
              id: project.id,
              workspaceRoot: project.workspaceRoot,
              defaultModelSelection: project.defaultModelSelection,
            })),
      ),
      Effect.mapError(() => batchError("Failed to load projects for the batch import.")),
    );

  // Deepest containing root wins so a session launched from a monorepo subdirectory is
  // attributed to the nested project rather than its parent (same rule as the web
  // grouping in externalSessionsGrouping.ts).
  const findProjectForCwd = (
    projects: ReadonlyArray<ResolvedImportProject>,
    cwd: string,
  ): ResolvedImportProject | null => {
    let best: ResolvedImportProject | null = null;
    let bestRootLength = -1;
    for (const project of projects) {
      if (isWorkspaceRootWithin(cwd, project.workspaceRoot, { platform: options.platform })) {
        const rootLength = normalizeWorkspaceRootForComparison(project.workspaceRoot, {
          platform: options.platform,
        }).length;
        if (rootLength > bestRootLength) {
          best = project;
          bestRootLength = rootLength;
        }
      }
    }
    return best;
  };

  return Effect.fnUntraced(function* (
    body: OrchestrationImportExternalThreadsInput,
  ): Effect.fn.Return<OrchestrationImportExternalThreadsResult, ImportExternalThreadsError, never> {
    if (body.items.length === 0) {
      return yield* Effect.fail(batchError("The batch import requires at least one session."));
    }
    if (body.items.length > IMPORT_EXTERNAL_THREADS_MAX_BATCH_SIZE) {
      return yield* Effect.fail(
        batchError(
          `The batch import accepts at most ${IMPORT_EXTERNAL_THREADS_MAX_BATCH_SIZE} sessions (received ${body.items.length}).`,
        ),
      );
    }

    // Projects created by THIS batch, keyed by normalized cwd. The projection may lag
    // behind an accepted project.create dispatch, so reuse within the batch goes
    // through this map instead of re-reading the snapshot.
    const createdProjectsByCwd = new Map<string, ResolvedImportProject>();

    const resolveProjectForCwd = Effect.fn(function* (cwd: string) {
      const normalizedCwd = normalizeWorkspaceRootForComparison(cwd, {
        platform: options.platform,
      });
      const alreadyCreated = createdProjectsByCwd.get(normalizedCwd);
      if (alreadyCreated) {
        return alreadyCreated;
      }
      // Also reuse a batch-created project that CONTAINS this cwd (e.g. the batch
      // created /a/repo and a later item lives in /a/repo/sub).
      for (const created of createdProjectsByCwd.values()) {
        if (isWorkspaceRootWithin(cwd, created.workspaceRoot, { platform: options.platform })) {
          return created;
        }
      }

      const existingMatch = findProjectForCwd(yield* listActiveProjects(), cwd);
      if (existingMatch) {
        return existingMatch;
      }

      // Discovered sessions can live under directories the user has since deleted;
      // recreate the (empty) folder so the resumed session has a real cwd, matching
      // the single-import flow and createWorkspaceRootIfMissing below.
      const workspaceRoot = yield* canonicalize(cwd, { createIfMissing: true }).pipe(
        Effect.mapError(() =>
          batchError(`The session folder '${cwd}' is not usable as a project directory.`),
        ),
      );
      const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
      const project: ResolvedImportProject = {
        id: projectId,
        workspaceRoot,
        defaultModelSelection: defaultModelSelectionForProvider("codex"),
      };
      yield* options.orchestrationEngine
        .dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId,
          kind: "project",
          title: projectTitleFromWorkspaceRoot(workspaceRoot),
          workspaceRoot,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: project.defaultModelSelection,
          createdAt: now(),
        })
        .pipe(
          // Duplicate-root rejection means another client linked the folder concurrently;
          // recover by re-matching against a fresh snapshot (createOrRecover semantics).
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const recovered = findProjectForCwd(yield* listActiveProjects(), cwd);
              if (!recovered) {
                return yield* Effect.fail(
                  batchError(
                    cause instanceof Error && cause.message.length > 0
                      ? cause.message
                      : `Failed to create a project for '${workspaceRoot}'.`,
                  ),
                );
              }
              createdProjectsByCwd.set(normalizedCwd, recovered);
            }),
          ),
        );
      const recovered = createdProjectsByCwd.get(normalizedCwd);
      if (recovered) {
        return recovered;
      }
      createdProjectsByCwd.set(normalizedCwd, project);
      return project;
    });

    const importOne = (
      item: OrchestrationImportExternalThreadsItem,
    ): Effect.Effect<OrchestrationImportExternalThreadsItemResult, never> =>
      Effect.gen(function* () {
        const externalId = item.externalId.trim();

        // 1. Dedup: the session may already be imported (earlier batch item or prior
        // import). Projection column first, live bindings as pre-migration fallback.
        const boundThreadId = yield* lookupAlreadyImportedThreadId(options, {
          provider: item.provider,
          externalId,
        }).pipe(
          Effect.mapError(() => batchError("Failed to check existing provider session imports.")),
        );
        if (boundThreadId) {
          const boundThreadOption =
            yield* options.projectionSnapshotQuery.getThreadDetailById(boundThreadId);
          if (Option.isSome(boundThreadOption)) {
            return {
              externalId: item.externalId,
              status: "alreadyImported" as const,
              threadId: boundThreadId,
            };
          }
        }

        // 2. Resolve (or create, once per distinct cwd) the target project.
        const cwd = item.cwd?.trim() ?? "";
        if (cwd.length === 0) {
          return yield* Effect.fail(
            batchError("This session has no working directory to import into."),
          );
        }
        const project = yield* resolveProjectForCwd(cwd);

        // 3. Create the thread server-side (same payload as the web single-import flow).
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        const title = importedThreadTitle(item);
        const modelSelection =
          project.defaultModelSelection?.provider === item.provider
            ? project.defaultModelSelection
            : defaultModelSelectionForProvider(item.provider);
        yield* options.orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: project.id,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: "local",
          branch: null,
          worktreePath: null,
          createdAt: now(),
        });

        // 4. Run the shared import core; on failure delete the shell thread exactly like
        // the web single-import flow does. A runner-side dedup hit (binding created
        // between steps 1 and 4) also leaves our shell behind — delete it too.
        const outcome = yield* runExternalSessionImport({
          threadId,
          externalId,
          ...(item.title?.trim() ? { title: item.title.trim() } : {}),
        }).pipe(
          Effect.tap((result) =>
            result.alreadyImported === true && result.threadId !== threadId
              ? options.orchestrationEngine
                  .dispatch({
                    type: "thread.delete",
                    commandId: CommandId.makeUnsafe(crypto.randomUUID()),
                    threadId,
                  })
                  .pipe(Effect.ignore)
              : Effect.void,
          ),
          Effect.onError(() =>
            options.orchestrationEngine
              .dispatch({
                type: "thread.delete",
                commandId: CommandId.makeUnsafe(crypto.randomUUID()),
                threadId,
              })
              .pipe(Effect.ignore),
          ),
        );

        return outcome.alreadyImported === true
          ? {
              externalId: item.externalId,
              status: "alreadyImported" as const,
              threadId: outcome.threadId,
            }
          : {
              externalId: item.externalId,
              status: "imported" as const,
              threadId: outcome.threadId,
            };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            externalId: item.externalId,
            status: "failed" as const,
            error:
              error instanceof Error && error.message.length > 0 ? error.message : "Import failed.",
          }),
        ),
      );

    // Strictly sequential: each codex item spawns/uses a discovery app-server, and the
    // batch must never fan out provider processes.
    const results: OrchestrationImportExternalThreadsItemResult[] = [];
    for (const item of body.items) {
      results.push(yield* importOne(item));
    }
    return { results };
  });
}
