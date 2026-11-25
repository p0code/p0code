// @effect-diagnostics nodeBuiltinImport:off -- Creates real SQLite fixtures on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { migrationManifest } from "@t3tools/shared/migrationManifest";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import { offerT3Import, runT3ImportOnTheFly } from "./DesktopT3Import.ts";

const seedT3Home = (stockHome: string, migrations: ReadonlyArray<readonly [number, string]>) => {
  const userdata = NodePath.join(stockHome, "userdata");
  NodeFS.mkdirSync(userdata, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(userdata, "settings.json"), '{"theme":"dark"}');
  const db = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"));
  try {
    db.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    const insert = db.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    for (const [id, name] of migrations) insert.run(id, name);
  } finally {
    db.close();
  }
};

it.layer(NodeServices.layer)("DesktopT3Import", (it) => {
  it.effect(
    "refuses a newer T3 Code database on first launch and leaves p0code home untouched",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "p0-desktop-t3-import-",
        });
        const baseDir = path.join(homeDirectory, ".p0code");
        const stockHome = path.join(homeDirectory, ".t3");
        yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
        yield* fs.writeFileString(path.join(baseDir, "userdata", "settings.json"), '{"mine":true}');
        seedT3Home(stockHome, [...migrationManifest, [120, "FutureT3Migration"]]);

        const errorBoxes: Array<{ title: string; content: string }> = [];
        let relaunched = false;
        let quitCalled = false;

        const result = yield* offerT3Import().pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            homeDirectory,
            baseDir,
            isDevelopment: false,
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
          Effect.provideService(ElectronDialog.ElectronDialog, {
            showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
            showErrorBox: (title: string, content: string) =>
              Effect.sync(() => {
                errorBoxes.push({ title, content });
              }),
          } as unknown as ElectronDialog.ElectronDialog["Service"]),
          Effect.provideService(ElectronApp.ElectronApp, {
            relaunch: () =>
              Effect.sync(() => {
                relaunched = true;
              }),
            quit: Effect.sync(() => {
              quitCalled = true;
            }),
          } as unknown as ElectronApp.ElectronApp["Service"]),
          Effect.provideService(HostProcess.Platform, "darwin"),
        );

        assert.isFalse(result);
        assert.isFalse(relaunched);
        assert.isFalse(quitCalled);
        assert.lengthOf(errorBoxes, 1);
        assert.include(
          errorBoxes[0]!.content,
          "This T3 Code install is newer than this p0code build understands.",
        );
        assert.notInclude(errorBoxes[0]!.content, "p0 migrate from-t3 --force");
        assert.equal(
          yield* fs.readFileString(path.join(baseDir, "userdata", "settings.json")),
          '{"mine":true}',
        );
      }),
  );

  it.effect(
    "refuses a newer T3 Code database in on-the-fly settings import without shutting down",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDirectory = yield* fs.makeTempDirectoryScoped({
          prefix: "p0-desktop-t3-onthefly-",
        });
        const baseDir = path.join(homeDirectory, ".p0code");
        const stockHome = path.join(homeDirectory, ".t3");
        yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
        yield* fs.writeFileString(path.join(baseDir, "userdata", "settings.json"), '{"mine":true}');
        seedT3Home(stockHome, [...migrationManifest, [120, "FutureT3Migration"]]);

        let shutdownRequested = false;

        const result = yield* runT3ImportOnTheFly({ keepEnvironmentId: false }).pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
            homeDirectory,
            baseDir,
          } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
          Effect.provideService(DesktopShutdown.DesktopShutdown, {
            request: Effect.sync(() => {
              shutdownRequested = true;
            }),
            awaitComplete: Effect.void,
          } as unknown as DesktopShutdown.DesktopShutdown["Service"]),
          Effect.provideService(ElectronDialog.ElectronDialog, {
            showErrorBox: () => Effect.void,
          } as unknown as ElectronDialog.ElectronDialog["Service"]),
          Effect.provideService(ElectronApp.ElectronApp, {
            relaunch: () => Effect.void,
            exit: () => Effect.void,
          } as unknown as ElectronApp.ElectronApp["Service"]),
          Effect.provide(DesktopState.layer),
          Effect.provideService(HostProcess.Platform, "darwin"),
        );

        assert.isFalse(result.ok);
        assert.include(
          result.error ?? "",
          "This T3 Code install is newer than this p0code build understands.",
        );
        assert.isFalse(shutdownRequested);
        assert.equal(
          yield* fs.readFileString(path.join(baseDir, "userdata", "settings.json")),
          '{"mine":true}',
        );
      }),
  );

  it.effect("does not prompt when the web welcome screen already staged consent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "p0-desktop-t3-pending-" });
      const baseDir = path.join(homeDirectory, ".p0code");
      const stockHome = path.join(homeDirectory, ".t3");
      yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
      yield* fs.writeFileString(
        path.join(baseDir, "userdata", "pending-t3-import.json"),
        '{"requestedAt":"2026-01-01T00:00:00.000Z","source":"/tmp/.t3","appVersion":"0.2.0"}',
      );
      seedT3Home(
        stockHome,
        migrationManifest.filter(([id]) => id <= 118),
      );

      const result = yield* offerT3Import().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          homeDirectory,
          baseDir,
          isDevelopment: false,
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(ElectronDialog.ElectronDialog, {
          showMessageBox: () => Effect.die("the dialog must not open for a pending import"),
          showErrorBox: (title: string) => Effect.die(`unexpected error box: ${title}`),
        } as unknown as ElectronDialog.ElectronDialog["Service"]),
        Effect.provideService(ElectronApp.ElectronApp, {
          relaunch: () => Effect.die("a pending import must not relaunch"),
          quit: () => Effect.die("a pending import must not quit"),
        } as unknown as ElectronApp.ElectronApp["Service"]),
      );

      assert.isFalse(result);
    }),
  );

  it.effect("imports a compatible T3 Code database on first launch and relaunches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "p0-desktop-t3-ok-" });
      const baseDir = path.join(homeDirectory, ".p0code");
      const stockHome = path.join(homeDirectory, ".t3");
      yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
      seedT3Home(
        stockHome,
        migrationManifest.filter(([id]) => id <= 118),
      );

      let relaunched = false;
      let quitCalled = false;

      const result = yield* offerT3Import().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          homeDirectory,
          baseDir,
          isDevelopment: false,
        } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(ElectronDialog.ElectronDialog, {
          showMessageBox: () => Effect.succeed({ response: 0, checkboxChecked: false }),
          showErrorBox: (title: string, content: string) =>
            Effect.die(`unexpected error box: ${title}: ${content}`),
        } as unknown as ElectronDialog.ElectronDialog["Service"]),
        Effect.provideService(ElectronApp.ElectronApp, {
          relaunch: () =>
            Effect.sync(() => {
              relaunched = true;
            }),
          quit: Effect.sync(() => {
            quitCalled = true;
          }),
        } as unknown as ElectronApp.ElectronApp["Service"]),
        Effect.provideService(HostProcess.Platform, "darwin"),
      );

      assert.isTrue(result);
      assert.isTrue(relaunched);
      assert.isTrue(quitCalled);
      assert.equal(
        yield* fs.readFileString(path.join(baseDir, "userdata", "settings.json")),
        '{"theme":"dark"}',
      );
    }),
  );
});
