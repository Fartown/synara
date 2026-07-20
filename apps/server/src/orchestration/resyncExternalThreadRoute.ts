// FILE: resyncExternalThreadRoute.ts
// Purpose: Re-reads the provider-native history for an imported external session and
//   re-dispatches the same thread.history.import command used at import time, so turns
//   the user added in the CLI after importing upsert into the existing Synara thread
//   projection (deterministic ids — new rows appear, existing rows update in place).
// Layer: Orchestration command handler
// Exports: makeResyncExternalThreadHandler.
//
// Lifecycle note: resync never touches the thread's provider session. Codex history is
// read through a discovery context (readExternalThread, not the thread-bound readThread)
// and Claude history is read from the persisted session file, so resync is safe whether
// or not a provider session is currently active for the thread — no stop, no busy error.

import { getSessionMessages as getClaudeSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { CommandId, type OrchestrationResyncExternalThreadInput } from "@synara/contracts";
import { Data, Effect, Option } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory";
import { extractExternalSessionId } from "./externalSessions";
import { mapClaudeSessionTurns, mapCodexSnapshotTurns } from "./importedThreadHistory";

class ResyncExternalThreadError extends Data.TaggedError("ResyncExternalThreadError")<{
  readonly message: string;
}> {}

function resyncError(message: string): ResyncExternalThreadError {
  return new ResyncExternalThreadError({ message });
}

export interface ResyncExternalThreadHandlerOptions {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerAdapterRegistry: ProviderAdapterRegistryShape;
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
  readonly now?: () => string;
}

export function makeResyncExternalThreadHandler(options: ResyncExternalThreadHandlerOptions) {
  const now = options.now ?? (() => new Date().toISOString());

  return Effect.fnUntraced(function* (body: OrchestrationResyncExternalThreadInput) {
    const threadOption = yield* options.projectionSnapshotQuery
      .getThreadDetailById(body.threadId)
      .pipe(
        Effect.mapError(() =>
          resyncError(`Failed to load thread '${body.threadId}' for external session resync.`),
        ),
      );
    if (Option.isNone(threadOption)) {
      return yield* Effect.fail(resyncError(`Thread '${body.threadId}' was not found.`));
    }
    const thread = threadOption.value;

    const bindingOption = yield* options.providerSessionDirectory
      .getBinding(thread.id)
      .pipe(
        Effect.mapError(() =>
          resyncError(`Failed to load the provider binding for thread '${body.threadId}'.`),
        ),
      );
    if (
      Option.isNone(bindingOption) ||
      (bindingOption.value.provider !== "codex" && bindingOption.value.provider !== "claudeAgent")
    ) {
      return yield* Effect.fail(
        resyncError(`Thread '${body.threadId}' is not bound to an external Codex/Claude session.`),
      );
    }
    const binding = bindingOption.value;
    const externalId = extractExternalSessionId(binding.provider, binding.resumeCursor);
    if (!externalId) {
      return yield* Effect.fail(
        resyncError(
          `Thread '${body.threadId}' has no external session id in its provider binding.`,
        ),
      );
    }

    const importedAt = now();
    let importedTurns = 0;

    if (binding.provider === "codex") {
      const adapter = yield* options.providerAdapterRegistry
        .getByProvider("codex")
        .pipe(Effect.mapError(() => resyncError("The Codex provider adapter is unavailable.")));
      if (!adapter.readExternalThread) {
        return yield* Effect.fail(resyncError("Codex external session resync is unavailable."));
      }
      const snapshot = yield* adapter
        .readExternalThread({ externalThreadId: externalId })
        .pipe(
          Effect.mapError((cause) =>
            resyncError(
              cause instanceof Error && cause.message.length > 0
                ? cause.message
                : "Failed to read Codex thread history.",
            ),
          ),
        );
      const turns = mapCodexSnapshotTurns({
        threadId: thread.id,
        turns: snapshot.turns,
        importedAt,
      });
      importedTurns = turns.length;
      if (turns.length > 0) {
        yield* options.orchestrationEngine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: thread.id,
          turns,
          createdAt: importedAt,
        });
      }
    } else {
      const projectOption = yield* options.projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(
          Effect.mapError(() =>
            resyncError(`Failed to load the project for thread '${body.threadId}'.`),
          ),
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
      const sessionMessages = yield* Effect.tryPromise({
        try: () => getClaudeSessionMessages(externalId, cwd ? { dir: cwd } : undefined),
        catch: (cause) =>
          resyncError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "Failed to read Claude session history.",
          ),
      });
      const turns = mapClaudeSessionTurns({
        threadId: thread.id,
        messages: sessionMessages,
        importedAt,
      });
      importedTurns = turns.length;
      if (turns.length > 0) {
        yield* options.orchestrationEngine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: thread.id,
          turns,
          createdAt: importedAt,
        });
      }
    }

    return { threadId: thread.id, importedTurns };
  });
}
