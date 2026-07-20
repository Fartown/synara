// FILE: SidebarDiscoveredSessions.tsx
// Purpose: "Discovered sessions" sidebar section — external Codex/Claude CLI sessions found
//          on this machine, grouped by the Synara project their cwd belongs to, with
//          one-click import (creating a project first for unknown locations), quick
//          navigation and on-demand history resync for sessions that are already imported.
//          Clicking an UNIMPORTED row opens a read-only transcript preview hosted in the
//          MAIN content area (ExternalSessionPreviewPanel via externalSessionPreviewStore)
//          without importing the session.
// Layer: Sidebar feature component (data fetching + rows); grouping logic lives in
//        externalSessionsGrouping.ts and the import flow is owned by Sidebar.tsx.

import type {
  OrchestrationExternalSession,
  OrchestrationImportExternalThreadsResult,
  ThreadId,
} from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useState } from "react";
import { IoFilter } from "react-icons/io5";
import { TbArrowsDiagonal, TbArrowsDiagonalMinimize2 } from "react-icons/tb";

import { DownloadIcon, RefreshCwIcon } from "~/lib/icons";
import {
  DISCLOSURE_INNER_CLASS,
  disclosureContentClassName,
  disclosureShellClassName,
} from "~/lib/disclosureMotion";
import { cn } from "~/lib/utils";
import { showConfirmDialogFallback } from "../confirmDialogFallback";
import { useExternalSessionPreviewStore } from "../externalSessionPreviewStore";
import {
  countUnimportedExternalSessions,
  externalSessionBatchToastDescription,
  externalSessionBatchToastTitle,
  externalSessionGroupAutoImportCovered,
  externalSessionsListQueryOptions,
  externalSessionsQueryKeys,
  summarizeExternalSessionBatchResults,
} from "../lib/externalSessions";
import { serverSettingsQueryOptions } from "../lib/serverReactQuery";
import { formatRelativeTime } from "../lib/relativeTime";
import { ensureNativeApi } from "../nativeApi";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
} from "../sidebarRowStyles";
import type { Project } from "../types";
import { ComposerPickerMenuPopup } from "./chat/ComposerPickerMenuPopup";
import {
  externalSessionDisplayTitle,
  filterExternalSessionGroupsByTitle,
  groupExternalSessionsByProject,
  sortExternalSessionsInGroups,
  type ExternalSessionGroup,
  type ExternalSessionSortOrder,
} from "./externalSessionsGrouping";
import { normalizeSidebarFilterQuery } from "./Sidebar.logic";
import { ProviderIcon } from "./ProviderIcon";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarSectionToolbar } from "./SidebarSectionToolbar";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { Menu, MenuGroup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "./ui/menu";
import { SidebarMenu, SidebarMenuButton } from "./ui/sidebar";
import { toastManager } from "./ui/toast";

const EMPTY_SESSIONS: readonly OrchestrationExternalSession[] = [];

function sessionKey(session: OrchestrationExternalSession): string {
  return `${session.provider}:${session.externalId}`;
}

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

export interface SidebarDiscoveredSessionsProps {
  projects: readonly Project[];
  /** Sidebar title filter (raw input value); rows filter by display title when non-empty. */
  filterQuery?: string;
  /** Navigate to an already-imported thread. */
  onOpenThread: (threadId: ThreadId) => void;
  /**
   * Import one session into `project` (or create a project from its cwd when null) and
   * navigate to the resulting thread. Resolves with the thread that was opened — the
   * existing thread when the server reports the session as already imported. Throws on
   * failure; this component surfaces the error toast.
   */
  onImportSession: (
    session: OrchestrationExternalSession,
    project: Project | null,
  ) => Promise<ThreadId>;
  /**
   * Batch-import a group's unimported sessions ("Import all"). For folder groups
   * (`project` null) the owner creates the project from the group's cwd first. Resolves
   * with the per-item server results; this component surfaces the summary toast and
   * refreshes the discovery list. Throws only for batch-level failures.
   */
  onImportSessionGroup: (
    sessions: readonly OrchestrationExternalSession[],
    project: Project | null,
  ) => Promise<OrchestrationImportExternalThreadsResult>;
}

export const SidebarDiscoveredSessions = memo(function SidebarDiscoveredSessions({
  projects,
  filterQuery = "",
  onOpenThread,
  onImportSession,
  onImportSessionGroup,
}: SidebarDiscoveredSessionsProps) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [pendingImportKey, setPendingImportKey] = useState<string | null>(null);
  const [pendingResyncKey, setPendingResyncKey] = useState<string | null>(null);
  // Preview selection lives in the shared store: the chat layout hosts the preview in
  // the main content area and closes it on any thread navigation.
  const previewSelection = useExternalSessionPreviewStore((state) => state.previewSelection);
  const openPreview = useExternalSessionPreviewStore((state) => state.openPreview);
  // Serialized per panel: one "Import all" batch at a time, keyed by the running group.
  const [batchGroup, setBatchGroup] = useState<{
    readonly key: string;
    readonly total: number;
  } | null>(null);
  // Per-group collapse state; groups default to expanded. Keys match the groupKey
  // derivation below (project id / folder:<cwd> / other-locations).
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroupCollapsed = useCallback((key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Discovery only runs once the section has been expanded (never on app boot); the
  // result is cached by react-query, so re-expanding stays cheap.
  const listQuery = useQuery(externalSessionsListQueryOptions({ enabled: expanded }));
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());
  const autoImportEnabled = serverSettingsQuery.data?.externalSessions.autoImportEnabled ?? false;
  const sessions = listQuery.data?.sessions ?? EMPTY_SESSIONS;
  const groups = useMemo(
    () => groupExternalSessionsByProject(sessions, projects),
    [sessions, projects],
  );
  // Sidebar title filter: rows keep their Imported/Import states as-is; groups left
  // with zero matches are pruned; a no-match filter shows its own hint instead of the
  // "no sessions discovered" empty state.
  const normalizedFilterQuery = normalizeSidebarFilterQuery(filterQuery);
  const isFilteringSessions = normalizedFilterQuery.length > 0;
  const visibleGroups = useMemo(
    () => filterExternalSessionGroupsByTitle(groups, filterQuery),
    [groups, filterQuery],
  );
  // Intra-group ordering (Default = server recency, Created at, Last reply); group
  // order itself is untouched by the sort selector.
  const [sortOrder, setSortOrder] = useState<ExternalSessionSortOrder>("default");
  const sortedVisibleGroups = useMemo(
    () => sortExternalSessionsInGroups(visibleGroups, sortOrder),
    [visibleGroups, sortOrder],
  );
  const matchedSessionCount = useMemo(
    () => visibleGroups.reduce((count, group) => count + group.sessions.length, 0),
    [visibleGroups],
  );

  const handleRefresh = useCallback(async () => {
    if (isRefreshing) {
      return;
    }
    setIsRefreshing(true);
    try {
      const result = await ensureNativeApi().orchestration.listExternalSessions({
        forceRefresh: true,
      });
      queryClient.setQueryData(externalSessionsQueryKeys.list(), result);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to refresh sessions",
        description: errorDescription(error),
      });
    } finally {
      setIsRefreshing(false);
    }
  }, [isRefreshing, queryClient]);

  const handleImport = useCallback(
    async (session: OrchestrationExternalSession, project: Project | null) => {
      // Serialize imports: each one creates a thread (and maybe a project), and parallel
      // clicks would race the same sidebar state.
      if (pendingImportKey !== null) {
        return;
      }
      setPendingImportKey(sessionKey(session));
      try {
        const threadId = await onImportSession(session, project);
        // Mark the row imported locally; the server-side discovery cache can lag up to
        // 60s, so a refetch would flappy back to the un-imported state.
        queryClient.setQueryData(
          externalSessionsQueryKeys.list(),
          (current: { sessions: OrchestrationExternalSession[] } | undefined) =>
            current
              ? {
                  sessions: current.sessions.map((candidate) =>
                    candidate.provider === session.provider &&
                    candidate.externalId === session.externalId
                      ? { ...candidate, importedThreadId: threadId }
                      : candidate,
                  ),
                }
              : current,
        );
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to import session",
          description: errorDescription(error),
        });
      } finally {
        setPendingImportKey(null);
      }
    },
    [onImportSession, pendingImportKey, queryClient],
  );

  const handleResync = useCallback(
    async (session: OrchestrationExternalSession) => {
      const threadId = session.importedThreadId;
      // Serialize resyncs like imports: each one re-reads the provider-native history
      // server-side, and parallel clicks would race the same sidebar state.
      if (!threadId || pendingResyncKey !== null) {
        return;
      }
      setPendingResyncKey(sessionKey(session));
      try {
        await ensureNativeApi().orchestration.resyncExternalThread({ threadId });
        // The imported history upserts through the normal orchestration event flow, so
        // opening the thread shows the refreshed projection without cache surgery.
        onOpenThread(threadId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to resync session",
          description: errorDescription(error),
        });
      } finally {
        setPendingResyncKey(null);
      }
    },
    [onOpenThread, pendingResyncKey],
  );

  // "Import all" per group: confirm, run one serialized batch through the owner's group
  // import flow (folder groups create their project first), summarize per-item results
  // in a toast, and let the invalidated discovery list flip rows to Imported.
  const handleImportGroup = useCallback(
    async (group: ExternalSessionGroup<Project>) => {
      if (group.kind === "other" || batchGroup !== null) {
        return;
      }
      const unimported = group.sessions.filter((session) => !session.importedThreadId);
      if (unimported.length === 0) {
        return;
      }
      const groupKey = group.kind === "project" ? group.project.id : `folder:${group.cwd}`;
      const confirmed = await showConfirmDialogFallback(
        group.kind === "project"
          ? `Import all sessions\nImport ${unimported.length} ${unimported.length === 1 ? "session" : "sessions"} into ${group.project.name}?`
          : `Import all sessions\nCreate a project from ${group.cwd} and import ${unimported.length} ${unimported.length === 1 ? "session" : "sessions"} into it?`,
      );
      if (!confirmed) {
        return;
      }
      setBatchGroup({ key: groupKey, total: unimported.length });
      try {
        const result = await onImportSessionGroup(
          unimported,
          group.kind === "project" ? group.project : null,
        );
        const summary = summarizeExternalSessionBatchResults(result.results);
        toastManager.add({
          type: summary.failed > 0 ? "error" : "success",
          title: externalSessionBatchToastTitle(summary),
          ...(externalSessionBatchToastDescription(summary)
            ? { description: externalSessionBatchToastDescription(summary) }
            : {}),
        });
        // importedThreadId is re-joined server-side on every list call, so a plain
        // refetch flips the imported rows without cache surgery.
        await queryClient.invalidateQueries({ queryKey: externalSessionsQueryKeys.list() });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to import sessions",
          description: errorDescription(error),
        });
      } finally {
        setBatchGroup(null);
      }
    },
    [batchGroup, onImportSessionGroup, queryClient],
  );

  const renderSessionRow = (session: OrchestrationExternalSession, project: Project | null) => {
    const key = sessionKey(session);
    const importedThreadId = session.importedThreadId;
    const isImporting = pendingImportKey === key;
    const isResyncing = pendingResyncKey === key;
    const isPreviewed =
      previewSelection !== null &&
      previewSelection.session.provider === session.provider &&
      previewSelection.session.externalId === session.externalId;
    const displayTitle = externalSessionDisplayTitle(session);

    return (
      <div key={key} className="group/session-row flex items-center gap-1 pr-1.5">
        <SidebarMenuButton
          size="sm"
          className={cn(
            "h-7 min-w-0 flex-1 gap-2 rounded-lg pl-2 text-left font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal",
            importedThreadId
              ? "cursor-pointer text-foreground/89 hover:bg-[var(--sidebar-accent)]"
              : "cursor-pointer text-foreground/75 hover:bg-[var(--sidebar-accent)]",
            isPreviewed && "bg-[var(--sidebar-accent)] text-foreground",
          )}
          title={session.cwd ?? session.externalId}
          onClick={
            importedThreadId
              ? () => {
                  onOpenThread(importedThreadId);
                }
              : () => {
                  // Unimported rows preview the transcript in the main content area
                  // without importing; the row's group project is the import target.
                  openPreview({ session, project });
                }
          }
        >
          <ProviderIcon provider={session.provider} className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
        </SidebarMenuButton>
        {session.updatedAt ? (
          <span className="shrink-0 text-[length:var(--app-font-size-ui-xs,10px)] tabular-nums text-muted-foreground/48">
            {formatRelativeTime(session.updatedAt)}
          </span>
        ) : null}
        <div className="flex shrink-0 items-center gap-1">
          {importedThreadId ? (
            <>
              <button
                type="button"
                disabled={pendingResyncKey !== null}
                className="cursor-pointer rounded-md px-1.5 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground/60 transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground disabled:cursor-default disabled:opacity-40"
                title="Re-read the external session history into this thread"
                onClick={() => void handleResync(session)}
              >
                {isResyncing ? (
                  <RefreshCwIcon className="size-3 animate-spin" aria-label="Resyncing" />
                ) : (
                  "Resync"
                )}
              </button>
              <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/55">
                Imported
              </span>
            </>
          ) : (
            <button
              type="button"
              disabled={pendingImportKey !== null}
              className="cursor-pointer rounded-md px-1.5 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground/60 transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground disabled:cursor-default disabled:opacity-40"
              onClick={() => void handleImport(session, project)}
            >
              {isImporting ? "…" : "Import"}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="group/collapsible">
      <div className="group/project-header relative">
        <SidebarMenuButton
          size="sm"
          aria-expanded={expanded}
          className={cn(
            SIDEBAR_HEADER_ROW_CLASS_NAME,
            SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
            SIDEBAR_ROW_HOVER_CLASS_NAME,
            "cursor-pointer",
          )}
          onClick={() => setExpanded((current) => !current)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setExpanded((current) => !current);
          }}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <span className="truncate font-system-ui text-[length:var(--app-font-size-ui,12px)] font-normal text-muted-foreground/79">
              Discovered sessions
            </span>
            <DisclosureChevron open={expanded} className="text-muted-foreground/79" />
          </div>
        </SidebarMenuButton>
        <SidebarSectionToolbar placement="overlay" revealOnHover>
          {sortedVisibleGroups.length > 1 ? (
            <SidebarIconButton
              icon={
                sortedVisibleGroups.every((group) =>
                  collapsedGroups.has(
                    group.kind === "project"
                      ? group.project.id
                      : group.kind === "folder"
                        ? `folder:${group.cwd}`
                        : "other-locations",
                  ),
                )
                  ? TbArrowsDiagonal
                  : TbArrowsDiagonalMinimize2
              }
              label={
                sortedVisibleGroups.every((group) =>
                  collapsedGroups.has(
                    group.kind === "project"
                      ? group.project.id
                      : group.kind === "folder"
                        ? `folder:${group.cwd}`
                        : "other-locations",
                  ),
                )
                  ? "Expand all groups"
                  : "Collapse all groups"
              }
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const allKeys = sortedVisibleGroups.map((group) =>
                  group.kind === "project"
                    ? group.project.id
                    : group.kind === "folder"
                      ? `folder:${group.cwd}`
                      : "other-locations",
                );
                setCollapsedGroups((current) =>
                  allKeys.every((key) => current.has(key)) ? new Set() : new Set(allKeys),
                );
              }}
              tooltip="Expand or collapse all groups"
              tooltipSide="top"
            />
          ) : null}
          <Menu>
            <SidebarIconButton
              render={<MenuTrigger />}
              icon={IoFilter}
              label="Sort discovered sessions"
              tooltip="Sort discovered sessions"
              tooltipSide="top"
            />
            <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
              <MenuGroup>
                <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
                  Sort sessions
                </div>
                <MenuRadioGroup
                  value={sortOrder}
                  onValueChange={(value) => setSortOrder(value as ExternalSessionSortOrder)}
                >
                  <MenuRadioItem value="default" className="min-h-7 py-1 sm:text-xs">
                    Default
                  </MenuRadioItem>
                  <MenuRadioItem value="created_at" className="min-h-7 py-1 sm:text-xs">
                    Created at
                  </MenuRadioItem>
                  <MenuRadioItem value="last_reply" className="min-h-7 py-1 sm:text-xs">
                    Last reply
                  </MenuRadioItem>
                </MenuRadioGroup>
              </MenuGroup>
            </ComposerPickerMenuPopup>
          </Menu>
          <SidebarIconButton
            icon={RefreshCwIcon}
            label="Refresh discovered sessions"
            iconClassName={cn("size-3.5 shrink-0", isRefreshing && "animate-spin")}
            disabled={isRefreshing}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void handleRefresh();
            }}
            tooltip="Scan for external sessions"
            tooltipSide="top"
          />
        </SidebarSectionToolbar>
      </div>

      <div className={cn(disclosureShellClassName(expanded), "pt-1")}>
        <div className={DISCLOSURE_INNER_CLASS}>
          <SidebarMenu className={cn("gap-1", disclosureContentClassName(expanded))}>
            {listQuery.isPending ? (
              <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">
                Scanning for sessions…
              </div>
            ) : listQuery.isError ? (
              <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">
                Couldn&apos;t load sessions — try the refresh button.
              </div>
            ) : groups.length === 0 ? (
              <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">
                No external sessions found
              </div>
            ) : isFilteringSessions && visibleGroups.length === 0 ? (
              <div className="px-2 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/48">
                No sessions match &apos;{normalizedFilterQuery}&apos;
              </div>
            ) : (
              <>
                {isFilteringSessions ? (
                  <div className="px-2 pt-1 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/55">
                    {matchedSessionCount} {matchedSessionCount === 1 ? "match" : "matches"}
                  </div>
                ) : null}
                {sortedVisibleGroups.map((group) => {
                  const groupKey =
                    group.kind === "project"
                      ? group.project.id
                      : group.kind === "folder"
                        ? `folder:${group.cwd}`
                        : "other-locations";
                  const unimportedCount = countUnimportedExternalSessions(group.sessions);
                  const isBatchingThisGroup = batchGroup?.key === groupKey;
                  const autoImportCovered = externalSessionGroupAutoImportCovered({
                    autoImportEnabled,
                    sessions: group.sessions,
                  });
                  return (
                    <div key={groupKey} className="flex flex-col gap-0.5">
                      <div
                        className="group/group-header flex cursor-pointer items-center gap-1 rounded-md px-2 pt-1 select-none"
                        onClick={() => toggleGroupCollapsed(groupKey)}
                        title={
                          group.kind === "folder"
                            ? group.cwd
                            : collapsedGroups.has(groupKey)
                              ? "Expand"
                              : "Collapse"
                        }
                      >
                        <DisclosureChevron
                          open={!collapsedGroups.has(groupKey)}
                          className="shrink-0 text-muted-foreground/55"
                        />
                        <div className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/55">
                          {group.kind === "project"
                            ? group.project.name
                            : group.kind === "folder"
                              ? group.label
                              : "Other locations"}
                        </div>
                        {group.kind !== "other" && autoImportCovered ? (
                          <span
                            className="shrink-0 rounded-md bg-muted/60 px-1 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/55"
                            title="New sessions in this folder import automatically"
                          >
                            auto
                          </span>
                        ) : null}
                        {group.kind !== "other" && unimportedCount > 0 ? (
                          <button
                            type="button"
                            disabled={batchGroup !== null}
                            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] font-medium text-muted-foreground/60 transition-colors hover:bg-[var(--sidebar-accent)] hover:text-foreground disabled:cursor-default disabled:opacity-40"
                            title={
                              group.kind === "project"
                                ? `Import all ${unimportedCount} sessions into ${group.project.name}`
                                : `Create a project from ${group.cwd} and import all ${unimportedCount} sessions`
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleImportGroup(group);
                            }}
                          >
                            {isBatchingThisGroup ? (
                              <>
                                <RefreshCwIcon
                                  className="size-3 animate-spin"
                                  aria-label="Importing"
                                />
                                Importing {batchGroup.total}…
                              </>
                            ) : (
                              <>
                                <DownloadIcon className="size-3" />
                                Import all · {unimportedCount}
                              </>
                            )}
                          </button>
                        ) : null}
                      </div>
                      <div className={disclosureShellClassName(!collapsedGroups.has(groupKey))}>
                        <div className={DISCLOSURE_INNER_CLASS}>
                          <div
                            className={disclosureContentClassName(!collapsedGroups.has(groupKey))}
                          >
                            {group.sessions.map((session) =>
                              renderSessionRow(
                                session,
                                group.kind === "project" ? group.project : null,
                              ),
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </SidebarMenu>
        </div>
      </div>
    </div>
  );
});
