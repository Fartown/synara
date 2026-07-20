// FILE: externalSessions.test.ts
// Purpose: Unit tests for the external session preview query options (cache key per
//          provider+externalId, 60s staleness) and the truncation notice builder.
// Layer: Web pure-logic tests

import { describe, expect, it } from "vitest";

import type { OrchestrationImportExternalThreadsItemResult } from "@synara/contracts";

import {
  countUnimportedExternalSessions,
  externalSessionBatchToastDescription,
  externalSessionBatchToastTitle,
  externalSessionGroupAutoImportCovered,
  externalSessionPreviewQueryOptions,
  externalSessionPreviewTruncationNotice,
  externalSessionsQueryKeys,
  summarizeExternalSessionBatchResults,
} from "./externalSessions";

describe("externalSessionsQueryKeys.preview", () => {
  it("keys the preview per provider and external id", () => {
    expect(externalSessionsQueryKeys.preview("codex", "abc-1")).toEqual([
      "orchestration",
      "externalSessions",
      "preview",
      "codex",
      "abc-1",
    ]);
    expect(externalSessionsQueryKeys.preview("claudeAgent", "abc-1")).not.toEqual(
      externalSessionsQueryKeys.preview("codex", "abc-1"),
    );
    expect(externalSessionsQueryKeys.preview("codex", "abc-2")).not.toEqual(
      externalSessionsQueryKeys.preview("codex", "abc-1"),
    );
  });
});

describe("externalSessionPreviewQueryOptions", () => {
  it("uses the per-session key and a 60s stale time matching the server cache", () => {
    const options = externalSessionPreviewQueryOptions({
      provider: "codex",
      externalId: "abc-1",
      cwd: "/work/repo",
    });

    expect(options.queryKey).toEqual(externalSessionsQueryKeys.preview("codex", "abc-1"));
    expect(options.staleTime).toBe(60_000);
    expect(options.enabled).toBe(true);
  });

  it("stays disabled until the drawer opens", () => {
    const options = externalSessionPreviewQueryOptions({
      provider: "claudeAgent",
      externalId: "abc-1",
      enabled: false,
    });

    expect(options.enabled).toBe(false);
  });
});

describe("externalSessionPreviewTruncationNotice", () => {
  it("returns null when the full history fits in the preview", () => {
    expect(externalSessionPreviewTruncationNotice({ shownTurns: 30, totalTurns: 30 })).toBeNull();
    expect(externalSessionPreviewTruncationNotice({ shownTurns: 2, totalTurns: 2 })).toBeNull();
    expect(externalSessionPreviewTruncationNotice({ shownTurns: 0, totalTurns: 0 })).toBeNull();
  });

  it("describes the visible window when the server truncated the history", () => {
    expect(externalSessionPreviewTruncationNotice({ shownTurns: 30, totalTurns: 42 })).toBe(
      "Showing the latest 30 of 42 turns.",
    );
    expect(externalSessionPreviewTruncationNotice({ shownTurns: 30, totalTurns: 31 })).toBe(
      "Showing the latest 30 of 31 turns.",
    );
  });
});

describe("countUnimportedExternalSessions", () => {
  it("counts only sessions without an imported thread binding", () => {
    expect(
      countUnimportedExternalSessions([
        { importedThreadId: null },
        { importedThreadId: "thread-1" as never },
        { importedThreadId: null },
      ]),
    ).toBe(2);
    expect(countUnimportedExternalSessions([])).toBe(0);
  });
});

describe("externalSessionGroupAutoImportCovered", () => {
  it("is covered only when the setting is on AND the group has an imported session", () => {
    const imported = { importedThreadId: "thread-1" as never };
    const unimported = { importedThreadId: null };

    expect(
      externalSessionGroupAutoImportCovered({
        autoImportEnabled: true,
        sessions: [unimported, imported],
      }),
    ).toBe(true);
    expect(
      externalSessionGroupAutoImportCovered({ autoImportEnabled: true, sessions: [unimported] }),
    ).toBe(false);
    expect(
      externalSessionGroupAutoImportCovered({ autoImportEnabled: false, sessions: [imported] }),
    ).toBe(false);
    expect(externalSessionGroupAutoImportCovered({ autoImportEnabled: true, sessions: [] })).toBe(
      false,
    );
  });
});

function batchResult(
  externalId: string,
  status: "imported" | "alreadyImported" | "failed",
  error?: string,
): OrchestrationImportExternalThreadsItemResult {
  return {
    externalId,
    status,
    ...(status === "failed" ? { error } : { threadId: `thread-${externalId}` as never }),
  };
}

describe("summarizeExternalSessionBatchResults", () => {
  it("counts per-item statuses and collects failure reasons", () => {
    const summary = summarizeExternalSessionBatchResults([
      batchResult("a1b2c3d4-session-1", "imported"),
      batchResult("e5f6a7b8-session-2", "alreadyImported"),
      batchResult("c9d0e1f2-session-3", "failed", "codex app-server unavailable"),
      batchResult("12345678-session-4", "failed"),
    ]);

    expect(summary.imported).toBe(1);
    expect(summary.alreadyImported).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.failures).toEqual([
      { externalId: "c9d0e1f2-session-3", error: "codex app-server unavailable" },
      { externalId: "12345678-session-4", error: "Import failed." },
    ]);
  });
});

describe("externalSessionBatchToastTitle", () => {
  it("lists only the outcomes that occurred", () => {
    expect(
      externalSessionBatchToastTitle({ imported: 3, alreadyImported: 1, failed: 2, failures: [] }),
    ).toBe("Imported 3, skipped 1 already-imported, 2 failed");
    expect(
      externalSessionBatchToastTitle({ imported: 5, alreadyImported: 0, failed: 0, failures: [] }),
    ).toBe("Imported 5");
    expect(
      externalSessionBatchToastTitle({ imported: 0, alreadyImported: 2, failed: 0, failures: [] }),
    ).toBe("Imported 0, skipped 2 already-imported");
  });
});

describe("externalSessionBatchToastDescription", () => {
  it("is undefined when nothing failed", () => {
    expect(
      externalSessionBatchToastDescription({
        imported: 2,
        alreadyImported: 0,
        failed: 0,
        failures: [],
      }),
    ).toBeUndefined();
  });

  it("lists shortened failure reasons and truncates beyond three", () => {
    const failures = Array.from({ length: 5 }, (_, index) => ({
      externalId: `abcdef123456-session-${index}`,
      error: `reason ${index}`,
    }));
    const description = externalSessionBatchToastDescription({
      imported: 0,
      alreadyImported: 0,
      failed: 5,
      failures,
    });

    expect(description).toBe(
      ["abcdef12…: reason 0", "abcdef12…: reason 1", "abcdef12…: reason 2", "+2 more"].join("\n"),
    );
  });
});
