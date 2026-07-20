// FILE: importThreadRoute.test.ts
// Purpose: Verifies duplicate-import short-circuiting and optional title dispatch on import.
// Layer: Orchestration command handler tests
// Depends on: importThreadRoute.

import { DEFAULT_SERVER_SETTINGS, ThreadId, type ServerSettings } from "@synara/contracts";
import { providerStartOptionsFromServerSettings } from "@synara/shared/serverSettings";
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
import { makeImportThreadHandler } from "./importThreadRoute.ts";

const NOW = "2026-07-10T12:00:00.000Z";
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function makeThreadDetail(id: string) {
  return {
    id: asThreadId(id),
    projectId: "project-1",
    session: null,
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    envMode: "local",
    worktreePath: null,
  };
}

type BindingFixture = {
  readonly threadId: ThreadId;
  readonly provider: string;
  readonly resumeCursor?: unknown;
};

interface MappingFixture {
  readonly provider: string;
  readonly externalId: string;
  readonly threadId: ThreadId;
}

interface SessionSetCommandLike {
  readonly type?: string;
  readonly threadId?: ThreadId;
  readonly externalSessionId?: string;
  readonly session?: { readonly providerName?: string | null };
}

function makeHarness(input?: {
  readonly bindings?: ReadonlyArray<BindingFixture>;
  readonly mappings?: ReadonlyArray<MappingFixture>;
  readonly knownThreadIds?: ReadonlyArray<string>;
  readonly settings?: ServerSettings;
  readonly withReadExternalThread?: boolean;
}) {
  // Simulates the projection pipeline: thread.session.set dispatches carrying an
  // externalSessionId land in projection_thread_sessions.provider_thread_id.
  const sessionMappings = new Map<string, MappingFixture>(
    (input?.mappings ?? []).map((row) => [`${row.provider}:${row.externalId}`, row]),
  );
  const dispatch = vi.fn((command: SessionSetCommandLike) => {
    if (
      command?.type === "thread.session.set" &&
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
  const startSession = vi.fn(() =>
    Effect.succeed({
      provider: "codex",
      status: "ready",
      runtimeMode: "full-access",
      cwd: "/work/repo",
      threadId: "unused",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
  const stopSession = vi.fn(() => Effect.void);
  const readExternalThread = vi.fn((_input: unknown) =>
    Effect.succeed({ threadId: asThreadId("ext"), turns: [], cwd: "/work/repo" }),
  );
  const knownThreadIds = new Set(input?.knownThreadIds ?? ["thread-1"]);
  let currentBindings: ReadonlyArray<BindingFixture> = input?.bindings ?? [];
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

  const handler = makeImportThreadHandler({
    fileSystem: {} as unknown as FileSystem.FileSystem,
    orchestrationEngine: { dispatch } as unknown as OrchestrationEngineShape,
    path: {} as unknown as Path.Path,
    platform: "darwin",
    projectionSnapshotQuery: {
      getThreadDetailById: (threadId: ThreadId) =>
        Effect.succeed(
          knownThreadIds.has(threadId) ? Option.some(makeThreadDetail(threadId)) : Option.none(),
        ),
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({
            id: "project-1",
            kind: "project",
            workspaceRoot: "/work/repo",
          }),
        ),
    } as unknown as ProjectionSnapshotQueryShape,
    providerAdapterRegistry: {
      getByProvider: () =>
        Effect.succeed({
          readThread: () => Effect.succeed({ threadId: asThreadId("thread-1"), turns: [] }),
          ...(input?.withReadExternalThread === true ? { readExternalThread } : {}),
        }),
    } as unknown as ProviderAdapterRegistryShape,
    providerService: { startSession, stopSession } as unknown as ProviderServiceShape,
    providerSessionDirectory: {
      listBindings: () => Effect.succeed(currentBindings),
    } as unknown as ProviderSessionDirectoryShape,
    serverSettings: {
      getSnapshot: Effect.succeed({
        revision: 0,
        migrationVersion: 1,
        settings: input?.settings ?? DEFAULT_SERVER_SETTINGS,
      }),
    } as unknown as ServerSettingsShape,
    projectionThreadSessionRepository,
  });

  return {
    dispatch,
    handler,
    readExternalThread,
    sessionMappings,
    setBindings: (bindings: ReadonlyArray<BindingFixture>) => {
      currentBindings = bindings;
    },
    startSession,
    stopSession,
  };
}

describe("makeImportThreadHandler duplicate-import guard", () => {
  it("returns the already-imported thread when a binding exists and the thread is alive", async () => {
    const { dispatch, handler, startSession } = makeHarness({
      knownThreadIds: ["thread-1", "thread-bound"],
      bindings: [
        {
          threadId: asThreadId("thread-bound"),
          provider: "codex",
          resumeCursor: { threadId: "ext-1" },
        },
      ],
    });

    const result = await Effect.runPromise(
      handler({ threadId: asThreadId("thread-1"), externalId: "ext-1" }),
    );

    expect(result).toEqual({ threadId: asThreadId("thread-bound"), alreadyImported: true });
    expect(startSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("imports when no binding exists for the external id", async () => {
    const { dispatch, handler, startSession } = makeHarness({
      bindings: [
        {
          threadId: asThreadId("thread-other"),
          provider: "codex",
          resumeCursor: { threadId: "ext-other" },
        },
        {
          threadId: asThreadId("thread-claude"),
          provider: "claudeAgent",
          resumeCursor: { resume: "ext-1" },
        },
      ],
    });

    const result = await Effect.runPromise(
      handler({ threadId: asThreadId("thread-1"), externalId: "ext-1" }),
    );

    expect(result).toEqual({ threadId: asThreadId("thread-1") });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(startSession).toHaveBeenCalledWith(
      asThreadId("thread-1"),
      expect.objectContaining({ resumeCursor: { threadId: "ext-1" } }),
    );
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "thread.session.set" }));
  });

  it("imports when the bound thread no longer exists in the projection", async () => {
    const { handler, startSession } = makeHarness({
      knownThreadIds: ["thread-1"],
      bindings: [
        {
          threadId: asThreadId("thread-deleted"),
          provider: "codex",
          resumeCursor: { threadId: "ext-1" },
        },
      ],
    });

    const result = await Effect.runPromise(
      handler({ threadId: asThreadId("thread-1"), externalId: "ext-1" }),
    );

    expect(result).toEqual({ threadId: asThreadId("thread-1") });
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("returns alreadyImported via the projection mapping with no runtime binding present", async () => {
    const { dispatch, handler, startSession } = makeHarness({
      knownThreadIds: ["thread-1", "thread-bound"],
      mappings: [{ provider: "codex", externalId: "ext-1", threadId: asThreadId("thread-bound") }],
    });

    const result = await Effect.runPromise(
      handler({ threadId: asThreadId("thread-1"), externalId: "ext-1" }),
    );

    expect(result).toEqual({ threadId: asThreadId("thread-bound"), alreadyImported: true });
    expect(startSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("regression: re-import after session-lifecycle binding cleanup returns alreadyImported", async () => {
    const { handler, sessionMappings, setBindings, startSession } = makeHarness({
      knownThreadIds: ["thread-1", "thread-2"],
    });

    const first = await Effect.runPromise(
      handler({ threadId: asThreadId("thread-1"), externalId: "ext-1" }),
    );
    expect(first).toEqual({ threadId: asThreadId("thread-1") });
    expect(startSession).toHaveBeenCalledTimes(1);
    // The import's thread.session.set carried the external id into the projection row
    // (simulated here); production would also hold a runtime binding.
    expect(sessionMappings.get("codex:ext-1")?.threadId).toBe(asThreadId("thread-1"));
    setBindings([
      { threadId: asThreadId("thread-1"), provider: "codex", resumeCursor: { threadId: "ext-1" } },
    ]);

    // Session-lifecycle cleanup deletes the ephemeral binding row.
    setBindings([]);

    const second = await Effect.runPromise(
      handler({ threadId: asThreadId("thread-2"), externalId: "ext-1" }),
    );
    expect(second).toEqual({ threadId: asThreadId("thread-1"), alreadyImported: true });
    expect(startSession).toHaveBeenCalledTimes(1);
  });

  it("dispatches thread.session.set with the external session id on a successful import", async () => {
    const { dispatch, handler, sessionMappings } = makeHarness();

    await Effect.runPromise(handler({ threadId: asThreadId("thread-1"), externalId: "ext-1" }));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.session.set", externalSessionId: "ext-1" }),
    );
    expect(sessionMappings.get("codex:ext-1")?.threadId).toBe(asThreadId("thread-1"));
  });
});

describe("makeImportThreadHandler title", () => {
  it("dispatches thread.meta.update with the provided title after a successful import", async () => {
    const { dispatch, handler } = makeHarness();

    await Effect.runPromise(
      handler({ threadId: asThreadId("thread-1"), externalId: "ext-1", title: "CLI session" }),
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.meta.update", title: "CLI session" }),
    );
  });

  it("does not dispatch a title update when no title is provided", async () => {
    const { dispatch, handler } = makeHarness();

    await Effect.runPromise(handler({ threadId: asThreadId("thread-1"), externalId: "ext-1" }));

    const metaUpdates = dispatch.mock.calls.filter(
      ([command]) => (command as { type?: string }).type === "thread.meta.update",
    );
    expect(metaUpdates).toEqual([]);
  });
});

describe("makeImportThreadHandler provider options", () => {
  it("passes configured provider options to the external thread read", async () => {
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          binaryPath: "/custom/codex",
          homePath: "/custom/codex-home",
        },
      },
    };
    const { handler, readExternalThread } = makeHarness({
      settings,
      withReadExternalThread: true,
    });

    await Effect.runPromise(handler({ threadId: asThreadId("thread-1"), externalId: "ext-1" }));

    expect(readExternalThread).toHaveBeenCalledWith({
      externalThreadId: "ext-1",
      cwd: "/work/repo",
      providerOptions: providerStartOptionsFromServerSettings(settings),
    });
    const calledInput = readExternalThread.mock.calls[0]?.[0] as {
      providerOptions?: { codex?: { binaryPath?: string; homePath?: string } };
    };
    expect(calledInput.providerOptions?.codex).toEqual({
      binaryPath: "/custom/codex",
      homePath: "/custom/codex-home",
    });
  });

  it("passes default provider options when no custom binary path is configured", async () => {
    const { handler, readExternalThread } = makeHarness({ withReadExternalThread: true });

    await Effect.runPromise(handler({ threadId: asThreadId("thread-1"), externalId: "ext-1" }));

    const calledInput = readExternalThread.mock.calls[0]?.[0] as {
      providerOptions?: { codex?: { binaryPath?: string; homePath?: string } };
    };
    expect(calledInput.providerOptions?.codex).toEqual({ binaryPath: "codex" });
  });
});
