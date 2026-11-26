import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS public_tunnels (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_json TEXT NOT NULL,
      routing TEXT NOT NULL,
      slug TEXT NOT NULL,
      rid TEXT,
      rid_mode TEXT NOT NULL DEFAULT 'tunnel',
      access TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      created_by_json TEXT NOT NULL,
      project_id TEXT,
      thread_id TEXT,
      target_dev TEXT,
      target_ino TEXT,
      host_label TEXT NOT NULL,
      link_secret_id TEXT,
      visit_count INTEGER NOT NULL DEFAULT 0,
      last_visit_at INTEGER,
      bytes_out INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_public_tunnels_path_slug_rid
      ON public_tunnels (slug, rid)
      WHERE routing = 'path' AND status IN ('pending_approval', 'live', 'paused')
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_public_tunnels_subdomain_slug
      ON public_tunnels (slug)
      WHERE routing = 'subdomain' AND status IN ('pending_approval', 'live', 'paused')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_public_tunnels_project_id
      ON public_tunnels (project_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_public_tunnels_thread_id
      ON public_tunnels (thread_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS public_tunnel_project_rids (
      project_id TEXT PRIMARY KEY,
      rid TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS public_tunnel_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tunnel_id TEXT NOT NULL REFERENCES public_tunnels(id) ON DELETE CASCADE,
      at INTEGER NOT NULL,
      ip TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      ua TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_public_tunnel_visits_tunnel_at
      ON public_tunnel_visits (tunnel_id, id DESC)
  `;
});
