import { ThreadId } from "@synara/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionExternalSessionMapping,
  ProjectionThreadSession,
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
  DeleteProjectionThreadSessionInput,
  GetProjectionThreadSessionInput,
} from "../Services/ProjectionThreadSessions.ts";

const makeProjectionThreadSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSessionRow = SqlSchema.void({
    Request: ProjectionThreadSession,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at,
          provider_thread_id
        )
        VALUES (
          ${row.threadId},
          ${row.status},
          ${row.providerName},
          ${row.runtimeMode},
          ${row.activeTurnId},
          ${row.lastError},
          ${row.updatedAt},
          ${row.providerThreadId}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          runtime_mode = excluded.runtime_mode,
          active_turn_id = excluded.active_turn_id,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at,
          -- Only thread.session-set events carrying an externalSessionId may set the
          -- column; every other session update leaves the stored value untouched.
          provider_thread_id = COALESCE(
            excluded.provider_thread_id,
            projection_thread_sessions.provider_thread_id
          )
      `,
  });

  const getProjectionThreadSessionRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadSessionInput,
    Result: ProjectionThreadSession,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt",
          provider_thread_id AS "providerThreadId"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadSessionRow = SqlSchema.void({
    Request: DeleteProjectionThreadSessionInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const findThreadIdByProviderThreadId = SqlSchema.findOneOption({
    Request: Schema.Struct({ providerName: Schema.String, providerThreadId: Schema.String }),
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: ({ providerName, providerThreadId }) =>
      sql`
        SELECT thread_id AS "threadId"
        FROM projection_thread_sessions
        WHERE provider_name = ${providerName}
          AND provider_thread_id = ${providerThreadId}
      `,
  });

  const listProviderThreadIdRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionExternalSessionMapping,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_thread_id AS "providerThreadId"
        FROM projection_thread_sessions
        WHERE provider_thread_id IS NOT NULL
        ORDER BY provider_name ASC, provider_thread_id ASC
      `,
  });

  const upsert: ProjectionThreadSessionRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadSessionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSessionRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadSessionRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.getByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadSessionRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.deleteByThreadId:query"),
      ),
    );

  const getThreadIdByProviderThreadId: ProjectionThreadSessionRepositoryShape["getThreadIdByProviderThreadId"] =
    (providerName, providerThreadId) =>
      findThreadIdByProviderThreadId({ providerName, providerThreadId }).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadSessionRepository.getThreadIdByProviderThreadId:query",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const listProviderThreadIds: ProjectionThreadSessionRepositoryShape["listProviderThreadIds"] =
    () =>
      listProviderThreadIdRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadSessionRepository.listProviderThreadIds:query"),
        ),
      );

  return {
    upsert,
    getByThreadId,
    deleteByThreadId,
    getThreadIdByProviderThreadId,
    listProviderThreadIds,
  } satisfies ProjectionThreadSessionRepositoryShape;
});

export const ProjectionThreadSessionRepositoryLive = Layer.effect(
  ProjectionThreadSessionRepository,
  makeProjectionThreadSessionRepository,
);
