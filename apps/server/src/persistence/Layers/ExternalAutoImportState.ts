import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ExternalAutoImportFolderState,
  ExternalAutoImportState,
  type ExternalAutoImportStateError,
  type ExternalAutoImportStateShape,
} from "../Services/ExternalAutoImportState.ts";

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
): (cause: unknown) => ExternalAutoImportStateError {
  return (cause) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeExternalAutoImportState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findFolderState = SqlSchema.findOneOption({
    Request: Schema.Struct({ folderCwd: Schema.String }),
    Result: ExternalAutoImportFolderState,
    execute: ({ folderCwd }) => sql`
      SELECT
        folder_cwd AS "folderCwd",
        last_seen_updated_at AS "lastSeenUpdatedAt",
        last_import_at AS "lastImportAt",
        last_error AS "lastError",
        consecutive_failures AS "consecutiveFailures",
        cooldown_until AS "cooldownUntil"
      FROM external_auto_import_state
      WHERE folder_cwd = ${folderCwd}
    `,
  });

  const writeFolderState = SqlSchema.void({
    Request: ExternalAutoImportFolderState,
    execute: (state) => sql`
      INSERT INTO external_auto_import_state (
        folder_cwd,
        last_seen_updated_at,
        last_import_at,
        last_error,
        consecutive_failures,
        cooldown_until
      )
      VALUES (
        ${state.folderCwd},
        ${state.lastSeenUpdatedAt},
        ${state.lastImportAt},
        ${state.lastError},
        ${state.consecutiveFailures},
        ${state.cooldownUntil}
      )
      ON CONFLICT (folder_cwd) DO UPDATE SET
        last_seen_updated_at = excluded.last_seen_updated_at,
        last_import_at = excluded.last_import_at,
        last_error = excluded.last_error,
        consecutive_failures = excluded.consecutive_failures,
        cooldown_until = excluded.cooldown_until
    `,
  });

  const getFolderState: ExternalAutoImportStateShape["getFolderState"] = (folderCwd) =>
    findFolderState({ folderCwd }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalAutoImportState.getFolderState:query",
          "ExternalAutoImportState.getFolderState:decodeRows",
        ),
      ),
    );

  const upsertFolderState: ExternalAutoImportStateShape["upsertFolderState"] = (state) =>
    writeFolderState(state).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ExternalAutoImportState.upsertFolderState:query",
          "ExternalAutoImportState.upsertFolderState:encodeRequest",
        ),
      ),
    );

  return { getFolderState, upsertFolderState } satisfies ExternalAutoImportStateShape;
});

export const ExternalAutoImportStateLive = Layer.effect(
  ExternalAutoImportState,
  makeExternalAutoImportState,
);
