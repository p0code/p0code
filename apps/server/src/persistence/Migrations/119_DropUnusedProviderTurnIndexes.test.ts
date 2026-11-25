import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("119_DropUnusedProviderTurnIndexes", (it) => {
  it.effect("drops the two indexes and keeps the lookup on an index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const indexes = () => sql<{ readonly name: string }>`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND name LIKE '%provider_turn_idx'
          AND tbl_name IN ('orchestration_v2_projection_nodes', 'orchestration_v2_projection_turn_items')
      `;
      yield* runMigrations({ toMigrationInclusive: 118 });
      assert.lengthOf(yield* indexes(), 2);

      yield* runMigrations({ toMigrationInclusive: 119 });
      assert.lengthOf(yield* indexes(), 0);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE thread_id = 'thread-1' AND provider_turn_id = 'turn-1' AND type = 'user_input_request'
      `;
      assert.include(plan[0]?.detail ?? "", "USING INDEX orchestration_v2_projection_turn_items_");
    }),
  );
});

// Its own database: the 112 slot has to be empty when the p0code row is written.
layer("p0code's earlier 112_DropUnusedProviderTurnIndexes", (it) => {
  it.effect(
    "moves a p0code database that recorded this migration as 112 onto upstream's 112-118",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 111 });
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (112, 'DropUnusedProviderTurnIndexes')`;

        yield* runMigrations();

        const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 112
        ORDER BY migration_id
      `;
        assert.deepStrictEqual(
          recorded.map((row) => `${row.migration_id}_${row.name}`),
          [
            "112_LayoutCommandApprovals",
            "113_WorkflowSkippedRuns",
            "114_WorkflowRunIndexes",
            "115_WorkflowRunTags",
            "116_ForkHistoryMembership",
            "117_WorkflowMailSender",
            "118_WorkflowPools",
            "119_DropUnusedProviderTurnIndexes",
          ],
        );
      }),
  );
});
