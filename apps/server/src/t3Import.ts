// @effect-diagnostics nodeBuiltinImport:off -- Reads the home and SQLite before the server opens its database.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import { STOCK_T3_HOME_DIRECTORY_NAME } from "@t3tools/shared/appHome";
import {
  credentialNamespace,
  keychainSecrets,
  keyringStore,
  type KeychainStore,
} from "@t3tools/shared/credentialKeychain";
import {
  formatMigrationReportJson,
  MIGRATION_MARKER_FILE,
  migrateFromT3,
  PENDING_T3_IMPORT_FILE,
  shouldOfferT3Import,
  T3_IMPORT_REPORT_FILE,
  type MigrateFromT3Report,
} from "@t3tools/shared/migrateFromT3";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { T3ImportStatus, T3ImportStatusReason } from "@t3tools/contracts";

const requireExternal = NodeModule.createRequire(import.meta.url);

export interface T3ImportHomes {
  readonly appHome: string;
  readonly stockHome: string;
}

const userdataPath = (home: string, name: string) => NodePath.join(home, "userdata", name);

const pathExists = (target: string) =>
  NodeFSP.lstat(target).then(
    () => true,
    () => false,
  );

const hasStockDatabase = (stockHome: string) =>
  pathExists(userdataPath(stockHome, "statev2.sqlite"));

const openReadOnlyDatabase = (databasePath: string) => {
  // As in the migrator, immutable reads never create WAL or shared-memory files beside the home.
  const hasLiveSideFiles =
    NodeFS.existsSync(`${databasePath}-wal`) || NodeFS.existsSync(`${databasePath}-shm`);
  const url = NodeURL.pathToFileURL(databasePath);
  url.search = hasLiveSideFiles ? "mode=ro" : "mode=ro&immutable=1";
  return new NodeSqlite.DatabaseSync(url, { readOnly: true });
};

const countRows = (database: NodeSqlite.DatabaseSync, table: string, where = "") => {
  const exists = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (exists === undefined) return 0;
  const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table}" ${where}`).get();
  return Number(row?.count ?? 0);
};

/**
 * True when this p0code home has no user data yet. Onboarding creates at most one project and one
 * thread, with no messages or runs, so those are tolerated; anything more means a real user.
 */
export const isT3ImportHomeFresh = async (appHome: string): Promise<boolean> => {
  if (await pathExists(userdataPath(appHome, "state.sqlite"))) return false;
  const databasePath = userdataPath(appHome, "statev2.sqlite");
  if (!(await pathExists(databasePath))) return true;
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = openReadOnlyDatabase(databasePath);
    const projectCount = countRows(database, "projection_projects");
    const threadCount = countRows(database, "orchestration_v2_projection_threads");
    const runCount = countRows(database, "orchestration_v2_projection_runs");
    const userMessageCount = countRows(
      database,
      "orchestration_v2_projection_messages",
      "WHERE json_extract(payload_json, '$.createdBy') = 'user'",
    );
    return projectCount <= 1 && threadCount <= 1 && runCount === 0 && userMessageCount === 0;
  } catch {
    // An unreadable database is not a home we should replace.
    return false;
  } finally {
    database?.close();
  }
};

export interface T3ImportStatusInput extends T3ImportHomes {}

export const readT3ImportStatus = async (input: T3ImportStatusInput): Promise<T3ImportStatus> => {
  const { appHome, stockHome } = input;
  const [fresh, stockAvailable, alreadyMigrated, pending, shouldOffer] = await Promise.all([
    isT3ImportHomeFresh(appHome),
    hasStockDatabase(stockHome),
    pathExists(userdataPath(appHome, MIGRATION_MARKER_FILE)),
    pathExists(userdataPath(appHome, PENDING_T3_IMPORT_FILE)),
    shouldOfferT3Import({ appHome, stockHome }),
  ]);

  const reason: T3ImportStatusReason = !stockAvailable
    ? "stock-home-missing"
    : alreadyMigrated
      ? "already-imported"
      : pending
        ? "pending"
        : !fresh
          ? "home-not-fresh"
          : "available";
  // shouldOfferT3Import refuses once this home has a database, as onboarding's first start leaves
  // behind; the fresh check is what lets the welcome screen offer the import on that same start.
  const available =
    reason === "available" && (shouldOffer || (fresh && stockAvailable && !alreadyMigrated));

  return { available, stockHome, appHome, fresh, reason };
};

export class T3ImportUnavailableError extends Error {
  constructor(
    readonly reason: T3ImportStatusReason,
    detail: string,
  ) {
    super(detail);
    this.name = "T3ImportUnavailableError";
  }
}

export interface AcceptT3ImportInput extends T3ImportHomes {
  readonly appVersion: string;
  readonly nowMs?: number;
}

export const acceptT3Import = async (input: AcceptT3ImportInput): Promise<T3ImportStatus> => {
  const status = await readT3ImportStatus(input);
  if (!status.available || !status.fresh) {
    throw new T3ImportUnavailableError(
      status.reason,
      `This p0code home cannot import T3 Code data (${status.reason}).`,
    );
  }
  const requestedAt = DateTime.formatIso(DateTime.makeUnsafe(input.nowMs ?? Date.now()));
  const marker = { requestedAt, source: input.stockHome, appVersion: input.appVersion };
  const markerPath = userdataPath(input.appHome, PENDING_T3_IMPORT_FILE);
  await NodeFSP.mkdir(NodePath.dirname(markerPath), { recursive: true, mode: 0o700 });
  await NodeFSP.writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return readT3ImportStatus(input);
};

export interface PendingT3ImportMarker {
  readonly requestedAt: string;
  readonly source: string;
  readonly appVersion: string;
}

const readPendingT3Import = async (appHome: string): Promise<PendingT3ImportMarker | null> => {
  const contents = await NodeFSP.readFile(
    userdataPath(appHome, PENDING_T3_IMPORT_FILE),
    "utf8",
  ).catch(() => undefined);
  if (contents === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(contents);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "requestedAt" in parsed &&
      typeof parsed.requestedAt === "string" &&
      "source" in parsed &&
      typeof parsed.source === "string" &&
      "appVersion" in parsed &&
      typeof parsed.appVersion === "string"
    ) {
      return {
        requestedAt: parsed.requestedAt,
        source: parsed.source,
        appVersion: parsed.appVersion,
      };
    }
  } catch {
    // A broken marker is handled as a failed import below; it never blocks startup.
  }
  return null;
};

const removePendingT3Import = (appHome: string) =>
  NodeFSP.rm(userdataPath(appHome, PENDING_T3_IMPORT_FILE), { force: true });

/** A destination moved aside by the migrator whose restore also failed. */
class T3ImportRestoreFailedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "T3ImportRestoreFailedError";
  }
}

const findReplacedDestination = async (appHome: string): Promise<string | undefined> => {
  const parent = NodePath.dirname(appHome);
  const prefix = `${NodePath.basename(appHome)}.replaced-`;
  const names = (await NodeFSP.readdir(parent).catch(() => [] as Array<string>))
    .filter((name) => name.startsWith(prefix))
    .sort((left, right) => left.localeCompare(right));
  const latest = names.at(-1);
  return latest === undefined ? undefined : NodePath.join(parent, latest);
};

export type ApplyPendingT3ImportResult =
  | { readonly status: "nothing" }
  | {
      readonly status: "applied";
      readonly report: MigrateFromT3Report;
      readonly reportPath: string;
    }
  | {
      readonly status: "failed";
      readonly error: string;
      readonly reportPath?: string;
    };

export interface ApplyPendingT3ImportInput extends T3ImportHomes {
  readonly keychain?: KeychainStore | null;
  /** Resolved inside the import so a keychain failure clears the marker instead of boot-looping. */
  readonly keychainLoader?: () => Promise<KeychainStore | null>;
  readonly nowMs?: number;
}

export const applyPendingT3Import = async (
  input: ApplyPendingT3ImportInput,
): Promise<ApplyPendingT3ImportResult> => {
  const { appHome } = input;
  const marker = await readPendingT3Import(appHome);
  if (marker === null) {
    if (await pathExists(userdataPath(appHome, PENDING_T3_IMPORT_FILE))) {
      await removePendingT3Import(appHome).catch(() => undefined);
      return { status: "failed", error: "The pending T3 Code import marker was unreadable." };
    }
    return { status: "nothing" };
  }

  const reportPath = userdataPath(appHome, T3_IMPORT_REPORT_FILE);
  try {
    const keychain = await (input.keychain === undefined && input.keychainLoader !== undefined
      ? input.keychainLoader()
      : Promise.resolve(input.keychain));
    const report = await migrateFromT3({
      from: marker.source || input.stockHome,
      to: appHome,
      force: true,
      ...(keychain === undefined ? {} : { keychain }),
      ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    });
    try {
      await NodeFSP.mkdir(NodePath.dirname(reportPath), { recursive: true, mode: 0o700 });
      await NodeFSP.writeFile(reportPath, `${formatMigrationReportJson(report)}\n`, {
        mode: 0o600,
      });
    } catch {
      // The import is done; a report we cannot write must not cause a second import next boot.
      await removePendingT3Import(appHome);
      return { status: "applied", report, reportPath };
    }
    await removePendingT3Import(appHome);
    return { status: "applied", report, reportPath };
  } catch (cause) {
    await removePendingT3Import(appHome).catch(() => undefined);
    const detail = cause instanceof Error ? cause.message : String(cause);
    const appHomeExists = await pathExists(appHome);
    const replaced = await findReplacedDestination(appHome);
    // migrateFromT3 renames the destination aside, then the new home into place. If that second
    // rename and its own restore both failed, starting on another home would hide the user's data.
    if (!appHomeExists && replaced !== undefined) {
      throw new T3ImportRestoreFailedError(
        `The T3 Code import could not restore ${appHome}; the previous home is at ${replaced}.`,
      );
    }
    return { status: "failed", error: detail };
  }
};

/** The CLI and the startup hook both import credentials straight to the OS keychain. */
export const resolveT3ImportKeychain = async ({
  to,
  dryRun,
  requested,
  platform,
}: {
  readonly to: string;
  readonly dryRun: boolean;
  readonly requested: string;
  readonly platform: NodeJS.Platform;
}): Promise<KeychainStore | null> => {
  if (requested === "file" || process.env.VITEST) return null;
  if (requested !== "auto" && requested !== "keychain") {
    throw new Error(`P0CODE_SECRET_BACKEND must be "keychain" or "file", got "${requested}".`);
  }
  try {
    const keyring: typeof import("@napi-rs/keyring") = requireExternal("@napi-rs/keyring");
    const store = keyringStore(keyring, platform);
    if (!dryRun) {
      const secrets = keychainSecrets(
        store,
        await credentialNamespace(userdataPath(to, "secrets")),
      );
      await secrets.probe();
    }
    return store;
  } catch (cause) {
    if (requested === "keychain") {
      throw new Error("P0CODE_SECRET_BACKEND=keychain, but the OS keychain is not available.", {
        cause,
      });
    }
    return null;
  }
};

/** Runs before the server opens its database, so the import replaces an untouched home. */
export const applyPendingT3ImportAtStartup = Effect.fn("server.t3Import.applyPending")(
  function* (options: {
    readonly appHome: string;
    readonly stockHome: string;
    readonly platform: NodeJS.Platform;
  }) {
    const requested = (process.env.P0CODE_SECRET_BACKEND ?? "auto").trim().toLowerCase();
    const result = yield* Effect.promise(() =>
      applyPendingT3Import({
        appHome: options.appHome,
        stockHome: options.stockHome,
        keychainLoader: () =>
          resolveT3ImportKeychain({
            to: options.appHome,
            dryRun: false,
            requested,
            platform: options.platform,
          }),
      }),
    );
    if (result.status === "applied") {
      yield* Effect.logInfo("Imported T3 Code data on startup", {
        reportPath: result.reportPath,
        copied: result.report.copied.length,
        rewritten: result.report.rewritten.length,
      });
    } else if (result.status === "failed") {
      yield* Effect.logError("Could not import T3 Code data on startup", {
        error: result.error,
      });
    }
  },
);

export const t3ImportStockHome = (homeDirectory: string) =>
  NodePath.join(homeDirectory, STOCK_T3_HOME_DIRECTORY_NAME);
