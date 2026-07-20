import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Backfill the durable external-import identity (projection_thread_sessions
  // .provider_thread_id) for imports that predate the thread.session-set
  // externalSessionId payload. Their only identity lives in the runtime binding's
  // resume cursor — Codex `{ threadId }`, Claude `{ resume }` — so copy it into
  // the projection column once, keeping every other projected field untouched.
  // Without this, imports whose bindings are later cleaned by the session
  // lifecycle would look un-imported again and invite duplicate imports.
  yield* sql`
    UPDATE projection_thread_sessions
    SET provider_thread_id = COALESCE(
      (
        SELECT CASE
          WHEN provider_session_runtime.provider_name = 'codex'
            THEN json_extract(provider_session_runtime.resume_cursor_json, '$.threadId')
          WHEN provider_session_runtime.provider_name = 'claudeAgent'
            THEN json_extract(provider_session_runtime.resume_cursor_json, '$.resume')
          ELSE NULL
        END
        FROM provider_session_runtime
        WHERE provider_session_runtime.thread_id = projection_thread_sessions.thread_id
      ),
      projection_thread_sessions.provider_thread_id
    )
    WHERE provider_thread_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM provider_session_runtime
        WHERE provider_session_runtime.thread_id = projection_thread_sessions.thread_id
          AND provider_session_runtime.provider_name IN ('codex', 'claudeAgent')
          AND provider_session_runtime.resume_cursor_json IS NOT NULL
      )
  `;
});
