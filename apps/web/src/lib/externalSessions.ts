// FILE: externalSessions.ts
// Purpose: React-query options for external session discovery (listExternalSessions),
//          read-only transcript previews (previewExternalSession), and per-thread
//          external session lookup (getThreadExternalSession).
// Layer: Web transport adapter extension

import type {
  OrchestrationExternalSession,
  OrchestrationExternalSessionProvider,
  OrchestrationImportExternalThreadsItemResult,
  ThreadId,
} from "@synara/contracts";
import { queryOptions } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";
import { shortenExternalSessionId } from "../components/externalSessionsGrouping";

export const externalSessionsQueryKeys = {
  all: ["orchestration", "externalSessions"] as const,
  list: () => [...externalSessionsQueryKeys.all, "list"] as const,
  preview: (provider: OrchestrationExternalSessionProvider, externalId: string) =>
    [...externalSessionsQueryKeys.all, "preview", provider, externalId] as const,
  thread: (threadId: ThreadId | null) =>
    [...externalSessionsQueryKeys.all, "thread", threadId ?? null] as const,
};

const EXTERNAL_SESSIONS_LIST_STALE_TIME_MS = 30_000;

// Lazy by design: the sidebar passes `enabled` only once the section has been expanded,
// so discovery never runs on app boot. The server additionally caches scans for 60s, so
// a short staleTime is enough to avoid refetch churn on collapse/re-expand.
export function externalSessionsListQueryOptions(input: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: externalSessionsQueryKeys.list(),
    queryFn: async () => {
      return ensureNativeApi().orchestration.listExternalSessions();
    },
    enabled: input.enabled ?? true,
    staleTime: EXTERNAL_SESSIONS_LIST_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

// The external-session binding for a thread is stable once written, so cache it for the
// life of the query; callers refetch explicitly when the session flips to ready (the
// binding can be created by the first turn, after this query first ran).
export function threadExternalSessionQueryOptions(input: { threadId: ThreadId | null }) {
  const threadId = input.threadId;
  return queryOptions({
    queryKey: externalSessionsQueryKeys.thread(threadId),
    queryFn: async () => {
      if (!threadId) {
        return null;
      }
      return ensureNativeApi().orchestration.getThreadExternalSession({
        threadId,
      });
    },
    enabled: threadId !== null,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

const EXTERNAL_SESSION_PREVIEW_STALE_TIME_MS = 60_000;

// Read-only transcript preview for an unimported session. The server mirrors this
// staleness window with its own 60s in-memory cache, so browsing back and forth between
// sessions never re-reads provider-native history.
export function externalSessionPreviewQueryOptions(input: {
  provider: OrchestrationExternalSessionProvider;
  externalId: string;
  cwd?: string | null;
  enabled?: boolean;
}) {
  const cwd = input.cwd?.trim() ? input.cwd.trim() : undefined;
  return queryOptions({
    queryKey: externalSessionsQueryKeys.preview(input.provider, input.externalId),
    queryFn: async () => {
      return ensureNativeApi().orchestration.previewExternalSession({
        provider: input.provider,
        externalId: input.externalId,
        ...(cwd ? { cwd } : {}),
      });
    },
    enabled: input.enabled ?? true,
    staleTime: EXTERNAL_SESSION_PREVIEW_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

// Top-of-drawer notice shown when the server truncated the preview to the latest turns.
// Returns null when the full history fits, so the caller can skip the notice entirely.
export function externalSessionPreviewTruncationNotice(input: {
  shownTurns: number;
  totalTurns: number;
}): string | null {
  if (input.totalTurns <= input.shownTurns) {
    return null;
  }
  return `Showing the latest ${input.shownTurns} of ${input.totalTurns} ${input.totalTurns === 1 ? "turn" : "turns"}.`;
}

/** Unimported sessions in a discovery group — the "Import all" count badge. */
export function countUnimportedExternalSessions(
  sessions: ReadonlyArray<Pick<OrchestrationExternalSession, "importedThreadId">>,
): number {
  return sessions.filter((session) => !session.importedThreadId).length;
}

/**
 * "auto" marker visibility for a discovery group header. Server-side, auto-import
 * covers each normalized cwd that has ≥1 live imported session (and only while the
 * opt-in setting is on). A group can mix several cwds (project groups collect
 * subdirectory sessions), so the group-level rule is the honest approximation: the
 * group is marked when at least one session in it is imported — that session's exact
 * folder is auto-import-covered, and new sessions there appear on their own.
 */
export function externalSessionGroupAutoImportCovered(input: {
  readonly autoImportEnabled: boolean;
  readonly sessions: ReadonlyArray<Pick<OrchestrationExternalSession, "importedThreadId">>;
}): boolean {
  return (
    input.autoImportEnabled && input.sessions.some((session) => session.importedThreadId != null)
  );
}

export interface ExternalSessionBatchSummary {
  readonly imported: number;
  readonly alreadyImported: number;
  readonly failed: number;
  readonly failures: ReadonlyArray<{ readonly externalId: string; readonly error: string }>;
}

export function summarizeExternalSessionBatchResults(
  results: ReadonlyArray<OrchestrationImportExternalThreadsItemResult>,
): ExternalSessionBatchSummary {
  let imported = 0;
  let alreadyImported = 0;
  const failures: Array<{ externalId: string; error: string }> = [];
  for (const result of results) {
    if (result.status === "imported") {
      imported += 1;
    } else if (result.status === "alreadyImported") {
      alreadyImported += 1;
    } else {
      failures.push({
        externalId: result.externalId,
        error: result.error ?? "Import failed.",
      });
    }
  }
  return { imported, alreadyImported, failed: failures.length, failures };
}

// Completion toast title for a batch import, e.g. "Imported 3, skipped 1 already-imported, 2 failed".
export function externalSessionBatchToastTitle(summary: ExternalSessionBatchSummary): string {
  const parts = [`Imported ${summary.imported}`];
  if (summary.alreadyImported > 0) {
    parts.push(`skipped ${summary.alreadyImported} already-imported`);
  }
  if (summary.failed > 0) {
    parts.push(`${summary.failed} failed`);
  }
  return parts.join(", ");
}

const BATCH_TOAST_MAX_FAILURE_REASONS = 3;

// Failure reasons for the toast description, one per line, capped so a large failed
// batch stays readable.
export function externalSessionBatchToastDescription(
  summary: ExternalSessionBatchSummary,
): string | undefined {
  if (summary.failures.length === 0) {
    return undefined;
  }
  const lines = summary.failures
    .slice(0, BATCH_TOAST_MAX_FAILURE_REASONS)
    .map((failure) => `${shortenExternalSessionId(failure.externalId)}: ${failure.error}`);
  const remaining = summary.failures.length - lines.length;
  if (remaining > 0) {
    lines.push(`+${remaining} more`);
  }
  return lines.join("\n");
}
