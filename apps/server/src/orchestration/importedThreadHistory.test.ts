// FILE: importedThreadHistory.test.ts
// Purpose: Verifies provider-native snapshots map into structured imported turns with
//   live-fidelity messages, tool/reasoning activities, plans, turn ids, stable ids, and
//   transcript ordering.
// Layer: Orchestration mapping tests
// Depends on: importedThreadHistory.

import type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ThreadId, TurnId } from "@synara/contracts";
import { expect, it } from "vitest";

import { mapClaudeSessionTurns, mapCodexSnapshotTurns } from "./importedThreadHistory.ts";

const IMPORTED_AT = "2026-07-10T12:00:00.000Z";
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function collectOrderedCreatedAts(
  turns: ReadonlyArray<{
    readonly messages: ReadonlyArray<{ readonly createdAt: string }>;
    readonly activities: ReadonlyArray<{ readonly createdAt: string }>;
    readonly proposedPlans: ReadonlyArray<{ readonly createdAt: string }>;
  }>,
): Array<string> {
  return turns.flatMap((turn) => [
    ...turn.messages.map((entry) => entry.createdAt),
    ...turn.activities.map((entry) => entry.createdAt),
    ...turn.proposedPlans.map((entry) => entry.createdAt),
  ]);
}

// Imported entries carry a synthetic +1ms cadence in original transcript order, so the
// full set of timestamps must be a dense consecutive run starting at importedAt.
function expectDenseTimestampsFrom(
  turns: ReadonlyArray<{
    readonly messages: ReadonlyArray<{ readonly createdAt: string }>;
    readonly activities: ReadonlyArray<{ readonly createdAt: string }>;
    readonly proposedPlans: ReadonlyArray<{ readonly createdAt: string }>;
  }>,
  importedAt: string,
): void {
  const timestamps = collectOrderedCreatedAts(turns);
  expect(timestamps.length).toBeGreaterThan(0);
  expect(new Set(timestamps).size).toBe(timestamps.length);
  const base = Date.parse(importedAt);
  const sorted = [...timestamps].sort();
  sorted.forEach((timestamp, index) => {
    expect(timestamp).toBe(new Date(base + index).toISOString());
  });
}

it("maps a Codex snapshot into turns with messages, reasoning/tool activities, and plans", () => {
  const turns = mapCodexSnapshotTurns({
    threadId: asThreadId("thread-1"),
    importedAt: IMPORTED_AT,
    turns: [
      {
        id: asTurnId("turn-a"),
        items: [
          { type: "userMessage", id: "u1", content: [{ type: "text", text: "Fix the bug" }] },
          { type: "reasoning", id: "r1", summary: [{ text: "Thinking about it" }] },
          { type: "commandExecution", id: "c1", command: "bun test", status: "completed" },
          { type: "agentMessage", id: "a1", text: "Done" },
        ],
      },
      {
        id: asTurnId("turn-b"),
        items: [
          { type: "userMessage", text: "Now plan" },
          { type: "mcpToolCall", id: "m1", status: "failed" },
          { type: "plan", text: "1. Do X\n2. Do Y" },
          { type: "agentMessage", text: "Planned" },
        ],
      },
      // Empty turns and unrecognized items are dropped.
      { id: asTurnId("turn-empty"), items: [{ type: "somethingElse", value: 1 }] },
    ],
  });

  expect(turns.length).toBe(2);

  const first = turns[0]!;
  expect(first.turnId).toBe("turn-a");
  expect(first.state).toBe("completed");
  expect(first.userMessageId).toBe("import:thread-1:0:0");
  expect(first.assistantMessageId).toBe("import:thread-1:0:3");
  expect(first.messages).toEqual([
    {
      messageId: "import:thread-1:0:0",
      role: "user",
      text: "Fix the bug",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
    {
      messageId: "import:thread-1:0:3",
      role: "assistant",
      text: "Done",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  ]);
  expect(first.activities).toEqual([
    {
      id: "import-activity:thread-1:000000:000001",
      tone: "tool",
      kind: "task.progress",
      summary: "Reasoning trace",
      payload: {
        status: "completed",
        detail: "Thinking about it",
        data: { toolCallId: "r1" },
      },
      turnId: "turn-a",
      createdAt: expect.any(String),
    },
    {
      id: "import-activity:thread-1:000000:000002",
      tone: "tool",
      kind: "tool.completed",
      summary: "Ran command",
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "bun test",
        data: {
          toolCallId: "c1",
          item: { type: "commandExecution", id: "c1", command: "bun test", status: "completed" },
        },
      },
      turnId: "turn-a",
      createdAt: expect.any(String),
    },
  ]);
  expect(first.proposedPlans).toEqual([]);
  expect(first.requestedAt <= first.completedAt).toBe(true);

  const second = turns[1]!;
  expect(second.turnId).toBe("turn-b");
  expect(second.userMessageId).toBe("import:thread-1:1:0");
  expect(second.assistantMessageId).toBe("import:thread-1:1:3");
  expect(second.activities).toEqual([
    {
      id: "import-activity:thread-1:000001:000001",
      tone: "tool",
      kind: "tool.completed",
      summary: "MCP tool call",
      payload: {
        itemType: "mcp_tool_call",
        status: "failed",
        title: "MCP tool call",
        data: {
          toolCallId: "m1",
          item: { type: "mcpToolCall", id: "m1", status: "failed" },
        },
      },
      turnId: "turn-b",
      createdAt: expect.any(String),
    },
  ]);
  expect(second.proposedPlans).toEqual([
    {
      id: "plan:thread-1:turn:turn-b",
      turnId: "turn-b",
      planMarkdown: "1. Do X\n2. Do Y",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  ]);

  // Transcript order: every emitted entry across the whole import is a dense +1ms run.
  expectDenseTimestampsFrom(turns, IMPORTED_AT);
});

it("skips Codex reasoning items without a readable summary and turns without content", () => {
  const turns = mapCodexSnapshotTurns({
    threadId: asThreadId("thread-1"),
    importedAt: IMPORTED_AT,
    turns: [
      {
        id: asTurnId("turn-a"),
        items: [{ type: "reasoning", id: "r1", summary: [] }],
      },
      {
        id: asTurnId("turn-b"),
        items: [{ type: "agentMessage", text: "Answer" }],
      },
    ],
  });

  expect(turns.length).toBe(1);
  expect(turns[0]!.turnId).toBe("turn-b");
  expect(turns[0]!.activities).toEqual([]);
  expect(turns[0]!.assistantMessageId).toBe("import:thread-1:1:0");
});

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

it("maps a Claude session into turns with thinking/tool activities, results, and plans", () => {
  const turns = mapClaudeSessionTurns({
    threadId: asThreadId("thread-1"),
    importedAt: IMPORTED_AT,
    messages: [
      claudeMessage({ type: "system", uuid: "s1", message: { subtype: "init" } }),
      claudeMessage({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "Please fix" },
      }),
      claudeMessage({
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me look" },
            { type: "text", text: "Looking now" },
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } },
          ],
        },
      }),
      claudeMessage({
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "total 0", is_error: false },
          ],
        },
      }),
      claudeMessage({
        type: "assistant",
        uuid: "a2",
        message: { role: "assistant", content: [{ type: "text", text: "All done" }] },
      }),
      claudeMessage({
        type: "user",
        uuid: "u3",
        message: { role: "user", content: "Plan next" },
      }),
      claudeMessage({
        type: "assistant",
        uuid: "a3",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_2", name: "ExitPlanMode", input: { plan: "# Plan" } },
            { type: "text", text: "Plan ready" },
          ],
        },
      }),
      // Subagent transcript rows are excluded from the top-level history.
      claudeMessage({
        type: "user",
        uuid: "u4",
        parent_tool_use_id: "toolu_9",
        message: { role: "user", content: "subagent row" },
      }),
    ],
  });

  expect(turns.length).toBe(2);

  const first = turns[0]!;
  expect(first.turnId).toBe("import-turn:thread-1:claude:u1");
  expect(first.state).toBe("completed");
  expect(first.userMessageId).toBe("import:thread-1:claude:1:u1");
  expect(first.assistantMessageId).toBe("import:thread-1:claude:4:a2");
  expect(first.messages).toEqual([
    {
      messageId: "import:thread-1:claude:1:u1",
      role: "user",
      text: "Please fix",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
    {
      messageId: "import:thread-1:claude:2:a1",
      role: "assistant",
      text: "Looking now",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
    {
      messageId: "import:thread-1:claude:4:a2",
      role: "assistant",
      text: "All done",
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  ]);
  expect(first.activities).toEqual([
    {
      id: "import-activity:thread-1:claude:000002:000000",
      tone: "tool",
      kind: "task.progress",
      summary: "Reasoning trace",
      payload: {
        status: "completed",
        detail: "Let me look",
        data: { toolCallId: "thinking:a1:0" },
      },
      turnId: "import-turn:thread-1:claude:u1",
      createdAt: expect.any(String),
    },
    {
      id: "import-activity:thread-1:claude:toolu_1",
      tone: "tool",
      kind: "tool.completed",
      summary: "Command run",
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Command run",
        detail: "Bash: ls -la",
        data: {
          toolCallId: "toolu_1",
          callId: "toolu_1",
          toolName: "Bash",
          input: { command: "ls -la" },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "total 0",
            is_error: false,
          },
        },
      },
      turnId: "import-turn:thread-1:claude:u1",
      createdAt: expect.any(String),
    },
  ]);
  expect(first.proposedPlans).toEqual([]);

  const second = turns[1]!;
  expect(second.turnId).toBe("import-turn:thread-1:claude:u3");
  expect(second.userMessageId).toBe("import:thread-1:claude:5:u3");
  expect(second.assistantMessageId).toBe("import:thread-1:claude:6:a3");
  // ExitPlanMode renders through the proposed-plan channel only, never a tool row.
  expect(second.activities).toEqual([]);
  expect(second.proposedPlans).toEqual([
    {
      id: "plan:thread-1:turn:import-turn:thread-1:claude:u3",
      turnId: "import-turn:thread-1:claude:u3",
      planMarkdown: "# Plan",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    },
  ]);
  expect(second.messages.map((message) => message.text)).toEqual(["Plan next", "Plan ready"]);

  expectDenseTimestampsFrom(turns, IMPORTED_AT);
});

it("marks Claude tool calls with erroring results as failed", () => {
  const turns = mapClaudeSessionTurns({
    threadId: asThreadId("thread-1"),
    importedAt: IMPORTED_AT,
    messages: [
      claudeMessage({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "Run it" },
      }),
      claudeMessage({
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "x" } }],
        },
      }),
      claudeMessage({
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "denied", is_error: true },
          ],
        },
      }),
    ],
  });

  expect(turns.length).toBe(1);
  const activity = turns[0]!.activities[0]!;
  expect(activity.kind).toBe("tool.completed");
  expect(activity.payload).toMatchObject({
    itemType: "file_change",
    status: "failed",
    title: "File change",
  });
});

it("keeps Claude activities in transcript order when thinking follows a tool call", () => {
  const turns = mapClaudeSessionTurns({
    threadId: asThreadId("thread-1"),
    importedAt: IMPORTED_AT,
    messages: [
      claudeMessage({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "Run it" },
      }),
      claudeMessage({
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
            { type: "thinking", thinking: "Now interpret" },
          ],
        },
      }),
      claudeMessage({
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
      }),
    ],
  });

  expect(turns.length).toBe(1);
  expect(turns[0]!.activities.map((activity) => activity.kind)).toEqual([
    "tool.completed",
    "task.progress",
  ]);
});

it("produces identical output when mapping the same snapshots twice", () => {
  const codexInput = {
    threadId: asThreadId("thread-1"),
    importedAt: IMPORTED_AT,
    turns: [
      {
        id: asTurnId("turn-a"),
        items: [
          { type: "userMessage", text: "Hi" },
          { type: "commandExecution", id: "c1", command: "ls" },
          { type: "agentMessage", text: "Done" },
        ],
      },
    ],
  } as const;
  expect(mapCodexSnapshotTurns(codexInput)).toEqual(mapCodexSnapshotTurns(codexInput));

  const claudeInput = {
    threadId: asThreadId("thread-1"),
    importedAt: IMPORTED_AT,
    messages: [
      claudeMessage({ type: "user", uuid: "u1", message: { role: "user", content: "Hi" } }),
      claudeMessage({
        type: "assistant",
        uuid: "a1",
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      }),
    ],
  } as const;
  expect(mapClaudeSessionTurns(claudeInput)).toEqual(mapClaudeSessionTurns(claudeInput));
});
