# Shrinking statev2.sqlite

Measured on `VACUUM INTO` copy of a real 605 MB `statev2.sqlite` (page size 4096, `auto_vacuum=0`, no
free pages, migration head 111). Experiments ran on copies only.

Biggest consumers: `projection_turn_items` 225 MB (`dynamic_tool` payloads 94 MB, `command_execution`
46 MB), `orchestration_events` 152 MB, `projection_nodes` 65 MB. All 190 indexes together are 94 MB.
Almost all of the file is live data, so storage hygiene and index cleanup only recover a few percent.

| Step                                                   | Copy size (bytes) | Change      |
| ------------------------------------------------------ | ----------------- | ----------- |
| Baseline (`VACUUM INTO` of the live DB)                | 620,527,616       |             |
| 1. one-time `VACUUM` into `auto_vacuum=INCREMENTAL`    | 621,285,376       | +0.76 MB    |
| 2. drop two unused indexes + `incremental_vacuum`      | 611,004,416       | −10.3 MB    |
| 3. event log compaction                                | already implemented, see below | |
| 4. compress tool outputs                               | not done, see below | |

An end-to-end run of the real startup layer (`Sqlite.layerFromPath`) on a fresh copy gave the same
611.0 MB, with `auto_vacuum=2` and migration 112 recorded. The VACUUM took about 3 s here.

## 1. Storage hygiene

Most of this already existed: new databases are created `INCREMENTAL`, `DatabaseStorage.reclaim` returns
free pages every minute (1024 pages per pass), a worker thread checkpoints the WAL, and
`journal_size_limit` is 128 MB. What was missing:

- **Existing databases never switched modes** unless the user ran Settings' Reclaim (a restart plus an
  offline `VACUUM`). `EnableIncrementalVacuum.ts` now does the one-time `VACUUM` at server startup,
  before migrations, while this process is the only writer. It logs the start, a heartbeat every 10 s
  (`VACUUM` is one statement without progress callbacks) and the before/after size. It checks free disk
  space first (`reclaimSpaceShortfall`), and never fails startup: a busy database or too little space
  logs a warning and retries on the next start. CLI commands (`layerCliConfig`) skip it, since they
  must not hold the writer behind a running server.
- **The WAL file kept its peak size** (up to the 128 MB limit) until the process exited. The 6-hourly
  compaction pass now ends with `wal_checkpoint(TRUNCATE)`.

A plain `VACUUM` does not shrink this DB: it has no free pages. The mode switch only pays off once pruning
or index drops free pages, which the existing reclaim loop then returns.

## 2. Indexes

`redundant prefix` search over all 190 indexes (same table, same partial `WHERE`, key list a prefix of
another non-unique index) found nothing; migration 056 and later ones already removed those. Candidates
that remained were checked against every SQL statement:

- Dropped `orchestration_v2_projection_turn_items_provider_turn_idx` (5.3 MB). The only turn-item query
  filtering by `provider_turn_id` also filters `thread_id` and `type` (ProjectionStore, user-input
  requests). `EXPLAIN QUERY PLAN` before and after: `SEARCH ... USING INDEX
  orchestration_v2_projection_turn_items_thread_type_idx (thread_id=? AND type=?)`, unchanged.
- Dropped `orchestration_v2_projection_nodes_provider_turn_idx` (4.5 MB). No query reads nodes by
  `provider_turn_id`; the only mentions are upsert column lists. No foreign keys reference either table.
- Kept: every index named in an `INDEXED BY` hint, `thread_ordinal`, `thread_run`, `thread_type`,
  `node_ordinal`, `run_ordinal`, and `nodes_parent_idx` (a `parent_node_id IN (...)` term inside an
  `OR`, where SQLite may use it for a multi-index plan). Dropping those saves 3 to 6 MB each and risks the
  hot read paths, so they stay unless someone measures a plan.

Migration `112_DropUnusedProviderTurnIndexes`.

## 3. Event log

Not added: the compaction already exists. `ProjectionMaintenance.pruneEventStore` (every 6 h) deletes
every event older than the retention window (1 to 1.25 days) and behind the projection checkpoint,
except the newest event of each stream, `thread.created`, `run.updated` with status `running` (Codex
usage history), legacy v1 events not yet imported, and prompt anchors referenced through `promptSequence`.
`event-log-pruned-through` is published before deleting; clients and `ws.ts` replay compare their cursor
with it and take a snapshot instead of replaying. So superseded `*.updated` events older than the window
are never read again. Everything the copy still holds is the retention window (33,887 events, 152 MB).

Inside that window, superseded updates (a later event for the same entity id exists) are:

| Event type           | Rows   | Superseded rows | Superseded size |
| -------------------- | ------ | --------------- | --------------- |
| `turn-item.updated`  | 14,187 | 8,140           | 34.5 MB         |
| `node.updated`       | 9,185  | 4,234           | 6.6 MB          |
| `provider-turn.updated` | 4,139 | 4,033         | 6.0 MB          |
| `message.updated`    | 1,966  | 899             | 2.2 MB          |
| `run.updated`        | 1,236  | 281             | 0.3 MB          |

About 50 MB (8% of the file). I did not delete these, because it is not provable from the server alone:
events inside the window are replayed in order to reconnecting clients, plugins (`plugins/bindings.ts`)
and guest streams (`guestStream.logic.ts`), and the replay boundary is a single `prunedThrough` sequence.
Deleting inside the window would need a second boundary, or it effectively shortens retention, and
consumers that react to intermediate states (for example a run passing through `running`) would miss them.
The simple knob is `RETAINED_EVENT_HISTORY` (1 day): lowering it to a few hours would recover most of the
50 MB, at the cost of a full snapshot for clients that were away longer. That is a product call, so I left it.

## 4. Big tool outputs

Not done, proposal only. `dynamic_tool` plus `command_execution` payloads are 140 MB of the file, mostly
`$.output` (90 MB and 28 MB), and compress about 4x. But SQL reads these payloads directly:
`getTranscriptByteFloor` (ProjectionStore.ts) sums `octet_length(payload_json)` and walks
`json_tree(payload_json, '$.output')` over every tool row, and the whole projection layer decodes
`payload_json` in 48 places. The Go backend shares the DB, so it would need the same decoder.

Proposal, in order of safety:

1. Cap stored output (keep head and tail with a `truncated` marker) at write time in the projection, in
   one place. It changes nothing for readers except long outputs; needs a product decision on the cap.
2. Compress into a new nullable column `output_zstd BLOB`, leaving `payload_json` without `$.output`,
   and give `getTranscriptByteFloor` a stored `output_bytes` column. Needs one decode helper shared by all
   readers and by Go, and a backfill migration.
