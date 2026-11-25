import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Nothing looks nodes up by provider turn. The one turn-item lookup by provider turn also
  // filters by thread and type, which the (thread_id, type, status) index serves.
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_nodes_provider_turn_idx`;
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_provider_turn_idx`;
});
