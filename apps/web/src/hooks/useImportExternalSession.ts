// FILE: useImportExternalSession.ts
// Purpose: One-click external session import flow shared by the sidebar's "Discovered
//   sessions" rows (single Import button) and the main-area preview panel's Import CTA.
//   Sessions matched to a project import straight into it; sessions from unknown
//   locations first get a project created from their cwd (the shared add-project helper
//   recovers duplicates server-side). On success the flow navigates to the imported
//   thread; on failure it deletes the just-created thread shell and rethrows.
// Layer: Web hook
// Exports: useImportExternalSession.
//
// Extracted from Sidebar.tsx so the preview panel (rendered by the chat layout, not the
// sidebar) runs the SAME import path — one canonical flow, no copy.

import {
  type OrchestrationExternalSession,
  PROVIDER_DISPLAY_NAMES,
  type ProjectId,
  ThreadId,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useAppSettings } from "../appSettings";
import { resolveSidebarNewThreadEnvMode } from "../components/Sidebar.logic";
import type { Project } from "../types";
import { createOrRecoverProjectFromPath } from "../lib/projectCreation";
import { newCommandId, newThreadId } from "../lib/utils";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";

export function useImportExternalSession(): (
  session: OrchestrationExternalSession,
  project: Project | null,
) => Promise<ThreadId> {
  const navigate = useNavigate();
  const { settings: appSettings } = useAppSettings();
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);

  return useCallback(
    async (session: OrchestrationExternalSession, project: Project | null): Promise<ThreadId> => {
      const api = readNativeApi();
      if (!api) {
        throw new Error("The app server is unavailable.");
      }

      let targetProjectId: ProjectId;
      let targetProjectDefaultModelSelection = project?.defaultModelSelection ?? null;
      if (project) {
        targetProjectId = project.id;
      } else {
        const cwd = session.cwd?.trim() ?? "";
        if (!cwd) {
          throw new Error("This session has no working directory to add as a project.");
        }
        const creationResult = await createOrRecoverProjectFromPath({
          api,
          workspaceRoot: cwd,
          // Sessions discovered from external stores can live under directories the
          // user has since deleted; importing recreates the (empty) folder so the
          // resumed session has a real cwd to continue in.
          createIfMissing: true,
          loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
        });
        if (creationResult.snapshot) {
          syncServerShellSnapshot(creationResult.snapshot);
        }
        targetProjectId = creationResult.projectId;
        targetProjectDefaultModelSelection = creationResult.project?.defaultModelSelection ?? null;
      }

      const provider = session.provider;
      const providerDefaultModel = getDefaultModel(provider);
      const modelSelection =
        targetProjectDefaultModelSelection?.provider === provider
          ? targetProjectDefaultModelSelection
          : providerDefaultModel
            ? {
                provider,
                model: providerDefaultModel,
              }
            : null;
      if (!modelSelection) {
        throw new Error(
          `Select a ${PROVIDER_DISPLAY_NAMES[provider]} model before importing a session.`,
        );
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const trimmedExternalId = session.externalId.trim();
      const sessionTitle = session.title?.trim() ?? "";
      const suffix = trimmedExternalId.slice(-8);
      const title =
        sessionTitle.length > 0
          ? sessionTitle
          : provider === "claudeAgent"
            ? `Imported Claude session${suffix ? ` ${suffix}` : ""}`
            : `Imported Codex thread${suffix ? ` ${suffix}` : ""}`;
      let createdThread = false;

      try {
        await api.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: newCommandId(),
          threadId,
          projectId: targetProjectId,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          envMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          branch: null,
          worktreePath: null,
          createdAt,
        });
        createdThread = true;

        const result = await api.orchestration.importThread({
          threadId,
          externalId: trimmedExternalId,
          ...(sessionTitle.length > 0 ? { title: sessionTitle.slice(0, 120) } : {}),
        });

        // When the session turns out to be already imported, the server returns the
        // existing thread — open it instead of the shell we just created.
        const resolvedThreadId = result.alreadyImported === true ? result.threadId : threadId;
        await navigate({
          to: "/$threadId",
          params: { threadId: resolvedThreadId },
        });
        return resolvedThreadId;
      } catch (error) {
        if (createdThread) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: newCommandId(),
              threadId,
            })
            .catch(() => undefined);
        }
        throw error;
      }
    },
    [appSettings.defaultThreadEnvMode, navigate, syncServerShellSnapshot],
  );
}
