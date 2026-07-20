// FILE: externalSessions.ts
// Purpose: Maps persisted provider resume cursors to external session ids so external
//   session discovery can join against existing import bindings and the durable
//   external_imported_sessions table.
// Layer: Orchestration support (pure functions)
// Exports: extractExternalSessionId, findImportedThreadIdForExternalSession,
//   buildExternalSessionIndex, externalSessionIndexKey, isExternalSessionImportProvider,
//   resumeCommandForExternalSession.

import type { ThreadId } from "@synara/contracts";

import type { ProviderRuntimeBinding } from "../provider/Services/ProviderSessionDirectory";

export type ExternalSessionBinding = Pick<
  ProviderRuntimeBinding,
  "threadId" | "provider" | "resumeCursor"
>;

/**
 * Durable thread ↔ provider-native session mapping (sourced from
 * `projection_thread_sessions.provider_thread_id`).
 */
export interface DurableExternalImportedSession {
  readonly provider: string;
  readonly externalId: string;
  readonly threadId: ThreadId;
}

/** Providers with durable external-import identity (matches discovery coverage). */
export function isExternalSessionImportProvider(
  provider: string,
): provider is "codex" | "claudeAgent" {
  return provider === "codex" || provider === "claudeAgent";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Extract the provider-native session id from a persisted resume cursor.
 *
 * Cursor shapes are provider-specific: Codex stores `{ threadId }`, Claude stores
 * `{ resume }`. Unknown providers and malformed cursors yield `undefined`.
 */
export function extractExternalSessionId(
  provider: string,
  resumeCursor: unknown,
): string | undefined {
  const cursor = readRecord(resumeCursor);
  if (!cursor) return undefined;
  switch (provider) {
    case "codex":
      return readNonEmptyString(cursor.threadId);
    case "claudeAgent":
      return readNonEmptyString(cursor.resume);
    default:
      return undefined;
  }
}

export function externalSessionIndexKey(provider: string, externalId: string): string {
  return `${provider}${externalId}`;
}

/**
 * Find the Synara thread already bound to a `(provider, externalId)` pair, if any.
 */
export function findImportedThreadIdForExternalSession(
  bindings: ReadonlyArray<ExternalSessionBinding>,
  provider: string,
  externalId: string,
): ThreadId | undefined {
  for (const binding of bindings) {
    if (binding.provider !== provider) continue;
    if (extractExternalSessionId(provider, binding.resumeCursor) === externalId) {
      return binding.threadId;
    }
  }
  return undefined;
}

/**
 * Index import identity by `(provider, externalId)` for bulk discovery joins: live
 * runtime bindings first (they describe the currently running session), then durable
 * external_imported_sessions rows filling the gaps left by cleaned-up bindings.
 * Rows without an extractable external id are skipped; the first entry wins on
 * collision.
 */
export function buildExternalSessionIndex(
  bindings: ReadonlyArray<ExternalSessionBinding>,
  durableSessions: ReadonlyArray<DurableExternalImportedSession> = [],
): ReadonlyMap<string, ThreadId> {
  const index = new Map<string, ThreadId>();
  for (const binding of bindings) {
    const externalId = extractExternalSessionId(binding.provider, binding.resumeCursor);
    if (!externalId) continue;
    const key = externalSessionIndexKey(binding.provider, externalId);
    if (!index.has(key)) {
      index.set(key, binding.threadId);
    }
  }
  for (const session of durableSessions) {
    const externalId = session.externalId.trim();
    if (!externalId) continue;
    const key = externalSessionIndexKey(session.provider, externalId);
    if (!index.has(key)) {
      index.set(key, session.threadId);
    }
  }
  return index;
}

export function resumeCommandForExternalSession(
  provider: "codex" | "claudeAgent",
  externalId: string,
): string {
  return provider === "codex" ? `codex resume ${externalId}` : `claude --resume ${externalId}`;
}
