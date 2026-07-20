import { CommandId, EventId, ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Queue, Scope, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProfileStatsArchive, type ProfileStatsArchiveShape } from "../../profileStatsArchive.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../../provider/Services/ProviderAdapterRegistry.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  cleanupSucceededUnlessInterrupted,
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.makeUnsafe("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("cleanupSucceededUnlessInterrupted", () => {
  const threadId = ThreadId.makeUnsafe("thread-deletion-reactor-test");

  it("returns true for successful cleanup", async () => {
    const result = await Effect.runPromise(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.void,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(result).toBe(true);
  });

  it("returns false for ordinary cleanup failures", async () => {
    const result = await Effect.runPromise(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(result).toBe(false);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      cleanupSucceededUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

const NOW = "2026-07-10T12:00:00.000Z";

function makeThreadDeletedEvent(threadId: ThreadId): OrchestrationEvent {
  return {
    sequence: 1,
    eventId: EventId.makeUnsafe(`evt-deleted-${threadId}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: NOW,
    commandId: CommandId.makeUnsafe(`cmd-deleted-${threadId}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.deleted",
    payload: { threadId, deletedAt: NOW },
  } as OrchestrationEvent;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread deletion reactor expectation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ThreadDeletionReactor codex archive on delete", () => {
  let runtime: ManagedRuntime.ManagedRuntime<ThreadDeletionReactor, unknown> | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  function makeHarness(input: {
    readonly bindingProvider: string;
    readonly resumeCursor: unknown;
    readonly archiveError?: Error;
  }) {
    // A queue (not a PubSub) backs the domain-event stream so events offered before
    // the reactor's forked subscription starts are retained until consumed.
    const domainEvents = Effect.runSync(Queue.unbounded<OrchestrationEvent>());
    const threadId = ThreadId.makeUnsafe("thread-delete-archive");
    const archiveExternalThread = vi.fn(() =>
      input.archiveError ? Effect.fail(input.archiveError) : Effect.void,
    );
    const stopSession = vi.fn(() => Effect.void);
    const terminalClose = vi.fn(() => Effect.void);
    const purgeThreadWithStatsSnapshot = vi.fn(() => Effect.succeed(true));

    const orchestrationEngine = {
      streamDomainEvents: Stream.fromQueue(domainEvents),
      refreshCommandReadModel: () => Effect.void,
    } as unknown as OrchestrationEngineShape;
    const profileStatsArchive = {
      hasThreadPurgeFence: () => Effect.succeed(false),
      purgeThreadWithStatsSnapshot,
      purgeSoftDeletedManualThreads: () => Effect.succeed(0),
    } as unknown as ProfileStatsArchiveShape;
    const providerService = { stopSession } as unknown as ProviderServiceShape;
    const terminalManager = { close: terminalClose } as unknown as TerminalManagerShape;
    const providerSessionDirectory = {
      getBinding: () =>
        Effect.succeed(
          Option.some({
            threadId,
            provider: input.bindingProvider,
            resumeCursor: input.resumeCursor,
          }),
        ),
    } as unknown as ProviderSessionDirectoryShape;
    const providerAdapterRegistry = {
      getByProvider: () => Effect.succeed({ archiveExternalThread }),
    } as unknown as ProviderAdapterRegistryShape;

    const layer = ThreadDeletionReactorLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(Layer.succeed(ProfileStatsArchive, profileStatsArchive)),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(Layer.succeed(ProviderSessionDirectory, providerSessionDirectory)),
      Layer.provideMerge(Layer.succeed(ProviderAdapterRegistry, providerAdapterRegistry)),
      Layer.provideMerge(Layer.succeed(TerminalManager, terminalManager)),
    );

    return {
      archiveExternalThread,
      domainEvents,
      layer,
      purgeThreadWithStatsSnapshot,
      stopSession,
      threadId,
    };
  }

  async function startReactor(harness: ReturnType<typeof makeHarness>) {
    runtime = ManagedRuntime.make(harness.layer);
    const reactor = await runtime.runPromise(Effect.service(ThreadDeletionReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    return reactor;
  }

  it("archives the codex rollout with the binding's external thread id", async () => {
    const harness = makeHarness({
      bindingProvider: "codex",
      resumeCursor: { threadId: "codex-ext-1" },
    });
    await startReactor(harness);

    await Effect.runPromise(
      Queue.offer(harness.domainEvents, makeThreadDeletedEvent(harness.threadId)),
    );

    await waitFor(() => harness.purgeThreadWithStatsSnapshot.mock.calls.length === 1);
    expect(harness.archiveExternalThread).toHaveBeenCalledTimes(1);
    expect(harness.archiveExternalThread).toHaveBeenCalledWith({
      externalThreadId: "codex-ext-1",
    });
    expect(harness.stopSession).toHaveBeenCalledTimes(1);
  });

  it("completes the deletion when the codex archive fails", async () => {
    const harness = makeHarness({
      bindingProvider: "codex",
      resumeCursor: { threadId: "codex-ext-2" },
      archiveError: new Error("codex CLI missing"),
    });
    await startReactor(harness);

    await Effect.runPromise(
      Queue.offer(harness.domainEvents, makeThreadDeletedEvent(harness.threadId)),
    );

    await waitFor(() => harness.purgeThreadWithStatsSnapshot.mock.calls.length === 1);
    expect(harness.archiveExternalThread).toHaveBeenCalledTimes(1);
    expect(harness.stopSession).toHaveBeenCalledTimes(1);
    expect(harness.purgeThreadWithStatsSnapshot).toHaveBeenCalledWith({
      threadId: harness.threadId,
    });
  });

  it("skips the archive for non-codex threads", async () => {
    const harness = makeHarness({
      bindingProvider: "claudeAgent",
      resumeCursor: { resume: "claude-ext-1" },
    });
    await startReactor(harness);

    await Effect.runPromise(
      Queue.offer(harness.domainEvents, makeThreadDeletedEvent(harness.threadId)),
    );

    await waitFor(() => harness.purgeThreadWithStatsSnapshot.mock.calls.length === 1);
    expect(harness.archiveExternalThread).not.toHaveBeenCalled();
    expect(harness.stopSession).toHaveBeenCalledTimes(1);
  });

  it("skips the archive when the codex binding has no external thread id", async () => {
    const harness = makeHarness({
      bindingProvider: "codex",
      resumeCursor: null,
    });
    await startReactor(harness);

    await Effect.runPromise(
      Queue.offer(harness.domainEvents, makeThreadDeletedEvent(harness.threadId)),
    );

    await waitFor(() => harness.purgeThreadWithStatsSnapshot.mock.calls.length === 1);
    expect(harness.archiveExternalThread).not.toHaveBeenCalled();
  });
});
