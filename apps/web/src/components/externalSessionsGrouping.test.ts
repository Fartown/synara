import { ThreadId, type OrchestrationExternalSession } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  externalSessionDisplayTitle,
  filterExternalSessionGroupsByTitle,
  groupExternalSessionsByProject,
  shortenExternalSessionId,
  sortExternalSessionsInGroups,
} from "./externalSessionsGrouping";

function makeSession(
  overrides: Partial<OrchestrationExternalSession> = {},
): OrchestrationExternalSession {
  return {
    provider: "codex",
    externalId: "session-1",
    cwd: null,
    title: null,
    updatedAt: null,
    createdAt: null,
    source: null,
    importedThreadId: null,
    ...overrides,
  };
}

function makeProject(id: string, cwd: string) {
  return { id, cwd };
}

describe("groupExternalSessionsByProject", () => {
  it("matches sessions to projects by exact cwd", () => {
    const projects = [makeProject("p1", "/repo/app"), makeProject("p2", "/repo/lib")];
    const sessions = [
      makeSession({ externalId: "s1", cwd: "/repo/app" }),
      makeSession({ externalId: "s2", cwd: "/repo/lib" }),
    ];

    const groups = groupExternalSessionsByProject(sessions, projects);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ kind: "project", project: projects[0] });
    expect(groups[0]?.sessions.map((session) => session.externalId)).toEqual(["s1"]);
    expect(groups[1]).toMatchObject({ kind: "project", project: projects[1] });
    expect(groups[1]?.sessions.map((session) => session.externalId)).toEqual(["s2"]);
  });

  it("gives subdirectory sessions their own folder group instead of attributing them to the project", () => {
    const projects = [makeProject("p1", "/repo/app")];
    const sessions = [makeSession({ externalId: "s1", cwd: "/repo/app/packages/web" })];

    const groups = groupExternalSessionsByProject(sessions, projects);

    expect(groups).toEqual([
      {
        kind: "folder",
        cwd: "/repo/app/packages/web",
        label: "web",
        sessions,
      },
    ]);
  });

  it("does not let a parent project absorb sessions from a nested project's directory", () => {
    const projects = [makeProject("parent", "/repo"), makeProject("child", "/repo/app")];
    const sessions = [makeSession({ externalId: "s1", cwd: "/repo/app/packages" })];

    const groups = groupExternalSessionsByProject(sessions, projects);

    expect(groups).toEqual([
      { kind: "folder", cwd: "/repo/app/packages", label: "packages", sessions },
    ]);
  });

  it("does not treat a root as inside a sibling with a shared path prefix", () => {
    const projects = [makeProject("p1", "/repo/ap")];
    const sessions = [makeSession({ externalId: "s1", cwd: "/repo/app" })];

    const groups = groupExternalSessionsByProject(sessions, projects);

    expect(groups).toEqual([{ kind: "folder", cwd: "/repo/app", label: "app", sessions }]);
  });

  it("groups unmatched sessions per folder, with the no-cwd other group ordered last", () => {
    const projects = [makeProject("p1", "/repo/app")];
    const matched = makeSession({ externalId: "s1", cwd: "/repo/app" });
    const unmatched = makeSession({ externalId: "s2", cwd: "/elsewhere/tool" });
    const noCwd = makeSession({ externalId: "s3", cwd: null });

    const groups = groupExternalSessionsByProject([matched, unmatched, noCwd], projects);

    expect(groups).toHaveLength(3);
    expect(groups[0]?.kind).toBe("project");
    expect(groups[1]).toMatchObject({ kind: "folder", cwd: "/elsewhere/tool", label: "tool" });
    expect(groups[1]?.sessions.map((session) => session.externalId)).toEqual(["s2"]);
    expect(groups[2]).toEqual({ kind: "other", sessions: [noCwd] });
  });

  it("keeps imported sessions in their cwd group like any other session", () => {
    const projects = [makeProject("p1", "/repo/app")];
    const imported = makeSession({
      externalId: "s1",
      cwd: "/repo/app",
      importedThreadId: ThreadId.makeUnsafe("thread-1"),
    });
    const fresh = makeSession({ externalId: "s2", cwd: "/repo/app" });

    const groups = groupExternalSessionsByProject([imported, fresh], projects);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions.map((session) => session.externalId)).toEqual(["s1", "s2"]);
  });

  it("omits projects without sessions and returns no project groups when there are no projects", () => {
    const projects = [makeProject("p1", "/repo/app"), makeProject("p2", "/repo/lib")];
    const sessions = [makeSession({ externalId: "s1", cwd: "/repo/lib" })];

    const groups = groupExternalSessionsByProject(sessions, projects);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "project", project: projects[1] });

    expect(groupExternalSessionsByProject(sessions, [])).toEqual([
      { kind: "folder", cwd: "/repo/lib", label: "lib", sessions },
    ]);
    expect(groupExternalSessionsByProject([], projects)).toEqual([]);
  });

  it("preserves input order within a group (updatedAt desc from the server stays desc)", () => {
    const projects = [makeProject("p1", "/repo/app")];
    const sessions = [
      makeSession({ externalId: "newest", cwd: "/repo/app", updatedAt: "2026-07-18T10:00:00Z" }),
      makeSession({ externalId: "middle", cwd: "/repo/app", updatedAt: "2026-07-17T10:00:00Z" }),
      makeSession({ externalId: "oldest", cwd: "/repo/app", updatedAt: null }),
    ];

    const groups = groupExternalSessionsByProject(sessions, projects);

    expect(groups[0]?.sessions.map((session) => session.externalId)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
  });

  it("orders project groups by the sidebar project order, not by first session seen", () => {
    const projects = [makeProject("p1", "/repo/app"), makeProject("p2", "/repo/lib")];
    const sessions = [
      makeSession({ externalId: "s2", cwd: "/repo/lib" }),
      makeSession({ externalId: "s1", cwd: "/repo/app" }),
    ];

    const groups = groupExternalSessionsByProject(sessions, projects);

    expect(groups.map((group) => (group.kind === "project" ? group.project.id : "other"))).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("normalizes trailing slashes and duplicate separators before matching", () => {
    const projects = [makeProject("p1", "/repo/app/")];
    const sessions = [makeSession({ externalId: "s1", cwd: "/repo//app" })];

    const groups = groupExternalSessionsByProject(sessions, projects);

    expect(groups[0]?.kind).toBe("project");
  });

  it("matches windows paths case-insensitively and across separator styles", () => {
    const projects = [makeProject("p1", "C:\\Repos\\App")];
    const sessions = [makeSession({ externalId: "s1", cwd: "c:/repos/app" })];

    const groups = groupExternalSessionsByProject(sessions, projects);

    expect(groups[0]?.kind).toBe("project");
  });

  it("stays case-sensitive for posix paths (no platform hint, matching the rest of the app)", () => {
    const projects = [makeProject("p1", "/Repo/App")];
    const sessions = [makeSession({ externalId: "s1", cwd: "/repo/app" })];

    const groups = groupExternalSessionsByProject(sessions, projects);

    expect(groups).toEqual([{ kind: "folder", cwd: "/repo/app", label: "app", sessions }]);
  });

  it("groups unmatched sessions per folder, sorted alphabetically by basename", () => {
    const sessions = [
      makeSession({ externalId: "s1", cwd: "/x/charlie" }),
      makeSession({ externalId: "s2", cwd: "/x/alpha" }),
      makeSession({ externalId: "s3", cwd: "/x/beta" }),
    ];

    const groups = groupExternalSessionsByProject(sessions, []);

    expect(groups.map((group) => (group.kind === "folder" ? group.label : "?"))).toEqual([
      "alpha",
      "beta",
      "charlie",
    ]);
  });

  it("collapses equivalent cwd spellings into one folder group, preserving session order", () => {
    const sessions = [
      makeSession({ externalId: "s1", cwd: "/x/tool/" }),
      makeSession({ externalId: "s2", cwd: "/x//tool" }),
    ];

    const groups = groupExternalSessionsByProject(sessions, []);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: "folder", label: "tool" });
    expect(groups[0]?.sessions.map((session) => session.externalId)).toEqual(["s1", "s2"]);
  });

  it("labels windows folder groups with the basename", () => {
    const sessions = [makeSession({ externalId: "s1", cwd: "C:\\Repos\\Tool\\" })];

    const groups = groupExternalSessionsByProject(sessions, []);

    expect(groups).toEqual([{ kind: "folder", cwd: "C:\\Repos\\Tool\\", label: "Tool", sessions }]);
  });
});

describe("shortenExternalSessionId", () => {
  it("keeps short ids untouched", () => {
    expect(shortenExternalSessionId("abc123")).toBe("abc123");
    expect(shortenExternalSessionId("0123456789ab")).toBe("0123456789ab");
  });

  it("abbreviates long ids to their leading segment", () => {
    expect(shortenExternalSessionId("01948d2f-7a3e-7c1f-9b2d-1a2b3c4d5e6f")).toBe("01948d2f…");
  });

  it("trims surrounding whitespace", () => {
    expect(shortenExternalSessionId("  abc123  ")).toBe("abc123");
  });
});

describe("externalSessionDisplayTitle", () => {
  it("prefers the session title when present", () => {
    expect(
      externalSessionDisplayTitle(
        makeSession({ title: "Fix flaky login test", externalId: "01948d2f-7a3e-7c1f" }),
      ),
    ).toBe("Fix flaky login test");
  });

  it("falls back to the shortened external id when the title is missing or blank", () => {
    expect(
      externalSessionDisplayTitle(makeSession({ title: null, externalId: "01948d2f-7a3e-7c1f" })),
    ).toBe("01948d2f…");
    expect(externalSessionDisplayTitle(makeSession({ title: "   ", externalId: "abc" }))).toBe(
      "abc",
    );
  });
});

describe("filterExternalSessionGroupsByTitle", () => {
  function buildGroups() {
    const projects = [makeProject("p1", "/repo/app")];
    const sessions = [
      makeSession({ externalId: "s1", cwd: "/repo/app", title: "Fix flaky test" }),
      makeSession({ externalId: "s2", cwd: "/repo/app", title: "Add search filter" }),
      makeSession({ externalId: "s3", cwd: "/other", title: "Database migration" }),
    ];
    return groupExternalSessionsByProject(sessions, projects);
  }

  it("passes groups through untouched for an empty or whitespace query", () => {
    const groups = buildGroups();

    expect(filterExternalSessionGroupsByTitle(groups, "")).toEqual(groups);
    expect(filterExternalSessionGroupsByTitle(groups, "   ")).toEqual(groups);
  });

  it("filters case-insensitively on the trimmed query and prunes empty groups", () => {
    const groups = buildGroups();

    const filtered = filterExternalSessionGroupsByTitle(groups, "  SEARCH ");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toMatchObject({ kind: "project" });
    expect(filtered[0]?.sessions.map((session) => session.externalId)).toEqual(["s2"]);
  });

  it("matches against the display title, falling back to the shortened external id", () => {
    const groups = groupExternalSessionsByProject(
      [makeSession({ externalId: "abcdef1234567890", cwd: "/repo/app", title: null })],
      [makeProject("p1", "/repo/app")],
    );

    const filtered = filterExternalSessionGroupsByTitle(groups, "ABCDEF12");

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessions).toHaveLength(1);
  });

  it("keeps non-empty groups in order while dropping the ones with zero matches", () => {
    const projects = [makeProject("p1", "/repo/a"), makeProject("p2", "/repo/b")];
    const sessions = [
      makeSession({ externalId: "s1", cwd: "/repo/a", title: "alpha fix" }),
      makeSession({ externalId: "s2", cwd: "/repo/b", title: "beta fix" }),
      makeSession({ externalId: "s3", cwd: "/repo/b", title: "gamma" }),
    ];
    const groups = groupExternalSessionsByProject(sessions, projects);

    const filtered = filterExternalSessionGroupsByTitle(groups, "fix");

    expect(filtered.map((group) => group.kind)).toEqual(["project", "project"]);
    expect(filtered[0]?.sessions.map((session) => session.externalId)).toEqual(["s1"]);
    expect(filtered[1]?.sessions.map((session) => session.externalId)).toEqual(["s2"]);
  });
});

describe("sortExternalSessionsInGroups", () => {
  it("keeps the server order in default mode", () => {
    const sessions = [
      makeSession({ externalId: "older", cwd: "/repo/a", updatedAt: "2026-07-10T10:00:00Z" }),
      makeSession({ externalId: "newer", cwd: "/repo/a", updatedAt: "2026-07-18T10:00:00Z" }),
    ];
    const groups = groupExternalSessionsByProject(sessions, [makeProject("p1", "/repo/a")]);

    const sorted = sortExternalSessionsInGroups(groups, "default");

    expect(sorted[0]?.sessions.map((session) => session.externalId)).toEqual(["older", "newer"]);
  });

  it("sorts by created_at newest-first inside each group with missing timestamps last", () => {
    const sessions = [
      makeSession({ externalId: "mid", cwd: "/repo/a", createdAt: "2026-07-12T10:00:00Z" }),
      makeSession({ externalId: "unknown", cwd: "/repo/a", createdAt: null }),
      makeSession({ externalId: "newest", cwd: "/repo/a", createdAt: "2026-07-18T10:00:00Z" }),
    ];
    const groups = groupExternalSessionsByProject(sessions, [makeProject("p1", "/repo/a")]);

    const sorted = sortExternalSessionsInGroups(groups, "created_at");

    expect(sorted[0]?.sessions.map((session) => session.externalId)).toEqual([
      "newest",
      "mid",
      "unknown",
    ]);
  });

  it("sorts by last reply (updatedAt) and leaves group order untouched", () => {
    const projects = [makeProject("p1", "/repo/a"), makeProject("p2", "/repo/b")];
    const sessions = [
      makeSession({ externalId: "a-old", cwd: "/repo/a", updatedAt: "2026-07-10T10:00:00Z" }),
      makeSession({ externalId: "a-new", cwd: "/repo/a", updatedAt: "2026-07-18T10:00:00Z" }),
      makeSession({ externalId: "b-mid", cwd: "/repo/b", updatedAt: "2026-07-15T10:00:00Z" }),
    ];
    const groups = groupExternalSessionsByProject(sessions, projects);

    const sorted = sortExternalSessionsInGroups(groups, "last_reply");

    expect(sorted.map((group) => group.kind)).toEqual(["project", "project"]);
    expect(sorted[0]?.sessions.map((session) => session.externalId)).toEqual(["a-new", "a-old"]);
    expect(sorted[1]?.sessions.map((session) => session.externalId)).toEqual(["b-mid"]);
  });
});
