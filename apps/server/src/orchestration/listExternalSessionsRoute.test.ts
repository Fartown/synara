// FILE: listExternalSessionsRoute.test.ts
// Purpose: Verifies external session discovery merging, binding joins, caching, and
//   per-thread external session resolution.
// Layer: Orchestration query handler tests
// Depends on: listExternalSessionsRoute.

import { DEFAULT_SERVER_SETTINGS, ThreadId, type ServerSettings } from "@synara/contracts";
import { providerStartOptionsFromServerSettings } from "@synara/shared/serverSettings";
import { Duration, Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";

import type { ClaudeSessionSummary } from "../claudeSessionDiscovery.ts";
import type { ProjectionThreadSessionRepositoryShape } from "../persistence/Services/ProjectionThreadSessions.ts";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "../provider/Services/ProviderSessionDirectory";
import type { ServerSettingsShape } from "../serverSettings.ts";
import {
  EXTERNAL_SESSION_DISCOVERY_TIMEOUT_MS,
  makeGetThreadExternalSessionHandler,
  makeListExternalSessionsHandler,
} from "./listExternalSessionsRoute.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function makeHarness(input: {
  readonly codexThreads?: ReadonlyArray<{
    readonly id: string;
    readonly preview: string;
    readonly cwd?: string;
    readonly source?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  }>;
  readonly codexError?: unknown;
  readonly codexHang?: boolean;
  readonly claudeSessions?: ReadonlyArray<ClaudeSessionSummary>;
  readonly claudeError?: unknown;
  readonly claudeHang?: boolean;
  readonly bindings?: ReadonlyArray<ProviderRuntimeBinding>;
  readonly durableRows?: ReadonlyArray<{
    readonly provider: string;
    readonly externalId: string;
    readonly threadId: ThreadId;
  }>;
  readonly settings?: ServerSettings;
}) {
  const codexList = vi.fn((_input?: unknown) =>
    input.codexHang === true
      ? Effect.never
      : input.codexError !== undefined
        ? Effect.fail(input.codexError)
        : Effect.succeed({ threads: input.codexThreads ?? [], nextCursor: null }),
  );
  const claudeList = vi.fn(
    (): Promise<ReadonlyArray<ClaudeSessionSummary>> =>
      input.claudeHang === true
        ? new Promise<ReadonlyArray<ClaudeSessionSummary>>(() => {})
        : input.claudeError !== undefined
          ? Promise.reject(input.claudeError)
          : Promise.resolve(input.claudeSessions ?? []),
  );
  let nowMs = 1_000_000;

  const providerAdapterRegistry = {
    getByProvider: () => Effect.succeed({ listExternalThreads: codexList }),
  } as unknown as ProviderAdapterRegistryShape;
  const providerSessionDirectory = {
    listBindings: () => Effect.succeed(input.bindings ?? []),
  } as unknown as ProviderSessionDirectoryShape;
  const serverSettings = {
    getSnapshot: Effect.succeed({
      revision: 0,
      migrationVersion: 1,
      settings: input.settings ?? DEFAULT_SERVER_SETTINGS,
    }),
  } as unknown as ServerSettingsShape;
  const projectionThreadSessionRepository = {
    listProviderThreadIds: () =>
      Effect.succeed(
        (input.durableRows ?? []).map((row) => ({
          threadId: row.threadId,
          providerName: row.provider,
          providerThreadId: row.externalId,
        })),
      ),
  } as unknown as ProjectionThreadSessionRepositoryShape;

  const handler = makeListExternalSessionsHandler({
    providerAdapterRegistry,
    providerSessionDirectory,
    serverSettings,
    projectionThreadSessionRepository,
    listClaudeSessions: claudeList,
    now: () => nowMs,
  });

  return {
    claudeList,
    codexList,
    handler,
    setNow: (value: number) => {
      nowMs = value;
    },
  };
}

describe("makeListExternalSessionsHandler", () => {
  it("lists both providers and joins import bindings", async () => {
    const { handler } = makeHarness({
      codexThreads: [
        {
          id: "codex-1",
          preview: "Fix flaky test",
          cwd: "/work/repo",
          source: "cli",
          updatedAt: "2026-07-02T10:00:00.000Z",
        },
        { id: "codex-2", preview: "", updatedAt: "2026-07-01T10:00:00.000Z" },
      ],
      claudeSessions: [
        {
          sessionId: "claude-1",
          cwd: "/work/other",
          title: "Refactor auth",
          updatedAt: "2026-07-03T10:00:00.000Z",
        },
      ],
      bindings: [
        {
          threadId: asThreadId("thread-codex"),
          provider: "codex",
          resumeCursor: { threadId: "codex-1" },
        },
        {
          threadId: asThreadId("thread-claude"),
          provider: "claudeAgent",
          resumeCursor: { resume: "claude-1" },
        },
        { threadId: asThreadId("thread-broken"), provider: "codex", resumeCursor: "junk" },
      ],
    });

    const result = await Effect.runPromise(handler({}));

    expect(result.sessions).toEqual([
      {
        provider: "claudeAgent",
        externalId: "claude-1",
        cwd: "/work/other",
        title: "Refactor auth",
        updatedAt: "2026-07-03T10:00:00.000Z",
        createdAt: null,
        source: null,
        importedThreadId: asThreadId("thread-claude"),
      },
      {
        provider: "codex",
        externalId: "codex-1",
        cwd: "/work/repo",
        title: "Fix flaky test",
        updatedAt: "2026-07-02T10:00:00.000Z",
        createdAt: null,
        source: "cli",
        importedThreadId: asThreadId("thread-codex"),
      },
      {
        provider: "codex",
        externalId: "codex-2",
        cwd: null,
        title: null,
        updatedAt: "2026-07-01T10:00:00.000Z",
        createdAt: null,
        source: null,
        importedThreadId: null,
      },
    ]);
  });

  it("tolerates one provider failing and still returns the other", async () => {
    const { handler } = makeHarness({
      codexError: new Error("codex app-server unavailable"),
      claudeSessions: [{ sessionId: "claude-1", title: "Solo" }],
    });

    const result = await Effect.runPromise(handler({}));

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ provider: "claudeAgent", externalId: "claude-1" });
  });

  // Runs the handler against the TestClock and advances past the discovery timeout
  // without sleeping in real time.
  const runHandlerPastDiscoveryTimeout = (
    handler: ReturnType<typeof makeListExternalSessionsHandler>,
    input: Parameters<ReturnType<typeof makeListExternalSessionsHandler>>[0],
  ) =>
    Effect.gen(function* () {
      const fiber = yield* handler(input).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(EXTERNAL_SESSION_DISCOVERY_TIMEOUT_MS + 1));
      yield* Effect.yieldNow;
      return yield* Fiber.join(fiber);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer()));

  it("returns the healthy provider's sessions when another provider hangs past the timeout", async () => {
    const { handler } = makeHarness({
      codexHang: true,
      claudeSessions: [{ sessionId: "claude-1", title: "Solo" }],
    });

    const result = await Effect.runPromise(runHandlerPastDiscoveryTimeout(handler, {}));

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({ provider: "claudeAgent", externalId: "claude-1" });
  });

  it("responds within the timeout even when every provider hangs", async () => {
    const { handler } = makeHarness({ codexHang: true, claudeHang: true });

    const result = await Effect.runPromise(runHandlerPastDiscoveryTimeout(handler, {}));

    expect(result.sessions).toEqual([]);
  });

  it("queries only the requested providers", async () => {
    const { claudeList, codexList, handler } = makeHarness({
      codexThreads: [{ id: "codex-1", preview: "x" }],
      claudeSessions: [{ sessionId: "claude-1" }],
    });

    const result = await Effect.runPromise(handler({ providers: ["codex"] }));

    expect(codexList).toHaveBeenCalledTimes(1);
    expect(claudeList).not.toHaveBeenCalled();
    expect(result.sessions.map((session) => session.externalId)).toEqual(["codex-1"]);
  });

  it("passes the configured codex binary path options to codex discovery", async () => {
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
    const { codexList, handler } = makeHarness({ settings, claudeSessions: [] });

    await Effect.runPromise(handler({ providers: ["codex"] }));

    expect(codexList).toHaveBeenCalledWith({
      providerOptions: providerStartOptionsFromServerSettings(settings),
    });
    const calledInput = codexList.mock.calls[0]?.[0] as {
      providerOptions?: { codex?: { binaryPath?: string; homePath?: string } };
    };
    expect(calledInput.providerOptions?.codex).toEqual({
      binaryPath: "/custom/codex",
      homePath: "/custom/codex-home",
    });
  });

  it("passes the default codex options when no custom binary path is configured", async () => {
    const { codexList, handler } = makeHarness({ claudeSessions: [] });

    await Effect.runPromise(handler({ providers: ["codex"] }));

    const calledInput = codexList.mock.calls[0]?.[0] as {
      providerOptions?: { codex?: { binaryPath?: string; homePath?: string } };
    };
    expect(calledInput.providerOptions?.codex).toEqual({ binaryPath: "codex" });
  });

  it("caches discovery for 60s and bypasses the cache on forceRefresh", async () => {
    const { claudeList, codexList, handler, setNow } = makeHarness({
      codexThreads: [{ id: "codex-1", preview: "x" }],
      claudeSessions: [],
    });

    await Effect.runPromise(handler({}));
    await Effect.runPromise(handler({}));
    expect(codexList).toHaveBeenCalledTimes(1);
    expect(claudeList).toHaveBeenCalledTimes(1);

    setNow(1_000_000 + 30_000);
    await Effect.runPromise(handler({}));
    expect(codexList).toHaveBeenCalledTimes(1);

    setNow(1_000_000 + 61_000);
    await Effect.runPromise(handler({}));
    expect(codexList).toHaveBeenCalledTimes(2);

    await Effect.runPromise(handler({ forceRefresh: true }));
    expect(codexList).toHaveBeenCalledTimes(3);
  });
});

describe("makeGetThreadExternalSessionHandler", () => {
  function makeDirectory(binding: ProviderRuntimeBinding | null) {
    return {
      getBinding: () => Effect.succeed(binding === null ? Option.none() : Option.some(binding)),
    } as unknown as ProviderSessionDirectoryShape;
  }

  it("resolves a Codex external session with a resume command", async () => {
    const handler = makeGetThreadExternalSessionHandler({
      providerSessionDirectory: makeDirectory({
        threadId: asThreadId("thread-1"),
        provider: "codex",
        resumeCursor: { threadId: "codex-1" },
      }),
    });

    await expect(Effect.runPromise(handler({ threadId: asThreadId("thread-1") }))).resolves.toEqual(
      {
        provider: "codex",
        externalId: "codex-1",
        resumeCommand: "codex resume codex-1",
      },
    );
  });

  it("resolves a Claude external session with a resume command", async () => {
    const handler = makeGetThreadExternalSessionHandler({
      providerSessionDirectory: makeDirectory({
        threadId: asThreadId("thread-1"),
        provider: "claudeAgent",
        resumeCursor: { resume: "claude-1" },
      }),
    });

    await expect(Effect.runPromise(handler({ threadId: asThreadId("thread-1") }))).resolves.toEqual(
      {
        provider: "claudeAgent",
        externalId: "claude-1",
        resumeCommand: "claude --resume claude-1",
      },
    );
  });

  it("returns null when there is no binding, no cursor, or an unsupported provider", async () => {
    await expect(
      Effect.runPromise(
        makeGetThreadExternalSessionHandler({ providerSessionDirectory: makeDirectory(null) })({
          threadId: asThreadId("thread-1"),
        }),
      ),
    ).resolves.toBeNull();

    await expect(
      Effect.runPromise(
        makeGetThreadExternalSessionHandler({
          providerSessionDirectory: makeDirectory({
            threadId: asThreadId("thread-1"),
            provider: "codex",
            resumeCursor: null,
          }),
        })({ threadId: asThreadId("thread-1") }),
      ),
    ).resolves.toBeNull();

    await expect(
      Effect.runPromise(
        makeGetThreadExternalSessionHandler({
          providerSessionDirectory: makeDirectory({
            threadId: asThreadId("thread-1"),
            provider: "droid",
            resumeCursor: { schemaVersion: 1, sessionId: "d-1" },
          }),
        })({ threadId: asThreadId("thread-1") }),
      ),
    ).resolves.toBeNull();
  });
});
