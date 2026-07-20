import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { ExternalAutoImportState } from "../Services/ExternalAutoImportState.ts";
import { ExternalAutoImportStateLive } from "./ExternalAutoImportState.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ExternalAutoImportStateLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ExternalAutoImportState", (it) => {
  it.effect("round-trips a folder state row (insert then read)", () =>
    Effect.gen(function* () {
      const repo = yield* ExternalAutoImportState;

      assert.isTrue(Option.isNone(yield* repo.getFolderState("/work/repo")));

      yield* repo.upsertFolderState({
        folderCwd: "/work/repo",
        lastSeenUpdatedAt: "2026-07-19T10:00:00.000Z",
        lastImportAt: null,
        lastError: null,
        consecutiveFailures: 0,
        cooldownUntil: null,
      });

      assert.deepStrictEqual(
        yield* repo.getFolderState("/work/repo"),
        Option.some({
          folderCwd: "/work/repo",
          lastSeenUpdatedAt: "2026-07-19T10:00:00.000Z",
          lastImportAt: null,
          lastError: null,
          consecutiveFailures: 0,
          cooldownUntil: null,
        }),
      );
    }),
  );

  it.effect("upsert replaces watermark and failure bookkeeping", () =>
    Effect.gen(function* () {
      const repo = yield* ExternalAutoImportState;

      yield* repo.upsertFolderState({
        folderCwd: "/work/repo",
        lastSeenUpdatedAt: "2026-07-19T10:00:00.000Z",
        lastImportAt: null,
        lastError: null,
        consecutiveFailures: 0,
        cooldownUntil: null,
      });
      yield* repo.upsertFolderState({
        folderCwd: "/work/repo",
        lastSeenUpdatedAt: "2026-07-19T11:00:00.000Z",
        lastImportAt: "2026-07-19T11:05:00.000Z",
        lastError: "codex app-server unavailable",
        consecutiveFailures: 2,
        cooldownUntil: "2026-07-19T11:20:00.000Z",
      });

      const state = yield* repo.getFolderState("/work/repo");
      assert.isTrue(Option.isSome(state));
      if (Option.isSome(state)) {
        assert.strictEqual(state.value.lastSeenUpdatedAt, "2026-07-19T11:00:00.000Z");
        assert.strictEqual(state.value.lastImportAt, "2026-07-19T11:05:00.000Z");
        assert.strictEqual(state.value.lastError, "codex app-server unavailable");
        assert.strictEqual(state.value.consecutiveFailures, 2);
        assert.strictEqual(state.value.cooldownUntil, "2026-07-19T11:20:00.000Z");
      }
    }),
  );

  it.effect("isolates rows per folder", () =>
    Effect.gen(function* () {
      const repo = yield* ExternalAutoImportState;

      yield* repo.upsertFolderState({
        folderCwd: "/work/a",
        lastSeenUpdatedAt: "2026-07-19T10:00:00.000Z",
        lastImportAt: null,
        lastError: null,
        consecutiveFailures: 0,
        cooldownUntil: null,
      });

      assert.isTrue(Option.isNone(yield* repo.getFolderState("/work/b")));
      assert.isTrue(Option.isSome(yield* repo.getFolderState("/work/a")));
    }),
  );
});
