// FILE: externalSessionPreviewStore.test.ts
// Purpose: Unit tests for the external session preview selection store and the
//   close-on-navigate rule ("who wins": any route thread id change closes the preview).
// Layer: Web pure-logic tests

import { beforeEach, describe, expect, it } from "vitest";

import type { OrchestrationExternalSession } from "@synara/contracts";

import {
  shouldCloseExternalSessionPreviewOnRouteChange,
  useExternalSessionPreviewStore,
} from "./externalSessionPreviewStore";

function session(externalId: string): OrchestrationExternalSession {
  return {
    provider: "codex",
    externalId,
    cwd: "/work/repo",
    title: null,
    updatedAt: null,
    createdAt: null,
    source: null,
    importedThreadId: null,
  };
}

describe("useExternalSessionPreviewStore", () => {
  beforeEach(() => {
    useExternalSessionPreviewStore.getState().closePreview();
  });

  it("opens with the session and its group-resolved import target, then closes", () => {
    const project = { id: "project-1" } as never;
    useExternalSessionPreviewStore.getState().openPreview({ session: session("a"), project });

    expect(useExternalSessionPreviewStore.getState().previewSelection?.session.externalId).toBe(
      "a",
    );
    expect(useExternalSessionPreviewStore.getState().previewSelection?.project).toBe(project);

    useExternalSessionPreviewStore.getState().closePreview();
    expect(useExternalSessionPreviewStore.getState().previewSelection).toBeNull();
  });

  it("opening another session replaces the previous selection (latest wins)", () => {
    const store = useExternalSessionPreviewStore.getState();
    store.openPreview({ session: session("a"), project: null });
    store.openPreview({ session: session("b"), project: null });

    expect(useExternalSessionPreviewStore.getState().previewSelection?.session.externalId).toBe(
      "b",
    );
  });
});

describe("shouldCloseExternalSessionPreviewOnRouteChange", () => {
  it("closes on any thread id change, in either direction", () => {
    expect(shouldCloseExternalSessionPreviewOnRouteChange("thread-a", "thread-b")).toBe(true);
    expect(shouldCloseExternalSessionPreviewOnRouteChange("thread-a", null)).toBe(true);
    expect(shouldCloseExternalSessionPreviewOnRouteChange(null, "thread-a")).toBe(true);
  });

  it("stays open while the route thread id is stable", () => {
    expect(shouldCloseExternalSessionPreviewOnRouteChange("thread-a", "thread-a")).toBe(false);
    expect(shouldCloseExternalSessionPreviewOnRouteChange(null, null)).toBe(false);
  });
});
