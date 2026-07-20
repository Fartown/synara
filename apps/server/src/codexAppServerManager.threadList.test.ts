// FILE: codexAppServerManager.threadList.test.ts
// Purpose: Verifies defensive thread/list parsing, listExternalThreads pagination, and
//   discovery-session spawn provider options.
// Layer: Codex app-server manager tests
// Depends on: codexAppServerManager.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAppServerManager, parseCodexThreadListPage } from "./codexAppServerManager";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: vi.fn(),
  };
});

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-discovery-home-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("parseCodexThreadListPage", () => {
  it("parses a full thread/list page", () => {
    expect(
      parseCodexThreadListPage({
        data: [
          {
            id: "thread-1",
            preview: "Fix the flaky test",
            cwd: "/work/repo",
            modelProvider: "openai",
            source: "vscode",
            createdAt: "2026-07-01T10:00:00.000Z",
            updatedAt: "2026-07-02T11:00:00.000Z",
          },
        ],
        nextCursor: "cursor-2",
      }),
    ).toEqual({
      threads: [
        {
          id: "thread-1",
          preview: "Fix the flaky test",
          cwd: "/work/repo",
          modelProvider: "openai",
          source: "vscode",
          createdAt: "2026-07-01T10:00:00.000Z",
          updatedAt: "2026-07-02T11:00:00.000Z",
        },
      ],
      nextCursor: "cursor-2",
    });
  });

  it("skips malformed entries and tolerates missing optional fields", () => {
    expect(
      parseCodexThreadListPage({
        data: [
          { id: "thread-1" },
          { preview: "missing id" },
          "not-a-record",
          null,
          { id: 42 },
          { id: "  ", preview: "blank id" },
          { id: "thread-2", preview: 7, cwd: "", modelProvider: null },
        ],
        nextCursor: null,
      }),
    ).toEqual({
      threads: [
        { id: "thread-1", preview: "" },
        { id: "thread-2", preview: "" },
      ],
      nextCursor: null,
    });
  });

  it("normalizes numeric timestamps and object-shaped sources", () => {
    expect(
      parseCodexThreadListPage({
        data: [
          {
            id: "thread-1",
            source: { type: "cli" },
            createdAt: 1_751_000_000,
            updatedAt: 1_751_000_000_000,
          },
        ],
      }),
    ).toEqual({
      threads: [
        {
          id: "thread-1",
          preview: "",
          source: "cli",
          createdAt: new Date(1_751_000_000_000).toISOString(),
          updatedAt: new Date(1_751_000_000_000).toISOString(),
        },
      ],
      nextCursor: null,
    });
  });

  it("returns an empty page for malformed responses", () => {
    expect(parseCodexThreadListPage(undefined)).toEqual({ threads: [], nextCursor: null });
    expect(parseCodexThreadListPage({ data: "nope", nextCursor: 42 })).toEqual({
      threads: [],
      nextCursor: null,
    });
  });
});

describe("CodexAppServerManager.listExternalThreads", () => {
  function createManager(pages: ReadonlyArray<unknown>) {
    const manager = new CodexAppServerManager();
    const context = { session: { cwd: "/work/repo" } };
    vi.spyOn(
      manager as unknown as {
        resolveContextForDiscovery: (threadId?: string, cwd?: string) => Promise<unknown>;
      },
      "resolveContextForDiscovery",
    ).mockResolvedValue(context);
    const sendRequest = vi.spyOn(
      manager as unknown as {
        sendRequest: (context: unknown, method: string, params: unknown) => Promise<unknown>;
      },
      "sendRequest",
    );
    for (const page of pages) {
      sendRequest.mockResolvedValueOnce(page);
    }
    return { sendRequest, manager };
  }

  it("requests one page with thread/list sorted by recency", async () => {
    const { manager, sendRequest } = createManager([
      { data: [{ id: "thread-1", preview: "hello" }], nextCursor: null },
    ]);

    const result = await manager.listExternalThreads({ cwd: "/work/repo" });

    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledWith(expect.anything(), "thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
    expect(result.threads).toEqual([{ id: "thread-1", preview: "hello" }]);
    expect(result.nextCursor).toBeNull();
  });

  it("fetches a second page for aggregate discovery and dedupes by id", async () => {
    const { manager, sendRequest } = createManager([
      {
        data: [
          { id: "thread-1", preview: "one" },
          { id: "thread-2", preview: "two" },
        ],
        nextCursor: "cursor-2",
      },
      {
        data: [
          { id: "thread-2", preview: "two-shifted" },
          { id: "thread-3", preview: "three" },
        ],
        nextCursor: "cursor-3",
      },
    ]);

    const result = await manager.listExternalThreads({});

    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(sendRequest).toHaveBeenNthCalledWith(2, expect.anything(), "thread/list", {
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      cursor: "cursor-2",
    });
    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-1", "thread-2", "thread-3"]);
    expect(result.nextCursor).toBe("cursor-3");
  });

  it("passes an explicit cursor through and does not fetch extra pages", async () => {
    const { manager, sendRequest } = createManager([
      { data: [{ id: "thread-9", preview: "nine" }], nextCursor: "cursor-10" },
    ]);

    const result = await manager.listExternalThreads({ cursor: "cursor-9", limit: 25 });

    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledWith(expect.anything(), "thread/list", {
      limit: 25,
      sortKey: "updated_at",
      sortDirection: "desc",
      cursor: "cursor-9",
    });
    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-9"]);
    expect(result.nextCursor).toBe("cursor-10");
  });
});

describe("CodexAppServerManager discovery session provider options", () => {
  const spawnMock = vi.mocked(spawn);

  function createDiscoverySpawnHarness() {
    const manager = new CodexAppServerManager();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
      killed: false,
      pid: 4242,
    });
    spawnMock.mockReturnValue(child as never);
    const versionCheck = vi
      .spyOn(
        manager as unknown as {
          assertSupportedCodexCliVersion: (input: {
            binaryPath: string;
            cwd: string;
            homePath?: string;
          }) => void;
        },
        "assertSupportedCodexCliVersion",
      )
      .mockImplementation(() => {});
    vi.spyOn(
      manager as unknown as {
        sendRequest: (context: unknown, method: string, params: unknown) => Promise<unknown>;
      },
      "sendRequest",
    ).mockImplementation((_context, method) =>
      Promise.resolve(method === "thread/read" ? { thread: { id: "thread-ext", turns: [] } } : {}),
    );
    vi.spyOn(
      manager as unknown as { teardownContextProcess: (context: unknown) => Promise<void> },
      "teardownContextProcess",
    ).mockResolvedValue(undefined);
    return { manager, versionCheck };
  }

  it("spawns the discovery app-server with the configured binary and home path", async () => {
    const { manager, versionCheck } = createDiscoverySpawnHarness();
    // A real tmp home: buildCodexProcessEnv materializes a CODEX_HOME overlay
    // derived from the configured home path.
    const codexHomeRoot = makeTempHome();
    const codexHome = path.join(codexHomeRoot, "codex-home");
    // The discovery cwd must exist on disk (nonexistent cwds fall back to HOME).
    const workCwd = makeTempHome();

    try {
      await manager.listExternalThreads({
        cwd: workCwd,
        providerOptions: {
          codex: { binaryPath: "/custom/codex", homePath: codexHome },
        },
      });

      expect(versionCheck).toHaveBeenCalledWith({
        binaryPath: "/custom/codex",
        cwd: workCwd,
        homePath: codexHome,
      });
      expect(spawnMock).toHaveBeenCalledWith(
        "/custom/codex",
        ["app-server"],
        expect.objectContaining({
          cwd: workCwd,
          env: expect.objectContaining({ CODEX_HOME: expect.stringContaining(codexHomeRoot) }),
        }),
      );
    } finally {
      await manager.stopAll();
    }
  });

  it("defaults the discovery app-server to PATH codex without provider options", async () => {
    const { manager, versionCheck } = createDiscoverySpawnHarness();
    const workCwd = makeTempHome();

    try {
      await manager.listExternalThreads({ cwd: workCwd });

      expect(versionCheck).toHaveBeenCalledWith({ binaryPath: "codex", cwd: workCwd });
      expect(spawnMock).toHaveBeenCalledWith(
        "codex",
        ["app-server"],
        expect.objectContaining({ cwd: workCwd }),
      );
    } finally {
      await manager.stopAll();
    }
  });

  it("threads provider options through readExternalThread", async () => {
    const { manager, versionCheck } = createDiscoverySpawnHarness();
    const workCwd = makeTempHome();

    try {
      await manager.readExternalThread({
        externalThreadId: "thread-ext",
        cwd: workCwd,
        providerOptions: { codex: { binaryPath: "/custom/codex" } },
      });

      expect(versionCheck).toHaveBeenCalledWith({
        binaryPath: "/custom/codex",
        cwd: workCwd,
      });
      expect(spawnMock).toHaveBeenCalledWith(
        "/custom/codex",
        ["app-server"],
        expect.objectContaining({ cwd: workCwd }),
      );
    } finally {
      await manager.stopAll();
    }
  });
});
