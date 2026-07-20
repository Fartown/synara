// FILE: externalSessionImport.ts
// Purpose: Shared core of external session import: given an EXISTING Synara thread, bind
//   a provider-native session to it — dedup by (provider, externalId), patch the
//   thread's env/worktree context for subdirectory/worktree cwd matches, start the
//   provider session with the resume cursor, replay the provider-native history through
//   thread.history.import (rolling the session back on failure), publish
//   thread.session.set, and apply the optional caller-provided title.
// Layer: Orchestration command helper
// Exports: ExternalSessionImportError, makeExternalSessionImportRunner.
//
// Used by the single-import route (importThreadRoute.ts, thread pre-created by the
// client) and the batch route (importExternalThreadsRoute.ts, thread created
// server-side). Behavior of the single-import path must stay identical — this module
// is an extraction, not a rewrite.

import {
  getSessionInfo as getClaudeSessionInfo,
  getSessionMessages as getClaudeSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CommandId,
  type ProviderKind,
  type ThreadHandoffImportedMessage,
  type ThreadId,
  type ThreadImportedTurn,
} from "@synara/contracts";
import {
  deriveAssociatedWorktreeMetadata,
  workspaceRootsEqual,
} from "@synara/shared/threadWorkspace";
import { providerStartOptionsFromServerSettings } from "@synara/shared/serverSettings";
import type { FileSystem, Path } from "effect";
import { Data, Effect, Option } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils";
import type { ProjectionThreadSessionRepositoryShape } from "../persistence/Services/ProjectionThreadSessions";
import type { ProjectionRepositoryError } from "../persistence/Errors";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type {
  ProviderSessionDirectoryReadError,
  ProviderSessionDirectoryShape,
} from "../provider/Services/ProviderSessionDirectory";
import type { ServerSettingsShape } from "../serverSettings";
import { parseManagedWorktreeWorkspaceRoot } from "../workspace/managedWorktree";
import {
  findImportedThreadIdForExternalSession,
  isExternalSessionImportProvider,
} from "./externalSessions";
import { mapClaudeSessionTurns, mapCodexSnapshotTurns } from "./importedThreadHistory";
import { mapFactorySnapshotMessages, mapOpenCodeSnapshotMessages } from "./importedThreadMessages";

export class ExternalSessionImportError extends Data.TaggedError("ExternalSessionImportError")<{
  readonly message: string;
}> {}

function importMessagesError(message: string): ExternalSessionImportError {
  return new ExternalSessionImportError({ message });
}

export type ExternalImportLookupError =
  | ProjectionRepositoryError
  | ProviderSessionDirectoryReadError;

export interface ExternalImportLookupDeps {
  readonly projectionThreadSessionRepository: ProjectionThreadSessionRepositoryShape;
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
}

/**
 * Duplicate-import lookup. The durable identity is the thread's own projection row
 * (`projection_thread_sessions.provider_thread_id`, written from the import's
 * thread.session-set event and replayed on projection rebuild); live runtime
 * bindings remain as a fallback union for pre-migration imports only.
 */
export const lookupAlreadyImportedThreadId = (
  deps: ExternalImportLookupDeps,
  input: { readonly provider: string; readonly externalId: string },
): Effect.Effect<ThreadId | undefined, ExternalImportLookupError> =>
  Effect.gen(function* () {
    if (isExternalSessionImportProvider(input.provider)) {
      const mapped = yield* deps.projectionThreadSessionRepository.getThreadIdByProviderThreadId(
        input.provider,
        input.externalId,
      );
      if (Option.isSome(mapped)) {
        return mapped.value;
      }
    }
    const bindings = yield* deps.providerSessionDirectory.listBindings();
    return findImportedThreadIdForExternalSession(bindings, input.provider, input.externalId);
  });

function providerResumeCursorForImport(provider: ProviderKind, externalId: string): unknown {
  switch (provider) {
    case "claudeAgent":
      return { resume: externalId };
    case "droid":
      return { schemaVersion: 1, sessionId: externalId };
    case "kilo":
    case "opencode":
      return { openCodeSessionId: externalId };
    default:
      return { threadId: externalId };
  }
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): "starting" | "ready" | "running" | "error" | "stopped" {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

export interface ExternalSessionImportRunnerOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerAdapterRegistry: ProviderAdapterRegistryShape;
  readonly providerService: ProviderServiceShape;
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
  readonly serverSettings: ServerSettingsShape;
  readonly projectionThreadSessionRepository: ProjectionThreadSessionRepositoryShape;
}

export interface ExternalSessionImportRequest {
  readonly threadId: ThreadId;
  readonly externalId: string;
  readonly title?: string | undefined;
}

export interface ExternalSessionImportOutcome {
  readonly threadId: ThreadId;
  readonly alreadyImported?: boolean;
}

export function makeExternalSessionImportRunner(options: ExternalSessionImportRunnerOptions) {
  const dispatchImportedMessages = (input: {
    readonly createdAt: string;
    readonly messages: ReadonlyArray<ThreadHandoffImportedMessage>;
    readonly threadId: ThreadId;
  }) =>
    input.messages.length === 0
      ? Effect.void
      : options.orchestrationEngine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: input.threadId,
          messages: input.messages,
          createdAt: input.createdAt,
        });

  const dispatchImportedHistory = (input: {
    readonly createdAt: string;
    readonly threadId: ThreadId;
    readonly turns: ReadonlyArray<ThreadImportedTurn>;
  }) =>
    input.turns.length === 0
      ? Effect.void
      : options.orchestrationEngine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: input.threadId,
          turns: input.turns,
          createdAt: input.createdAt,
        });

  const ensureClaudeThreadImportable = Effect.fn(function* (input: {
    readonly cwd: string | undefined;
    readonly externalId: string;
  }) {
    const claudeSessionInfo = yield* Effect.tryPromise({
      try: () => getClaudeSessionInfo(input.externalId, input.cwd ? { dir: input.cwd } : undefined),
      catch: (cause) =>
        importMessagesError(
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "Failed to inspect Claude session metadata.",
        ),
    });

    if (claudeSessionInfo) return;

    const sessionFoundElsewhere = yield* Effect.tryPromise({
      try: () => getClaudeSessionInfo(input.externalId),
      catch: () => undefined,
    });

    return yield* Effect.fail(
      importMessagesError(
        sessionFoundElsewhere && input.cwd
          ? `Claude session '${input.externalId}' exists, but not for this workspace. Claude resume only works when the session file is stored for '${input.cwd}'.`
          : `Claude session '${input.externalId}' was not found on this machine for this workspace. Claude import only works with a locally persisted Claude session ID.`,
      ),
    );
  });

  const resolveImportedProviderThreadContext = Effect.fn(function* (input: {
    readonly provider: "codex" | "droid" | "kilo" | "opencode";
    readonly externalId: string;
    readonly projectWorkspaceRoot: string;
    readonly fallbackCwd?: string;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider(input.provider);
    if (!adapter.readExternalThread) return null;

    // Pass configured provider launch options (e.g. a custom Codex binary path) so
    // the external read uses the same binary as thread-bound sessions.
    const settingsSnapshot = yield* options.serverSettings.getSnapshot.pipe(
      Effect.mapError(() =>
        importMessagesError("Failed to load server settings for provider options."),
      ),
    );
    const providerOptions = providerStartOptionsFromServerSettings(settingsSnapshot.settings);

    const snapshot = yield* adapter
      .readExternalThread({
        externalThreadId: input.externalId,
        ...(input.fallbackCwd ? { cwd: input.fallbackCwd } : {}),
        providerOptions,
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const externalCwd = snapshot?.cwd?.trim();
    if (!externalCwd) return null;

    if (
      workspaceRootsEqual(input.projectWorkspaceRoot, externalCwd, {
        platform: options.platform,
      })
    ) {
      return {
        runtimeCwd: externalCwd,
        patch: {
          envMode: "local" as const,
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
        },
      };
    }

    const relativeToProjectRoot = options.path.relative(input.projectWorkspaceRoot, externalCwd);
    if (
      relativeToProjectRoot.length > 0 &&
      !relativeToProjectRoot.startsWith("..") &&
      !options.path.isAbsolute(relativeToProjectRoot)
    ) {
      return {
        runtimeCwd: externalCwd,
        patch: null,
      };
    }

    let currentPath = externalCwd;
    while (true) {
      const gitPointerFileContents = yield* options.fileSystem
        .readFileString(options.path.join(currentPath, ".git"))
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (gitPointerFileContents) {
        const workspaceRoot = parseManagedWorktreeWorkspaceRoot({
          gitPointerFileContents,
          path: options.path,
          worktreePath: currentPath,
        });
        if (
          workspaceRoot &&
          workspaceRootsEqual(input.projectWorkspaceRoot, workspaceRoot, {
            platform: options.platform,
          })
        ) {
          return {
            runtimeCwd: externalCwd,
            patch: {
              envMode: "worktree" as const,
              branch: null,
              worktreePath: currentPath,
              ...deriveAssociatedWorktreeMetadata({
                branch: null,
                worktreePath: currentPath,
              }),
            },
          };
        }
      }

      const parentPath = options.path.dirname(currentPath);
      if (parentPath === currentPath) return null;
      currentPath = parentPath;
    }
  });

  const importCodexThreadHistory = Effect.fn(function* (input: {
    readonly importedAt: string;
    readonly threadId: ThreadId;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider("codex");
    const snapshot = yield* adapter
      .readThread(input.threadId)
      .pipe(
        Effect.mapError((cause) =>
          importMessagesError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "Failed to read Codex thread history.",
          ),
        ),
      );

    yield* dispatchImportedHistory({
      threadId: input.threadId,
      turns: mapCodexSnapshotTurns({
        threadId: input.threadId,
        turns: snapshot.turns,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  const importClaudeThreadHistory = Effect.fn(function* (input: {
    readonly cwd: string | undefined;
    readonly externalId: string;
    readonly importedAt: string;
    readonly threadId: ThreadId;
  }) {
    const sessionMessages = yield* Effect.tryPromise({
      try: () =>
        getClaudeSessionMessages(input.externalId, input.cwd ? { dir: input.cwd } : undefined),
      catch: (cause) =>
        importMessagesError(
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "Failed to read Claude session history.",
        ),
    });

    yield* dispatchImportedHistory({
      threadId: input.threadId,
      turns: mapClaudeSessionTurns({
        threadId: input.threadId,
        messages: sessionMessages,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  const importOpenCodeCompatibleThreadHistory = Effect.fn(function* (input: {
    readonly importedAt: string;
    readonly provider: "kilo" | "opencode";
    readonly threadId: ThreadId;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider(input.provider);
    const snapshot = yield* adapter
      .readThread(input.threadId)
      .pipe(
        Effect.mapError((cause) =>
          importMessagesError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : `Failed to read ${input.provider === "kilo" ? "Kilo" : "OpenCode"} session history.`,
          ),
        ),
      );

    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: mapOpenCodeSnapshotMessages({
        threadId: input.threadId,
        turns: snapshot.turns,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  const importDroidThreadHistory = Effect.fn(function* (input: {
    readonly externalId: string;
    readonly importedAt: string;
    readonly threadId: ThreadId;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider("droid");
    if (!adapter.readExternalThread) {
      return yield* Effect.fail(importMessagesError("Droid session import is unavailable."));
    }
    const snapshot = yield* adapter
      .readExternalThread({ externalThreadId: input.externalId })
      .pipe(
        Effect.mapError((cause) =>
          importMessagesError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "Failed to read Droid session history.",
          ),
        ),
      );
    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: mapFactorySnapshotMessages({
        threadId: input.threadId,
        turns: snapshot.turns,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  return Effect.fnUntraced(function* (body: ExternalSessionImportRequest) {
    const threadOption = yield* options.projectionSnapshotQuery.getThreadDetailById(body.threadId);
    if (Option.isNone(threadOption)) {
      return yield* Effect.fail(importMessagesError(`Thread '${body.threadId}' was not found.`));
    }
    const thread = threadOption.value;
    const externalId = body.externalId.trim();

    // Duplicate-import guard: if this provider session is already imported into an
    // existing Synara thread, return that thread instead of starting a second session
    // for it. The projection column is the durable identity; live bindings are the
    // pre-migration fallback.
    const boundThreadId = yield* lookupAlreadyImportedThreadId(options, {
      provider: thread.modelSelection.provider,
      externalId,
    }).pipe(
      Effect.mapError(() =>
        importMessagesError("Failed to check existing provider session imports."),
      ),
    );
    if (boundThreadId) {
      const boundThreadOption =
        yield* options.projectionSnapshotQuery.getThreadDetailById(boundThreadId);
      if (Option.isSome(boundThreadOption)) {
        return { threadId: boundThreadId, alreadyImported: true };
      }
    }

    if (thread.session && thread.session.status !== "stopped") {
      return yield* Effect.fail(
        importMessagesError(`Thread '${body.threadId}' already has an active provider session.`),
      );
    }

    const projectOption = yield* options.projectionSnapshotQuery.getProjectShellById(
      thread.projectId,
    );
    const project = Option.getOrNull(projectOption);
    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project
        ? [
            {
              id: project.id,
              kind: project.kind,
              workspaceRoot: project.workspaceRoot,
            },
          ]
        : [],
    });
    const importedProviderContext =
      (thread.modelSelection.provider === "codex" ||
        thread.modelSelection.provider === "droid" ||
        thread.modelSelection.provider === "kilo" ||
        thread.modelSelection.provider === "opencode") &&
      project
        ? yield* resolveImportedProviderThreadContext({
            provider: thread.modelSelection.provider,
            externalId,
            projectWorkspaceRoot: project.workspaceRoot,
            ...(cwd ? { fallbackCwd: cwd } : {}),
          })
        : null;

    if (importedProviderContext?.patch) {
      yield* options.orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: thread.id,
        ...importedProviderContext.patch,
      });
    }

    if (thread.modelSelection.provider === "claudeAgent") {
      yield* ensureClaudeThreadImportable({
        cwd,
        externalId,
      });
    }

    const session = yield* options.providerService.startSession(thread.id, {
      threadId: thread.id,
      provider: thread.modelSelection.provider,
      ...((importedProviderContext?.runtimeCwd ?? cwd)
        ? { cwd: importedProviderContext?.runtimeCwd ?? cwd }
        : {}),
      modelSelection: thread.modelSelection,
      resumeCursor: providerResumeCursorForImport(thread.modelSelection.provider, externalId),
      runtimeMode: thread.runtimeMode,
    });

    yield* Effect.gen(function* () {
      if (thread.modelSelection.provider === "codex") {
        yield* importCodexThreadHistory({
          threadId: thread.id,
          importedAt: session.updatedAt,
        });
      } else if (thread.modelSelection.provider === "claudeAgent") {
        yield* importClaudeThreadHistory({
          threadId: thread.id,
          externalId,
          cwd,
          importedAt: session.updatedAt,
        });
      } else if (thread.modelSelection.provider === "droid") {
        yield* importDroidThreadHistory({
          threadId: thread.id,
          externalId,
          importedAt: session.updatedAt,
        });
      } else if (
        thread.modelSelection.provider === "kilo" ||
        thread.modelSelection.provider === "opencode"
      ) {
        yield* importOpenCodeCompatibleThreadHistory({
          provider: thread.modelSelection.provider,
          threadId: thread.id,
          importedAt: session.updatedAt,
        });
      }
    }).pipe(
      Effect.onError(() =>
        // Startup precedes history materialization. Roll it back when import
        // cannot finish so no provider child or persisted binding is orphaned.
        options.providerService.stopSession({ threadId: thread.id }).pipe(Effect.ignore),
      ),
    );

    yield* options.orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: mapProviderSessionStatusToOrchestrationStatus(session.status),
        providerName: session.provider,
        runtimeMode: thread.runtimeMode,
        activeTurnId: null,
        lastError: session.lastError ?? null,
        updatedAt: session.updatedAt,
      },
      // The durable import identity: projected into
      // projection_thread_sessions.provider_thread_id, where it survives
      // session-lifecycle binding cleanup and projection rebuilds.
      externalSessionId: externalId,
      createdAt: session.updatedAt,
    });

    // Optional caller-provided title (e.g. the provider-native session's own title).
    // Best effort: the import itself already succeeded, so a rejected meta update
    // must not surface as an import failure.
    if (body.title) {
      yield* options.orchestrationEngine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: thread.id,
          title: body.title,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to set imported thread title", {
              threadId: thread.id,
              cause,
            }),
          ),
        );
    }

    return { threadId: thread.id };
  });
}
