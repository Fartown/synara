// FILE: importHistoryProjection.test.ts
// Purpose: Verifies the thread.history.import command flows through the decider into
//   projection rows for turns, messages, activities, and proposed plans — without
//   checkpoint data — and that re-dispatching the same history is idempotent.
// Layer: Orchestration engine + projection tests
// Depends on: decider, ProjectionPipeline, ProjectionSnapshotQuery.

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ThreadImportedTurn,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const NOW = "2026-07-10T12:00:00.000Z";
const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);

async function createOrchestrationSystem() {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "synara-import-history-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const projectionTurns = await runtime.runPromise(Effect.service(ProjectionTurnRepository));
  return {
    engine,
    snapshotQuery,
    projectionTurns,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function makeImportedTurns(threadId: ThreadId): ReadonlyArray<ThreadImportedTurn> {
  return [
    {
      turnId: asTurnId("import-turn:1"),
      state: "completed",
      userMessageId: asMessageId("import:1:user"),
      assistantMessageId: asMessageId("import:1:assistant"),
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: "2026-07-10T12:00:00.003Z",
      messages: [
        {
          messageId: asMessageId("import:1:user"),
          role: "user",
          text: "First question",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          messageId: asMessageId("import:1:assistant"),
          role: "assistant",
          text: "First answer",
          createdAt: "2026-07-10T12:00:00.003Z",
          updatedAt: "2026-07-10T12:00:00.003Z",
        },
      ],
      activities: [
        {
          id: asEventId("import-activity:1:reasoning"),
          tone: "tool",
          kind: "task.progress",
          summary: "Reasoning trace",
          payload: { status: "completed", detail: "Thinking", data: { toolCallId: "r1" } },
          turnId: asTurnId("import-turn:1"),
          createdAt: "2026-07-10T12:00:00.001Z",
        },
        {
          id: asEventId("import-activity:1:tool"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Ran command",
          payload: {
            itemType: "command_execution",
            status: "completed",
            title: "Ran command",
            detail: "bun test",
            data: { toolCallId: "c1" },
          },
          turnId: asTurnId("import-turn:1"),
          createdAt: "2026-07-10T12:00:00.002Z",
        },
      ],
      proposedPlans: [],
    },
    {
      turnId: asTurnId("import-turn:2"),
      state: "completed",
      userMessageId: asMessageId("import:2:user"),
      assistantMessageId: asMessageId("import:2:assistant"),
      requestedAt: "2026-07-10T12:00:00.004Z",
      startedAt: "2026-07-10T12:00:00.004Z",
      completedAt: "2026-07-10T12:00:00.006Z",
      messages: [
        {
          messageId: asMessageId("import:2:user"),
          role: "user",
          text: "Second question",
          createdAt: "2026-07-10T12:00:00.004Z",
          updatedAt: "2026-07-10T12:00:00.004Z",
        },
        {
          messageId: asMessageId("import:2:assistant"),
          role: "assistant",
          text: "Second answer",
          createdAt: "2026-07-10T12:00:00.006Z",
          updatedAt: "2026-07-10T12:00:00.006Z",
        },
      ],
      activities: [],
      proposedPlans: [
        {
          id: `plan:${String(threadId)}:turn:import-turn:2`,
          turnId: asTurnId("import-turn:2"),
          planMarkdown: "# Plan\nDo the thing",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-07-10T12:00:00.005Z",
          updatedAt: "2026-07-10T12:00:00.005Z",
        },
      ],
    },
  ];
}

describe("thread.history.import projections", () => {
  it("projects turns, messages, activities, and plans without checkpoint data", async () => {
    const system = await createOrchestrationSystem();
    const threadId = asThreadId("thread-import-history");

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-import-history-project"),
        projectId: asProjectId("project-import-history"),
        title: "Import history",
        workspaceRoot: "/tmp/import-history",
        defaultModelSelection: null,
        createdAt: NOW,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-import-history-thread"),
        threadId,
        projectId: asProjectId("project-import-history"),
        title: "Import history thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      }),
    );

    const dispatchImport = (commandId: string) =>
      system.engine.dispatch({
        type: "thread.history.import",
        commandId: CommandId.makeUnsafe(commandId),
        threadId,
        turns: makeImportedTurns(threadId),
        createdAt: NOW,
      });

    await system.run(dispatchImport("cmd-import-history-1"));

    const turnRows = await system.run(system.projectionTurns.listByThreadId({ threadId }));
    expect(turnRows.length).toBe(2);
    expect(
      turnRows.map((row) => ({
        turnId: row.turnId,
        state: row.state,
        pendingMessageId: row.pendingMessageId,
        assistantMessageId: row.assistantMessageId,
        requestedAt: row.requestedAt,
        completedAt: row.completedAt,
        checkpointTurnCount: row.checkpointTurnCount,
        checkpointRef: row.checkpointRef,
      })),
    ).toEqual([
      {
        turnId: "import-turn:1",
        state: "completed",
        pendingMessageId: "import:1:user",
        assistantMessageId: "import:1:assistant",
        requestedAt: NOW,
        completedAt: "2026-07-10T12:00:00.003Z",
        checkpointTurnCount: null,
        checkpointRef: null,
      },
      {
        turnId: "import-turn:2",
        state: "completed",
        pendingMessageId: "import:2:user",
        assistantMessageId: "import:2:assistant",
        requestedAt: "2026-07-10T12:00:00.004Z",
        completedAt: "2026-07-10T12:00:00.006Z",
        checkpointTurnCount: null,
        checkpointRef: null,
      },
    ]);

    const detailOption = await system.run(system.snapshotQuery.getThreadDetailById(threadId));
    expect(detailOption._tag).toBe("Some");
    if (detailOption._tag !== "Some") {
      throw new Error("expected thread detail");
    }
    const detail = detailOption.value;

    expect(
      detail.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
        text: message.text,
        streaming: message.streaming,
      })),
    ).toEqual([
      {
        id: "import:1:user",
        role: "user",
        turnId: "import-turn:1",
        text: "First question",
        streaming: false,
      },
      {
        id: "import:1:assistant",
        role: "assistant",
        turnId: "import-turn:1",
        text: "First answer",
        streaming: false,
      },
      {
        id: "import:2:user",
        role: "user",
        turnId: "import-turn:2",
        text: "Second question",
        streaming: false,
      },
      {
        id: "import:2:assistant",
        role: "assistant",
        turnId: "import-turn:2",
        text: "Second answer",
        streaming: false,
      },
    ]);

    expect(
      detail.activities.map((activity) => ({
        id: activity.id,
        kind: activity.kind,
        turnId: activity.turnId,
        summary: activity.summary,
      })),
    ).toEqual([
      {
        id: "import-activity:1:reasoning",
        kind: "task.progress",
        turnId: "import-turn:1",
        summary: "Reasoning trace",
      },
      {
        id: "import-activity:1:tool",
        kind: "tool.completed",
        turnId: "import-turn:1",
        summary: "Ran command",
      },
    ]);

    expect(
      detail.proposedPlans.map((plan) => ({
        id: plan.id,
        turnId: plan.turnId,
        planMarkdown: plan.planMarkdown,
      })),
    ).toEqual([
      {
        id: `plan:${String(threadId)}:turn:import-turn:2`,
        turnId: "import-turn:2",
        planMarkdown: "# Plan\nDo the thing",
      },
    ]);

    // Imported turns carry no workspace snapshots: no checkpoints may appear.
    expect(detail.checkpoints).toEqual([]);
    expect(detail.latestTurn).toMatchObject({
      turnId: "import-turn:2",
      state: "completed",
      completedAt: "2026-07-10T12:00:00.006Z",
      assistantMessageId: "import:2:assistant",
    });

    // Re-dispatching the same history (e.g. a re-sync) must not duplicate rows.
    await system.run(dispatchImport("cmd-import-history-2"));

    const turnRowsAfterResync = await system.run(
      system.projectionTurns.listByThreadId({ threadId }),
    );
    expect(turnRowsAfterResync.length).toBe(2);

    const detailAfterResyncOption = await system.run(
      system.snapshotQuery.getThreadDetailById(threadId),
    );
    if (detailAfterResyncOption._tag !== "Some") {
      throw new Error("expected thread detail after re-import");
    }
    const detailAfterResync = detailAfterResyncOption.value;
    expect(detailAfterResync.messages.length).toBe(4);
    expect(detailAfterResync.activities.length).toBe(2);
    expect(detailAfterResync.proposedPlans.length).toBe(1);
    expect(detailAfterResync.checkpoints).toEqual([]);
    expect(detailAfterResync.latestTurn).toMatchObject({
      turnId: "import-turn:2",
      state: "completed",
    });

    await system.dispose();
  });

  it("rejects a history import without turns", async () => {
    const system = await createOrchestrationSystem();
    const threadId = asThreadId("thread-import-history-empty");

    await system.run(
      system.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-import-history-empty-project"),
        projectId: asProjectId("project-import-history-empty"),
        title: "Import history empty",
        workspaceRoot: "/tmp/import-history-empty",
        defaultModelSelection: null,
        createdAt: NOW,
      }),
    );
    await system.run(
      system.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-import-history-empty-thread"),
        threadId,
        projectId: asProjectId("project-import-history-empty"),
        title: "Import history empty thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      }),
    );

    await expect(
      system.run(
        system.engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.makeUnsafe("cmd-import-history-empty-1"),
          threadId,
          turns: [],
          createdAt: NOW,
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "OrchestrationCommandInvariantError",
    });

    await system.dispose();
  });
});
