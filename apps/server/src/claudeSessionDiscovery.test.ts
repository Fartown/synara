// FILE: claudeSessionDiscovery.test.ts
// Purpose: Verifies the Claude session filesystem fallback scanner on fixture directories.
// Layer: Provider discovery tests
// Depends on: claudeSessionDiscovery.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import OS from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseClaudeSessionFileHead,
  resolveClaudeProjectsDir,
  scanClaudeSessionFiles,
} from "./claudeSessionDiscovery.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(nodePath.join(OS.tmpdir(), "synara-claude-discovery-"));
  tempDirs.push(dir);
  return dir;
}

function writeSessionFile(
  projectsDir: string,
  projectDirName: string,
  fileName: string,
  lines: ReadonlyArray<string>,
  mtime: Date,
): string {
  const projectDir = nodePath.join(projectsDir, projectDirName);
  mkdirSync(projectDir, { recursive: true });
  const filePath = nodePath.join(projectDir, fileName);
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
  utimesSync(filePath, mtime, mtime);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("resolveClaudeProjectsDir", () => {
  it("prefers CLAUDE_CONFIG_DIR over the home directory default", () => {
    expect(resolveClaudeProjectsDir({ env: { CLAUDE_CONFIG_DIR: "/custom/claude" } })).toBe(
      nodePath.join("/custom/claude", "projects"),
    );
    expect(resolveClaudeProjectsDir({ env: {}, homeDir: "/home/user" })).toBe(
      nodePath.join("/home/user", ".claude", "projects"),
    );
  });
});

describe("parseClaudeSessionFileHead", () => {
  it("extracts session id, cwd, created timestamp, and summary title", () => {
    expect(
      parseClaudeSessionFileHead(
        [
          JSON.stringify({
            type: "summary",
            summary: "Investigate flaky test",
            leafUuid: "leaf-1",
          }),
          JSON.stringify({
            type: "user",
            sessionId: "session-1",
            cwd: "/work/repo",
            timestamp: "2026-07-01T10:00:00.000Z",
            message: { role: "user", content: "hi" },
          }),
        ].join("\n"),
      ),
    ).toEqual({
      sessionId: "session-1",
      cwd: "/work/repo",
      title: "Investigate flaky test",
      createdAt: "2026-07-01T10:00:00.000Z",
    });
  });

  it("tolerates partial and invalid lines", () => {
    expect(
      parseClaudeSessionFileHead(
        [
          '{"type":"user","sessionId":"session-1","cwd":"/work/r', // truncated line
          "not json at all",
          JSON.stringify({
            type: "assistant",
            sessionId: "session-1",
            cwd: "/work/repo",
            timestamp: "2026-07-01T10:00:00.000Z",
          }),
        ].join("\n"),
      ),
    ).toEqual({
      sessionId: "session-1",
      cwd: "/work/repo",
      createdAt: "2026-07-01T10:00:00.000Z",
    });
  });

  it("reads ai-title lines for the title and falls back to the file name id", () => {
    expect(
      parseClaudeSessionFileHead(
        JSON.stringify({ type: "ai-title", title: "Renamed session" }),
        "session-from-filename",
      ),
    ).toEqual({
      sessionId: "session-from-filename",
      title: "Renamed session",
    });
  });

  it("returns undefined when no session id can be recovered", () => {
    expect(parseClaudeSessionFileHead('garbage\n{"type":"user"}\n')).toBeUndefined();
  });
});

describe("scanClaudeSessionFiles", () => {
  it("scans project directories, newest first, and skips unreadable entries", () => {
    const root = makeTempDir();
    const projectsDir = nodePath.join(root, "projects");
    writeSessionFile(
      projectsDir,
      "-work-repo-a",
      "session-a.jsonl",
      [
        JSON.stringify({ type: "summary", summary: "Session A" }),
        JSON.stringify({
          type: "user",
          sessionId: "session-a",
          cwd: "/work/repo-a",
          timestamp: "2026-06-30T09:00:00.000Z",
        }),
      ],
      new Date("2026-07-01T00:00:00.000Z"),
    );
    writeSessionFile(
      projectsDir,
      "-work-repo-b",
      "session-b.jsonl",
      [
        JSON.stringify({
          type: "user",
          sessionId: "session-b",
          cwd: "/work/repo-b",
          timestamp: "2026-07-02T09:00:00.000Z",
        }),
      ],
      new Date("2026-07-03T00:00:00.000Z"),
    );
    // A file without any session metadata still resolves its id from the file name.
    writeSessionFile(
      projectsDir,
      "-work-repo-c",
      "session-c.jsonl",
      ["not json"],
      new Date("2026-06-01T00:00:00.000Z"),
    );

    const sessions = scanClaudeSessionFiles({ projectsDir });

    expect(sessions.map((session) => session.sessionId)).toEqual([
      "session-b",
      "session-a",
      "session-c",
    ]);
    expect(sessions[0]).toMatchObject({
      cwd: "/work/repo-b",
      createdAt: "2026-07-02T09:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    expect(sessions[1]).toMatchObject({
      cwd: "/work/repo-a",
      title: "Session A",
    });
    expect(sessions[2]).toEqual({
      sessionId: "session-c",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("honors the limit and ignores non-jsonl files", () => {
    const root = makeTempDir();
    const projectsDir = nodePath.join(root, "projects");
    for (const [index, mtime] of [
      [1, "2026-07-01T00:00:00.000Z"],
      [2, "2026-07-02T00:00:00.000Z"],
      [3, "2026-07-03T00:00:00.000Z"],
    ] as const) {
      writeSessionFile(
        projectsDir,
        "-work-repo",
        `session-${index}.jsonl`,
        [JSON.stringify({ sessionId: `session-${index}` })],
        new Date(mtime),
      );
    }
    writeSessionFile(
      projectsDir,
      "-work-repo",
      "notes.txt",
      ["ignored"],
      new Date("2026-07-04T00:00:00.000Z"),
    );

    const sessions = scanClaudeSessionFiles({ projectsDir, limit: 2 });
    expect(sessions.map((session) => session.sessionId)).toEqual(["session-3", "session-2"]);
  });

  it("returns an empty list when the projects directory does not exist", () => {
    const root = makeTempDir();
    expect(scanClaudeSessionFiles({ projectsDir: nodePath.join(root, "missing") })).toEqual([]);
  });
});
