// FILE: externalSessionsGrouping.ts
// Purpose: Attribute discovered external provider sessions (Codex/Claude CLIs) to Synara
//          projects by cwd so the sidebar can group them per project. A session lands in a
//          project group only when its cwd EQUALS the project root — sessions from
//          subdirectories get their own per-folder groups instead of being swallowed by a
//          parent project (a project rooted at a container dir like ~/workspace must not
//          absorb every repo beneath it). Sessions with no usable cwd fall back to a final
//          "Other locations" group.
// Layer: Web UI pure derivation (unit-tested)
// Exports: groupExternalSessionsByProject, shortenExternalSessionId, externalSessionDisplayTitle,
//   filterExternalSessionGroupsByTitle

import type { OrchestrationExternalSession } from "@synara/contracts";
import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";

import { normalizeSidebarFilterQuery, sidebarTitleMatchesFilter } from "./Sidebar.logic";

export interface ExternalSessionProjectLike {
  readonly id: string;
  readonly cwd: string;
}

export interface ExternalSessionProjectGroup<TProject extends ExternalSessionProjectLike> {
  readonly kind: "project";
  readonly project: TProject;
  readonly sessions: OrchestrationExternalSession[];
}

export interface ExternalSessionFolderGroup {
  readonly kind: "folder";
  /** Full cwd as first reported by a session in this group (trimmed) — the group tooltip. */
  readonly cwd: string;
  /** Folder basename used as the group label. */
  readonly label: string;
  readonly sessions: OrchestrationExternalSession[];
}

export interface ExternalSessionOtherGroup {
  readonly kind: "other";
  readonly sessions: OrchestrationExternalSession[];
}

export type ExternalSessionGroup<TProject extends ExternalSessionProjectLike> =
  | ExternalSessionProjectGroup<TProject>
  | ExternalSessionFolderGroup
  | ExternalSessionOtherGroup;

// Basename for the folder group label; both separator styles and trailing slashes are
// tolerated ("/a/b/" and "C:\a\b" both label as "b").
function folderLabelFromCwd(cwd: string): string {
  return cwd.split(/[/\\]/).findLast((segment) => segment.length > 0) ?? cwd;
}

// Stable partition: project groups follow the incoming `projects` order, folder groups
// (sessions whose cwd is no project root, one group per distinct normalized cwd) sort
// alphabetically by basename, and the no-cwd "other" group always comes last. Sessions
// keep their input order within each group, so a list already sorted by `updatedAt` desc
// (the server contract) stays sorted per group.
export function groupExternalSessionsByProject<TProject extends ExternalSessionProjectLike>(
  sessions: readonly OrchestrationExternalSession[],
  projects: readonly TProject[],
): ExternalSessionGroup<TProject>[] {
  const sessionsByProjectId = new Map<string, OrchestrationExternalSession[]>();
  // Exact-root matching: keyed by the same normalized form so equivalent spellings
  // (trailing slash, duplicate separators, windows case) still match.
  const projectByNormalizedRoot = new Map<string, TProject>(
    projects.map((project) => [normalizeWorkspaceRootForComparison(project.cwd), project]),
  );
  // Keyed by the same normalized form the project matcher compares on, so equivalent
  // spellings (trailing slash, duplicate separators, windows case) collapse into one group.
  const folderGroupsByNormalizedCwd = new Map<string, ExternalSessionFolderGroup>();
  const otherSessions: OrchestrationExternalSession[] = [];

  for (const session of sessions) {
    const cwd = session.cwd?.trim() ?? "";
    const normalizedCwd = cwd.length > 0 ? normalizeWorkspaceRootForComparison(cwd) : "";
    // Only an exact root match attributes a session to a project; subdirectory sessions
    // get their own folder group (import still resolves the containing project at import
    // time — this is purely a display rule).
    const project =
      normalizedCwd.length > 0 ? projectByNormalizedRoot.get(normalizedCwd) : undefined;
    if (project) {
      const bucket = sessionsByProjectId.get(project.id);
      if (bucket) {
        bucket.push(session);
      } else {
        sessionsByProjectId.set(project.id, [session]);
      }
      continue;
    }

    if (normalizedCwd.length === 0) {
      otherSessions.push(session);
      continue;
    }
    const folderGroup = folderGroupsByNormalizedCwd.get(normalizedCwd);
    if (folderGroup) {
      folderGroup.sessions.push(session);
    } else {
      folderGroupsByNormalizedCwd.set(normalizedCwd, {
        kind: "folder",
        cwd,
        label: folderLabelFromCwd(cwd),
        sessions: [session],
      });
    }
  }

  const groups: ExternalSessionGroup<TProject>[] = [];
  for (const project of projects) {
    const projectSessions = sessionsByProjectId.get(project.id);
    if (projectSessions && projectSessions.length > 0) {
      groups.push({ kind: "project", project, sessions: projectSessions });
    }
  }
  const folderGroups = [...folderGroupsByNormalizedCwd.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: "base" }),
  );
  groups.push(...folderGroups);
  if (otherSessions.length > 0) {
    groups.push({ kind: "other", sessions: otherSessions });
  }
  return groups;
}

const SHORT_EXTERNAL_ID_LENGTH = 8;
const UNABBREVIATED_EXTERNAL_ID_LENGTH = 12;

// Compact id for tight sidebar rows: keep the leading segment ("a1b2c3d4…"),
// mirroring how CLIs abbreviate session uuids.
export function shortenExternalSessionId(externalId: string): string {
  const trimmed = externalId.trim();
  return trimmed.length > UNABBREVIATED_EXTERNAL_ID_LENGTH
    ? `${trimmed.slice(0, SHORT_EXTERNAL_ID_LENGTH)}…`
    : trimmed;
}

export function externalSessionDisplayTitle(
  session: Pick<OrchestrationExternalSession, "externalId" | "title">,
): string {
  const title = session.title?.trim();
  return title && title.length > 0 ? title : shortenExternalSessionId(session.externalId);
}

export type ExternalSessionSortOrder = "default" | "created_at" | "last_reply";

// Intra-group ordering for discovered sessions. "default" keeps the server's
// updatedAt-desc order; created_at sorts by session creation, last_reply by the
// session's last activity, both newest-first with missing timestamps last.
export function sortExternalSessionsInGroups<TProject extends ExternalSessionProjectLike>(
  groups: readonly ExternalSessionGroup<TProject>[],
  sortOrder: ExternalSessionSortOrder,
): ExternalSessionGroup<TProject>[] {
  if (sortOrder === "default") {
    return [...groups];
  }
  const timestampOf = (session: OrchestrationExternalSession): string | null =>
    sortOrder === "created_at" ? session.createdAt : session.updatedAt;
  const byTimestampDesc = (
    left: OrchestrationExternalSession,
    right: OrchestrationExternalSession,
  ): number => {
    const leftTs = timestampOf(left);
    const rightTs = timestampOf(right);
    if (leftTs === null && rightTs === null) return 0;
    if (leftTs === null) return 1;
    if (rightTs === null) return -1;
    return rightTs.localeCompare(leftTs);
  };
  return groups.map((group) => ({
    ...group,
    sessions: [...group.sessions].sort(byTimestampDesc),
  }));
}

// Sidebar title filter for the discovered panel: keeps only sessions whose DISPLAY
// title matches (case-insensitive substring, trimmed query) and drops groups left
// empty, preserving group/session order. Empty query passes everything through.
export function filterExternalSessionGroupsByTitle<TProject extends ExternalSessionProjectLike>(
  groups: readonly ExternalSessionGroup<TProject>[],
  query: string,
): ExternalSessionGroup<TProject>[] {
  const normalizedQuery = normalizeSidebarFilterQuery(query);
  if (normalizedQuery.length === 0) {
    return [...groups];
  }
  const result: ExternalSessionGroup<TProject>[] = [];
  for (const group of groups) {
    const sessions = group.sessions.filter((session) =>
      sidebarTitleMatchesFilter(externalSessionDisplayTitle(session), normalizedQuery),
    );
    if (sessions.length > 0) {
      result.push({ ...group, sessions });
    }
  }
  return result;
}
