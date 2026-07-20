// FILE: importExternalThreadsRoute.test.ts
// Purpose: Verifies the server-driven batch import: strict sequential order, per-item
//   statuses (imported / alreadyImported / failed) with failure isolation, batch-size
//   guardrails, one project per distinct cwd, and shell-thread cleanup after failed
//   items (no lingering empty threads).
// Layer: Orchestration command handler tests
// Depends on: importExternalThreadsRoute, externalSessionImport.

import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@synara/contracts";
import type { FileSystem, Path } from "effect";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery";
import type { ProjectionThreadSessionRepositoryShape } from "../persistence/Services/ProjectionThreadSessions.ts";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ProviderSessionDirectoryShape } from "../provider/Services/ProviderSessionDirectory";
import type { ServerSettingsShape } from "../serverSettings.ts";
import { makeImportExternalThreadsHandler } from "./importExternalThreadsRoute.ts";

const getClaudeSessionInfo = vi.fn(async (_sessionId: string, _options?: { dir?: string }) => ({
  sessionId: "session-1",
}));
const getClaudeSessionMessages = vi.fn(
  async (_sessionId: string, _options?: { dir?: string }): Promise<ReadonlyArray<unknown>> => [],
);
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  getSessionInfo: (sessionId: string, options?: { dir?: string }) =>
    getClaudeSessionInfo(sessionId, options),
  getSessionMessages: (sessionId: string, options?: { dir?: string }) =>
    getClaudeSessionMessages(sessionId, options),
}));

const NOW = "2026-07-19T12:00:00.000Z";
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

interface TrackedCommand {
  readonly type?: string;
  readonly threadId?: ThreadId;
  readonly projectId?: string;
  readonly modelSelection?: { provider: string; model: string };
  readonly runtimeMode?: string;
  readonly envMode?: string;
  readonly worktreePath?: string | null;
  readonly workspaceRoot?: string;
  readonly title?: string;
  readonly externalSessionId?: string;
  readonly session?: { readonly providerName?: string | null };
}

interface MappingFixture {
  readonly provider: string;
  readonly externalId: string;
  readonly threadId: ThreadId;
}

function makeHarness(input?: {
  readonly bindings?: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly provider: string;
    readonly resumeCursor?: unknown;
  }>;
  readonly mappings?: ReadonlyArray<MappingFixture>;
  readonly durableRows?: ReadonlyArray<
    MappingFixture & {
      readonly firstImportedAt?: string;
      readonly lastImportedAt?: string;
    }
  >;
  readonly existingThreadIds?: ReadonlyArray<string>;
  readonly projects?: ReadonlyArray<{ readonly id: string; readonly workspaceRoot: string }>;
  readonly failStartSessionForExternalId?: string;
  // Cwds treated as deleted on disk: the canonicalize spy rejects them unless the
  // route asks for createIfMissing, mimicking the production wsRpc canonicalizer.
  readonly missingCwdDirs?: ReadonlyArray<string>;
}) {
  const projects = (input?.projects ?? []).map((project) => ({ ...project }));
  const createdThreadIds = new Set<string>();
  const dispatched: TrackedCommand[] = [];
  // Simulates the projection pipeline: thread.session.set dispatches carrying an
  // externalSessionId land in projection_thread_sessions.provider_thread_id.
  const sessionMappings = new Map<string, MappingFixture>(
    [...(input?.mappings ?? []), ...(input?.durableRows ?? [])].map((row) => [
      `${row.provider}:${row.externalId}`,
      row,
    ]),
  );
  const projectionThreadSessionRepository = {
    getThreadIdByProviderThreadId: (provider: string, providerThreadId: string) =>
      Effect.succeed(
        (() => {
          const row = sessionMappings.get(`${provider}:${providerThreadId}`);
          return row ? Option.some(row.threadId) : Option.none();
        })(),
      ),
    listProviderThreadIds: () =>
      Effect.succeed(
        [...sessionMappings.values()].map((row) => ({
          threadId: row.threadId,
          providerName: row.provider,
          providerThreadId: row.externalId,
        })),
      ),
  } as unknown as ProjectionThreadSessionRepositoryShape;
  const dispatch = vi.fn((command: TrackedCommand) => {
    dispatched.push(command);
    if (command.type === "thread.create" && command.threadId) {
      createdThreadIds.add(command.threadId);
    }
    if (command.type === "thread.delete" && command.threadId) {
      createdThreadIds.delete(command.threadId);
    }
    if (command.type === "project.create" && command.projectId && command.workspaceRoot) {
      projects.push({ id: command.projectId, workspaceRoot: command.workspaceRoot });
    }
    if (
      command.type === "thread.session.set" &&
      command.externalSessionId &&
      command.threadId &&
      command.session?.providerName
    ) {
      const provider = command.session.providerName;
      sessionMappings.set(`${provider}:${command.externalSessionId}`, {
        provider,
        externalId: command.externalSessionId,
        threadId: command.threadId,
      });
    }
    return Effect.succeed({});
  });
  const startSession = vi.fn((threadId: ThreadId, startInput: { resumeCursor?: unknown }) => {
    const cursor = startInput.resumeCursor as { threadId?: string } | undefined;
    if (
      input?.failStartSessionForExternalId !== undefined &&
      cursor?.threadId === input.failStartSessionForExternalId
    ) {
      return Effect.fail(new Error("codex app-server unavailable"));
    }
    return Effect.succeed({
      provider: "codex",
      status: "ready",
      runtimeMode: "full-access",
      cwd: "/work/repo",
      threadId,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });
  const stopSession = vi.fn(() => Effect.void);

  const existingThreadIds = new Set(input?.existingThreadIds ?? []);
  const missingCwdDirs = new Set(input?.missingCwdDirs ?? []);
  const canonicalizeProjectWorkspaceRoot = vi.fn(
    (workspaceRoot: string, options?: { readonly createIfMissing?: boolean }) => {
      const root = workspaceRoot.trim();
      if (missingCwdDirs.has(root) && !options?.createIfMissing) {
        return Effect.fail(new Error(`Project directory does not exist: ${root}`));
      }
      return Effect.succeed(root);
    },
  );
  const handler = makeImportExternalThreadsHandler({
    now: () => NOW,
    fileSystem: {} as unknown as FileSystem.FileSystem,
    orchestrationEngine: { dispatch } as unknown as OrchestrationEngineShape,
    path: {} as unknown as Path.Path,
    platform: "darwin",
    canonicalizeProjectWorkspaceRoot,
    projectionSnapshotQuery: {
      getSnapshot: () =>
        Effect.succeed({
          projects: projects.map((project) => ({
            id: project.id,
            kind: "project",
            title: project.workspaceRoot,
            workspaceRoot: project.workspaceRoot,
            defaultModelSelection: null,
            deletedAt: null,
          })),
        }),
      getThreadDetailById: (threadId: ThreadId) => {
        if (existingThreadIds.has(threadId)) {
          return Effect.succeed(
            Option.some({
              id: threadId,
              projectId: projects[0]?.id ?? "project-1",
              session: null,
              modelSelection: { provider: "codex", model: "gpt-5.5" },
              runtimeMode: "full-access",
              envMode: "local",
              worktreePath: null,
            }),
          );
        }
        const createCommand = dispatched.find(
          (command) => command.type === "thread.create" && command.threadId === threadId,
        );
        if (!createCommand || !createdThreadIds.has(threadId)) {
          return Effect.succeed(Option.none());
        }
        return Effect.succeed(
          Option.some({
            id: threadId,
            projectId: createCommand.projectId ?? "project-1",
            session: null,
            modelSelection: createCommand.modelSelection ?? { provider: "codex", model: "gpt-5.5" },
            runtimeMode: createCommand.runtimeMode ?? "full-access",
            envMode: createCommand.envMode ?? "local",
            worktreePath: createCommand.worktreePath ?? null,
          }),
        );
      },
      getProjectShellById: (projectId: string) => {
        const project = projects.find((candidate) => candidate.id === projectId);
        return Effect.succeed(
          project
            ? Option.some({ id: project.id, kind: "project", workspaceRoot: project.workspaceRoot })
            : Option.none(),
        );
      },
    } as unknown as ProjectionSnapshotQueryShape,
    providerAdapterRegistry: {
      getByProvider: () =>
        Effect.succeed({
          readThread: () => Effect.succeed({ threadId: asThreadId("thread-1"), turns: [] }),
        }),
    } as unknown as ProviderAdapterRegistryShape,
    providerService: { startSession, stopSession } as unknown as ProviderServiceShape,
    providerSessionDirectory: {
      listBindings: () => Effect.succeed(input?.bindings ?? []),
    } as unknown as ProviderSessionDirectoryShape,
    serverSettings: {
      getSnapshot: Effect.succeed({
        revision: 0,
        migrationVersion: 1,
        settings: DEFAULT_SERVER_SETTINGS,
      }),
    } as unknown as ServerSettingsShape,
    projectionThreadSessionRepository,
  });

  return {
    dispatch,
    dispatched,
    durableRows: sessionMappings,
    handler,
    canonicalizeProjectWorkspaceRoot,
    sessionMappings,
    startSession,
    stopSession,
  };
}

async function runHandlerError(
  handler: ReturnType<typeof makeHarness>["handler"],
  items: ReadonlyArray<unknown>,
) {
  const error = await Effect.runPromise(handler({ items: items as never }).pipe(Effect.flip));
  return error instanceof Error ? error.message : String(error);
}

describe("makeImportExternalThreadsHandler guardrails", () => {
  it("rejects an empty batch", async () => {
    const { handler } = makeHarness();

    const message = await runHandlerError(handler, []);

    expect(message).toContain("at least one session");
  });

  it("rejects batches over 50 items", async () => {
    const { handler } = makeHarness();
    const items = Array.from({ length: 51 }, (_, index) => ({
      provider: "codex",
      externalId: `ext-${index}`,
      cwd: "/work/repo",
    }));

    const message = await runHandlerError(handler, items);

    expect(message).toContain("at most 50");
    expect(message).toContain("51");
  });
});

describe("makeImportExternalThreadsHandler per-item flow", () => {
  it("imports sequentially in input order with per-item statuses and failure isolation", async () => {
    const { dispatch, dispatched, handler, startSession } = makeHarness({
      projects: [{ id: "project-1", workspaceRoot: "/work/repo" }],
      existingThreadIds: ["thread-bound"],
      bindings: [
        {
          threadId: asThreadId("thread-bound"),
          provider: "codex",
          resumeCursor: { threadId: "ext-dup" },
        },
      ],
      failStartSessionForExternalId: "ext-fail",
    });

    const result = await Effect.runPromise(
      handler({
        items: [
          { provider: "codex", externalId: "ext-1", cwd: "/work/repo", title: "First session" },
          { provider: "codex", externalId: "ext-dup", cwd: "/work/repo" },
          { provider: "codex", externalId: "ext-fail", cwd: "/work/repo" },
          { provider: "codex", externalId: "ext-2", cwd: "/work/repo" },
        ],
      }),
    );

    // Input order preserved; statuses per item.
    expect(result.results.map((entry) => entry.externalId)).toEqual([
      "ext-1",
      "ext-dup",
      "ext-fail",
      "ext-2",
    ]);
    expect(result.results.map((entry) => entry.status)).toEqual([
      "imported",
      "alreadyImported",
      "failed",
      "imported",
    ]);
    expect(result.results[0]?.threadId).toBeDefined();
    expect(result.results[1]?.threadId).toBe("thread-bound");
    expect(result.results[2]?.threadId).toBeUndefined();
    expect(result.results[2]?.error).toContain("codex app-server unavailable");

    // Strictly sequential: provider sessions start in input order (dup/fail excluded).
    const startedExternalIds = startSession.mock.calls.map(
      (call) => (call[1] as { resumeCursor?: { threadId?: string } }).resumeCursor?.threadId,
    );
    expect(startedExternalIds).toEqual(["ext-1", "ext-fail", "ext-2"]);

    // The failed item's thread shell was deleted; the two successful threads remain.
    const createdIds = dispatched
      .filter((command) => command.type === "thread.create")
      .map((command) => command.threadId);
    const deletedIds = dispatched
      .filter((command) => command.type === "thread.delete")
      .map((command) => command.threadId);
    expect(createdIds).toHaveLength(3);
    expect(deletedIds).toHaveLength(1);
    expect(createdIds).toContain(deletedIds[0]);
    expect(result.results[0]?.threadId).not.toBe(deletedIds[0]);
    expect(result.results[3]?.threadId).not.toBe(deletedIds[0]);

    // No project creation needed: every item matched the existing project.
    expect(dispatched.some((command) => command.type === "project.create")).toBe(false);
    // The provided title reached both the thread create and the import title update.
    expect(
      dispatched.some(
        (command) => command.type === "thread.create" && command.title === "First session",
      ),
    ).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.meta.update", title: "First session" }),
    );
  });

  it("creates one project per distinct cwd and reuses it across items", async () => {
    const { dispatched, handler } = makeHarness({ projects: [] });

    const result = await Effect.runPromise(
      handler({
        items: [
          { provider: "codex", externalId: "ext-1", cwd: "/new/folder" },
          { provider: "codex", externalId: "ext-2", cwd: "/new/folder" },
        ],
      }),
    );

    expect(result.results.map((entry) => entry.status)).toEqual(["imported", "imported"]);
    const projectCreates = dispatched.filter((command) => command.type === "project.create");
    expect(projectCreates).toHaveLength(1);
    expect(projectCreates[0]?.workspaceRoot).toBe("/new/folder");
    expect(projectCreates[0]?.title).toBe("folder");
    const threadCreates = dispatched.filter((command) => command.type === "thread.create");
    expect(threadCreates).toHaveLength(2);
    expect(
      threadCreates.every((command) => command.projectId === projectCreates[0]?.projectId),
    ).toBe(true);
    // Fallback titles use the provider + external id suffix.
    expect(threadCreates[0]?.title).toBe("Imported Codex thread ext-1");
    expect(threadCreates[1]?.title).toBe("Imported Codex thread ext-2");
  });

  it("recreates a missing session folder instead of failing the import", async () => {
    const { canonicalizeProjectWorkspaceRoot, dispatched, handler } = makeHarness({
      projects: [],
      missingCwdDirs: ["/deleted/folder"],
    });

    const result = await Effect.runPromise(
      handler({
        items: [{ provider: "codex", externalId: "ext-missing", cwd: "/deleted/folder" }],
      }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("imported");
    // The route must ask the canonicalizer to recreate the deleted folder (same
    // semantics as the web single-import flow), otherwise this item fails with
    // "not usable as a project directory".
    expect(canonicalizeProjectWorkspaceRoot).toHaveBeenCalledWith("/deleted/folder", {
      createIfMissing: true,
    });
    const projectCreate = dispatched.find((command) => command.type === "project.create");
    expect(projectCreate?.workspaceRoot).toBe("/deleted/folder");
  });

  it("imports claude sessions with a claude model selection", async () => {
    getClaudeSessionInfo.mockClear();
    const { dispatched, handler } = makeHarness({
      projects: [{ id: "project-1", workspaceRoot: "/work/repo" }],
    });

    const result = await Effect.runPromise(
      handler({
        items: [{ provider: "claudeAgent", externalId: "claude-1", cwd: "/work/repo" }],
      }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.status).toBe("imported");
    const threadCreate = dispatched.find((command) => command.type === "thread.create");
    expect(threadCreate?.modelSelection?.provider).toBe("claudeAgent");
    expect(getClaudeSessionInfo).toHaveBeenCalledWith("claude-1", { dir: "/work/repo" });
  });

  it("dedups via the durable mapping when the runtime binding is gone", async () => {
    const { dispatched, durableRows, handler, startSession } = makeHarness({
      projects: [{ id: "project-1", workspaceRoot: "/work/repo" }],
      existingThreadIds: ["thread-bound"],
      durableRows: [
        {
          provider: "codex",
          externalId: "ext-dup",
          threadId: asThreadId("thread-bound"),
          firstImportedAt: "2026-07-01T00:00:00.000Z",
          lastImportedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
    });

    const result = await Effect.runPromise(
      handler({
        items: [
          { provider: "codex", externalId: "ext-dup", cwd: "/work/repo" },
          { provider: "codex", externalId: "ext-new", cwd: "/work/repo" },
        ],
      }),
    );

    expect(result.results.map((entry) => entry.status)).toEqual(["alreadyImported", "imported"]);
    expect(result.results[0]?.threadId).toBe("thread-bound");
    // Only the genuinely new session started a provider session / created a thread.
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(dispatched.filter((command) => command.type === "thread.create")).toHaveLength(1);
    // The fresh import recorded its own durable row through the shared runner.
    expect(durableRows.get("codex:ext-new")?.threadId).toBe(result.results[1]?.threadId);
  });
});
