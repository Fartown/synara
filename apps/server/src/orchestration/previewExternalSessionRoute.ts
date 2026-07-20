// FILE: previewExternalSessionRoute.ts
// Purpose: Read-only preview of an external Codex/Claude session's transcript WITHOUT
//   importing it — reads the provider-native history, maps it with the same
//   full-fidelity mappers used by import (importedThreadHistory.ts), and returns the
//   last N turns plus the full turn count so the client can show a truncation notice.
// Layer: Orchestration query handler
// Exports: makePreviewExternalSessionHandler, PREVIEW_EXTERNAL_SESSION_MAX_TURNS.
//
// Read-only guarantees: this handler never dispatches an orchestration command, never
// writes a provider binding, and never starts a provider session — Codex history is read
// through a discovery context (readExternalThread) and Claude history is read from the
// persisted session file. Results are cached in memory for 60s (keyed by
// provider+externalId) because previews are re-requested repeatedly while browsing.

import { getSessionMessages as getClaudeSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import {
  ThreadId,
  type OrchestrationPreviewExternalSessionInput,
  type OrchestrationPreviewExternalSessionResult,
  type ThreadImportedTurn,
} from "@synara/contracts";
import { providerStartOptionsFromServerSettings } from "@synara/shared/serverSettings";
import { Data, Effect } from "effect";

import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ServerSettingsShape } from "../serverSettings";
import { mapClaudeSessionTurns, mapCodexSnapshotTurns } from "./importedThreadHistory";

export const PREVIEW_EXTERNAL_SESSION_MAX_TURNS = 30;
const PREVIEW_CACHE_TTL_MS = 60_000;

export class PreviewExternalSessionError extends Data.TaggedError("PreviewExternalSessionError")<{
  readonly message: string;
}> {}

function previewError(message: string): PreviewExternalSessionError {
  return new PreviewExternalSessionError({ message });
}

export interface PreviewExternalSessionHandlerOptions {
  readonly providerAdapterRegistry: ProviderAdapterRegistryShape;
  readonly serverSettings: ServerSettingsShape;
  readonly now?: () => number;
  readonly nowIso?: () => string;
  readonly cacheTtlMs?: number;
}

interface PreviewCacheEntry {
  readonly expiresAtMs: number;
  readonly turns: ReadonlyArray<ThreadImportedTurn>;
}

export function makePreviewExternalSessionHandler(options: PreviewExternalSessionHandlerOptions) {
  const now = options.now ?? Date.now;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const cacheTtlMs = options.cacheTtlMs ?? PREVIEW_CACHE_TTL_MS;
  // Caches the full mapped history (pre-slice) so totalTurns/truncated stay consistent
  // and repeat previews of the same session skip the provider read entirely.
  const previewCache = new Map<string, PreviewCacheEntry>();

  const readCodexTurns = Effect.fnUntraced(function* (
    body: OrchestrationPreviewExternalSessionInput,
  ) {
    const adapter = yield* options.providerAdapterRegistry
      .getByProvider("codex")
      .pipe(Effect.mapError(() => previewError("The Codex provider adapter is unavailable.")));
    if (!adapter.readExternalThread) {
      return yield* Effect.fail(previewError("Codex external session preview is unavailable."));
    }
    // Honor a configured custom Codex binary/home for the discovery app-server, same as
    // external session discovery and import.
    const settingsSnapshot = yield* options.serverSettings.getSnapshot.pipe(
      Effect.mapError(() =>
        previewError("Failed to load server settings for the external session preview."),
      ),
    );
    const providerOptions = providerStartOptionsFromServerSettings(settingsSnapshot.settings);
    const snapshot = yield* adapter
      .readExternalThread({
        externalThreadId: body.externalId,
        ...(body.cwd ? { cwd: body.cwd } : {}),
        providerOptions,
      })
      .pipe(
        Effect.mapError((cause) =>
          previewError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : `Codex session '${body.externalId}' was not found or could not be read.`,
          ),
        ),
      );
    return mapCodexSnapshotTurns({
      threadId: previewThreadId(body),
      turns: snapshot.turns,
      importedAt: nowIso(),
    });
  });

  const readClaudeTurns = Effect.fnUntraced(function* (
    body: OrchestrationPreviewExternalSessionInput,
  ) {
    const sessionMessages = yield* Effect.tryPromise({
      try: () =>
        getClaudeSessionMessages(body.externalId, body.cwd ? { dir: body.cwd } : undefined),
      catch: (cause) =>
        previewError(
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : `Claude session '${body.externalId}' was not found or could not be read.`,
        ),
    });
    return mapClaudeSessionTurns({
      threadId: previewThreadId(body),
      messages: sessionMessages,
      importedAt: nowIso(),
    });
  });

  return Effect.fnUntraced(function* (
    body: OrchestrationPreviewExternalSessionInput,
  ): Effect.fn.Return<
    OrchestrationPreviewExternalSessionResult,
    PreviewExternalSessionError,
    never
  > {
    const cacheKey = `${body.provider}:${body.externalId}`;
    let fullTurns: ReadonlyArray<ThreadImportedTurn> | undefined;
    const cached = previewCache.get(cacheKey);
    if (cached && cached.expiresAtMs > now()) {
      fullTurns = cached.turns;
    } else {
      if (body.provider === "codex") {
        fullTurns = yield* readCodexTurns(body);
      } else if (body.provider === "claudeAgent") {
        fullTurns = yield* readClaudeTurns(body);
      } else {
        return yield* Effect.fail(
          previewError(
            `External session preview is not supported for provider '${body.provider}'.`,
          ),
        );
      }
      previewCache.set(cacheKey, { expiresAtMs: now() + cacheTtlMs, turns: fullTurns });
    }

    const totalTurns = fullTurns.length;
    const turns = fullTurns.slice(-PREVIEW_EXTERNAL_SESSION_MAX_TURNS);
    return { turns: [...turns], totalTurns, truncated: totalTurns > turns.length };
  });
}

// Synthetic but deterministic thread id for the mapped rows: there is no Synara thread
// for a preview, and the mappers only use it to namespace message/activity/plan ids.
function previewThreadId(body: OrchestrationPreviewExternalSessionInput): ThreadId {
  return ThreadId.makeUnsafe(`preview:${body.provider}:${body.externalId}`);
}
