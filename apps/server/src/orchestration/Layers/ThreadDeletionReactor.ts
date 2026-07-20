import { ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@synara/shared/DrainableWorker";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { ProfileStatsArchive } from "../../profileStatsArchive";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry";
import { ProviderService } from "../../provider/Services/ProviderService";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory";
import { TerminalManager } from "../../terminal/Services/Manager";
import { THREAD_RETENTION_COMMAND_ID_PREFIX } from "../../threadRetention";
import { extractExternalSessionId } from "../externalSessions";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

// Crash recovery / backfill: threads soft-deleted before the purge could run
// (or before purge existed) are archived and purged shortly after startup.
const PURGE_STARTUP_SWEEP_DELAY_MS = 60 * 1000;
const THREAD_DELETION_REACTOR_CAPACITY = 64;
const PURGE_FENCE_RETRY_ATTEMPTS = 20;
const PURGE_FENCE_RETRY_DELAY_MS = 100;

const MISSING_PROVIDER_BINDING_DETAIL = "no persisted provider binding exists";

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

export const cleanupSucceededUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<boolean, E, R> =>
  effect.pipe(
    Effect.as(true),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(false));
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const profileStatsArchive = yield* ProfileStatsArchive;
  const providerAdapterRegistry = yield* ProviderAdapterRegistry;
  const providerService = yield* ProviderService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const terminalManager = yield* TerminalManager;

  const refreshCommandReadModelAfterPurge = (threadId: string) =>
    orchestrationEngine.refreshCommandReadModel().pipe(
      Effect.asVoid,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion cleanup could not refresh command read model", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const stopProviderSessionWithoutBinding = (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
    cause: Cause.Cause<unknown>,
  ) =>
    Effect.logDebug("thread deletion cleanup found no provider session to stop", {
      threadId,
      cause: Cause.pretty(cause),
    }).pipe(Effect.as(true));

  const stopProviderSession = Effect.fn(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    return yield* providerService.stopSession({ threadId }).pipe(
      Effect.as(true),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        if (Cause.pretty(cause).includes(MISSING_PROVIDER_BINDING_DETAIL)) {
          return stopProviderSessionWithoutBinding(threadId, cause);
        }
        return Effect.logDebug("thread deletion cleanup skipped provider session stop", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false));
      }),
    );
  });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    cleanupSucceededUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const waitForThreadPurgeFence = Effect.fn(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    for (let attempt = 0; attempt < PURGE_FENCE_RETRY_ATTEMPTS; attempt += 1) {
      const fenced = yield* profileStatsArchive.hasThreadPurgeFence({ threadId });
      if (!fenced) return true;
      yield* Effect.sleep(PURGE_FENCE_RETRY_DELAY_MS);
    }
    yield* Effect.logWarning("thread deletion retained unresolved provider delivery evidence", {
      threadId,
    });
    return false;
  });

  // Retention deletes only hide the thread (its rows keep feeding profile
  // stats directly). Explicit deletes snapshot the stat aggregates and then
  // hard-delete the thread's rows so disk space is actually reclaimed.
  const purgeThreadData = (event: ThreadDeletedEvent) => {
    if (event.commandId?.startsWith(THREAD_RETENTION_COMMAND_ID_PREFIX)) {
      return Effect.void;
    }
    return waitForThreadPurgeFence(event.payload.threadId).pipe(
      Effect.flatMap((canPurge) =>
        canPurge
          ? profileStatsArchive.purgeThreadWithStatsSnapshot({
              threadId: event.payload.threadId,
            })
          : Effect.succeed(false),
      ),
      Effect.flatMap((purged) =>
        purged ? refreshCommandReadModelAfterPurge(event.payload.threadId) : Effect.void,
      ),
      Effect.catch((error) =>
        // A failed purge leaves the thread soft-deleted; the startup sweep
        // retries it on the next boot.
        Effect.logWarning("thread deletion cleanup skipped stats archive purge", {
          threadId: event.payload.threadId,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  };

  // Codex archive-on-delete: capture the binding's external thread id BEFORE the
  // provider session stop drops the persisted binding, then (after cleanup) move the
  // codex-side rollout into archived_sessions via thread/archive. Strictly
  // best-effort: archive is recoverable, so failures (missing codex CLI, spawn
  // errors, already-archived rollouts) are logged and never block or roll back the
  // deletion. Other providers have no equivalent API and are skipped.
  const readCodexExternalThreadIdForArchive = (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) =>
    providerSessionDirectory.getBinding(threadId).pipe(
      Effect.map((bindingOption) => {
        if (Option.isNone(bindingOption) || bindingOption.value.provider !== "codex") {
          return null;
        }
        return extractExternalSessionId("codex", bindingOption.value.resumeCursor) ?? null;
      }),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logDebug("thread deletion cleanup could not read provider binding", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(null));
      }),
    );

  const archiveCodexExternalThread = Effect.fn(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
    externalThreadId: string,
  ) {
    const adapter = yield* providerAdapterRegistry.getByProvider("codex");
    if (!adapter.archiveExternalThread) return;
    yield* adapter.archiveExternalThread({ externalThreadId });
    yield* Effect.logInfo("archived codex rollout for deleted thread", {
      threadId,
      externalThreadId,
    });
  });

  const archiveCodexExternalThreadUnlessInterrupted = (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
    externalThreadId: string | null,
  ) =>
    externalThreadId === null
      ? Effect.void
      : archiveCodexExternalThread(threadId, externalThreadId).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            return Effect.logWarning("thread deletion cleanup could not archive codex rollout", {
              threadId,
              externalThreadId,
              cause: Cause.pretty(cause),
            });
          }),
        );

  const cleanupThreadBeforePurge = Effect.fn(function* (
    threadId: ThreadDeletedEvent["payload"]["threadId"],
  ) {
    const codexExternalThreadId = yield* readCodexExternalThreadIdForArchive(threadId);
    const providerCleanupSucceeded = yield* stopProviderSession(threadId);
    const terminalCleanupSucceeded = yield* closeThreadTerminals(threadId);
    yield* archiveCodexExternalThreadUnlessInterrupted(threadId, codexExternalThreadId);
    return providerCleanupSucceeded && terminalCleanupSucceeded;
  });

  const processThreadDeleted = Effect.fn(function* (event: ThreadDeletedEvent) {
    const { threadId } = event.payload;
    const cleanupSucceeded = yield* cleanupThreadBeforePurge(threadId);
    if (!cleanupSucceeded) {
      yield* Effect.logWarning("thread deletion cleanup deferred stats archive purge", {
        threadId,
      });
      return;
    }
    yield* purgeThreadData(event);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely, {
    capacity: THREAD_DELETION_REACTOR_CAPACITY,
  });

  const start: ThreadDeletionReactorShape["start"] = Effect.fn(() =>
    startDrainableWorkerProducers(
      worker,
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
            if (event.type !== "thread.deleted") {
              return Effect.void;
            }
            return worker.enqueue(event);
          }),
        );
        yield* Effect.forkScoped(
          Effect.sleep(PURGE_STARTUP_SWEEP_DELAY_MS).pipe(
            Effect.flatMap(() =>
              profileStatsArchive.purgeSoftDeletedManualThreads({
                beforePurge: (threadId) =>
                  cleanupThreadBeforePurge(ThreadId.makeUnsafe(threadId)).pipe(
                    Effect.flatMap((cleaned) =>
                      cleaned
                        ? waitForThreadPurgeFence(ThreadId.makeUnsafe(threadId))
                        : Effect.succeed(false),
                    ),
                  ),
              }),
            ),
            Effect.tap((purgedCount) =>
              purgedCount > 0 ? refreshCommandReadModelAfterPurge("startup-sweep") : Effect.void,
            ),
            Effect.flatMap((purgedCount) =>
              purgedCount > 0
                ? Effect.logInfo("purged soft-deleted threads after stats archive snapshot", {
                    purgedCount,
                  })
                : Effect.void,
            ),
            Effect.catch((error) =>
              Effect.logWarning("startup purge sweep for deleted threads failed", {
                error: error instanceof Error ? error.message : String(error),
              }),
            ),
          ),
        );
      }),
    ),
  );

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
