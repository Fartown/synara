/**
 * Durable per-folder auto-import state for external session discovery.
 *
 * One row per already-imported folder: the high-water mark of provider session
 * `updatedAt` values the auto-importer has seen (sessions newer than this get
 * imported), plus failure bookkeeping driving the cooldown backoff. Folder identity
 * is the caller-normalized workspace root; this service never derives or normalizes
 * paths itself.
 */
import { NonNegativeInt } from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type ExternalAutoImportStateError = PersistenceSqlError | PersistenceDecodeError;

export const ExternalAutoImportFolderState = Schema.Struct({
  folderCwd: Schema.String,
  lastSeenUpdatedAt: Schema.NullOr(Schema.String),
  lastImportAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  consecutiveFailures: NonNegativeInt,
  cooldownUntil: Schema.NullOr(Schema.String),
});
export type ExternalAutoImportFolderState = typeof ExternalAutoImportFolderState.Type;

export interface ExternalAutoImportStateShape {
  /** Read one folder's state; none when the folder has never been tracked. */
  readonly getFolderState: (
    folderCwd: string,
  ) => Effect.Effect<Option.Option<ExternalAutoImportFolderState>, ExternalAutoImportStateError>;

  /** Insert or replace one folder's state (watermark + failure bookkeeping together). */
  readonly upsertFolderState: (
    state: ExternalAutoImportFolderState,
  ) => Effect.Effect<void, ExternalAutoImportStateError>;
}

export class ExternalAutoImportState extends ServiceMap.Service<
  ExternalAutoImportState,
  ExternalAutoImportStateShape
>()("synara/persistence/Services/ExternalAutoImportState/ExternalAutoImportState") {}
