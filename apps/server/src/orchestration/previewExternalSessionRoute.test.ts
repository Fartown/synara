// FILE: previewExternalSessionRoute.test.ts
// Purpose: Verifies the read-only external session preview maps provider-native history
//   with the import mappers, truncates to the latest 30 turns with consistent
//   totalTurns/truncated flags, serves repeat previews from the 60s cache, and performs
//   no orchestration dispatch or provider session start.
// Layer: Orchestration query handler tests
// Depends on: previewExternalSessionRoute.

import type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  TurnId,
  type OrchestrationPreviewExternalSessionInput,
} from "@synara/contracts";
import { providerStartOptionsFromServerSettings } from "@synara/shared/serverSettings";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ServerSettingsShape } from "../serverSettings.ts";
import { makePreviewExternalSessionHandler } from "./previewExternalSessionRoute.ts";

const getClaudeSessionMessages = vi.fn(
  async (_sessionId: string, _options?: { dir?: string }): Promise<ReadonlyArray<unknown>> => [],
);
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  getSessionMessages: (sessionId: string, options?: { dir?: string }) =>
    getClaudeSessionMessages(sessionId, options),
}));

const NOW_ISO = "2026-07-19T12:00:00.000Z";
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function codexTurn(index: number): { id: TurnId; items: ReadonlyArray<unknown> } {
  return {
    id: asTurnId(`turn-${index}`),
    items: [
      {
        type: "userMessage",
        id: `u${index}`,
        content: [{ type: "text", text: `Prompt ${index}` }],
      },
      {
        type: "assistantMessage",
        id: `a${index}`,
        content: [{ type: "text", text: `Reply ${index}` }],
      },
    ],
  };
}

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
  readonly turnCount?: number;
  readonly readExternalThread?: (args: {
    externalThreadId: string;
    cwd?: string;
    providerOptions?: unknown;
  }) => Effect.Effect<
    { threadId: ThreadId; turns: ReadonlyArray<{ id: TurnId; items: ReadonlyArray<unknown> }> },
    Error
  >;
}) {
  const turnCount = input.turnCount ?? 2;
  const readExternalThread = vi.fn(
    input.readExternalThread ??
      (() =>
        Effect.succeed({
          threadId: ThreadId.makeUnsafe("ext-codex-1"),
          turns: Array.from({ length: turnCount }, (_, index) => codexTurn(index)),
        })),
  );

  let nowMs = 1_000_000;
  const handler = makePreviewExternalSessionHandler({
    now: () => nowMs,
    nowIso: () => NOW_ISO,
    providerAdapterRegistry: {
      getByProvider: () => Effect.succeed({ readExternalThread }),
    } as unknown as ProviderAdapterRegistryShape,
    serverSettings: {
      getSnapshot: Effect.succeed({
        revision: 0,
        migrationVersion: 1,
        settings: DEFAULT_SERVER_SETTINGS,
      }),
    } as unknown as ServerSettingsShape,
  });

  // Read-only witnesses: the handler must never dispatch orchestration commands or start
  // provider sessions. They exist only to prove the preview never touches them.
  const dispatch = vi.fn((_command: unknown) => Effect.succeed({ sequence: 1 }));
  const startSession = vi.fn(() => Effect.void);

  return {
    dispatch,
    handler,
    readExternalThread,
    startSession,
    setNow: (value: number) => {
      nowMs = value;
    },
  };
}

const CODEX_INPUT: OrchestrationPreviewExternalSessionInput = {
  provider: "codex",
  externalId: "ext-codex-1",
  cwd: "/work/repo",
};

async function runHandlerError(
  handler: ReturnType<typeof makeHarness>["handler"],
  input: OrchestrationPreviewExternalSessionInput,
) {
  const error = await Effect.runPromise(handler(input).pipe(Effect.flip));
  return error instanceof Error ? error.message : String(error);
}

describe("makePreviewExternalSessionHandler codex", () => {
  it("reads the external thread with provider options and maps the full history", async () => {
    const { dispatch, handler, readExternalThread, startSession } = makeHarness({});

    const result = await Effect.runPromise(handler(CODEX_INPUT));

    expect(result.totalTurns).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]?.turnId).toBe("turn-0");
    expect(result.turns[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.turns[0]?.messages[0]?.text).toBe("Prompt 0");
    expect(readExternalThread).toHaveBeenCalledTimes(1);
    expect(readExternalThread).toHaveBeenCalledWith({
      externalThreadId: "ext-codex-1",
      cwd: "/work/repo",
      providerOptions: providerStartOptionsFromServerSettings(DEFAULT_SERVER_SETTINGS),
    });
    // Read-only: no orchestration dispatch, no provider session start.
    expect(dispatch).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("returns the last 30 turns with totalTurns and truncated flags", async () => {
    const { handler } = makeHarness({ turnCount: 35 });

    const result = await Effect.runPromise(handler(CODEX_INPUT));

    expect(result.totalTurns).toBe(35);
    expect(result.truncated).toBe(true);
    expect(result.turns).toHaveLength(30);
    expect(result.turns[0]?.turnId).toBe("turn-5");
    expect(result.turns[29]?.turnId).toBe("turn-34");
  });

  it("serves repeat previews from the 60s cache and re-reads after expiry", async () => {
    const { handler, readExternalThread, setNow } = makeHarness({});

    await Effect.runPromise(handler(CODEX_INPUT));
    const second = await Effect.runPromise(handler(CODEX_INPUT));
    expect(second.totalTurns).toBe(2);
    expect(readExternalThread).toHaveBeenCalledTimes(1);

    setNow(1_000_000 + 61_000);
    await Effect.runPromise(handler(CODEX_INPUT));
    expect(readExternalThread).toHaveBeenCalledTimes(2);
  });

  it("surfaces provider read failures as typed errors", async () => {
    const { handler } = makeHarness({
      readExternalThread: () => Effect.fail(new Error("codex app-server unavailable")),
    });

    const message = await runHandlerError(handler, CODEX_INPUT);

    expect(message).toContain("codex app-server unavailable");
  });
});

describe("makePreviewExternalSessionHandler claude", () => {
  it("reads the session messages with the requested cwd and maps them", async () => {
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
    const { dispatch, handler, readExternalThread, startSession } = makeHarness({});

    const result = await Effect.runPromise(
      handler({ provider: "claudeAgent", externalId: "ext-claude-1", cwd: "/work/repo" }),
    );

    expect(getClaudeSessionMessages).toHaveBeenCalledTimes(1);
    expect(getClaudeSessionMessages).toHaveBeenCalledWith("ext-claude-1", { dir: "/work/repo" });
    expect(readExternalThread).not.toHaveBeenCalled();
    expect(result.totalTurns).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.turns[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(dispatch).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });

  it("surfaces unreadable sessions as typed errors", async () => {
    getClaudeSessionMessages.mockClear();
    getClaudeSessionMessages.mockRejectedValueOnce(new Error("session file is corrupt"));
    const { handler } = makeHarness({});

    const message = await runHandlerError(handler, {
      provider: "claudeAgent",
      externalId: "ext-claude-1",
      cwd: "/work/repo",
    });

    expect(message).toContain("session file is corrupt");
  });
});

describe("makePreviewExternalSessionHandler guardrails", () => {
  it("fails for an unsupported provider without touching any provider", async () => {
    getClaudeSessionMessages.mockClear();
    const { dispatch, handler, readExternalThread, startSession } = makeHarness({});

    const message = await runHandlerError(handler, {
      provider: "droid",
      externalId: "ext-droid-1",
    } as unknown as OrchestrationPreviewExternalSessionInput);

    expect(message).toContain("not supported for provider 'droid'");
    expect(readExternalThread).not.toHaveBeenCalled();
    expect(getClaudeSessionMessages).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
  });
});
