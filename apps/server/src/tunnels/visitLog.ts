import {
  PUBLIC_TUNNEL_MAX_VISITS_LIMIT,
  PublicTunnelId,
  type PublicTunnelVisit,
  type PublicTunnelVisitsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

const VISIT_FLUSH_INTERVAL_MS = 2_000;
const MAX_VISITS_KEPT_PER_TUNNEL = 500;
const MAX_METHOD_LENGTH = 16;
const MAX_IP_LENGTH = 64;
const MAX_PATH_LENGTH = 200;
const MAX_UA_LENGTH = 120;

export interface PendingPublicTunnelVisit {
  readonly tunnelId: PublicTunnelId;
  readonly at: number;
  readonly ip: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly bytes: number;
  readonly ua: string | null;
}

interface VisitRow {
  readonly id: number;
  readonly tunnel_id: string;
  readonly at: number;
  readonly ip: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly bytes: number;
  readonly ua: string | null;
}

export interface VisitLogHandle {
  readonly record: (entry: PendingPublicTunnelVisit) => void;
  readonly flush: () => Effect.Effect<void>;
  readonly query: (
    tunnelId: PublicTunnelId,
    options?: { readonly before?: number; readonly limit?: number },
  ) => Effect.Effect<PublicTunnelVisitsResult, SqlError.SqlError>;
}

export const makeVisitLog = Effect.fn("PublicTunnels.makeVisitLog")(function* (options: {
  readonly onFlushed?: (tunnelIds: ReadonlySet<PublicTunnelId>) => Effect.Effect<void>;
}) {
  const sql = yield* SqlClient.SqlClient;
  let buffer: PendingPublicTunnelVisit[] = [];

  const record = (entry: PendingPublicTunnelVisit) => {
    buffer.push({
      tunnelId: entry.tunnelId,
      at: entry.at,
      ip: entry.ip.slice(0, MAX_IP_LENGTH),
      method: entry.method.slice(0, MAX_METHOD_LENGTH),
      path: entry.path.slice(0, MAX_PATH_LENGTH),
      status: entry.status,
      bytes: Math.max(0, Math.floor(entry.bytes)),
      ua: entry.ua ? entry.ua.slice(0, MAX_UA_LENGTH) : null,
    });
  };

  const flush = Effect.fn("PublicTunnels.visitLog.flush")(function* () {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

    const byTunnel = new Map<PublicTunnelId, { count: number; lastAt: number; bytesOut: number }>();
    for (const item of batch) {
      const current = byTunnel.get(item.tunnelId);
      if (current) {
        current.count += 1;
        current.lastAt = Math.max(current.lastAt, item.at);
        current.bytesOut += item.bytes;
      } else {
        byTunnel.set(item.tunnelId, {
          count: 1,
          lastAt: item.at,
          bytesOut: item.bytes,
        });
      }
    }

    const updatedTunnels = new Set<PublicTunnelId>();
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const [tunnelId, delta] of byTunnel) {
            const existing = yield* sql<{ readonly id: string }>`
              SELECT id FROM public_tunnels WHERE id = ${tunnelId}
            `;
            if (existing.length === 0) continue;
            updatedTunnels.add(tunnelId);
            yield* sql`
              UPDATE public_tunnels
              SET
                visit_count = visit_count + ${delta.count},
                last_visit_at = MAX(COALESCE(last_visit_at, 0), ${delta.lastAt}),
                bytes_out = bytes_out + ${delta.bytesOut}
              WHERE id = ${tunnelId}
            `;
          }
          for (const item of batch) {
            if (!updatedTunnels.has(item.tunnelId)) continue;
            yield* sql`
              INSERT INTO public_tunnel_visits (tunnel_id, at, ip, method, path, status, bytes, ua)
              VALUES (
                ${item.tunnelId},
                ${item.at},
                ${item.ip},
                ${item.method},
                ${item.path},
                ${item.status},
                ${item.bytes},
                ${item.ua}
              )
            `;
          }
          for (const tunnelId of updatedTunnels) {
            yield* sql`
              DELETE FROM public_tunnel_visits
              WHERE tunnel_id = ${tunnelId}
                AND id NOT IN (
                  SELECT id FROM public_tunnel_visits
                  WHERE tunnel_id = ${tunnelId}
                  ORDER BY id DESC
                  LIMIT ${MAX_VISITS_KEPT_PER_TUNNEL}
                )
            `;
          }
        }),
      )
      .pipe(Effect.ignoreCause({ log: true }));

    if (updatedTunnels.size > 0 && options.onFlushed) {
      yield* options.onFlushed(updatedTunnels).pipe(Effect.ignoreCause({ log: true }));
    }
  });

  yield* Effect.sleep(`${VISIT_FLUSH_INTERVAL_MS} millis`).pipe(
    Effect.andThen(flush()),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => flush().pipe(Effect.ignore));

  const query: VisitLogHandle["query"] = Effect.fn("PublicTunnels.visitLog.query")(
    function* (tunnelId, input) {
      yield* flush();
      const limit = Math.min(PUBLIC_TUNNEL_MAX_VISITS_LIMIT, Math.max(1, input?.limit ?? 50));
      const rows =
        input?.before !== undefined
          ? yield* sql<VisitRow>`
            SELECT id, tunnel_id, at, ip, method, path, status, bytes, ua
            FROM public_tunnel_visits
            WHERE tunnel_id = ${tunnelId} AND id < ${input.before}
            ORDER BY id DESC
            LIMIT ${limit}
          `
          : yield* sql<VisitRow>`
            SELECT id, tunnel_id, at, ip, method, path, status, bytes, ua
            FROM public_tunnel_visits
            WHERE tunnel_id = ${tunnelId}
            ORDER BY id DESC
            LIMIT ${limit}
          `;
      const visits: PublicTunnelVisit[] = rows.map((row) => ({
        id: row.id,
        tunnelId: PublicTunnelId.make(row.tunnel_id),
        at: row.at,
        ip: row.ip,
        method: row.method,
        path: row.path,
        status: row.status,
        bytes: row.bytes,
        ua: row.ua,
      }));
      const nextCursor = visits.length === limit ? (visits[visits.length - 1]?.id ?? null) : null;
      return { visits, nextCursor };
    },
  );

  return { record, flush, query } satisfies VisitLogHandle;
});
