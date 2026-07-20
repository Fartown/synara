// FILE: resyncExternalThreadRoute.test.ts
// Purpose: Verifies external session resync reads provider-native history through the
//   thread's binding, re-dispatches thread.history.import, and raises typed guardrail
//   errors for threads without a resyncable external session.
// Layer: Orchestration command handler tests
// Depends on: resyncExternalThreadRoute.

import type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId, TurnId } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory";
import { makeResyncExternalThreadHandler } from "./resyncExternalThreadRoute.ts";

const getClaudeSessionMessages = vi.fn(
  async (_sessionId: string, _options?: { dir?: string }): Promise<ReadonlyArray<unknown>> => [],
);
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  getSessionMessages: (sessionId: string, options?: { dir?: string }) =>
    getClaudeSessionMessages(sessionId, options),
}));

const NOW = "2026-07-19T12:00:00.000Z";
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function claudeMessage(
  value: Omit<ClaudeSessionMessage, "session_id" | "parent_tool_use_id" | "parent_agent_id"> &
    Partial<ClaudeSessionMessage>,
): ClaudeSessionMessage {
  return {
    session_id: "session-1",
    parent_tool_use_id: null,
    parent_agent_id: null,
    ...value,
  } as ClaudeSessionMessage;
}

function makeHarness(input: {
  readonly bindingProvider?: string;
  readonly resumeCursor?: unknown;
  readonly knownThreadIds?: ReadonlyArray<string>;
  readonly readExternalThread?: (args: {
    externalThreadId: string;
  }) => Effect.Effect<
    { threadId: ThreadId; turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<unknown> }> },
    Error
  >;
}) {
  const threadId = asThreadId("thread-1");
  const dispatch = vi.fn((_command: unknown) => Effect.succeed({ sequence: 1 }));
  const readExternalThread = vi.fn(
    input.readExternalThread ??
      (() =>
        Effect.succeed({
          threadId,
          turns: [
            {
              id: asTurnId("turn-1"),
              items: [
                { type: "userMessage", id: "u1", content: [{ type: "text", text: "First" }] },
              ],
            },
            {
              id: asTurnId("turn-2"),
              items: [
                { type: "userMessage", id: "u2", content: [{ type: "text", text: "Second" }] },
              ],
            },
          ],
        })),
  );

  const knownThreadIds = new Set(input.knownThreadIds ?? ["thread-1"]);
  const handler = makeResyncExternalThreadHandler({
    now: () => NOW,
    orchestrationEngine: { dispatch } as unknown as OrchestrationEngineShape,
    projectionSnapshotQuery: {
      getThreadDetailById: (id: ThreadId) =>
        Effect.succeed(
          knownThreadIds.has(id)
            ? Option.some({
                id,
                projectId: "project-1",
                envMode: "local",
                worktreePath: null,
              })
            : Option.none(),
        ),
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({
            id: "project-1",
            kind: "project",
            workspaceRoot: "/work/repo",
          }),
        ),
    } as unknown as ProjectionSnapshotQueryShape,
    providerAdapterRegistry: {
      getByProvider: () => Effect.succeed({ readExternalThread }),
    } as unknown as ProviderAdapterRegistryShape,
    providerSessionDirectory: {
      getBinding: () =>
        Effect.succeed(
          input.bindingProvider === undefined
            ? Option.none()
            : Option.some({
                threadId,
                provider: input.bindingProvider,
                resumeCursor: input.resumeCursor,
              }),
        ),
    } as unknown as ProviderSessionDirectoryShape,
  });

  return { dispatch, handler, readExternalThread, threadId };
}

async function runHandlerError(
  handler: ReturnType<typeof makeHarness>["handler"],
  threadId: ThreadId,
) {
  const error = await Effect.runPromise(handler({ threadId }).pipe(Effect.flip));
  return error instanceof Error ? error.message : String(error);
}

describe("makeResyncExternalThreadHandler codex", () => {
  it("re-reads the external history and dispatches thread.history.import", async () => {
    const { dispatch, handler, readExternalThread, threadId } = makeHarness({
      bindingProvider: "codex",
      resumeCursor: { threadId: "ext-codex-1" },
    });

    const result = await Effect.runPromise(handler({ threadId }));

    expect(result).toEqual({ threadId, importedTurns: 2 });
    expect(readExternalThread).toHaveBeenCalledTimes(1);
    expect(readExternalThread).toHaveBeenCalledWith({ externalThreadId: "ext-codex-1" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const command = dispatch.mock.calls[0]?.[0] as {
      type: string;
      threadId: ThreadId;
      turns: ReadonlyArray<unknown>;
      createdAt: string;
    };
    expect(command.type).toBe("thread.history.import");
    expect(command.threadId).toBe(threadId);
    expect(command.turns).toHaveLength(2);
    expect(command.createdAt).toBe(NOW);
  });

  it("returns zero imported turns and skips the dispatch for empty history", async () => {
    const { dispatch, handler, threadId } = makeHarness({
      bindingProvider: "codex",
      resumeCursor: { threadId: "ext-codex-1" },
      readExternalThread: () => Effect.succeed({ threadId: asThreadId("thread-1"), turns: [] }),
    });

    const result = await Effect.runPromise(handler({ threadId }));

    expect(result).toEqual({ threadId, importedTurns: 0 });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("surfaces provider read failures as typed errors", async () => {
    const { handler, threadId } = makeHarness({
      bindingProvider: "codex",
      resumeCursor: { threadId: "ext-codex-1" },
      readExternalThread: () => Effect.fail(new Error("codex app-server unavailable")),
    });

    await expect(Effect.runPromise(handler({ threadId }))).rejects.toThrow(
      /codex app-server unavailable|Failed/,
    );
  });
});

describe("makeResyncExternalThreadHandler claude", () => {
  it("reads the session messages with the thread workspace cwd and dispatches the import", async () => {
    getClaudeSessionMessages.mockClear();
    getClaudeSessionMessages.mockResolvedValueOnce([
      claudeMessage({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "Please fix" },
      }),
      claudeMessage({
        type: "assistant",
        uuid: "a1",
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      }),
    ]);
    const { dispatch, handler, threadId } = makeHarness({
      bindingProvider: "claudeAgent",
      resumeCursor: { resume: "ext-claude-1" },
    });

    const result = await Effect.runPromise(handler({ threadId }));

    expect(result).toEqual({ threadId, importedTurns: 1 });
    expect(getClaudeSessionMessages).toHaveBeenCalledTimes(1);
    expect(getClaudeSessionMessages).toHaveBeenCalledWith("ext-claude-1", { dir: "/work/repo" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0]?.[0] as { type: string }).type).toBe("thread.history.import");
  });
});

describe("makeResyncExternalThreadHandler guardrails", () => {
  it("fails when the thread does not exist", async () => {
    const { dispatch, handler } = makeHarness({
      bindingProvider: "codex",
      resumeCursor: { threadId: "ext-codex-1" },
      knownThreadIds: [],
    });

    const message = await runHandlerError(handler, asThreadId("thread-missing"));

    expect(message).toContain("thread-missing");
    expect(message).toContain("was not found");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails when the thread has no provider binding", async () => {
    const { dispatch, handler, threadId } = makeHarness({});

    const message = await runHandlerError(handler, threadId);

    expect(message).toContain("not bound to an external Codex/Claude session");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails when the binding belongs to another provider", async () => {
    const { dispatch, handler, threadId } = makeHarness({
      bindingProvider: "droid",
      resumeCursor: { schemaVersion: 1, sessionId: "ext-droid-1" },
    });

    const message = await runHandlerError(handler, threadId);

    expect(message).toContain("not bound to an external Codex/Claude session");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails when the binding cursor has no external session id", async () => {
    const { dispatch, handler, threadId } = makeHarness({
      bindingProvider: "codex",
      resumeCursor: null,
    });

    const message = await runHandlerError(handler, threadId);

    expect(message).toContain("no external session id");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
