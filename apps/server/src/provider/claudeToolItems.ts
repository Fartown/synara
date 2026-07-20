// FILE: claudeToolItems.ts
// Purpose: Pure Claude tool classification and lifecycle payload helpers shared by the
//   live adapter (streamed tool_use blocks) and the external-session history import
//   (persisted session messages).
// Layer: Provider mapping helpers
// Exports: classifyToolItemType, isReadOnlyToolName, classifyRequestType,
//   summarizeToolRequest, isClientSurfacedClaudeTool, toolLifecycleEventData,
//   subagentReceiverData, CLAUDE_WORKER_EFFORT_TIERS, claudeWorkerEffortFromSubagentType,
//   titleForTool, extractExitPlanModePlan.

import type { CanonicalItemType, CanonicalRequestType } from "@synara/contracts";

export function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized === "todowrite" ||
    normalized.includes("todo") ||
    normalized === "taskcreate" ||
    normalized === "taskupdate" ||
    normalized === "taskget" ||
    normalized === "tasklist"
  ) {
    return "plan";
  }
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  const serialized = JSON.stringify(input);
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

// Tools whose result is surfaced through a dedicated runtime channel — AskUserQuestion
// via the user-input request flow, ExitPlanMode via the proposed-plan flow — must NOT
// also emit a generic tool-call lifecycle item, or the timeline shows a redundant
// "ToolName: {json}" row alongside the real interaction surface.
export function isClientSurfacedClaudeTool(toolName: string): boolean {
  return toolName === "AskUserQuestion" || toolName === "ExitPlanMode";
}

export interface ClaudeToolLifecycleIdentity {
  readonly itemId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

// Stable per-call identity stamped on every tool lifecycle event's data so the client
// can collapse started/updated/completed (and dedupe parallel calls) by tool-call id
// instead of relying on row adjacency. Mirrors the shape other adapters emit (Pi/Grok).
export function toolLifecycleEventData(
  tool: ClaudeToolLifecycleIdentity,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    toolCallId: tool.itemId,
    callId: tool.itemId,
    toolName: tool.toolName,
    input: tool.input,
    ...(tool.toolName === "Task" || tool.toolName === "Agent" ? subagentReceiverData(tool) : {}),
    ...extra,
  };
}

export const CLAUDE_WORKER_EFFORT_TIERS = ["low", "medium", "high", "xhigh"] as const;

export function claudeWorkerEffortFromSubagentType(subagentType: string): string | undefined {
  return (CLAUDE_WORKER_EFFORT_TIERS as readonly string[]).find(
    (tier) => subagentType === `worker-${tier}`,
  );
}

// Receiver identity for the shared subagent-thread machinery: ingestion spawns a
// child thread per receiverThreadId on collab_agent_tool_call items and titles it
// from these hints (see extractSubagentIdentityHints in @synara/shared/subagents).
export function subagentReceiverData(
  tool: Pick<ClaudeToolLifecycleIdentity, "itemId" | "input">,
): Record<string, unknown> {
  const {
    subagent_type: subagentType,
    description,
    prompt,
    model,
    run_in_background: runInBackground,
  } = tool.input;
  const effort =
    typeof subagentType === "string" ? claudeWorkerEffortFromSubagentType(subagentType) : undefined;
  return {
    receiverThreadId: tool.itemId,
    ...(typeof subagentType === "string" ? { agentType: subagentType } : {}),
    ...(typeof description === "string" ? { nickname: description } : {}),
    ...(typeof prompt === "string" ? { prompt } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(runInBackground === true ? { background: true } : {}),
  };
}

export function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "plan":
      return "Plan";
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}
