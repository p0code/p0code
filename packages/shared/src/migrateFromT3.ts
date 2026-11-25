// @effect-diagnostics nodeBuiltinImport:off -- Shared by the CLI and the Electron main process, which run it outside an Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  classifySecret,
  credentialNamespace,
  KEYCHAIN_MARKER_FILE,
  keychainSecrets,
  realpathLoose,
  type KeychainStore,
} from "./credentialKeychain.ts";
import { incompatibleSourceMigrations } from "./migrationManifest.ts";

/**
 * One-shot import of a stock T3 Code home (`~/.t3`) into an p0code home (`~/.p0code`).
 *
 * The source is read-only: files are read, SQLite databases are snapshotted with
 * `VACUUM INTO` from a read-only connection (which includes committed WAL content),
 * and nothing under the source is created, moved, renamed or deleted.
 */

export const MIGRATION_MARKER_FILE = "migrated-from-t3.json";
/** Web consent written now and applied by the next server start, before its database opens. */
export const PENDING_T3_IMPORT_FILE = "pending-t3-import.json";
/** What the one import applied at startup copied, rewritten and skipped. */
export const T3_IMPORT_REPORT_FILE = "t3-import-report.json";
const MIGRATION_TOOL_VERSION = 1;

export interface MigrationEntry {
  readonly path: string;
  readonly detail: string;
}

export interface MigrationProviderInstance {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly home: string;
}

export interface MigrateFromT3Report {
  readonly status: "migrated" | "dry-run" | "already-migrated";
  readonly from: string;
  readonly to: string;
  readonly environmentId: "kept" | "new";
  readonly copied: ReadonlyArray<MigrationEntry>;
  readonly rewritten: ReadonlyArray<MigrationEntry>;
  readonly skipped: ReadonlyArray<MigrationEntry>;
  readonly sharedExternal: ReadonlyArray<MigrationEntry>;
  readonly providerInstances: ReadonlyArray<MigrationProviderInstance>;
  readonly replacedDestination?: string;
}

export class MigrateFromT3Error extends Schema.TaggedError<MigrateFromT3Error>()(
  "MigrateFromT3Error",
  {
    code: Schema.Literals([
      "source-missing",
      "overlapping-paths",
      "destination-not-empty",
      "destination-in-use",
      "source-unsupported",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const migrationError = (code: MigrateFromT3Error["code"], detail: string) =>
  new MigrateFromT3Error({ code, detail });

export interface MigrateFromT3Options {
  readonly from: string;
  readonly to: string;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly keepEnvironmentId?: boolean;
  /** Epoch milliseconds used for the staging and replaced-folder names. */
  readonly nowMs?: number;
  /** Reports whether a PID belongs to a live process; injectable for tests. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /**
   * Destination keychain store for credentials. Pass a `KeychainStore` (real or in-memory fake)
   * to write credentials straight into the keychain instead of copying `.bin` files; pass `null`
   * (or omit) to copy them as owner-only files.
   */
  readonly keychain?: KeychainStore | null;
}

type Rule =
  | { readonly action: "copy"; readonly rewrite?: boolean }
  | { readonly action: "copy-tree"; readonly exclude?: ReadonlyArray<string> }
  | { readonly action: "database" }
  | { readonly action: "secrets" }
  | { readonly action: "environment-id" }
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "shared"; readonly reason: string };

/** Top-level entries whose files move with the home; paths into them are rewritten. */
const MOVED_TOP_LEVEL = ["userdata", "workflows", "service.env", "usage-host-id"];

const TOP_LEVEL_RULES: Readonly<Record<string, Rule>> = {
  workflows: { action: "copy-tree" },
  "service.env": { action: "copy", rewrite: true },
  "usage-host-id": { action: "copy" },
  worktrees: {
    action: "shared",
    reason: "git worktrees stay in place; their repositories point at this path",
  },
  scratch: { action: "shared", reason: "project-less thread folders stay in place" },
  projects: { action: "shared", reason: "managed project folders stay in place" },
  runtime: { action: "skip", reason: "downloaded server runtimes are fetched again" },
  caches: { action: "skip", reason: "cache" },
  dev: { action: "skip", reason: "development state" },
  bin: { action: "skip", reason: "stock T3 Code CLI shim" },
  tools: { action: "skip", reason: "downloaded tools are fetched again on demand" },
  "ssh-launch": { action: "skip", reason: "runtime state of SSH-launched servers" },
  "wsl-runtime": { action: "skip", reason: "downloaded WSL runtime is fetched again" },
};

const USERDATA_RULES: Readonly<Record<string, Rule>> = {
  "settings.json": { action: "copy", rewrite: true },
  "client-settings.json": { action: "copy", rewrite: true },
  "desktop-settings.json": { action: "copy", rewrite: true },
  "keybindings.json": { action: "copy", rewrite: true },
  "keybindings-migrations": { action: "copy-tree" },
  "saved-environments.json": { action: "copy", rewrite: true },
  "connection-catalog.json": { action: "copy", rewrite: true },
  "model-manifest.json": { action: "copy", rewrite: true },
  "usage-model-rates.json": { action: "copy" },
  "desktop-host-scope": { action: "copy" },
  "cli-command-first-launch": { action: "copy" },
  themes: { action: "copy-tree" },
  attachments: { action: "copy-tree" },
  "browser-artifacts": { action: "copy-tree" },
  providers: { action: "copy-tree" },
  device: { action: "copy-tree", exclude: ["agent-device", "bin", "hub"] },
  secrets: { action: "secrets" },
  "environment-id": { action: "environment-id" },
  "statev2.sqlite": { action: "database" },
  "anonymous-id": { action: "skip", reason: "telemetry" },
  clerk: { action: "skip", reason: "T3 Connect sign-in" },
  "cloud-auth-token.json": { action: "skip", reason: "T3 Connect sign-in" },
  "relay-clients": { action: "skip", reason: "T3 Connect relay clients" },
  logs: { action: "skip", reason: "logs" },
  "server-runtime.json": { action: "skip", reason: "runtime state of the source server" },
  "server-browser": { action: "skip", reason: "browser profile cache" },
  "shell-environment-cache.json": { action: "skip", reason: "cache" },
  "compacted-at": { action: "skip", reason: "database maintenance marker" },
  "desktop-last-started-version": { action: "skip", reason: "runtime state" },
  "antigravity-tmp": { action: "skip", reason: "temporary files" },
  "opencode-servers": {
    action: "skip",
    reason: "ledger of OpenCode servers the source install still owns",
  },
  [MIGRATION_MARKER_FILE]: { action: "skip", reason: "marker of an earlier migration" },
};

const SQLITE_SIDE_FILE = /\.sqlite(-wal|-shm|-journal)$/;
const TELEMETRY_NAME = /posthog|axiom|telemetry/i;

const userdataRule = (name: string, hasV2Database: boolean): Rule => {
  const rule = USERDATA_RULES[name];
  if (rule !== undefined) return rule;
  if (SQLITE_SIDE_FILE.test(name)) {
    return name.startsWith("statev2.sqlite")
      ? { action: "skip", reason: "folded into the statev2.sqlite snapshot" }
      : { action: "skip", reason: "runtime or legacy database side file" };
  }
  if (name.startsWith("server-owner.sqlite")) {
    return { action: "skip", reason: "runtime lock of the source server" };
  }
  if (name === "state.sqlite") {
    return hasV2Database
      ? { action: "skip", reason: "legacy V1 database, already imported into statev2.sqlite" }
      : { action: "database" };
  }
  if (name.startsWith("usage-scan-cache")) return { action: "skip", reason: "cache" };
  if (TELEMETRY_NAME.test(name)) return { action: "skip", reason: "telemetry" };
  return { action: "skip", reason: "not recognized" };
};

const secretRule = (name: string, keepEnvironmentId: boolean): Rule => {
  if (name === KEYCHAIN_MARKER_FILE) {
    return { action: "skip", reason: "keychain marker" };
  }
  if (name.endsWith(".tmp")) {
    return { action: "skip", reason: "temporary file" };
  }
  const baseName = name.endsWith(".bin") ? name.slice(0, -".bin".length) : name;
  if (classifySecret(baseName) === "file") {
    return { action: "skip", reason: "single-use replay marker" };
  }
  // The T3 Connect bridge plugin has to import the old cloud link key
  // (cloud-link-ed25519-key-pair.bin) on its own if it ever needs it.
  if (name.startsWith("cloud-") || name.startsWith("relay-")) {
    return { action: "skip", reason: "T3 Connect credential" };
  }
  if (name === "server-signing-key.bin" || name.startsWith("peer-link-")) {
    return keepEnvironmentId
      ? { action: "copy" }
      : {
          action: "skip",
          reason: "belongs to the source environment identity (use --keep-environment-id)",
        };
  }
  return { action: "copy" };
};

const PROVIDER_TEXT_FILE = /\.(json|jsonc|toml|ya?ml|env|ini|conf)$/i;
const MAX_REWRITE_BYTES = 4 * 1024 * 1024;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrites absolute paths into the moved parts of the source home, in raw and JSON-escaped form. */
export const makePathRewriter = (from: string, to: string) => {
  const separators = from.includes("\\") ? ["\\", "\\\\", "/"] : ["/"];
  const replacements: Array<{ readonly pattern: RegExp; readonly replacement: string }> = [];
  for (const separator of separators) {
    const fromPrefix =
      separator === "\\\\"
        ? from.replaceAll("\\", "\\\\")
        : separator === "/"
          ? from.replaceAll("\\", "/")
          : from;
    const toPrefix =
      separator === "\\\\"
        ? to.replaceAll("\\", "\\\\")
        : separator === "/"
          ? to.replaceAll("\\", "/")
          : to;
    for (const entry of MOVED_TOP_LEVEL) {
      replacements.push({
        pattern: new RegExp(
          `${escapeRegExp(`${fromPrefix}${separator}${entry}`)}(?=$|[\\\\/"'\\s,;:)\\]}])`,
          "g",
        ),
        replacement: `${toPrefix}${separator}${entry}`,
      });
    }
  }
  return (text: string) => {
    let count = 0;
    let result = text;
    for (const { pattern, replacement } of replacements) {
      result = result.replace(pattern, () => {
        count += 1;
        return replacement;
      });
    }
    return { text: result, count };
  };
};

const isInside = (parent: string, child: string) => {
  const relative = NodePath.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};

const pathExists = (target: string) =>
  NodeFSP.lstat(target).then(
    () => true,
    () => false,
  );

const readDirectoryNames = async (directory: string) =>
  [...(await NodeFSP.readdir(directory))].sort((left, right) => left.localeCompare(right));

const defaultIsProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
};

const readLivePid = async (
  runtimeStatePath: string,
  isProcessAlive: (pid: number) => boolean,
): Promise<number | undefined> => {
  const contents = await NodeFSP.readFile(runtimeStatePath, "utf8").catch(() => undefined);
  if (contents === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null || !("pid" in parsed)) return undefined;
    const pid = parsed.pid;
    return typeof pid === "number" && pid > 0 && isProcessAlive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
};

const isAbsoluteLike = (value: string) =>
  value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:[\\/]/.test(value);

const expandTilde = (value: string) =>
  value === "~" || value.startsWith("~/") || value.startsWith("~\\")
    ? NodePath.join(NodeOS.homedir(), value.slice(1))
    : value;

const collectExternalPaths = (
  value: unknown,
  location: string,
  from: string,
  output: Array<MigrationEntry>,
) => {
  if (typeof value === "string") {
    if (isAbsoluteLike(value) && !isInside(from, expandTilde(value))) {
      output.push({ path: value, detail: location });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectExternalPaths(item, `${location}[${index}]`, from, output),
    );
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      collectExternalPaths(item, `${location}.${key}`, from, output);
    }
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readProviderInstances = (
  settingsText: string | undefined,
  from: string,
  sharedExternal: Array<MigrationEntry>,
): Array<MigrationProviderInstance> => {
  if (settingsText === undefined) return [];
  let settings: unknown;
  try {
    settings = JSON.parse(settingsText);
  } catch {
    return [];
  }
  if (!isRecord(settings) || !isRecord(settings.providerInstances)) return [];
  const instances: Array<MigrationProviderInstance> = [];
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    if (!isRecord(instance)) continue;
    const external: Array<MigrationEntry> = [];
    collectExternalPaths(instance, `settings.json providerInstances.${instanceId}`, from, external);
    sharedExternal.push(...external);
    const config = isRecord(instance.config) ? instance.config : {};
    const homePath = typeof config.homePath === "string" ? config.homePath.trim() : "";
    instances.push({
      instanceId,
      driver: typeof instance.driver === "string" ? instance.driver : "unknown",
      enabled: instance.enabled !== false,
      home:
        homePath.length === 0
          ? "default"
          : isInside(from, expandTilde(homePath))
            ? "copied with this home"
            : `shared: ${homePath}`,
    });
  }
  return instances;
};

interface Plan {
  readonly copied: Array<MigrationEntry>;
  readonly skipped: Array<MigrationEntry>;
  readonly sharedExternal: Array<MigrationEntry>;
  readonly steps: Array<() => Promise<void>>;
  readonly keychainSteps: Array<() => Promise<void>>;
  readonly rewritten: Array<MigrationEntry>;
}

const openSourceDatabase = (source: string) => {
  // Without a WAL or shared-memory file, opening normally would create them in the
  // source directory; immutable reads the file as is and never touches the source.
  const hasLiveSideFiles = NodeFS.existsSync(`${source}-wal`) || NodeFS.existsSync(`${source}-shm`);
  const url = NodeURL.pathToFileURL(source);
  url.search = hasLiveSideFiles ? "mode=ro" : "mode=ro&immutable=1";
  return new NodeSqlite.DatabaseSync(url, { readOnly: true });
};

/** Migration history a source database records, read-only; empty when it has none. */
const readSourceMigrations = (
  source: string,
): ReadonlyArray<{ readonly id: number; readonly name: string }> => {
  const database = openSourceDatabase(source);
  try {
    const hasTable = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'",
      )
      .get();
    if (hasTable === undefined) return [];
    return database
      .prepare("SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id")
      .all()
      .map((row) => ({ id: Number(row.migration_id), name: String(row.name) }));
  } finally {
    database.close();
  }
};

const snapshotDatabase = (source: string, destination: string) => {
  const database = openSourceDatabase(source);
  try {
    database.prepare("VACUUM INTO ?").run(destination);
  } finally {
    database.close();
  }
};

const TEXT_COLUMN = /^(|TEXT|.*CHAR.*|CLOB|JSON)$/i;

const MOVED_FILE_ENTRIES = new Set(["service.env", "usage-host-id"]);

const rewriteDatabasePaths = (databasePath: string, from: string, to: string) => {
  const separators = from.includes("\\") ? ["\\\\", "\\", "/"] : ["/"];
  const needles: Array<{ readonly from: string; readonly to: string }> = [];
  for (const separator of separators) {
    const fromPrefix =
      separator === "\\\\"
        ? from.replaceAll("\\", "\\\\")
        : separator === "/"
          ? from.replaceAll("\\", "/")
          : from;
    const toPrefix =
      separator === "\\\\"
        ? to.replaceAll("\\", "\\\\")
        : separator === "/"
          ? to.replaceAll("\\", "/")
          : to;
    for (const entry of MOVED_TOP_LEVEL) {
      const suffix = MOVED_FILE_ENTRIES.has(entry) ? "" : separator;
      needles.push({
        from: `${fromPrefix}${separator}${entry}${suffix}`,
        to: `${toPrefix}${separator}${entry}${suffix}`,
      });
    }
  }
  const database = new NodeSqlite.DatabaseSync(databasePath);
  let total = 0;
  try {
    const virtualTables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL%'")
      .all()
      .map((row) => String(row.name));
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
      )
      .all()
      .map((row) => String(row.name))
      .filter((name) => !virtualTables.some((virtual) => name.startsWith(`${virtual}_`)));
    database.exec("BEGIN");
    for (const table of tables) {
      const columns = database
        .prepare("SELECT name, type FROM pragma_table_info(?)")
        .all(table)
        .filter((column) => TEXT_COLUMN.test(String(column.type)))
        .map((column) => String(column.name));
      for (const column of columns) {
        const quotedTable = `"${table.replaceAll('"', '""')}"`;
        const quotedColumn = `"${column.replaceAll('"', '""')}"`;
        const update = database.prepare(
          `UPDATE ${quotedTable} SET ${quotedColumn} = replace(${quotedColumn}, ?, ?) WHERE typeof(${quotedColumn}) = 'text' AND instr(${quotedColumn}, ?) > 0`,
        );
        for (const needle of needles) {
          total += Number(update.run(needle.from, needle.to, needle.from).changes);
        }
      }
    }
    database.exec("COMMIT");
    database.exec("PRAGMA journal_mode = WAL");
  } catch (cause) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw cause;
  } finally {
    database.close();
  }
  return total;
};

const countDatabaseReferences = (source: string, prefixes: ReadonlyArray<string>) => {
  const database = openSourceDatabase(source);
  const counts = prefixes.map(() => 0);
  try {
    const virtualTables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL%'")
      .all()
      .map((row) => String(row.name));
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
      )
      .all()
      .map((row) => String(row.name))
      .filter((name) => !virtualTables.some((virtual) => name.startsWith(`${virtual}_`)));
    for (const table of tables) {
      const quotedTable = `"${table.replaceAll('"', '""')}"`;
      for (const column of database
        .prepare("SELECT name, type FROM pragma_table_info(?)")
        .all(table)) {
        if (!TEXT_COLUMN.test(String(column.type))) continue;
        const quotedColumn = `"${String(column.name).replaceAll('"', '""')}"`;
        const sums = prefixes
          .map((_, index) => `sum(instr(${quotedColumn}, ?) > 0) AS c${index}`)
          .join(", ");
        const row = database
          .prepare(`SELECT ${sums} FROM ${quotedTable} WHERE typeof(${quotedColumn}) = 'text'`)
          .get(...prefixes);
        prefixes.forEach((_, index) => {
          counts[index] = (counts[index] ?? 0) + Number(row?.[`c${index}`] ?? 0);
        });
      }
    }
  } finally {
    database.close();
  }
  return counts;
};

const copyFile = async (source: string, destination: string) => {
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.copyFile(source, destination, NodeFS.constants.COPYFILE_EXCL);
  const { mode } = await NodeFSP.stat(source);
  await NodeFSP.chmod(destination, mode & 0o777);
};

/** Copies a tree; symlinks are recreated, sockets and other special files are skipped. */
const copyTree = async (
  source: string,
  destination: string,
  options: {
    readonly exclude?: ReadonlyArray<string>;
    readonly rewrite?: (file: string, relative: string) => Promise<void>;
    readonly relative: string;
    readonly skipped: Array<MigrationEntry>;
    readonly rewriteSymlink: (target: string) => string;
  },
): Promise<number> => {
  const info = await NodeFSP.lstat(source);
  if (info.isSymbolicLink()) {
    const target = await NodeFSP.readlink(source);
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.symlink(options.rewriteSymlink(target), destination);
    return 0;
  }
  if (info.isFile()) {
    await copyFile(source, destination);
    await options.rewrite?.(destination, options.relative);
    return info.size;
  }
  if (!info.isDirectory()) {
    options.skipped.push({ path: options.relative, detail: "special file" });
    return 0;
  }
  await NodeFSP.mkdir(destination, { recursive: true, mode: info.mode & 0o777 });
  let bytes = 0;
  for (const name of await readDirectoryNames(source)) {
    if (options.exclude?.includes(name)) {
      options.skipped.push({
        path: NodePath.join(options.relative, name),
        detail: "downloaded or runtime state",
      });
      continue;
    }
    const { exclude: _exclude, ...childOptions } = options;
    bytes += await copyTree(NodePath.join(source, name), NodePath.join(destination, name), {
      ...childOptions,
      relative: NodePath.join(options.relative, name),
    });
  }
  return bytes;
};

const treeSize = async (target: string): Promise<number> => {
  const info = await NodeFSP.lstat(target);
  if (!info.isDirectory()) return info.isFile() ? info.size : 0;
  let total = 0;
  for (const name of await NodeFSP.readdir(target)) {
    total += await treeSize(NodePath.join(target, name));
  }
  return total;
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
};

const buildPlan = async (input: {
  readonly from: string;
  readonly staging: string;
  readonly to: string;
  readonly keepEnvironmentId: boolean;
  readonly keychain: KeychainStore | null;
}): Promise<Plan> => {
  const { from, staging, to, keepEnvironmentId, keychain } = input;
  const plan: Plan = {
    copied: [],
    skipped: [],
    sharedExternal: [],
    steps: [],
    keychainSteps: [],
    rewritten: [],
  };
  const rewriter = makePathRewriter(from, to);
  const rewriteSymlink = (target: string) =>
    NodePath.isAbsolute(target) ? rewriter(target).text : target;
  const rewriteFile = async (file: string, relative: string) => {
    const contents = await NodeFSP.readFile(file, "utf8");
    const { text, count } = rewriter(contents);
    if (count === 0) return;
    await NodeFSP.writeFile(file, text);
    plan.rewritten.push({ path: relative, detail: `${count} path${count === 1 ? "" : "s"}` });
  };
  const rewriteProviderFile = async (file: string, relative: string) => {
    if (!PROVIDER_TEXT_FILE.test(file)) return;
    if ((await NodeFSP.stat(file)).size > MAX_REWRITE_BYTES) return;
    await rewriteFile(file, relative);
  };

  const addEntry = async (relative: string, rule: Rule) => {
    const source = NodePath.join(from, relative);
    const destination = NodePath.join(staging, relative);
    switch (rule.action) {
      case "skip":
        plan.skipped.push({ path: relative, detail: rule.reason });
        return;
      case "shared":
        plan.sharedExternal.push({ path: source, detail: rule.reason });
        return;
      case "copy": {
        const info = await NodeFSP.lstat(source);
        if (!info.isFile()) {
          plan.skipped.push({ path: relative, detail: "expected a file" });
          return;
        }
        plan.copied.push({ path: relative, detail: formatBytes(info.size) });
        plan.steps.push(async () => {
          await copyFile(source, destination);
          if (rule.rewrite === true) await rewriteFile(destination, relative);
        });
        return;
      }
      case "copy-tree": {
        plan.copied.push({ path: relative, detail: formatBytes(await treeSize(source)) });
        plan.steps.push(async () => {
          await copyTree(source, destination, {
            ...(rule.exclude === undefined ? {} : { exclude: rule.exclude }),
            relative,
            skipped: plan.skipped,
            rewriteSymlink,
            ...(relative.startsWith(`userdata${NodePath.sep}providers`) ||
            relative === NodePath.join("userdata", "providers")
              ? { rewrite: rewriteProviderFile }
              : {}),
          });
        });
        return;
      }
      case "database": {
        const info = await NodeFSP.stat(source);
        plan.copied.push({
          path: relative,
          detail: `database snapshot (${formatBytes(info.size)} before WAL)`,
        });
        plan.steps.push(async () => {
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          snapshotDatabase(source, destination);
          const count = rewriteDatabasePaths(destination, from, to);
          await NodeFSP.chmod(destination, 0o600);
          if (count > 0) {
            plan.rewritten.push({
              path: relative,
              detail: `${count} value${count === 1 ? "" : "s"} across all tables`,
            });
          }
        });
        const sharedFolders = ["worktrees", "scratch", "projects"];
        const counts = countDatabaseReferences(
          source,
          sharedFolders.map((shared) => `${NodePath.join(from, shared)}${NodePath.sep}`),
        );
        for (const [index, shared] of sharedFolders.entries()) {
          const rows = counts[index] ?? 0;
          if (rows > 0) {
            plan.sharedExternal.push({
              path: NodePath.join(from, shared),
              detail: `${rows} value${rows === 1 ? "" : "s"} in ${relative} still point here`,
            });
          }
        }
        return;
      }
      case "environment-id":
        if (keepEnvironmentId) {
          plan.copied.push({ path: relative, detail: "kept (--keep-environment-id)" });
          plan.steps.push(() => copyFile(source, destination));
        } else {
          plan.skipped.push({
            path: relative,
            detail: "a new environment id is created on first start (use --keep-environment-id)",
          });
        }
        return;
      case "secrets": {
        const names = await readDirectoryNames(source);
        let copiedCount = 0;
        const skippedByReason = new Map<string, Array<string>>();
        const keychainEntries: Array<{ readonly name: string; readonly source: string }> = [];
        for (const name of names) {
          const secretRelative = NodePath.join(relative, name);
          const secret = secretRule(name, keepEnvironmentId);
          if (secret.action === "skip") {
            skippedByReason.set(secret.reason, [
              ...(skippedByReason.get(secret.reason) ?? []),
              secretRelative,
            ]);
            continue;
          }
          const secretSource = NodePath.join(source, name);
          if (keychain !== null && name.endsWith(".bin")) {
            const info = await NodeFSP.lstat(secretSource);
            if (!info.isFile()) {
              skippedByReason.set("expected a file", [
                ...(skippedByReason.get("expected a file") ?? []),
                secretRelative,
              ]);
              continue;
            }
            copiedCount += 1;
            keychainEntries.push({
              name: name.slice(0, -".bin".length),
              source: secretSource,
            });
            continue;
          }
          copiedCount += 1;
          const secretDestination = NodePath.join(destination, name);
          plan.steps.push(async () => {
            await copyTree(secretSource, secretDestination, {
              relative: secretRelative,
              skipped: plan.skipped,
              rewriteSymlink,
            });
          });
        }
        for (const [reason, paths] of skippedByReason) {
          plan.skipped.push(
            paths.length === 1
              ? { path: paths[0] ?? relative, detail: reason }
              : { path: NodePath.join(relative, `<${paths.length} entries>`), detail: reason },
          );
        }
        const entryLabel = copiedCount === 1 ? "secret entry" : "secret entries";
        plan.copied.push({
          path: relative,
          detail:
            keychain !== null
              ? `${copiedCount} ${entryLabel} → keychain`
              : `${copiedCount} ${entryLabel}`,
        });
        plan.steps.unshift(async () => {
          await NodeFSP.mkdir(destination, { recursive: true, mode: 0o700 });
          if (keychain !== null) {
            await NodeFSP.writeFile(
              NodePath.join(destination, KEYCHAIN_MARKER_FILE),
              `${keychain.label}\n`,
              { mode: 0o600 },
            );
          }
        });
        if (keychain !== null && keychainEntries.length > 0) {
          const destinationSecretsDir = NodePath.join(to, relative);
          plan.keychainSteps.push(async () => {
            const secrets = keychainSecrets(
              keychain,
              await credentialNamespace(destination, destinationSecretsDir),
            );
            for (const entry of keychainEntries) {
              const bytes = new Uint8Array(await NodeFSP.readFile(entry.source));
              await secrets.set(entry.name, bytes);
              const stored = await secrets.get(entry.name);
              if (stored === undefined || !Buffer.from(stored).equals(Buffer.from(bytes))) {
                throw new Error(
                  `The keychain did not keep ${entry.name}; aborting without replacing ${to}.`,
                );
              }
            }
          });
        }
        return;
      }
    }
  };

  for (const name of await readDirectoryNames(from)) {
    if (name === "userdata") continue;
    await addEntry(
      name,
      TOP_LEVEL_RULES[name] ??
        (TELEMETRY_NAME.test(name)
          ? { action: "skip", reason: "telemetry" }
          : { action: "skip", reason: "not recognized" }),
    );
  }
  const userdata = NodePath.join(from, "userdata");
  const userdataNames = await readDirectoryNames(userdata);
  const hasV2Database = userdataNames.includes("statev2.sqlite");
  for (const name of userdataNames) {
    await addEntry(NodePath.join("userdata", name), userdataRule(name, hasV2Database));
  }
  return plan;
};

const resolveInputPath = (raw: string) => NodePath.resolve(raw);

export async function migrateFromT3(options: MigrateFromT3Options): Promise<MigrateFromT3Report> {
  const from = resolveInputPath(options.from);
  const to = resolveInputPath(options.to);
  const keepEnvironmentId = options.keepEnvironmentId === true;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const keychain = options.keychain ?? null;
  // @effect-diagnostics-next-line globalDate:off -- Runs outside an Effect runtime (CLI and Electron main).
  const nowMs = options.nowMs ?? Date.now();

  if (!(await pathExists(NodePath.join(from, "userdata")))) {
    throw migrationError(
      "source-missing",
      `${from} has no userdata folder, so there is nothing to import.`,
    );
  }
  const [realFrom, realTo] = await Promise.all([NodeFSP.realpath(from), realpathLoose(to)]);
  if (isInside(realFrom, realTo) || isInside(realTo, realFrom)) {
    throw migrationError(
      "overlapping-paths",
      `The source ${from} and destination ${to} overlap. Choose separate folders.`,
    );
  }

  // Refuse a source written by a newer T3 Code than this build understands before replacing or
  // creating anything. The check reuses the migrator's own compatibility rule so they never disagree.
  const sourceStateDatabase = NodePath.join(from, "userdata", "statev2.sqlite");
  if (await pathExists(sourceStateDatabase)) {
    const recorded = readSourceMigrations(sourceStateDatabase);
    if (incompatibleSourceMigrations(recorded).length > 0) {
      throw migrationError(
        "source-unsupported",
        "This T3 Code install is newer than this p0code build understands. Update p0code, then import again.",
      );
    }
  }

  const markerPath = NodePath.join(to, "userdata", MIGRATION_MARKER_FILE);
  const marker = await NodeFSP.readFile(markerPath, "utf8").catch(() => undefined);
  const destinationEntries = (await pathExists(to)) ? await NodeFSP.readdir(to) : [];
  const destinationHasData = destinationEntries.length > 0;

  const settingsText = await NodeFSP.readFile(
    NodePath.join(from, "userdata", "settings.json"),
    "utf8",
  ).catch(() => undefined);
  const staging = `${to}.migrating-${nowMs}`;
  const plan = await buildPlan({ from, staging, to, keepEnvironmentId, keychain });
  const providerInstances = readProviderInstances(settingsText, from, plan.sharedExternal);
  const report = (
    status: MigrateFromT3Report["status"],
    extra: Partial<MigrateFromT3Report> = {},
  ): MigrateFromT3Report => ({
    status,
    from,
    to,
    environmentId: keepEnvironmentId ? "kept" : "new",
    copied: plan.copied,
    rewritten: plan.rewritten,
    skipped: plan.skipped,
    sharedExternal: plan.sharedExternal,
    providerInstances,
    ...extra,
  });

  if (marker !== undefined && options.force !== true) {
    try {
      const parsed: unknown = JSON.parse(marker);
      if (isRecord(parsed) && (parsed.source === from || parsed.source === realFrom)) {
        return report("already-migrated");
      }
    } catch {
      // An unreadable marker falls through to the destination check.
    }
  }
  if (destinationHasData) {
    if (options.force !== true) {
      throw migrationError(
        "destination-not-empty",
        `${to} already has data. Pass --force to move it aside to ${to}.replaced-<time> and import anyway.`,
      );
    }
    const livePid = await readLivePid(
      NodePath.join(to, "userdata", "server-runtime.json"),
      isProcessAlive,
    );
    if (livePid !== undefined) {
      throw migrationError(
        "destination-in-use",
        `A server is running for ${to} (pid ${livePid}). Stop it, then import again.`,
      );
    }
  }
  if (options.dryRun === true) return report("dry-run");

  await NodeFSP.mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await NodeFSP.mkdir(NodePath.join(staging, "userdata"), { recursive: true, mode: 0o700 });
    for (const step of plan.steps) await step();
    await NodeFSP.writeFile(
      NodePath.join(staging, "userdata", MIGRATION_MARKER_FILE),
      `${JSON.stringify(
        {
          source: from,
          migratedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          toolVersion: MIGRATION_TOOL_VERSION,
          environmentId: keepEnvironmentId ? "kept" : "new",
        },
        null,
        2,
      )}\n`,
    );
    for (const step of plan.keychainSteps) await step();
  } catch (cause) {
    await NodeFSP.rm(staging, { recursive: true, force: true });
    throw cause;
  }

  let replacedDestination: string | undefined;
  if (await pathExists(to)) {
    if (destinationHasData) {
      replacedDestination = `${to}.replaced-${nowMs}`;
      await NodeFSP.rename(to, replacedDestination);
    } else {
      await NodeFSP.rmdir(to);
    }
  }
  try {
    await NodeFSP.mkdir(NodePath.dirname(to), { recursive: true });
    await NodeFSP.rename(staging, to);
  } catch (cause) {
    if (replacedDestination !== undefined) {
      await NodeFSP.rename(replacedDestination, to).catch(() => undefined);
    }
    await NodeFSP.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
  return report("migrated", replacedDestination === undefined ? {} : { replacedDestination });
}

/** True when a fresh p0code home should offer to import a stock T3 Code home. */
export async function shouldOfferT3Import(input: {
  readonly appHome: string;
  readonly stockHome: string;
}): Promise<boolean> {
  if (await pathExists(NodePath.join(input.appHome, "userdata", "statev2.sqlite"))) return false;
  if (await pathExists(NodePath.join(input.appHome, "userdata", MIGRATION_MARKER_FILE))) {
    return false;
  }
  return pathExists(NodePath.join(input.stockHome, "userdata", "statev2.sqlite"));
}

export const formatMigrationReportJson = (report: MigrateFromT3Report) =>
  JSON.stringify(report, null, 2);

export function formatMigrationReport(report: MigrateFromT3Report): string {
  const lines: Array<string> = [];
  const heading =
    report.status === "dry-run"
      ? `Dry run: would import ${report.from} into ${report.to}`
      : report.status === "already-migrated"
        ? `${report.to} was already imported from ${report.from}. Pass --force to import again.`
        : `Imported ${report.from} into ${report.to}`;
  lines.push(heading);
  lines.push(
    `Environment id: ${report.environmentId === "kept" ? "kept (paired clients keep working; do not run both apps at once)" : "new (pair your clients again)"}`,
  );
  if (report.replacedDestination !== undefined) {
    lines.push(`Previous destination moved to ${report.replacedDestination}`);
  }
  const section = (title: string, entries: ReadonlyArray<MigrationEntry>) => {
    if (entries.length === 0) return;
    lines.push("", `${title} (${entries.length})`);
    for (const entry of entries) lines.push(`  ${entry.path}: ${entry.detail}`);
  };
  section("Copied", report.copied);
  section("Rewritten paths", report.rewritten);
  section("Skipped", report.skipped);
  section("Shared, left in place", report.sharedExternal);
  if (report.providerInstances.length > 0) {
    lines.push("", `Provider instances (${report.providerInstances.length})`);
    for (const instance of report.providerInstances) {
      lines.push(
        `  ${instance.instanceId} (${instance.driver}${instance.enabled ? "" : ", disabled"}), home: ${instance.home}`,
      );
    }
  }
  return lines.join("\n");
}
