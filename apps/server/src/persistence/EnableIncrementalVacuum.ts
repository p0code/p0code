import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { reclaimSpaceShortfall } from "./DatabaseMaintenance.ts";

const HEARTBEAT_MS = 10_000;

const readBytes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pages = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
  const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
  const size = yield* sql<{ readonly page_size: number }>`PRAGMA page_size`;
  const pageSize = size[0]?.page_size ?? 0;
  const pageCount = pages[0]?.page_count ?? 0;
  const freeCount = free[0]?.freelist_count ?? 0;
  return { databaseBytes: pageCount * pageSize, liveBytes: (pageCount - freeCount) * pageSize };
});

/**
 * Databases created before incremental auto_vacuum only switch modes through a VACUUM. Runs it once
 * at startup, before migrations, while this process is the only writer. Never fails startup: a
 * busy database or too little disk space leaves the old mode and tries again on the next start.
 */
export const enableIncrementalVacuum = Effect.fn("Sqlite.enableIncrementalVacuum")(
  function* (databasePath: string) {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
    if (mode[0]?.auto_vacuum !== 0) return;
    const tables = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table'`;
    if ((tables[0]?.count ?? 0) === 0) return;

    const before = yield* readBytes;
    const shortfall = yield* reclaimSpaceShortfall(databasePath, before.liveBytes).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (shortfall !== null) {
      return yield* Effect.logWarning(
        "Skipping the one-time database VACUUM that enables incremental auto_vacuum; not enough free disk space",
        shortfall,
      );
    }

    yield* Effect.logInfo("Enabling incremental auto_vacuum with a one-time VACUUM", {
      databasePath,
      databaseBytes: before.databaseBytes,
    });
    const startedAt = yield* Clock.currentTimeMillis;
    // VACUUM is one statement with no progress callback, so a heartbeat shows it is still running.
    const heartbeat = Effect.forever(
      Effect.sleep(HEARTBEAT_MS).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.flatMap((now) =>
          Effect.logInfo("Still running the one-time database VACUUM", {
            elapsedSeconds: Math.round((now - startedAt) / 1000),
          }),
        ),
      ),
    );
    yield* sql`PRAGMA auto_vacuum = INCREMENTAL`.pipe(
      Effect.andThen(sql`VACUUM`),
      Effect.race(heartbeat),
      // VACUUM in WAL mode rewrites the whole database through the WAL; shrink that file again.
      Effect.andThen(sql`PRAGMA wal_checkpoint(TRUNCATE)`),
      Effect.andThen(readBytes),
      Effect.flatMap((after) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Effect.logInfo("Finished the one-time database VACUUM", {
              elapsedSeconds: Math.round((now - startedAt) / 1000),
              beforeBytes: before.databaseBytes,
              afterBytes: after.databaseBytes,
            }),
          ),
        ),
      ),
    );
  },
  Effect.catch((cause) =>
    Effect.logWarning("The one-time database VACUUM failed; it will run again on the next start", {
      cause,
    }),
  ),
);
