import * as Schema from "effect/Schema";
import { sqliteTempDirectory } from "./DatabaseMaintenance.ts";
import packageJson from "../../package.json" with { type: "json" };
import {
  DataRestoreError,
  type DataSnapshotManifest,
  type PendingRestore,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Files from "./dataBackupFiles.ts";
import { ServerRestart } from "./DatabaseStorage.ts";

const isDataRestoreError = Schema.is(DataRestoreError);

export class DataBackup extends Context.Service<
  DataBackup,
  {
    readonly snapshot: (
      dataDir: string,
    ) => Effect.Effect<
      { readonly directory: string; readonly manifest: DataSnapshotManifest },
      DataRestoreError,
      Scope.Scope
    >;
    readonly stage: (
      directory: string,
      within: string,
    ) => Effect.Effect<PendingRestore, DataRestoreError>;
    readonly pending: Effect.Effect<PendingRestore | null, DataRestoreError>;
    readonly changes: Stream.Stream<PendingRestore | null>;
    readonly cancel: Effect.Effect<void, DataRestoreError>;
    readonly approve: (id: string) => Effect.Effect<void, DataRestoreError>;
    readonly cleanup: (dataDir: string) => Effect.Effect<void, DataRestoreError>;
  }
>()("t3/persistence/DataBackup") {}

export const layer = Layer.effect(
  DataBackup,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const fs = yield* FileSystem.FileSystem;
    const restart = yield* ServerRestart;
    const snapshots = yield* Semaphore.make(1);
    const restores = yield* Semaphore.make(1);
    const attempt = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: (cause) =>
          new DataRestoreError({
            message: isDataRestoreError(cause)
              ? cause.message
              : "Could not prepare the data backup. Check that its files are readable and enough disk space is available.",
          }),
      });
    const pending = attempt(() => Files.pendingRestore(config));
    const state = yield* SubscriptionRef.make(yield* pending);
    const publish = pending.pipe(Effect.flatMap((value) => SubscriptionRef.set(state, value)));
    const snapshot = Effect.fn("DataBackup.snapshot")(function* (dataDir: string) {
      const directory = yield* Effect.acquireRelease(
        fs
          .makeTempDirectory({ directory: dataDir, prefix: "snapshot-" })
          .pipe(
            Effect.mapError(
              () => new DataRestoreError({ message: "Could not create a snapshot directory." }),
            ),
          ),
        (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
      );
      const environmentId = yield* environment.getEnvironmentId;
      const temporaryDirectory = yield* sqliteTempDirectory.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.mapError(
          () => new DataRestoreError({ message: "Could not check SQLite temporary disk space." }),
        ),
      );
      const manifest = yield* snapshots.withPermits(1)(
        attempt(() =>
          Files.createSnapshot(
            config,
            directory,
            environmentId,
            packageJson.version,
            temporaryDirectory,
          ),
        ).pipe(Effect.uninterruptible),
      );
      return { directory, manifest };
    });
    const stage = Effect.fn("DataBackup.stage")((directory: string, within: string) =>
      restores.withPermits(1)(
        attempt(() => Files.stageRestore(config, directory, within)).pipe(
          Effect.tap(publish),
          Effect.uninterruptible,
        ),
      ),
    );
    const cancel = restores.withPermits(1)(
      attempt(() => Files.cancelRestore(config)).pipe(Effect.tap(publish), Effect.uninterruptible),
    );
    const approve = Effect.fn("DataBackup.approve")(function* (id: string) {
      if (restart === null)
        return yield* new DataRestoreError({
          message:
            "This server has no supervisor. Start p0code as a desktop app or background service before restoring.",
        });
      yield* restores.withPermits(1)(
        attempt(() => Files.approveRestore(config, id)).pipe(
          Effect.andThen(restart.pipe(Effect.delay("500 millis"), Effect.forkDetach)),
          Effect.uninterruptible,
        ),
      );
    });
    const cleanup = Effect.fn("DataBackup.cleanup")(
      function* (dataDir: string) {
        const entries = yield* fs.readDirectory(dataDir);
        for (const entry of entries)
          if (entry.startsWith("snapshot-"))
            yield* fs.remove(`${dataDir}/${entry}`, { recursive: true, force: true });
      },
      Effect.mapError(() => new DataRestoreError({ message: "Could not clean stale snapshots." })),
    );
    return DataBackup.of({
      snapshot,
      stage,
      pending,
      changes: SubscriptionRef.changes(state),
      cancel,
      approve,
      cleanup,
    });
  }),
);
