// FILE: ExternalAutoImporter.test.ts
// Purpose: Sweep-level tests for the auto-import background task: setting read per tick
//   (enabled/disabled honored), first-run watermark seeding WITHOUT backfill, unbound +
//   newer-than-watermark imports through the shared batch handler, watermark
//   advancement, failure recording with cooldown, and cooldown gating the next sweep.
// Layer: Orchestration background task tests
// Depends on: Layers/ExternalAutoImporter (makeExternalAutoImportSweep), externalAutoImport.

import type {
  OrchestrationExternalSession,
  OrchestrationImportExternalThreadsInput,
  OrchestrationImportExternalThreadsResult,
} from "@synara/contracts";
import { DEFAULT_SERVER_SETTINGS, ThreadId } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ExternalAutoImportStateShape } from "../../persistence/Services/ExternalAutoImportState.ts";
import type { AutoImportFolderState } from "../externalAutoImport.ts";
import { makeExternalAutoImportSweep } from "./ExternalAutoImporter.ts";

const NOW_MS = Date.parse("2026-07-19T12:00:00.000Z");

function session(
  externalId: string,
  overrides: Partial<OrchestrationExternalSession> = {},
): OrchestrationExternalSession {
  return {
    provider: "codex",
    externalId,
    cwd: "/work/repo",
    title: null,
    updatedAt: "2026-07-19T10:00:00.000Z",
    createdAt: null,
    source: "cli",
    importedThreadId: null,
    ...overrides,
  };
}

function makeHarness(input?: {
  readonly autoImportEnabled?: boolean;
  readonly sessions?: ReadonlyArray<OrchestrationExternalSession>;
  readonly importExternalThreads?: (
    input: OrchestrationImportExternalThreadsInput,
  ) => OrchestrationImportExternalThreadsResult;
}) {
  const states = new Map<string, AutoImportFolderState>();
  let currentSessions: ReadonlyArray<OrchestrationExternalSession> = input?.sessions ?? [];
  const listExternalSessions = vi.fn(() => Effect.succeed({ sessions: currentSessions }));
  const importExternalThreads = vi.fn((body: OrchestrationImportExternalThreadsInput) =>
    Effect.succeed(
      input?.importExternalThreads?.(body) ?? {
        results: body.items.map((item) => ({
          externalId: item.externalId,
          status: "imported" as const,
          threadId: ThreadId.makeUnsafe(`thread-${item.externalId}`),
        })),
      },
    ),
  );
  let nowMs = NOW_MS;
  const autoImportState: ExternalAutoImportStateShape = {
    getFolderState: (folderCwd) => {
      const state = states.get(folderCwd);
      return Effect.succeed(state ? Option.some(state) : Option.none());
    },
    upsertFolderState: (state) => {
      states.set(state.folderCwd, state);
      return Effect.void;
    },
  };
  const sweep = makeExternalAutoImportSweep({
    listExternalSessions,
    importExternalThreads,
    autoImportState,
    serverSettings: {
      getSnapshot: Effect.succeed({
        revision: 0,
        migrationVersion: 1,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          externalSessions: { autoImportEnabled: input?.autoImportEnabled ?? true },
        },
      }),
    } as never,
    now: () => nowMs,
    platform: "darwin",
  });

  return {
    importExternalThreads,
    listExternalSessions,
    states,
    sweep,
    setNow: (value: number) => {
      nowMs = value;
    },
    setSessions: (sessions: ReadonlyArray<OrchestrationExternalSession>) => {
      currentSessions = sessions;
    },
  };
}

describe("makeExternalAutoImportSweep", () => {
  it("does nothing while the setting is disabled", async () => {
    const { importExternalThreads, listExternalSessions, states, sweep } = makeHarness({
      autoImportEnabled: false,
      sessions: [session("a", { importedThreadId: "thread-1" as never })],
    });

    await Effect.runPromise(sweep);

    expect(listExternalSessions).not.toHaveBeenCalled();
    expect(importExternalThreads).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });

  it("reads the setting every tick (toggle takes effect without restart)", async () => {
    let enabled = false;
    const states = new Map<string, AutoImportFolderState>();
    const listExternalSessions = vi.fn(() =>
      Effect.succeed({
        sessions: [session("a", { importedThreadId: "thread-1" as never })],
      }),
    );
    const sweep = makeExternalAutoImportSweep({
      listExternalSessions,
      importExternalThreads: vi.fn(() => Effect.succeed({ results: [] })),
      autoImportState: {
        getFolderState: () => Effect.succeed(Option.none()),
        upsertFolderState: (state) => {
          states.set(state.folderCwd, state);
          return Effect.void;
        },
      },
      serverSettings: {
        getSnapshot: Effect.suspend(() =>
          Effect.succeed({
            revision: 0,
            migrationVersion: 1,
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              externalSessions: { autoImportEnabled: enabled },
            },
          }),
        ),
      } as never,
      now: () => NOW_MS,
      platform: "darwin",
    });

    await Effect.runPromise(sweep);
    expect(listExternalSessions).not.toHaveBeenCalled();

    enabled = true;
    await Effect.runPromise(sweep);
    expect(listExternalSessions).toHaveBeenCalledTimes(1);
    expect(states.has("/work/repo")).toBe(true);
  });

  it("seeds the watermark on first run and imports nothing (no backfill)", async () => {
    const { importExternalThreads, states, sweep } = makeHarness({
      sessions: [
        session("bound", { importedThreadId: "thread-1" as never }),
        session("stock-1", { updatedAt: "2026-07-18T09:00:00.000Z" }),
        session("stock-2", { updatedAt: "2026-07-19T11:00:00.000Z" }),
      ],
    });

    await Effect.runPromise(sweep);

    expect(importExternalThreads).not.toHaveBeenCalled();
    expect(states.get("/work/repo")).toEqual({
      folderCwd: "/work/repo",
      lastSeenUpdatedAt: "2026-07-19T11:00:00.000Z",
      lastImportAt: null,
      lastError: null,
      consecutiveFailures: 0,
      cooldownUntil: null,
    });
  });

  it("imports only unbound sessions newer than the watermark and advances it", async () => {
    const bound = session("bound", { importedThreadId: "thread-1" as never });
    const old = session("old", { updatedAt: "2026-07-18T09:00:00.000Z" });
    const harness = makeHarness({ sessions: [bound, old] });

    // First tick seeds the watermark from the current snapshot (no backfill).
    await Effect.runPromise(harness.sweep);
    // A NEW session appears afterwards; the next tick imports exactly it.
    harness.setSessions([
      bound,
      old,
      session("new", { updatedAt: "2026-07-19T11:30:00.000Z", title: "Fresh session" }),
      session("also-old", { updatedAt: "2026-07-18T10:00:00.000Z" }),
    ]);
    harness.setNow(NOW_MS + 5 * 60_000);
    await Effect.runPromise(harness.sweep);

    expect(harness.importExternalThreads).toHaveBeenCalledTimes(1);
    const body = harness.importExternalThreads.mock.calls[0]?.[0];
    expect(body?.items).toEqual([
      {
        provider: "codex",
        externalId: "new",
        cwd: "/work/repo",
        title: "Fresh session",
      },
    ]);
    expect(harness.states.get("/work/repo")).toEqual({
      folderCwd: "/work/repo",
      lastSeenUpdatedAt: "2026-07-19T11:30:00.000Z",
      lastImportAt: new Date(NOW_MS + 5 * 60_000).toISOString(),
      lastError: null,
      consecutiveFailures: 0,
      cooldownUntil: null,
    });
  });

  it("ignores folders with no imported sessions and sessions without cwd", async () => {
    const { importExternalThreads, states, sweep } = makeHarness({
      sessions: [
        session("unbound-1"),
        session("no-cwd", { cwd: null, importedThreadId: "thread-1" as never }),
      ],
    });

    await Effect.runPromise(sweep);

    expect(importExternalThreads).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });

  it("records failures with cooldown and skips the folder until it elapses", async () => {
    const bound = session("bound", { importedThreadId: "thread-1" as never });
    const harness = makeHarness({
      sessions: [bound],
      importExternalThreads: (body) => ({
        results: body.items.map((item) => ({
          externalId: item.externalId,
          status: "failed" as const,
          error: "codex app-server unavailable",
        })),
      }),
    });

    await Effect.runPromise(harness.sweep); // seed
    harness.setSessions([bound, session("new", { updatedAt: "2026-07-19T11:30:00.000Z" })]);
    harness.setNow(NOW_MS + 5 * 60_000);
    await Effect.runPromise(harness.sweep); // import fails

    const failed = harness.states.get("/work/repo");
    expect(failed?.consecutiveFailures).toBe(1);
    expect(failed?.lastError).toBe("codex app-server unavailable");
    expect(failed?.cooldownUntil).toBe(new Date(NOW_MS + 10 * 60_000).toISOString());
    // The watermark still advanced past the failed session (no infinite retry).
    expect(failed?.lastSeenUpdatedAt).toBe("2026-07-19T11:30:00.000Z");

    // Next sweep inside the cooldown window: no import attempt at all.
    harness.importExternalThreads.mockClear();
    harness.setNow(NOW_MS + 12 * 60_000);
    await Effect.runPromise(harness.sweep);
    expect(harness.importExternalThreads).not.toHaveBeenCalled();
  });

  it("treats a wholesale batch failure like per-item failures", async () => {
    const bound = session("bound", { importedThreadId: "thread-1" as never });
    const states = new Map<string, AutoImportFolderState>();
    let currentSessions: ReadonlyArray<OrchestrationExternalSession> = [bound];
    const listExternalSessions = vi.fn(() => Effect.succeed({ sessions: currentSessions }));
    const sweep = makeExternalAutoImportSweep({
      listExternalSessions,
      importExternalThreads: vi.fn(() => Effect.fail(new Error("engine unavailable"))),
      autoImportState: {
        getFolderState: (folderCwd) => {
          const state = states.get(folderCwd);
          return Effect.succeed(state ? Option.some(state) : Option.none());
        },
        upsertFolderState: (state) => {
          states.set(state.folderCwd, state);
          return Effect.void;
        },
      },
      serverSettings: {
        getSnapshot: Effect.succeed({
          revision: 0,
          migrationVersion: 1,
          settings: { ...DEFAULT_SERVER_SETTINGS, externalSessions: { autoImportEnabled: true } },
        }),
      } as never,
      now: () => NOW_MS,
      platform: "darwin",
    });

    await Effect.runPromise(sweep); // seed
    currentSessions = [bound, session("new", { updatedAt: "2026-07-19T11:30:00.000Z" })];
    await Effect.runPromise(sweep); // import attempt fails wholesale

    const state = states.get("/work/repo");
    expect(state?.consecutiveFailures).toBe(1);
    expect(state?.lastError).toBe("engine unavailable");
    expect(state?.cooldownUntil).toBe(new Date(NOW_MS + 5 * 60_000).toISOString());
  });
});
