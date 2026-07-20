// FILE: importedThreadHistory.ts
// Purpose: Maps provider-native transcript snapshots into structured imported turns —
//   ordered messages, tool/reasoning activities, and proposed plans with turn ids — for
//   full-fidelity external session import (thread.history.import).
// Layer: Orchestration import mapping
// Exports: mapCodexSnapshotTurns, mapClaudeSessionTurns.
//
// Fidelity notes:
// - Activities reuse the live shapes the web switches on: codex/claude tool calls become
//   "tool.completed" rows with { itemType, status, title, detail, data } payloads and
//   reasoning/thinking becomes "task.progress" "Reasoning trace" rows, mirroring
//   ProviderRuntimeIngestion output for live turns.
// - Ids are deterministic (positional or provider-native) so re-importing the same
//   session upserts the same projection rows instead of duplicating them. Chat message
//   ids intentionally match the legacy text-only import scheme so rows imported by
//   thread.messages.import upgrade in place.
// - Historical turns are always "completed": neither the Codex thread/read snapshot nor
//   the Claude SDK SessionMessage list carries terminal turn outcomes, and they carry
//   no workspace snapshots, so no checkpoint/diff data is produced.

import type { SessionMessage as ClaudeSessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  EventId,
  isToolLifecycleItemType,
  MessageId,
  TurnId,
  type CanonicalItemType,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type ThreadId,
  type ThreadImportedTurn,
  type ThreadImportedTurnMessage,
} from "@synara/contracts";

import {
  itemDetail as codexItemDetail,
  itemStatus as codexItemStatus,
  itemTitle as codexItemTitle,
  reasoningSummaryDetail as codexReasoningSummaryDetail,
  toCanonicalItemType as toCanonicalCodexItemType,
} from "../provider/codexThreadItems.ts";
import {
  classifyToolItemType,
  extractExitPlanModePlan,
  isClientSurfacedClaudeTool,
  summarizeToolRequest,
  titleForTool as claudeTitleForTool,
  toolLifecycleEventData,
} from "../provider/claudeToolItems.ts";
import {
  boundActivityData,
  MAX_ACTIVITY_DATA_STRING_CHARS,
  truncateDetail,
} from "./Layers/ProviderRuntimeIngestion.ts";
import {
  readClaudeSessionMessageText,
  readCodexSnapshotMessageText,
} from "./importedThreadMessages.ts";

type ActivityPayload = OrchestrationThreadActivity["payload"];

// The web merges messages, plans, and work entries into one timeline ordered by
// createdAt, so imported entries get a synthetic but deterministic +1ms cadence in
// original transcript order. Live turns always land later in real time and therefore
// keep sorting after imported history.
function makeImportedClock(importedAt: string): () => string {
  const base = Date.parse(importedAt);
  let offset = 0;
  return () => {
    if (!Number.isFinite(base)) {
      return importedAt;
    }
    const timestamp = new Date(base + offset).toISOString();
    offset += 1;
    return timestamp;
  };
}

function padItemIndex(value: number): string {
  return String(value).padStart(6, "0");
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${String(threadId)}:turn:${String(turnId)}`;
}

export function mapCodexSnapshotTurns(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<{
    readonly id: TurnId;
    readonly items: ReadonlyArray<unknown>;
  }>;
}): ReadonlyArray<ThreadImportedTurn> {
  const nextTimestamp = makeImportedClock(input.importedAt);
  return input.turns.flatMap((turn, turnIndex) => {
    const turnId = turn.id;
    const messages: ThreadImportedTurnMessage[] = [];
    const activities: OrchestrationThreadActivity[] = [];
    const proposedPlans: OrchestrationProposedPlan[] = [];
    let userMessageId: MessageId | null = null;
    let assistantMessageId: MessageId | null = null;
    let firstEntryAt: string | null = null;
    let lastEntryAt: string | null = null;
    const stampEntry = () => {
      const timestamp = nextTimestamp();
      firstEntryAt ??= timestamp;
      lastEntryAt = timestamp;
      return timestamp;
    };

    turn.items.forEach((item, itemIndex) => {
      if (!item || typeof item !== "object") {
        return;
      }
      const source = item as Record<string, unknown>;
      const itemType = toCanonicalCodexItemType(source.type ?? source.kind);
      const toolCallId =
        typeof source.id === "string" && source.id.trim().length > 0
          ? source.id
          : `${turnIndex}:${itemIndex}`;

      if (itemType === "user_message" || itemType === "assistant_message") {
        const text = readCodexSnapshotMessageText(source);
        if (text.length === 0) {
          return;
        }
        const messageId = MessageId.makeUnsafe(
          `import:${String(input.threadId)}:${turnIndex}:${itemIndex}`,
        );
        const createdAt = stampEntry();
        messages.push({
          messageId,
          role: itemType === "user_message" ? "user" : "assistant",
          text,
          createdAt,
          updatedAt: createdAt,
        });
        if (itemType === "user_message") {
          userMessageId ??= messageId;
        } else {
          assistantMessageId = messageId;
        }
        return;
      }

      if (itemType === "reasoning") {
        const detail = codexReasoningSummaryDetail(source);
        if (detail === undefined || detail.trim().length === 0) {
          return;
        }
        activities.push({
          id: EventId.makeUnsafe(
            `import-activity:${String(input.threadId)}:${padItemIndex(turnIndex)}:${padItemIndex(itemIndex)}`,
          ),
          tone: "tool",
          kind: "task.progress",
          summary: "Reasoning trace",
          payload: {
            status: codexItemStatus("item.completed", source.status) ?? "completed",
            detail: truncateDetail(detail, MAX_ACTIVITY_DATA_STRING_CHARS),
            data: { toolCallId },
          } as ActivityPayload,
          turnId,
          createdAt: stampEntry(),
        });
        return;
      }

      if (itemType === "plan") {
        const planMarkdown = codexItemDetail(source, {});
        if (planMarkdown === undefined) {
          return;
        }
        const createdAt = stampEntry();
        proposedPlans.push({
          id: proposedPlanIdForTurn(input.threadId, turnId),
          turnId,
          planMarkdown,
          implementedAt: null,
          implementationThreadId: null,
          createdAt,
          updatedAt: createdAt,
        });
        return;
      }

      if (!isToolLifecycleItemType(itemType)) {
        return;
      }
      const title = codexItemTitle(itemType);
      const detail = codexItemDetail(source, {});
      activities.push({
        id: EventId.makeUnsafe(
          `import-activity:${String(input.threadId)}:${padItemIndex(turnIndex)}:${padItemIndex(itemIndex)}`,
        ),
        tone: "tool",
        kind: "tool.completed",
        summary: title ?? "Tool",
        payload: {
          itemType,
          status: codexItemStatus("item.completed", source.status) ?? "completed",
          ...(title ? { title } : {}),
          ...(detail ? { detail: truncateDetail(detail) } : {}),
          data: boundActivityData({ toolCallId, item: source }),
        } as ActivityPayload,
        turnId,
        createdAt: stampEntry(),
      });
    });

    if (messages.length === 0 && activities.length === 0 && proposedPlans.length === 0) {
      return [];
    }
    const turnCreatedAt = firstEntryAt ?? nextTimestamp();
    return [
      {
        turnId,
        state: "completed" as const,
        userMessageId,
        assistantMessageId,
        requestedAt: turnCreatedAt,
        startedAt: turnCreatedAt,
        completedAt: lastEntryAt ?? turnCreatedAt,
        messages,
        activities,
        proposedPlans,
      },
    ];
  });
}

interface ClaudePendingToolActivity {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail: string;
  readonly input: Record<string, unknown>;
  readonly createdAt: string;
  result?: {
    readonly block: Record<string, unknown>;
    readonly isError: boolean;
  };
}

function readClaudeContentBlocks(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!value || typeof value !== "object") {
    return [];
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((entry) =>
    entry && typeof entry === "object" ? [entry as Record<string, unknown>] : [],
  );
}

export function mapClaudeSessionTurns(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ClaudeSessionMessage>;
}): ReadonlyArray<ThreadImportedTurn> {
  const nextTimestamp = makeImportedClock(input.importedAt);
  const turns: ThreadImportedTurn[] = [];

  // Accumulates one turn: a genuine user prompt plus every assistant/tool row that
  // follows it, until the next prompt. Subagent transcript rows
  // (parent_tool_use_id !== null) are excluded — they belong to collab tool-call
  // sub-transcripts, which the live path renders through dedicated channels.
  let promptUuid: string | null = null;
  let userMessageId: MessageId | null = null;
  let assistantMessageId: MessageId | null = null;
  let firstEntryAt: string | null = null;
  let lastEntryAt: string | null = null;
  let turnMessages: ThreadImportedTurnMessage[] = [];
  let turnActivities: OrchestrationThreadActivity[] = [];
  let turnProposedPlans: OrchestrationProposedPlan[] = [];
  let pendingTools: ClaudePendingToolActivity[] = [];

  const stampEntry = () => {
    const timestamp = nextTimestamp();
    firstEntryAt ??= timestamp;
    lastEntryAt = timestamp;
    return timestamp;
  };

  const resetTurn = () => {
    promptUuid = null;
    userMessageId = null;
    assistantMessageId = null;
    firstEntryAt = null;
    lastEntryAt = null;
    turnMessages = [];
    turnActivities = [];
    turnProposedPlans = [];
    pendingTools = [];
  };

  const closeTurn = () => {
    const hasContent =
      turnMessages.length > 0 || turnActivities.length > 0 || turnProposedPlans.length > 0;
    if (!hasContent || promptUuid === null) {
      resetTurn();
      return;
    }
    const turnId = TurnId.makeUnsafe(`import-turn:${String(input.threadId)}:claude:${promptUuid}`);
    // Tool results arrive after the tool_use blocks that opened them; finalize the
    // lifecycle rows now that the turn (and therefore every result) is complete.
    for (const tool of pendingTools) {
      turnActivities.push({
        id: EventId.makeUnsafe(`import-activity:${String(input.threadId)}:claude:${tool.itemId}`),
        tone: "tool",
        kind: "tool.completed",
        summary: tool.title,
        payload: {
          itemType: tool.itemType,
          status: tool.result?.isError === true ? "failed" : "completed",
          title: tool.title,
          ...(tool.detail.length > 0 ? { detail: truncateDetail(tool.detail) } : {}),
          data: toolLifecycleEventData(
            tool,
            tool.result !== undefined ? { result: tool.result.block } : undefined,
          ),
        } as ActivityPayload,
        turnId,
        createdAt: tool.createdAt,
      });
    }
    // Tool rows were appended at close time, after any later thinking rows; restore
    // encounter order. createdAt values are unique +1ms stamps in transcript order.
    turnActivities.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const turnCreatedAt = firstEntryAt ?? nextTimestamp();
    turns.push({
      turnId,
      state: "completed" as const,
      userMessageId,
      assistantMessageId,
      requestedAt: turnCreatedAt,
      startedAt: turnCreatedAt,
      completedAt: lastEntryAt ?? turnCreatedAt,
      messages: turnMessages,
      activities: turnActivities,
      proposedPlans: turnProposedPlans,
    });
    resetTurn();
  };

  input.messages.forEach((message, messageIndex) => {
    if (message.parent_tool_use_id !== null) {
      return;
    }

    if (message.type === "user") {
      const text = readClaudeSessionMessageText(message.message).trim();
      if (text.length > 0) {
        // A genuine user prompt opens a new turn.
        closeTurn();
        promptUuid = message.uuid;
        const messageId = MessageId.makeUnsafe(
          `import:${String(input.threadId)}:claude:${messageIndex}:${message.uuid}`,
        );
        const createdAt = stampEntry();
        turnMessages.push({
          messageId,
          role: "user",
          text,
          createdAt,
          updatedAt: createdAt,
        });
        userMessageId = messageId;
        return;
      }

      // Tool-result carrier: pair each result with the tool_use that requested it.
      for (const block of readClaudeContentBlocks(message.message)) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
          continue;
        }
        const pendingTool = pendingTools.find((tool) => tool.itemId === block.tool_use_id);
        if (!pendingTool) {
          continue;
        }
        pendingTool.result = {
          block,
          isError: block.is_error === true,
        };
      }
      return;
    }

    if (message.type !== "assistant") {
      return;
    }
    if (promptUuid === null) {
      // Assistant rows before the first user prompt (e.g. restored session heads)
      // have no turn to attach to.
      return;
    }

    const turnId = TurnId.makeUnsafe(`import-turn:${String(input.threadId)}:claude:${promptUuid}`);
    const blocks = readClaudeContentBlocks(message.message);
    const text = readClaudeSessionMessageText(message.message).trim();
    if (text.length > 0) {
      const messageId = MessageId.makeUnsafe(
        `import:${String(input.threadId)}:claude:${messageIndex}:${message.uuid}`,
      );
      const createdAt = stampEntry();
      turnMessages.push({
        messageId,
        role: "assistant",
        text,
        createdAt,
        updatedAt: createdAt,
      });
      assistantMessageId = messageId;
    }

    blocks.forEach((block, blockIndex) => {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        const thinking = block.thinking.trim();
        if (thinking.length === 0) {
          return;
        }
        turnActivities.push({
          id: EventId.makeUnsafe(
            `import-activity:${String(input.threadId)}:claude:${padItemIndex(messageIndex)}:${padItemIndex(blockIndex)}`,
          ),
          tone: "tool",
          kind: "task.progress",
          summary: "Reasoning trace",
          payload: {
            status: "completed",
            detail: truncateDetail(thinking, MAX_ACTIVITY_DATA_STRING_CHARS),
            data: { toolCallId: `thinking:${message.uuid}:${blockIndex}` },
          } as ActivityPayload,
          turnId,
          createdAt: stampEntry(),
        });
        return;
      }

      const isToolUseBlock =
        block.type === "tool_use" ||
        block.type === "server_tool_use" ||
        block.type === "mcp_tool_use";
      if (!isToolUseBlock || typeof block.name !== "string") {
        return;
      }
      const toolName = block.name;
      const toolInput =
        block.input && typeof block.input === "object" && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {};

      if (isClientSurfacedClaudeTool(toolName)) {
        // Matches the live path: AskUserQuestion renders via the user-input channel and
        // ExitPlanMode via the proposed-plan channel, never as a generic tool row.
        if (toolName === "ExitPlanMode") {
          const planMarkdown = extractExitPlanModePlan(toolInput);
          if (planMarkdown !== undefined) {
            const createdAt = stampEntry();
            turnProposedPlans.push({
              id: proposedPlanIdForTurn(input.threadId, turnId),
              turnId,
              planMarkdown,
              implementedAt: null,
              implementationThreadId: null,
              createdAt,
              updatedAt: createdAt,
            });
          }
        }
        return;
      }

      const itemType = classifyToolItemType(toolName);
      pendingTools.push({
        itemId:
          typeof block.id === "string" && block.id.trim().length > 0
            ? block.id
            : `import-tool:${padItemIndex(messageIndex)}:${padItemIndex(blockIndex)}`,
        itemType,
        toolName,
        title: claudeTitleForTool(itemType),
        detail: summarizeToolRequest(toolName, toolInput),
        input: toolInput,
        createdAt: stampEntry(),
      });
    });
  });
  closeTurn();

  return turns;
}
