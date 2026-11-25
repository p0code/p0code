// @effect-diagnostics nodeBuiltinImport:off -- Creates real homes and SQLite fixtures on disk.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  acceptT3Import,
  applyPendingT3Import,
  isT3ImportHomeFresh,
  readT3ImportStatus,
  T3ImportUnavailableError,
} from "./t3Import.ts";

const temporaryDirectories: Array<string> = [];

const temporaryHome = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "p0-t3-import-"));
  temporaryDirectories.push(directory);
  return {
    homeDirectory: directory,
    appHome: NodePath.join(directory, ".p0code"),
    stockHome: NodePath.join(directory, ".t3"),
  };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

const seedDatabase = (databasePath: string, seed: (database: NodeSqlite.DatabaseSync) => void) => {
  NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    seed(database);
  } finally {
    database.close();
  }
};

const seedStockHome = (stockHome: string, migrations?: Array<readonly [number, string]>) => {
  const databasePath = NodePath.join(stockHome, "userdata", "statev2.sqlite");
  NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(stockHome, "userdata", "settings.json"), '{"theme":"dark"}');
  seedDatabase(databasePath, (database) => {
    database.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    const insert = database.prepare(
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (?, ?)",
    );
    for (const [id, name] of migrations ?? [[5, "Projections"]]) insert.run(id, name);
  });
};

const bootstrapSchema = `
  CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, deleted_at TEXT);
  CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    deleted_at TEXT,
    payload_json TEXT NOT NULL
  );
  CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY);
  CREATE TABLE orchestration_v2_projection_messages (
    message_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL
  );
`;

const seedBootstrapHome = (appHome: string) => {
  seedDatabase(NodePath.join(appHome, "userdata", "statev2.sqlite"), (database) => {
    database.exec(bootstrapSchema);
    database.exec(`
      INSERT INTO projection_projects (project_id) VALUES ('bootstrap-project');
      INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, payload_json)
        VALUES ('bootstrap-thread', 'bootstrap-project',
          '{"createdBy":"system","creationSource":"server"}');
    `);
  });
};

const seedUsedHome = (appHome: string) => {
  seedDatabase(NodePath.join(appHome, "userdata", "statev2.sqlite"), (database) => {
    database.exec(bootstrapSchema);
    database.exec(`
      INSERT INTO projection_projects (project_id) VALUES ('project-a');
      INSERT INTO projection_projects (project_id) VALUES ('project-b');
      INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, payload_json)
        VALUES ('thread-a', 'project-a', '{"createdBy":"user","creationSource":"web"}');
      INSERT INTO orchestration_v2_projection_messages (message_id, payload_json)
        VALUES ('message-a', '{"createdBy":"user"}');
    `);
  });
};

const writePendingMarker = (appHome: string, source: string) => {
  const path = NodePath.join(appHome, "userdata", "pending-t3-import.json");
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(
    path,
    `${JSON.stringify({ requestedAt: "2026-01-01T00:00:00.000Z", source, appVersion: "0.2.0" })}\n`,
  );
  return path;
};

describe("t3 import status", () => {
  it("offers the import on a home whose only data is onboarding's bootstrap", async () => {
    const { appHome, stockHome } = temporaryHome();
    seedBootstrapHome(appHome);
    seedStockHome(stockHome);

    expect(await isT3ImportHomeFresh(appHome)).toBe(true);
    expect(await readT3ImportStatus({ appHome, stockHome })).toMatchObject({
      available: true,
      fresh: true,
      reason: "available",
      appHome,
      stockHome,
    });
  });

  it("offers the import before this home has any database", async () => {
    const { appHome, stockHome } = temporaryHome();
    seedStockHome(stockHome);

    expect(await readT3ImportStatus({ appHome, stockHome })).toMatchObject({
      available: true,
      fresh: true,
      reason: "available",
    });
  });

  it("never throws when the stock home is missing", async () => {
    const { appHome, stockHome } = temporaryHome();

    expect(await readT3ImportStatus({ appHome, stockHome })).toMatchObject({
      available: false,
      fresh: true,
      reason: "stock-home-missing",
    });
  });

  it("refuses a home with user data", async () => {
    const { appHome, stockHome } = temporaryHome();
    seedUsedHome(appHome);
    seedStockHome(stockHome);

    expect(await isT3ImportHomeFresh(appHome)).toBe(false);
    expect(await readT3ImportStatus({ appHome, stockHome })).toMatchObject({
      available: false,
      fresh: false,
      reason: "home-not-fresh",
    });
  });
});

describe("accepting the t3 import", () => {
  it("refuses when the home already has user data", async () => {
    const { appHome, stockHome } = temporaryHome();
    seedUsedHome(appHome);
    seedStockHome(stockHome);

    await expect(
      acceptT3Import({ appHome, stockHome, appVersion: "0.2.0" }),
    ).rejects.toBeInstanceOf(T3ImportUnavailableError);
    expect(NodeFS.existsSync(NodePath.join(appHome, "userdata", "pending-t3-import.json"))).toBe(
      false,
    );
  });

  it("writes consent without running the migration", async () => {
    const { appHome, stockHome } = temporaryHome();
    seedBootstrapHome(appHome);
    seedStockHome(stockHome);

    const status = await acceptT3Import({
      appHome,
      stockHome,
      appVersion: "0.2.0",
      nowMs: Date.UTC(2026, 0, 2),
    });

    expect(status).toMatchObject({ available: false, reason: "pending" });
    const marker = JSON.parse(
      NodeFS.readFileSync(NodePath.join(appHome, "userdata", "pending-t3-import.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(marker).toEqual({
      requestedAt: "2026-01-02T00:00:00.000Z",
      source: stockHome,
      appVersion: "0.2.0",
    });
    // Nothing copied yet: the settings only arrive on the next start.
    expect(NodeFS.existsSync(NodePath.join(appHome, "userdata", "settings.json"))).toBe(false);
  });
});

describe("applying the t3 import on boot", () => {
  it("imports once, writes the report and removes the marker", async () => {
    const { appHome, stockHome } = temporaryHome();
    seedBootstrapHome(appHome);
    seedStockHome(stockHome);
    const markerPath = writePendingMarker(appHome, stockHome);

    const result = await applyPendingT3Import({ appHome, stockHome, keychain: null });

    expect(result.status).toBe("applied");
    expect(NodeFS.existsSync(markerPath)).toBe(false);
    expect(
      JSON.parse(
        NodeFS.readFileSync(NodePath.join(appHome, "userdata", "t3-import-report.json"), "utf8"),
      ),
    ).toMatchObject({ status: "migrated", from: stockHome, to: appHome });
    expect(NodeFS.readFileSync(NodePath.join(appHome, "userdata", "settings.json"), "utf8")).toBe(
      '{"theme":"dark"}',
    );

    // A second boot has nothing left to do.
    expect(await applyPendingT3Import({ appHome, stockHome, keychain: null })).toEqual({
      status: "nothing",
    });
  });

  it("fails safely and clears the marker when the source is newer", async () => {
    const { appHome, stockHome } = temporaryHome();
    seedBootstrapHome(appHome);
    seedStockHome(stockHome, [[999, "FutureT3Migration"]]);
    const markerPath = writePendingMarker(appHome, stockHome);

    const result = await applyPendingT3Import({ appHome, stockHome, keychain: null });

    expect(result.status).toBe("failed");
    expect(NodeFS.existsSync(markerPath)).toBe(false);
    expect(
      NodeFS.readFileSync(NodePath.join(appHome, "userdata", "statev2.sqlite")).length,
    ).toBeGreaterThan(0);
    // The next boot starts normally instead of retrying forever.
    expect(await applyPendingT3Import({ appHome, stockHome, keychain: null })).toEqual({
      status: "nothing",
    });
  });

  it("clears the marker when the keychain cannot be resolved", async () => {
    const { appHome, stockHome } = temporaryHome();
    seedBootstrapHome(appHome);
    seedStockHome(stockHome);
    const markerPath = writePendingMarker(appHome, stockHome);

    const result = await applyPendingT3Import({
      appHome,
      stockHome,
      keychainLoader: () => Promise.reject(new Error("keychain unavailable")),
    });

    expect(result).toMatchObject({ status: "failed", error: "keychain unavailable" });
    expect(NodeFS.existsSync(markerPath)).toBe(false);
  });

  it("ignores a marker with no readable source instead of boot-looping", async () => {
    const { appHome, stockHome } = temporaryHome();
    const markerPath = NodePath.join(appHome, "userdata", "pending-t3-import.json");
    await NodeFSP.mkdir(NodePath.dirname(markerPath), { recursive: true });
    await NodeFSP.writeFile(markerPath, "not json");

    expect(await applyPendingT3Import({ appHome, stockHome, keychain: null })).toEqual({
      status: "failed",
      error: "The pending T3 Code import marker was unreadable.",
    });
    expect(NodeFS.existsSync(markerPath)).toBe(false);
  });
});
