// @effect-diagnostics nodeBuiltinImport:off -- Tests inspect real files and WAL state independently of the host adapter.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { afterEach, expect, it } from "vite-plus/test";
import { BUILD_MIGRATION_HEAD, migrationManifest } from "@t3tools/shared/migrationManifest";
import {
  applyApprovedRestore,
  approveRestore,
  cancelRestore,
  createSnapshot,
  pendingRestore,
  stageRestore,
  verifySnapshot,
} from "./dataBackupFiles.ts";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await NodeFSP.rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p0-backup-test-")),
  );
  temporary.push(root);
  const stateDir = NodePath.join(root, "userdata");
  const plugin = NodePath.join(stateDir, "plugins", "backup");
  await NodeFSP.mkdir(plugin, { recursive: true });
  const config = {
    baseDir: root,
    stateDir,
    dbPath: NodePath.join(stateDir, "statev2.sqlite"),
    attachmentsDir: NodePath.join(stateDir, "attachments"),
    settingsPath: NodePath.join(stateDir, "settings.json"),
    keybindingsConfigPath: NodePath.join(stateDir, "keybindings.json"),
  };
  await NodeFSP.mkdir(config.attachmentsDir);
  await NodeFSP.writeFile(NodePath.join(config.attachmentsDir, "image.png"), "attachment");
  await NodeFSP.writeFile(
    config.settingsPath,
    JSON.stringify({ path: NodePath.join(root, "userdata", "attachments") }),
  );
  await NodeFSP.writeFile(config.keybindingsConfigPath, "{}");
  await NodeFSP.mkdir(NodePath.join(stateDir, "secrets"));
  await NodeFSP.writeFile(NodePath.join(stateDir, "secrets", "token"), "must-not-leave");
  const db = new NodeSqlite.DatabaseSync(config.dbPath);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE effect_sql_migrations (migration_id INTEGER, name TEXT); CREATE TABLE chats (message TEXT); INSERT INTO chats VALUES ('committed in WAL');",
  );
  const insert = db.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
  for (const [id, name] of migrationManifest) insert.run(id, name);
  const snapshot = async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(plugin, "snapshot-"));
    const manifest = await createSnapshot(config, directory, "source-environment", "test-build");
    return { directory, manifest };
  };
  return { root, config, plugin, db, snapshot };
}

it("snapshots committed WAL data with a complete hashed manifest and no secrets", async () => {
  const f = await fixture();
  try {
    const { directory, manifest } = await f.snapshot();
    expect(manifest.format).toBe(1);
    expect(manifest.migrationHead).toBe(BUILD_MIGRATION_HEAD);
    expect(manifest.files.map((file) => file.path)).toEqual([
      "attachments/image.png",
      "keybindings.json",
      "settings.json",
      "statev2.sqlite",
    ]);
    for (const file of manifest.files) {
      const bytes = await NodeFSP.readFile(NodePath.join(directory, file.path));
      expect(file.bytes).toBe(bytes.length);
      expect(file.sha256).toBe(NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
    }
    const copy = new NodeSqlite.DatabaseSync(NodePath.join(directory, "statev2.sqlite"), {
      readOnly: true,
    });
    try {
      expect(copy.prepare("SELECT message FROM chats").get()?.message).toBe("committed in WAL");
    } finally {
      copy.close();
    }
    expect(await verifySnapshot(directory)).toEqual(manifest);
    expect(await NodeFSP.readdir(directory)).not.toContain("secrets");
  } finally {
    f.db.close();
  }
});

it("stages without changing live data, requires approval, and preserves replaced data", async () => {
  const f = await fixture();
  const { directory } = await f.snapshot();
  f.db.exec("INSERT INTO chats VALUES ('new live data')");
  f.db.close();
  const pending = await stageRestore(f.config, directory, f.plugin);
  expect(await pendingRestore(f.config)).toEqual(pending);
  await expect(NodeFSP.stat(directory)).rejects.toThrow();
  await applyApprovedRestore(f.config);
  let live = new NodeSqlite.DatabaseSync(f.config.dbPath, { readOnly: true });
  expect(live.prepare("SELECT COUNT(*) AS n FROM chats").get()?.n).toBe(2);
  live.close();
  await expect(approveRestore(f.config, "stale-id")).rejects.toThrow("changed");
  await approveRestore(f.config, pending.id);
  await applyApprovedRestore(f.config);
  live = new NodeSqlite.DatabaseSync(f.config.dbPath, { readOnly: true });
  expect(live.prepare("SELECT COUNT(*) AS n FROM chats").get()?.n).toBe(1);
  live.close();
  const replaced = (await NodeFSP.readdir(f.config.stateDir)).find((name) =>
    name.startsWith("restore-replaced-"),
  );
  expect(replaced).toBeDefined();
  const old = new NodeSqlite.DatabaseSync(
    NodePath.join(f.config.stateDir, replaced!, "statev2.sqlite"),
    {
      readOnly: true,
    },
  );
  try {
    expect(old.prepare("SELECT COUNT(*) AS n FROM chats").get()?.n).toBe(2);
  } finally {
    old.close();
  }
  expect(await pendingRestore(f.config)).toBeNull();
  expect(await NodeFSP.readFile(NodePath.join(f.config.stateDir, "secrets", "token"), "utf8")).toBe(
    "must-not-leave",
  );
});

it("refuses a newer migration head and preserves an earlier pending restore", async () => {
  const f = await fixture();
  try {
    const first = await f.snapshot();
    const previous = await stageRestore(f.config, first.directory, f.plugin);
    const next = await f.snapshot();
    await NodeFSP.writeFile(
      NodePath.join(next.directory, "manifest.json"),
      JSON.stringify({ ...next.manifest, migrationHead: BUILD_MIGRATION_HEAD + 1 }),
    );
    await expect(stageRestore(f.config, next.directory, f.plugin)).rejects.toThrow("newer p0code");
    expect(await pendingRestore(f.config)).toEqual(previous);
    await cancelRestore(f.config);
    expect(await pendingRestore(f.config)).toBeNull();
  } finally {
    f.db.close();
  }
});

it.each(["tampered", "unlisted", "symlink", "traversal", "migration-lie"])(
  "refuses %s backups",
  async (kind) => {
    const f = await fixture();
    try {
      const { directory, manifest } = await f.snapshot();
      if (kind === "tampered")
        await NodeFSP.writeFile(NodePath.join(directory, "settings.json"), "changed");
      if (kind === "unlisted") await NodeFSP.writeFile(NodePath.join(directory, "extra"), "extra");
      if (kind === "symlink") {
        await NodeFSP.rm(NodePath.join(directory, "settings.json"));
        await NodeFSP.symlink(f.config.settingsPath, NodePath.join(directory, "settings.json"));
      }
      if (kind === "traversal")
        await NodeFSP.writeFile(
          NodePath.join(directory, "manifest.json"),
          JSON.stringify({
            ...manifest,
            files: [...manifest.files, { path: "../secrets/token", bytes: 0, sha256: "" }],
          }),
        );
      if (kind === "migration-lie")
        await NodeFSP.writeFile(
          NodePath.join(directory, "manifest.json"),
          JSON.stringify({ ...manifest, migrationHead: 0 }),
        );
      await expect(stageRestore(f.config, directory, f.plugin)).rejects.toThrow();
      expect(await pendingRestore(f.config)).toBeNull();
    } finally {
      f.db.close();
    }
  },
);

it("refuses directories outside the plugin data directory", async () => {
  const f = await fixture();
  try {
    await expect(stageRestore(f.config, f.root, f.plugin)).rejects.toThrow("inside");
  } finally {
    f.db.close();
  }
});

it("rolls back a failed install and leaves the verified snapshot available for retry", async () => {
  const f = await fixture();
  const { directory, manifest } = await f.snapshot();
  f.db.exec("INSERT INTO chats VALUES ('keep on failure')");
  f.db.close();
  const pending = await stageRestore(f.config, directory, f.plugin);
  await approveRestore(f.config, pending.id);
  const brokenConfig = {
    ...f.config,
    keybindingsConfigPath: NodePath.join(f.root, "missing-parent", "keybindings.json"),
  };
  await expect(applyApprovedRestore(brokenConfig)).rejects.toThrow();
  const live = new NodeSqlite.DatabaseSync(f.config.dbPath, { readOnly: true });
  try {
    expect(live.prepare("SELECT COUNT(*) AS n FROM chats").get()?.n).toBe(2);
  } finally {
    live.close();
  }
  expect(await pendingRestore(f.config)).toEqual(pending);
  expect(
    await verifySnapshot(NodePath.join(f.config.stateDir, "restore-pending", "snapshot")),
  ).toEqual(manifest);
  await applyApprovedRestore(f.config);
  expect(await pendingRestore(f.config)).toBeNull();
});

it("rewrites paths from the source home when restoring on another machine", async () => {
  const f = await fixture();
  const { directory } = await f.snapshot();
  f.db.close();
  const pending = await stageRestore(f.config, directory, f.plugin);
  await approveRestore(f.config, pending.id);
  await applyApprovedRestore({ ...f.config, baseDir: "/a-different-home/p0code" });
  expect(await NodeFSP.readFile(f.config.settingsPath, "utf8")).toContain(
    "/a-different-home/p0code/userdata/attachments",
  );
});

it("rejects migration names this build cannot apply even when the head is supported", async () => {
  const f = await fixture();
  try {
    f.db
      .prepare("UPDATE effect_sql_migrations SET name = ? WHERE migration_id = ?")
      .run("UnknownFutureLayout", BUILD_MIGRATION_HEAD);
    const { directory } = await f.snapshot();
    await expect(stageRestore(f.config, directory, f.plugin)).rejects.toThrow("newer p0code");
  } finally {
    f.db.close();
  }
});

it("recovers an interrupted replacement before opening the live database", async () => {
  const f = await fixture();
  const { directory, manifest } = await f.snapshot();
  f.db.exec("INSERT INTO chats VALUES ('survives interrupted restart')");
  f.db.close();
  await stageRestore(f.config, directory, f.plugin);
  const replaced = NodePath.join(f.config.stateDir, "restore-replaced-interrupted");
  const install = NodePath.join(f.config.stateDir, "restore-pending", "install");
  await NodeFSP.mkdir(replaced);
  await NodeFSP.mkdir(install);
  await NodeFSP.writeFile(
    NodePath.join(f.config.stateDir, "restore-transaction.json"),
    JSON.stringify({ replaced, committed: false }),
  );
  await NodeFSP.rename(f.config.dbPath, NodePath.join(replaced, "statev2.sqlite"));
  await NodeFSP.copyFile(
    NodePath.join(f.config.stateDir, "restore-pending", "snapshot", "statev2.sqlite"),
    f.config.dbPath,
  );
  await applyApprovedRestore(f.config);
  const live = new NodeSqlite.DatabaseSync(f.config.dbPath, { readOnly: true });
  try {
    expect(live.prepare("SELECT COUNT(*) AS n FROM chats").get()?.n).toBe(2);
  } finally {
    live.close();
  }
  expect(
    await verifySnapshot(NodePath.join(f.config.stateDir, "restore-pending", "snapshot")),
  ).toEqual(manifest);
});
