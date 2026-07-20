// FILE: externalSessions.test.ts
// Purpose: Verifies resume-cursor extraction and binding joins for external session discovery.
// Layer: Orchestration mapping tests
// Depends on: externalSessions.

import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildExternalSessionIndex,
  externalSessionIndexKey,
  extractExternalSessionId,
  findImportedThreadIdForExternalSession,
  resumeCommandForExternalSession,
} from "./externalSessions.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

describe("extractExternalSessionId", () => {
  it("extracts the Codex thread id from a resume cursor", () => {
    expect(extractExternalSessionId("codex", { threadId: "codex-thread-1" })).toBe(
      "codex-thread-1",
    );
  });

  it("extracts the Claude session id from a resume cursor", () => {
    expect(extractExternalSessionId("claudeAgent", { resume: "claude-session-1" })).toBe(
      "claude-session-1",
    );
  });

  it("returns undefined for malformed cursors and unsupported providers", () => {
    expect(extractExternalSessionId("codex", null)).toBeUndefined();
    expect(extractExternalSessionId("codex", undefined)).toBeUndefined();
    expect(extractExternalSessionId("codex", "thread-1")).toBeUndefined();
    expect(extractExternalSessionId("codex", [{ threadId: "x" }])).toBeUndefined();
    expect(extractExternalSessionId("codex", {})).toBeUndefined();
    expect(extractExternalSessionId("codex", { threadId: "" })).toBeUndefined();
    expect(extractExternalSessionId("codex", { threadId: 42 })).toBeUndefined();
    expect(extractExternalSessionId("claudeAgent", { threadId: "wrong-key" })).toBeUndefined();
    expect(extractExternalSessionId("droid", { sessionId: "s-1" })).toBeUndefined();
  });
});

describe("findImportedThreadIdForExternalSession", () => {
  const bindings = [
    { threadId: asThreadId("thread-a"), provider: "codex", resumeCursor: { threadId: "ext-1" } },
    {
      threadId: asThreadId("thread-b"),
      provider: "claudeAgent",
      resumeCursor: { resume: "ext-2" },
    },
    { threadId: asThreadId("thread-c"), provider: "codex", resumeCursor: null },
  ] as const;

  it("finds the bound thread for a matching provider and external id", () => {
    expect(findImportedThreadIdForExternalSession(bindings, "codex", "ext-1")).toBe(
      asThreadId("thread-a"),
    );
    expect(findImportedThreadIdForExternalSession(bindings, "claudeAgent", "ext-2")).toBe(
      asThreadId("thread-b"),
    );
  });

  it("returns undefined when nothing matches", () => {
    expect(findImportedThreadIdForExternalSession(bindings, "codex", "ext-2")).toBeUndefined();
    expect(
      findImportedThreadIdForExternalSession(bindings, "claudeAgent", "ext-1"),
    ).toBeUndefined();
    expect(findImportedThreadIdForExternalSession([], "codex", "ext-1")).toBeUndefined();
  });
});

describe("buildExternalSessionIndex", () => {
  it("indexes bindings by provider and external id, skipping malformed rows", () => {
    const index = buildExternalSessionIndex([
      { threadId: asThreadId("thread-a"), provider: "codex", resumeCursor: { threadId: "ext-1" } },
      {
        threadId: asThreadId("thread-b"),
        provider: "claudeAgent",
        resumeCursor: { resume: "ext-2" },
      },
      { threadId: asThreadId("thread-c"), provider: "codex", resumeCursor: "not-a-record" },
      { threadId: asThreadId("thread-d"), provider: "droid", resumeCursor: { sessionId: "s" } },
    ]);

    expect(index.get(externalSessionIndexKey("codex", "ext-1"))).toBe(asThreadId("thread-a"));
    expect(index.get(externalSessionIndexKey("claudeAgent", "ext-2"))).toBe(asThreadId("thread-b"));
    expect(index.size).toBe(2);
  });

  it("keeps the first binding when two rows point at the same external session", () => {
    const index = buildExternalSessionIndex([
      { threadId: asThreadId("thread-a"), provider: "codex", resumeCursor: { threadId: "ext-1" } },
      { threadId: asThreadId("thread-b"), provider: "codex", resumeCursor: { threadId: "ext-1" } },
    ]);
    expect(index.get(externalSessionIndexKey("codex", "ext-1"))).toBe(asThreadId("thread-a"));
  });
});

describe("resumeCommandForExternalSession", () => {
  it("builds provider CLI resume commands", () => {
    expect(resumeCommandForExternalSession("codex", "ext-1")).toBe("codex resume ext-1");
    expect(resumeCommandForExternalSession("claudeAgent", "ext-2")).toBe("claude --resume ext-2");
  });
});
