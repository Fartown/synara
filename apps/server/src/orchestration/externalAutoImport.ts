// FILE: externalAutoImport.ts
// Purpose: Pure decision logic for external session auto-import (design doc
//   docs/plans/external-session-preview-bulk-auto-import.md §5): which folders count as
//   "already-imported", which sessions in them are import candidates for a tick
//   (unbound + newer than the folder watermark + determinable cwd), watermark
//   advancement WITHOUT backfill (first run only seeds), and the per-folder failure
//   cooldown schedule (5m -> 15m -> 1h -> 6h cap, reset on success).
// Layer: Orchestration pure derivation (unit-tested)
// Exports: deriveAlreadyImportedFolders, planAutoImportFolder, autoImportStateAfterRun,
//   autoImportStateForWatermarkAdvance, autoImportCooldownMs, AUTO_IMPORT_COOLDOWN_SCHEDULE_MS.

import type { OrchestrationExternalSession } from "@synara/contracts";
import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";

export const AUTO_IMPORT_COOLDOWN_SCHEDULE_MS = [
  5 * 60_000, // 1st consecutive failure: 5 minutes
  15 * 60_000, // 2nd: 15 minutes
  60 * 60_000, // 3rd: 1 hour
  6 * 60 * 60_000, // 4th and beyond: 6 hours (cap)
] as const;

export function autoImportCooldownMs(consecutiveFailures: number): number {
  const index = Math.min(
    Math.max(Math.floor(consecutiveFailures), 1),
    AUTO_IMPORT_COOLDOWN_SCHEDULE_MS.length,
  );
  return AUTO_IMPORT_COOLDOWN_SCHEDULE_MS[index - 1]!;
}

export interface AutoImportFolderStateLike {
  readonly lastSeenUpdatedAt: string | null;
  readonly consecutiveFailures: number;
  readonly cooldownUntil: string | null;
}

export interface AutoImportFolderState extends AutoImportFolderStateLike {
  readonly folderCwd: string;
  readonly lastImportAt: string | null;
  readonly lastError: string | null;
}

function normalizeCwd(cwd: string, platform: NodeJS.Platform | undefined): string {
  return normalizeWorkspaceRootForComparison(cwd, platform ? { platform } : undefined);
}

function parseableUpdatedAt(session: OrchestrationExternalSession): number | null {
  if (!session.updatedAt) return null;
  const parsed = Date.parse(session.updatedAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * "Already-imported folder" derivation (chosen for simplicity and correctness): the
 * normalized cwd of any session in the CURRENT discovery snapshot that carries an
 * `importedThreadId`. The join server-side re-reads live bindings on every call, so a
 * folder appears exactly while ≥1 session from it stays imported (live binding, live
 * thread); sessions without a usable cwd never contribute a folder.
 */
export function deriveAlreadyImportedFolders(
  sessions: ReadonlyArray<OrchestrationExternalSession>,
  options?: { readonly platform?: NodeJS.Platform },
): Set<string> {
  const folders = new Set<string>();
  for (const session of sessions) {
    if (!session.importedThreadId) continue;
    const cwd = session.cwd?.trim() ?? "";
    if (cwd.length === 0) continue;
    folders.add(normalizeCwd(cwd, options?.platform));
  }
  return folders;
}

export interface AutoImportFolderPlan {
  readonly folderCwd: string;
  /** Unbound sessions newer than the watermark, oldest first. Empty when seeded/cooldown. */
  readonly sessionsToImport: ReadonlyArray<OrchestrationExternalSession>;
  /** Watermark advance target: max parseable updatedAt across the folder's sessions. */
  readonly maxSeenUpdatedAt: string | null;
  /** First tick for this folder: seed the watermark, import NOTHING (no backfill). */
  readonly seeded: boolean;
  /** Cooldown active: skip the folder entirely (no import, no watermark write). */
  readonly inCooldown: boolean;
}

export function planAutoImportFolder(input: {
  readonly folderCwd: string;
  readonly sessions: ReadonlyArray<OrchestrationExternalSession>;
  readonly state: AutoImportFolderStateLike | null;
  readonly nowMs: number;
}): AutoImportFolderPlan {
  const { folderCwd, sessions, state } = input;

  let maxSeenMs: number | null = null;
  let maxSeenUpdatedAt: string | null = null;
  for (const session of sessions) {
    const parsed = parseableUpdatedAt(session);
    if (parsed !== null && (maxSeenMs === null || parsed > maxSeenMs)) {
      maxSeenMs = parsed;
      maxSeenUpdatedAt = session.updatedAt;
    }
  }

  if (state === null) {
    return { folderCwd, sessionsToImport: [], maxSeenUpdatedAt, seeded: true, inCooldown: false };
  }

  if (state.cooldownUntil) {
    const cooldownUntilMs = Date.parse(state.cooldownUntil);
    if (!Number.isNaN(cooldownUntilMs) && cooldownUntilMs > input.nowMs) {
      return {
        folderCwd,
        sessionsToImport: [],
        maxSeenUpdatedAt: state.lastSeenUpdatedAt,
        seeded: false,
        inCooldown: true,
      };
    }
  }

  const watermarkMs = state.lastSeenUpdatedAt ? Date.parse(state.lastSeenUpdatedAt) : null;
  const sessionsToImport = sessions
    .filter((session) => {
      if (session.importedThreadId) return false;
      const parsed = parseableUpdatedAt(session);
      if (parsed === null) return false;
      return watermarkMs === null || Number.isNaN(watermarkMs) ? true : parsed > watermarkMs;
    })
    // Import oldest first so the sidebar fills in chronological order.
    .sort((left, right) => {
      const leftMs = parseableUpdatedAt(left) ?? 0;
      const rightMs = parseableUpdatedAt(right) ?? 0;
      return leftMs - rightMs;
    });

  return { folderCwd, sessionsToImport, maxSeenUpdatedAt, seeded: false, inCooldown: false };
}

/** State row written after an import run: watermark advances either way; failures back off. */
export function autoImportStateAfterRun(input: {
  readonly previous: AutoImportFolderStateLike;
  readonly folderCwd: string;
  readonly maxSeenUpdatedAt: string | null;
  readonly nowIso: string;
  readonly nowMs: number;
  readonly failureMessage: string | null;
}): AutoImportFolderState {
  const lastSeenUpdatedAt = input.maxSeenUpdatedAt ?? input.previous.lastSeenUpdatedAt;
  if (input.failureMessage === null) {
    return {
      folderCwd: input.folderCwd,
      lastSeenUpdatedAt,
      lastImportAt: input.nowIso,
      lastError: null,
      consecutiveFailures: 0,
      cooldownUntil: null,
    };
  }
  const consecutiveFailures = input.previous.consecutiveFailures + 1;
  return {
    folderCwd: input.folderCwd,
    lastSeenUpdatedAt,
    lastImportAt: input.nowIso,
    lastError: input.failureMessage,
    consecutiveFailures,
    cooldownUntil: new Date(input.nowMs + autoImportCooldownMs(consecutiveFailures)).toISOString(),
  };
}

/** Quiet watermark advance for ticks with nothing to import; failure bookkeeping preserved. */
export function autoImportStateForWatermarkAdvance(input: {
  readonly previous: AutoImportFolderStateLike & {
    readonly lastImportAt: string | null;
    readonly lastError: string | null;
  };
  readonly folderCwd: string;
  readonly maxSeenUpdatedAt: string;
}): AutoImportFolderState {
  return {
    folderCwd: input.folderCwd,
    lastSeenUpdatedAt: input.maxSeenUpdatedAt,
    lastImportAt: input.previous.lastImportAt,
    lastError: input.previous.lastError,
    consecutiveFailures: input.previous.consecutiveFailures,
    cooldownUntil: input.previous.cooldownUntil,
  };
}
