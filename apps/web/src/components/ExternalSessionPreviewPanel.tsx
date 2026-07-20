// FILE: ExternalSessionPreviewPanel.tsx
// Purpose: Read-only preview of an UNIMPORTED external Codex/Claude session, hosted in
//   the MAIN content area by the chat layout (in place of the route Outlet while a
//   preview selection is active — see externalSessionPreviewStore.ts). Header (provider
//   icon, title, folder/cwd, updated time, source badge, primary Import CTA, close) +
//   the session's latest turns (server caps at 30, with a truncation notice) as a
//   read-only timeline: user bubbles and assistant markdown, compact one-line activity
//   rows, plan cards. Loading shows an inline "Loading session…" skeleton; failures
//   show an inline error with retry. Switching the selection swaps the react-query key,
//   so the panel always renders the LATEST selected session — older in-flight queries
//   can never surface over newer content.
// Layer: Web main-area feature component
//
// Transcript rendering choice (unchanged from the drawer version): the live
// MessagesTimeline is not reusable here (it needs ~40 props bound to live thread
// projection state), so the timeline reuses the same extractors the thread view is
// built on — ChatMarkdown for messages and session-logic's deriveWorkLogEntries for
// activities. The server maps previews with the import mappers, so the shapes are
// identical to what an imported thread would show.

import type { OrchestrationProposedPlan, ThreadImportedTurnMessage } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  BotIcon,
  FolderIcon,
  HammerIcon,
  PencilIcon,
  RefreshCwIcon,
  SearchIcon,
  SkillCubeIcon,
  TerminalIcon,
  WebSearchIcon,
  XIcon,
  type LucideIcon,
} from "~/lib/icons";
import {
  externalSessionPreviewQueryOptions,
  externalSessionPreviewTruncationNotice,
} from "../lib/externalSessions";
import { formatRelativeTime } from "../lib/relativeTime";
import { deriveWorkLogEntries, type WorkLogEntry } from "../session-logic";
import {
  useExternalSessionPreviewStore,
  type ExternalSessionPreviewSelection,
} from "../externalSessionPreviewStore";
import { useImportExternalSession } from "../hooks/useImportExternalSession";
import ChatMarkdown from "./ChatMarkdown";
import { externalSessionDisplayTitle } from "./externalSessionsGrouping";
import { ProviderIcon } from "./ProviderIcon";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { toastManager } from "./ui/toast";

type PreviewTimelineEntry =
  | {
      readonly kind: "message";
      readonly createdAt: string;
      readonly message: ThreadImportedTurnMessage;
    }
  | { readonly kind: "activity"; readonly createdAt: string; readonly entry: WorkLogEntry }
  | { readonly kind: "plan"; readonly createdAt: string; readonly plan: OrchestrationProposedPlan };

function previewWorkEntryIcon(entry: WorkLogEntry): LucideIcon {
  if (entry.tone === "thinking") return BotIcon;
  if (entry.itemType === "command_execution" || entry.command) return TerminalIcon;
  if (entry.itemType === "file_change") return PencilIcon;
  if (entry.itemType === "web_search") return WebSearchIcon;
  if (entry.itemType === "mcp_tool_call") return SkillCubeIcon;
  if (entry.toolName === "Read" || entry.itemType === "image_view") return SearchIcon;
  return HammerIcon;
}

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

export function ExternalSessionPreviewPanel({
  selection,
}: {
  readonly selection: ExternalSessionPreviewSelection;
}) {
  const { session, project } = selection;
  const closePreview = useExternalSessionPreviewStore((state) => state.closePreview);
  const importExternalSession = useImportExternalSession();
  const [isImporting, setIsImporting] = useState(false);

  // Keyed per provider+externalId: switching the selection swaps the key, so this query
  // always tracks the latest selected session. The panel unmounts when the preview
  // closes, which also stops the query.
  const previewQuery = useQuery(
    externalSessionPreviewQueryOptions({
      provider: session.provider,
      externalId: session.externalId,
      cwd: session.cwd,
    }),
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closePreview();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closePreview]);

  const timelineEntries = useMemo<PreviewTimelineEntry[]>(() => {
    const turns = previewQuery.data?.turns;
    if (!turns) {
      return [];
    }
    const entries: PreviewTimelineEntry[] = [];
    for (const turn of turns) {
      for (const message of turn.messages) {
        entries.push({ kind: "message", createdAt: message.createdAt, message });
      }
      for (const entry of deriveWorkLogEntries(turn.activities, undefined)) {
        entries.push({ kind: "activity", createdAt: entry.createdAt, entry });
      }
      for (const plan of turn.proposedPlans) {
        entries.push({ kind: "plan", createdAt: plan.createdAt, plan });
      }
    }
    // Imported rows carry a synthetic +1ms clock in original transcript order.
    entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return entries;
  }, [previewQuery.data]);

  const truncationNotice = previewQuery.data
    ? externalSessionPreviewTruncationNotice({
        shownTurns: previewQuery.data.turns.length,
        totalTurns: previewQuery.data.totalTurns,
      })
    : null;

  const handleImport = () => {
    if (isImporting) {
      return;
    }
    setIsImporting(true);
    // On success the flow navigates to the imported thread, and the layout's
    // close-on-navigate rule closes this preview. On failure the preview stays open.
    void importExternalSession(session, project)
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Failed to import session",
          description: errorDescription(error),
        });
      })
      .finally(() => setIsImporting(false));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex items-start gap-3 border-b border-border/50 px-5 pt-4 pb-3">
        <ProviderIcon provider={session.provider} className="mt-1 size-4.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[15px] font-medium text-foreground"
            title={session.title ?? session.externalId}
          >
            {externalSessionDisplayTitle(session)}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/70">
            {session.cwd ? (
              <>
                <FolderIcon className="size-3.5 shrink-0" />
                <span className="truncate" title={session.cwd}>
                  {session.cwd}
                </span>
              </>
            ) : (
              <span className="truncate" title={session.externalId}>
                {session.externalId}
              </span>
            )}
            {session.updatedAt ? (
              <span className="shrink-0 tabular-nums text-muted-foreground/48">
                · {formatRelativeTime(session.updatedAt)}
              </span>
            ) : null}
            {session.source ? (
              <span className="shrink-0 rounded-md bg-muted/60 px-1.5 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70">
                {session.source}
              </span>
            ) : null}
          </div>
        </div>
        <Button size="sm" disabled={isImporting} onClick={handleImport}>
          {isImporting ? "Importing…" : "Import"}
        </Button>
        <IconButton label="Close preview" onClick={closePreview} className="shrink-0">
          <XIcon className="size-4" />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {truncationNotice ? (
          <div className="border-b border-border/40 bg-muted/30 px-5 py-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70">
            {truncationNotice}
          </div>
        ) : null}

        {previewQuery.isPending ? (
          <div className="px-5 py-5" aria-label="Loading session preview">
            <div className="mb-4 flex items-center gap-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/60">
              <RefreshCwIcon className="size-3.5 animate-spin" aria-label="Loading" />
              Loading session…
            </div>
            <div className="space-y-3">
              <div className="ml-auto h-8 w-3/5 animate-pulse rounded-xl bg-muted/50" />
              <div className="h-3 w-4/5 animate-pulse rounded-full bg-muted/40" />
              <div className="h-3 w-2/5 animate-pulse rounded-full bg-muted/30" />
              <div className="ml-auto h-8 w-2/5 animate-pulse rounded-xl bg-muted/50" />
              <div className="h-3 w-3/5 animate-pulse rounded-full bg-muted/40" />
            </div>
          </div>
        ) : previewQuery.isError ? (
          <div className="mx-5 mt-5 max-w-xl rounded-xl border border-destructive/40 bg-destructive/8 px-3 py-3">
            <div className="text-[length:var(--app-font-size-ui,12px)] font-medium text-foreground">
              Couldn&apos;t load the preview
            </div>
            <div className="mt-1 text-[length:var(--app-font-size-ui-sm,11px)] break-words text-muted-foreground/70">
              {errorDescription(previewQuery.error)}
            </div>
            <Button
              size="xs"
              variant="outline"
              className="mt-2"
              onClick={() => void previewQuery.refetch()}
            >
              <RefreshCwIcon className="size-3" />
              Retry
            </Button>
          </div>
        ) : timelineEntries.length === 0 ? (
          <div className="px-5 py-8 text-center text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">
            No transcript content found in this session.
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-1.5 px-5 py-5">
            {timelineEntries.map((item, index) => {
              if (item.kind === "message") {
                const { message } = item;
                if (message.role === "user") {
                  return (
                    <div
                      key={message.messageId}
                      className="ml-auto max-w-[85%] rounded-2xl bg-[var(--sidebar-accent)] px-3 py-2 text-foreground/90"
                    >
                      <ChatMarkdown
                        text={message.text}
                        cwd={session.cwd ?? undefined}
                        variant="user"
                      />
                    </div>
                  );
                }
                return (
                  <div key={message.messageId} className="max-w-full text-foreground/90">
                    <ChatMarkdown text={message.text} cwd={session.cwd ?? undefined} />
                  </div>
                );
              }
              if (item.kind === "plan") {
                return (
                  <div
                    key={item.plan.id}
                    className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2"
                  >
                    <div className="mb-1 text-[length:var(--app-font-size-ui-xs,10px)] font-medium tracking-wide text-muted-foreground/60 uppercase">
                      Proposed plan
                    </div>
                    <ChatMarkdown text={item.plan.planMarkdown} cwd={session.cwd ?? undefined} />
                  </div>
                );
              }
              const EntryIcon = previewWorkEntryIcon(item.entry);
              return (
                <div
                  key={`${item.entry.id}:${index}`}
                  className="flex items-center gap-2 text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/70"
                  title={item.entry.detail ?? item.entry.label}
                >
                  <EntryIcon className="size-3 shrink-0 text-muted-foreground/55" />
                  <span className="truncate">{item.entry.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
