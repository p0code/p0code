import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Deploy: linked accounts (names and profiles only; credentials stay in each plugin's storage),
 * project mappings, recent deployments and approvals waiting for a person, so a restart keeps
 * them. Deployments and approvals are capped per project by the deploy service.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS deploy_accounts (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL,
      label TEXT,
      team_id TEXT,
      profile_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS deploy_project_mappings (
      project_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES deploy_accounts(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      target_name TEXT NOT NULL,
      default_environment TEXT NOT NULL,
      directory TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS deploy_records (
      account_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      target_kind TEXT NOT NULL,
      target_name TEXT NOT NULL,
      environment TEXT NOT NULL,
      branch TEXT,
      url TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (account_id, deployment_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_deploy_records_project_created
      ON deploy_records (project_id, created_at DESC)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS deploy_approvals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      approval_json TEXT NOT NULL,
      request_json TEXT NOT NULL,
      requested_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_deploy_approvals_project
      ON deploy_approvals (project_id, requested_at DESC)
  `;
});
