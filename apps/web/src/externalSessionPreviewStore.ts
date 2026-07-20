// FILE: externalSessionPreviewStore.ts
// Purpose: In-memory selection state for the external session preview hosted in the
//   MAIN content area (not a URL route — deliberately in-memory, like thread
//   multi-selection). The chat layout renders the preview panel in place of the route
//   Outlet while a selection is set, so thread content and a preview can never stack.
// Layer: Web UI state
// Exports: useExternalSessionPreviewStore, shouldCloseExternalSessionPreviewOnRouteChange.

import type { OrchestrationExternalSession } from "@synara/contracts";
import { create } from "zustand";

import type { Project } from "./types";

export interface ExternalSessionPreviewSelection {
  readonly session: OrchestrationExternalSession;
  /**
   * The group-resolved import target the sidebar row already computed (project group →
   * that project; folder/other group → null = create a project from the session cwd).
   * Carried here so the panel's Import CTA passes exactly what the row's Import button
   * would, with no second derivation.
   */
  readonly project: Project | null;
}

interface ExternalSessionPreviewStore {
  readonly previewSelection: ExternalSessionPreviewSelection | null;
  readonly openPreview: (selection: ExternalSessionPreviewSelection) => void;
  readonly closePreview: () => void;
}

export const useExternalSessionPreviewStore = create<ExternalSessionPreviewStore>((set) => ({
  previewSelection: null,
  openPreview: (selection) => set({ previewSelection: selection }),
  closePreview: () =>
    set((state) => (state.previewSelection === null ? state : { previewSelection: null })),
}));

/**
 * Close-on-navigate rule ("who wins"): the preview closes when the route thread id
 * CHANGES in either direction (thread A -> thread B, thread -> no thread, no thread ->
 * thread). Opening a preview does not itself navigate, so a stable id keeps it open;
 * any thread/chat/import/search-palette navigation changes the id and wins immediately.
 */
export function shouldCloseExternalSessionPreviewOnRouteChange(
  previousRouteThreadId: string | null,
  nextRouteThreadId: string | null,
): boolean {
  return previousRouteThreadId !== nextRouteThreadId;
}
