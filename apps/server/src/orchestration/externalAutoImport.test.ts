// FILE: externalAutoImport.test.ts
// Purpose: Unit tests for the auto-import decision logic: already-imported folder
//   derivation, watermark planning (no backfill on first run, unbound-only + newer-only
//   candidates, cooldown skip), state transitions after runs, and the cooldown schedule.
// Layer: Orchestration pure derivation tests
// Depends on: externalAutoImport.

import type { OrchestrationExternalSession } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  autoImportCooldownMs,
  autoImportStateAfterRun,
  autoImportStateForWatermarkAdvance,
  deriveAlreadyImportedFolders,
  planAutoImportFolder,
} from "./externalAutoImport.ts";

const NOW_MS = Date.parse("2026-07-19T12:00:00.000Z");
const NOW_ISO = "2026-07-19T12:00:00.000Z";

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

describe("deriveAlreadyImportedFolders", () => {
  it("collects normalized cwds of imported sessions only", () => {
    const folders = deriveAlreadyImportedFolders(
      [
        session("a", { importedThreadId: "thread-1" as never }),
        session("b"), // unbound: does not qualify the folder
        session("c", { cwd: "/other/place/", importedThreadId: "thread-2" as never }),
        session("d", { cwd: null, importedThreadId: "thread-3" as never }), // no cwd: skipped
      ],
      { platform: "darwin" },
    );

    expect([...folders].sort()).toEqual(["/other/place", "/work/repo"]);
  });
});

describe("planAutoImportFolder", () => {
  const folderSessions = [
    session("bound", { importedThreadId: "thread-1" as never }),
    session("old", { updatedAt: "2026-07-18T10:00:00.000Z" }),
    session("new", { updatedAt: "2026-07-19T11:00:00.000Z" }),
    session("no-timestamp", { updatedAt: null }),
  ];

  it("seeds the watermark on first run and imports nothing (no backfill)", () => {
    const plan = planAutoImportFolder({
      folderCwd: "/work/repo",
      sessions: folderSessions,
      state: null,
      nowMs: NOW_MS,
    });

    expect(plan.seeded).toBe(true);
    expect(plan.sessionsToImport).toEqual([]);
    expect(plan.maxSeenUpdatedAt).toBe("2026-07-19T11:00:00.000Z");
  });

  it("selects unbound sessions newer than the watermark, oldest first", () => {
    const plan = planAutoImportFolder({
      folderCwd: "/work/repo",
      sessions: [...folderSessions, session("newest", { updatedAt: "2026-07-19T11:30:00.000Z" })],
      state: {
        lastSeenUpdatedAt: "2026-07-19T10:30:00.000Z",
        consecutiveFailures: 0,
        cooldownUntil: null,
      },
      nowMs: NOW_MS,
    });

    expect(plan.sessionsToImport.map((entry) => entry.externalId)).toEqual(["new", "newest"]);
  });

  it("imports every unbound parseable session when the watermark is null", () => {
    const plan = planAutoImportFolder({
      folderCwd: "/work/repo",
      sessions: folderSessions,
      state: { lastSeenUpdatedAt: null, consecutiveFailures: 0, cooldownUntil: null },
      nowMs: NOW_MS,
    });

    expect(plan.sessionsToImport.map((entry) => entry.externalId)).toEqual(["old", "new"]);
  });

  it("skips the folder while the cooldown is active", () => {
    const plan = planAutoImportFolder({
      folderCwd: "/work/repo",
      sessions: folderSessions,
      state: {
        lastSeenUpdatedAt: "2026-07-18T10:00:00.000Z",
        consecutiveFailures: 1,
        cooldownUntil: "2026-07-19T12:05:00.000Z",
      },
      nowMs: NOW_MS,
    });

    expect(plan.inCooldown).toBe(true);
    expect(plan.sessionsToImport).toEqual([]);
    expect(plan.maxSeenUpdatedAt).toBe("2026-07-18T10:00:00.000Z");
  });

  it("runs again once the cooldown has elapsed", () => {
    const plan = planAutoImportFolder({
      folderCwd: "/work/repo",
      sessions: folderSessions,
      state: {
        lastSeenUpdatedAt: "2026-07-19T10:30:00.000Z",
        consecutiveFailures: 1,
        cooldownUntil: "2026-07-19T11:55:00.000Z",
      },
      nowMs: NOW_MS,
    });

    expect(plan.inCooldown).toBe(false);
    expect(plan.sessionsToImport.map((entry) => entry.externalId)).toEqual(["new"]);
  });
});

describe("autoImportCooldownMs", () => {
  it("follows the 5m -> 15m -> 1h -> 6h schedule with a 6h cap", () => {
    expect(autoImportCooldownMs(1)).toBe(5 * 60_000);
    expect(autoImportCooldownMs(2)).toBe(15 * 60_000);
    expect(autoImportCooldownMs(3)).toBe(60 * 60_000);
    expect(autoImportCooldownMs(4)).toBe(6 * 60 * 60_000);
    expect(autoImportCooldownMs(12)).toBe(6 * 60 * 60_000);
    expect(autoImportCooldownMs(0)).toBe(5 * 60_000);
  });
});

describe("autoImportStateAfterRun", () => {
  const previous = {
    lastSeenUpdatedAt: "2026-07-19T10:00:00.000Z",
    consecutiveFailures: 2,
    cooldownUntil: "2026-07-19T11:00:00.000Z",
  };

  it("success advances the watermark and resets failure bookkeeping", () => {
    const state = autoImportStateAfterRun({
      previous,
      folderCwd: "/work/repo",
      maxSeenUpdatedAt: "2026-07-19T11:30:00.000Z",
      nowIso: NOW_ISO,
      nowMs: NOW_MS,
      failureMessage: null,
    });

    expect(state).toEqual({
      folderCwd: "/work/repo",
      lastSeenUpdatedAt: "2026-07-19T11:30:00.000Z",
      lastImportAt: NOW_ISO,
      lastError: null,
      consecutiveFailures: 0,
      cooldownUntil: null,
    });
  });

  it("failure advances the watermark but records error, count, and backoff", () => {
    const state = autoImportStateAfterRun({
      previous,
      folderCwd: "/work/repo",
      maxSeenUpdatedAt: "2026-07-19T11:30:00.000Z",
      nowIso: NOW_ISO,
      nowMs: NOW_MS,
      failureMessage: "codex app-server unavailable",
    });

    expect(state.lastSeenUpdatedAt).toBe("2026-07-19T11:30:00.000Z");
    expect(state.lastError).toBe("codex app-server unavailable");
    expect(state.consecutiveFailures).toBe(3);
    expect(state.cooldownUntil).toBe(new Date(NOW_MS + 60 * 60_000).toISOString());
    expect(state.lastImportAt).toBe(NOW_ISO);
  });
});

describe("autoImportStateForWatermarkAdvance", () => {
  it("advances the watermark while preserving failure bookkeeping and last import time", () => {
    const state = autoImportStateForWatermarkAdvance({
      previous: {
        lastSeenUpdatedAt: "2026-07-19T10:00:00.000Z",
        lastImportAt: "2026-07-19T10:05:00.000Z",
        lastError: "boom",
        consecutiveFailures: 1,
        cooldownUntil: "2026-07-19T12:05:00.000Z",
      },
      folderCwd: "/work/repo",
      maxSeenUpdatedAt: "2026-07-19T11:30:00.000Z",
    });

    expect(state).toEqual({
      folderCwd: "/work/repo",
      lastSeenUpdatedAt: "2026-07-19T11:30:00.000Z",
      lastImportAt: "2026-07-19T10:05:00.000Z",
      lastError: "boom",
      consecutiveFailures: 1,
      cooldownUntil: "2026-07-19T12:05:00.000Z",
    });
  });
});
