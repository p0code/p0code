// @effect-diagnostics globalDate:off -- This Promise adapter also runs at startup, before the Effect runtime services exist.
// @effect-diagnostics nodeBuiltinImport:off -- Filesystem and SQLite worker adapter shared by startup and the Effect service.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeWorkerThreads from "node:worker_threads";
import { DataRestoreError, DataSnapshotManifest, PendingRestore } from "@t3tools/contracts";
import {
  BUILD_MIGRATION_HEAD,
  incompatibleSourceMigrations,
} from "@t3tools/shared/migrationManifest";
import { makePathRewriter } from "@t3tools/shared/migrateFromT3";
import * as Schema from "effect/Schema";
import type { ServerConfig } from "../config.ts";

const decodeManifest = Schema.decodeUnknownSync(DataSnapshotManifest);
type Config = Pick<
  ServerConfig["Service"],
  "stateDir" | "dbPath" | "attachmentsDir" | "settingsPath" | "keybindingsConfigPath" | "baseDir"
>;
const roots = ["statev2.sqlite", "attachments", "settings.json", "keybindings.json"] as const;
const destinations = (config: Config) => [
  config.dbPath,
  config.attachmentsDir,
  config.settingsPath,
  config.keybindingsConfigPath,
];
const pendingPath = (config: Config) => NodePath.join(config.stateDir, "restore-pending");

const sqliteWorker = `
const { workerData, parentPort } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db = new DatabaseSync(workerData.source, { readOnly: true });
try {
  if (workerData.destination) {
    db.prepare("VACUUM INTO ?").run(workerData.destination);
    db.close();
    db = new DatabaseSync(workerData.destination, { readOnly: true });
  }
  const check = db.prepare(workerData.destination ? "PRAGMA quick_check" : "PRAGMA integrity_check").all();
  if (check.length !== 1 || Object.values(check[0])[0] !== "ok") throw new Error("Snapshot database failed its integrity check.");
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'effect_sql_migrations' AND type = 'table'").get();
  parentPort.postMessage(exists ? db.prepare("SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id").all() : []);
} finally { db.close(); }
`;
const Migrations = Schema.Array(Schema.Struct({ id: Schema.Number, name: Schema.String }));
const decodeMigrations = Schema.decodeUnknownSync(Migrations);
const sqlite = (source: string, destination?: string) =>
  new Promise<typeof Migrations.Type>((resolve, reject) => {
    const worker = new NodeWorkerThreads.Worker(sqliteWorker, {
      eval: true,
      workerData: { source, destination },
    });
    let result: typeof Migrations.Type | undefined;
    worker.on("message", (message: unknown) => {
      try {
        result = decodeMigrations(message);
      } catch (error) {
        reject(error);
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) =>
      code === 0 && result !== undefined
        ? resolve(result)
        : reject(new DataRestoreError({ message: "Snapshot database could not be read." })),
    );
  });

async function exists(file: string) {
  try {
    await NodeFSP.lstat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function regularFiles(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  const info = await NodeFSP.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new DataRestoreError({ message: "Backup contains an unsafe directory." });
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      result.push(...(await regularFiles(NodePath.join(directory, entry.name), relative + "/")));
    else if (entry.isFile()) result.push(relative);
    else
      throw new DataRestoreError({ message: "Backups cannot contain symlinks or special files." });
  }
  return result.sort();
}

async function fingerprint(directory: string, relative: string) {
  const file = NodePath.join(directory, relative);
  const info = await NodeFSP.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new DataRestoreError({ message: "Backup contains an unsafe file." });
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk);
  return { path: relative, bytes: info.size, sha256: hash.digest("hex") };
}

export async function createSnapshot(
  config: Config,
  directory: string,
  environmentId: string,
  appVersion: string,
  temporaryDirectory = directory,
): Promise<DataSnapshotManifest> {
  let attachments = (await exists(config.attachmentsDir))
    ? await regularFiles(config.attachmentsDir)
    : [];
  const sources = [
    config.dbPath,
    config.dbPath + "-wal",
    ...attachments.map((file) => NodePath.join(config.attachmentsDir, file)),
    config.settingsPath,
    config.keybindingsConfigPath,
  ];
  let bytes = 0;
  for (const source of sources)
    if (await exists(source)) bytes += (await NodeFSP.stat(source)).size;
  const temporarySpace = await NodeFSP.statfs(temporaryDirectory);
  const sameDevice =
    (await NodeFSP.stat(directory)).dev === (await NodeFSP.stat(temporaryDirectory)).dev;
  const walBytes = (await exists(config.dbPath + "-wal"))
    ? (await NodeFSP.stat(config.dbPath + "-wal")).size
    : 0;
  const databaseBytes = (await NodeFSP.stat(config.dbPath)).size + walBytes;
  if (temporarySpace.bavail * temporarySpace.bsize < databaseBytes * 1.2)
    throw new DataRestoreError({
      message: "Not enough free disk space for SQLite temporary backup files.",
    });
  const space = await NodeFSP.statfs(directory);
  if (space.bavail * space.bsize < (bytes + (sameDevice ? databaseBytes : 0)) * 1.2)
    throw new DataRestoreError({ message: "Not enough free disk space for a data backup." });
  const migrations = await sqlite(config.dbPath, NodePath.join(directory, "statev2.sqlite"));
  attachments = (await exists(config.attachmentsDir))
    ? await regularFiles(config.attachmentsDir)
    : [];
  for (let i = 1; i < roots.length; i++) {
    const source = destinations(config)[i]!;
    if (!(await exists(source))) continue;
    const files = i === 1 ? attachments : [""];
    for (const file of files) {
      const target = NodePath.join(directory, roots[i]!, file);
      await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
      const sourceFile = NodePath.join(source, file);
      const info = await NodeFSP.lstat(sourceFile);
      if (!info.isFile() || info.isSymbolicLink())
        throw new DataRestoreError({
          message: "Backup source contains a symlink or special file.",
        });
      await NodeFSP.copyFile(sourceFile, target, NodeFS.constants.COPYFILE_FICLONE);
    }
  }
  const manifest: DataSnapshotManifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    environmentId,
    appVersion,
    migrationHead: Math.max(0, ...migrations.map((row) => row.id)),
    sourceBaseDir: config.baseDir,
    files: await Promise.all(
      (await regularFiles(directory)).map((file) => fingerprint(directory, file)),
    ),
  };
  await NodeFSP.writeFile(NodePath.join(directory, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

export async function verifySnapshot(directory: string): Promise<DataSnapshotManifest> {
  const files = await regularFiles(directory);
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "attachments")
      throw new DataRestoreError({ message: "Backup contains an unlisted directory." });
  }
  if (!files.includes("manifest.json"))
    throw new DataRestoreError({ message: "Backup manifest is missing." });
  const manifest = decodeManifest(
    JSON.parse(await NodeFSP.readFile(NodePath.join(directory, "manifest.json"), "utf8")),
  );
  if (!Number.isInteger(manifest.migrationHead) || manifest.migrationHead < 0)
    throw new DataRestoreError({ message: "Invalid backup migration head." });
  if (manifest.migrationHead > BUILD_MIGRATION_HEAD)
    throw new DataRestoreError({ message: "This backup was made by a newer p0code." });
  const listed = new Set<string>();
  for (const file of manifest.files) {
    if (
      file.path.includes("\\") ||
      file.path.split("/").some((part) => part === ".." || part === "." || part === "") ||
      !(
        file.path === "statev2.sqlite" ||
        file.path === "settings.json" ||
        file.path === "keybindings.json" ||
        file.path.startsWith("attachments/")
      ) ||
      listed.has(file.path)
    )
      throw new DataRestoreError({ message: "Backup contains an unsafe or duplicate NodePath." });
    listed.add(file.path);
    const actual = await fingerprint(directory, file.path);
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
      throw new DataRestoreError({ message: "Backup file size or SHA-256 does not match." });
  }
  if (
    !listed.has("statev2.sqlite") ||
    files.length !== listed.size + 1 ||
    files.some((file) => file !== "manifest.json" && !listed.has(file))
  )
    throw new DataRestoreError({ message: "Backup has missing or unlisted files." });
  const migrations = await sqlite(NodePath.join(directory, "statev2.sqlite"));
  if (Math.max(0, ...migrations.map((row) => row.id)) !== manifest.migrationHead)
    throw new DataRestoreError({ message: "Backup migration head does not match its database." });
  if (incompatibleSourceMigrations(migrations).length > 0)
    throw new DataRestoreError({ message: "This backup was made by a newer p0code." });
  return manifest;
}

const Metadata = Schema.Struct({ pending: PendingRestore, approved: Schema.Boolean });
const decodeMetadata = Schema.decodeUnknownSync(Metadata);
const metadataPath = (config: Config) => NodePath.join(pendingPath(config), "pending.json");
const snapshotPath = (config: Config) => NodePath.join(pendingPath(config), "snapshot");
export async function pendingRestore(config: Config) {
  if (!(await exists(metadataPath(config)))) return null;
  return decodeMetadata(JSON.parse(await NodeFSP.readFile(metadataPath(config), "utf8"))).pending;
}
export async function cancelRestore(config: Config) {
  await NodeFSP.rm(pendingPath(config), { recursive: true, force: true });
}
export async function stageRestore(
  config: Config,
  directory: string,
  within: string,
): Promise<PendingRestore> {
  const parent = await NodeFSP.realpath(within);
  const source = await NodeFSP.realpath(directory);
  if (source !== NodePath.resolve(directory) || !source.startsWith(parent + NodePath.sep))
    throw new DataRestoreError({
      message: "Restore must be a directory inside the plugin's data directory.",
    });
  const incoming = await NodeFSP.mkdtemp(NodePath.join(config.stateDir, "restore-incoming-"));
  try {
    await NodeFSP.rename(source, NodePath.join(incoming, "snapshot"));
    const manifest = await verifySnapshot(NodePath.join(incoming, "snapshot"));
    const pending: PendingRestore = {
      id: NodeCrypto.randomUUID(),
      stagedAt: new Date().toISOString(),
      snapshotCreatedAt: manifest.createdAt,
      sourceEnvironmentId: manifest.environmentId,
      files: manifest.files.length,
      bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    };
    await NodeFSP.writeFile(
      NodePath.join(incoming, "pending.json"),
      JSON.stringify({ pending, approved: false }),
    );
    await cancelRestore(config);
    await NodeFSP.rename(incoming, pendingPath(config));
    return pending;
  } finally {
    await NodeFSP.rm(incoming, { recursive: true, force: true });
  }
}
export async function approveRestore(config: Config, id: string) {
  const pending = await pendingRestore(config);
  if (pending === null || pending.id !== id)
    throw new DataRestoreError({ message: "This pending restore has changed. Review it again." });
  await verifySnapshot(snapshotPath(config));
  await durableJson(metadataPath(config), { pending, approved: true });
}

const Journal = Schema.Struct({ replaced: Schema.String, committed: Schema.Boolean });
const decodeJournal = Schema.decodeUnknownSync(Journal);
async function durableJson(file: string, value: unknown) {
  const temporary = file + ".tmp";
  const handle = await NodeFSP.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, file);
}

/** Called only under the server-owner lock, before any connection opens the state database. */
export async function applyApprovedRestore(config: Config) {
  const journalPath = NodePath.join(config.stateDir, "restore-transaction.json");
  const install = NodePath.join(pendingPath(config), "install");
  const pairsFor = (replaced: string) => [
    ...roots.map((root, i) => ({
      live: destinations(config)[i]!,
      old: NodePath.join(replaced, root),
      staged: NodePath.join(install, root),
    })),
    ...["-wal", "-shm"].map((suffix) => ({
      live: config.dbPath + suffix,
      old: NodePath.join(replaced, "statev2.sqlite" + suffix),
      staged: null,
    })),
  ];
  const rollback = async (replaced: string) => {
    for (const pair of pairsFor(replaced).reverse()) {
      if (await exists(pair.old)) {
        if ((await exists(pair.live)) && pair.staged !== null)
          await NodeFSP.rename(pair.live, pair.staged);
        await NodeFSP.rename(pair.old, pair.live);
      } else if (
        pair.staged !== null &&
        !(await exists(pair.staged)) &&
        (await exists(pair.live))
      ) {
        const absent = NodePath.join(replaced, NodePath.basename(pair.old) + ".absent");
        if (await exists(absent)) await NodeFSP.rename(pair.live, pair.staged);
      }
    }
    await NodeFSP.rm(journalPath, { force: true });
  };
  if (await exists(journalPath)) {
    const journal = decodeJournal(JSON.parse(await NodeFSP.readFile(journalPath, "utf8")));
    if (journal.committed) {
      await cancelRestore(config);
      await NodeFSP.rm(journalPath);
      return;
    }
    await rollback(journal.replaced);
  }
  if (!(await exists(metadataPath(config)))) return;
  const metadata = decodeMetadata(JSON.parse(await NodeFSP.readFile(metadataPath(config), "utf8")));
  if (!metadata.approved) return;
  const source = snapshotPath(config);
  const manifest = await verifySnapshot(source);
  await NodeFSP.rm(install, { recursive: true, force: true });
  await NodeFSP.mkdir(install);
  await NodeFSP.mkdir(NodePath.join(install, "attachments"));
  for (const file of manifest.files) {
    const destination = NodePath.join(install, file.path);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.copyFile(
      NodePath.join(source, file.path),
      destination,
      NodeFS.constants.COPYFILE_FICLONE,
    );
  }
  if (
    manifest.sourceBaseDir !== undefined &&
    manifest.sourceBaseDir !== config.baseDir &&
    (await exists(NodePath.join(install, "settings.json")))
  ) {
    const settings = await NodeFSP.readFile(NodePath.join(install, "settings.json"), "utf8");
    await NodeFSP.writeFile(
      NodePath.join(install, "settings.json"),
      makePathRewriter(manifest.sourceBaseDir, config.baseDir)(settings).text,
    );
  }
  const replaced = await NodeFSP.mkdtemp(
    NodePath.join(config.stateDir, "restore-replaced-" + Date.now() + "-"),
  );
  const pairs = pairsFor(replaced);
  for (const pair of pairs)
    if (!(await exists(pair.live))) await NodeFSP.writeFile(pair.old + ".absent", "");
  await durableJson(journalPath, { replaced, committed: false });
  try {
    for (const pair of pairs)
      if (await exists(pair.live)) await NodeFSP.rename(pair.live, pair.old);
    for (const pair of pairs)
      if (pair.staged !== null && (await exists(pair.staged)))
        await NodeFSP.rename(pair.staged, pair.live);
    await durableJson(journalPath, { replaced, committed: true });
  } catch (error) {
    await rollback(replaced);
    throw error;
  }
  await cancelRestore(config);
  await NodeFSP.rm(journalPath);
}
