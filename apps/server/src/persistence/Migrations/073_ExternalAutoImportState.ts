import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Per-folder auto-import watermarks for external session discovery. Survives
  // projection repair on purpose (no foreign keys into projection tables): the
  // watermarks record what the auto-importer has already seen, independent of
  // rebuildable projections.
  yield* sql`
    CREATE TABLE IF NOT EXISTS external_auto_import_state (
      folder_cwd TEXT PRIMARY KEY,
      last_seen_updated_at TEXT,
      last_import_at TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      cooldown_until TEXT
    )
  `;
});
