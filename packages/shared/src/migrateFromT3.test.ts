// @effect-diagnostics nodeBuiltinImport:off - builds real T3 homes and SQLite databases on disk.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  KEYCHAIN_MARKER_FILE,
  credentialNamespace,
  keychainSecrets,
  memoryKeychainStore,
} from "./credentialKeychain.ts";
import {
  MIGRATION_MARKER_FILE,
  MigrateFromT3Error,
  makePathRewriter,
  migrateFromT3,
  shouldOfferT3Import,
} from "./migrateFromT3.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

const write = (file: string, contents: string) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, contents);
};

const snapshotTree = (root: string): Record<string, string> => {
  const result: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of NodeFS.readdirSync(directory)) {
      const file = NodePath.join(directory, name);
      const info = NodeFS.lstatSync(file);
      if (info.isDirectory()) walk(file);
      else result[NodePath.relative(root, file)] = NodeFS.readFileSync(file).toString("base64");
    }
  };
  walk(root);
  return result;
};

const makeFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hhh-migrate-"));
  roots.push(root);
  const from = NodePath.join(root, "home", ".t3");
  const to = NodePath.join(root, "home", ".hhh");
  const userdata = NodePath.join(from, "userdata");
  const externalClaude = NodePath.join(root, "home", ".claude_work");
  write(
    NodePath.join(userdata, "settings.json"),
    JSON.stringify(
      {
        providerInstances: {
          claudeAgent_work: {
            driver: "claudeAgent",
            enabled: true,
            config: { homePath: externalClaude },
          },
          codex_personal: {
            driver: "codex",
            enabled: true,
            config: { homePath: NodePath.join(userdata, "providers", "codex", "personal") },
          },
          antigravity_2: { driver: "antigravity", enabled: false },
          claudeAgent_tilde: {
            driver: "claudeAgent",
            enabled: true,
            config: { homePath: "~/.claude_tilde/" },
          },
          opencode: { driver: "opencode", enabled: true, config: { binaryPath: "opencode" } },
        },
        accountProfiles: { work: ["claudeAgent_work"], personal: ["codex_personal"] },
      },
      null,
      2,
    ),
  );
  write(NodePath.join(userdata, "client-settings.json"), "{}");
  write(NodePath.join(userdata, "keybindings.json"), "[]");
  write(NodePath.join(userdata, "environment-id"), "old-environment-id");
  write(NodePath.join(userdata, "anonymous-id"), "telemetry");
  write(NodePath.join(userdata, "cloud-auth-token.json"), "{}");
  write(NodePath.join(userdata, "clerk", "session.json"), "{}");
  write(NodePath.join(userdata, "logs", "server.trace.ndjson"), "{}");
  write(NodePath.join(userdata, "server-runtime.json"), JSON.stringify({ pid: 1 }));
  write(NodePath.join(userdata, "opencode-servers", "1234.json"), "{}");
  write(NodePath.join(userdata, "attachments", "a.png"), "png");
  write(NodePath.join(userdata, "secrets", "provider-auth-abc.bin"), "provider secret");
  write(NodePath.join(userdata, "secrets", "mcp-oauth-signing-key.bin"), "mcp key");
  write(NodePath.join(userdata, "secrets", "server-signing-key.bin"), "server key");
  write(NodePath.join(userdata, "secrets", "peer-link-1.bin"), "peer");
  write(NodePath.join(userdata, "secrets", "cloud-link-ed25519-key-pair.bin"), "cloud");
  write(NodePath.join(userdata, "secrets", "dpop-proof-x.bin"), "dpop");
  write(
    NodePath.join(userdata, "providers", "codex", "personal", "config.toml"),
    `sqlite_home = "${NodePath.join(userdata, "providers", "codex", "personal")}"\n`,
  );
  write(NodePath.join(userdata, "providers", "antigravity", "hash", "state.bin"), "bin");
  write(NodePath.join(userdata, "device", "hosts", "h.json"), "{}");
  write(NodePath.join(userdata, "device", "agent-device", "tool"), "downloaded");
  write(NodePath.join(from, "workflows", "release.ts"), "export default {}");
  write(NodePath.join(from, "runtime", "versions", "1.0.0", "t3"), "binary");
  write(NodePath.join(from, "worktrees", "repo", "wt", "file"), "work");

  const database = new NodeSqlite.DatabaseSync(NodePath.join(userdata, "statev2.sqlite"));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA wal_autocheckpoint = 0;
    CREATE TABLE threads (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, count INTEGER);
    CREATE VIRTUAL TABLE search USING fts5(text);
  `);
  const insert = database.prepare("INSERT INTO threads VALUES (?, ?, ?)");
  insert.run(
    "attachment",
    JSON.stringify({ image: NodePath.join(userdata, "attachments", "a.png") }),
    1,
  );
  insert.run(
    "worktree",
    JSON.stringify({ cwd: NodePath.join(from, "worktrees", "repo", "wt") }),
    2,
  );
  database.prepare("INSERT INTO search VALUES (?)").run("hello");
  return { root, from, to, userdata, externalClaude, database };
};

describe("migrateFromT3", () => {
  it("imports every kept file, rewrites paths into the old home and leaves the source untouched", async () => {
    const fixture = makeFixture();
    const before = snapshotTree(fixture.from);

    const report = await migrateFromT3({
      from: fixture.from,
      to: fixture.to,
      nowMs: 1_700_000_000_000,
      isProcessAlive: () => false,
    });
    // A WAL reader may only update SQLite's shared-memory index; every real file is unchanged.
    const withoutShm = (tree: Record<string, string>) =>
      Object.fromEntries(Object.entries(tree).filter(([file]) => !file.endsWith("-shm")));
    assert.deepEqual(withoutShm(snapshotTree(fixture.from)), withoutShm(before));
    fixture.database.close();

    assert.equal(report.status, "migrated");
    assert.equal(report.environmentId, "new");
    const to = (...segments: Array<string>) => NodePath.join(fixture.to, ...segments);
    assert.isTrue(NodeFS.existsSync(to("userdata", "attachments", "a.png")));
    assert.isTrue(NodeFS.existsSync(to("userdata", "secrets", "provider-auth-abc.bin")));
    assert.isTrue(NodeFS.existsSync(to("userdata", "secrets", "mcp-oauth-signing-key.bin")));
    assert.isTrue(
      NodeFS.existsSync(to("userdata", "providers", "antigravity", "hash", "state.bin")),
    );
    assert.isTrue(NodeFS.existsSync(to("userdata", "device", "hosts", "h.json")));
    assert.isTrue(NodeFS.existsSync(to("workflows", "release.ts")));
    for (const absent of [
      ["userdata", "environment-id"],
      ["userdata", "anonymous-id"],
      ["userdata", "cloud-auth-token.json"],
      ["userdata", "clerk"],
      ["userdata", "logs"],
      ["userdata", "server-runtime.json"],
      ["userdata", "opencode-servers"],
      ["userdata", "secrets", "server-signing-key.bin"],
      ["userdata", "secrets", "peer-link-1.bin"],
      ["userdata", "secrets", "cloud-link-ed25519-key-pair.bin"],
      ["userdata", "secrets", "dpop-proof-x.bin"],
      ["userdata", "device", "agent-device"],
      ["runtime"],
      ["worktrees"],
    ]) {
      assert.isFalse(NodeFS.existsSync(to(...absent)), absent.join("/"));
    }

    const settings = JSON.parse(NodeFS.readFileSync(to("userdata", "settings.json"), "utf8"));
    assert.equal(
      settings.providerInstances.codex_personal.config.homePath,
      to("userdata", "providers", "codex", "personal"),
    );
    assert.equal(
      settings.providerInstances.claudeAgent_work.config.homePath,
      fixture.externalClaude,
    );
    assert.deepEqual(settings.accountProfiles, {
      work: ["claudeAgent_work"],
      personal: ["codex_personal"],
    });
    assert.include(
      NodeFS.readFileSync(to("userdata", "providers", "codex", "personal", "config.toml"), "utf8"),
      to("userdata", "providers", "codex", "personal"),
    );

    const copy = new NodeSqlite.DatabaseSync(to("userdata", "statev2.sqlite"), { readOnly: true });
    const rows = copy.prepare("SELECT id, payload_json FROM threads ORDER BY id").all();
    assert.equal(
      JSON.parse(String(rows[0]?.payload_json)).image,
      to("userdata", "attachments", "a.png"),
    );
    assert.equal(
      JSON.parse(String(rows[1]?.payload_json)).cwd,
      NodePath.join(fixture.from, "worktrees", "repo", "wt"),
    );
    assert.equal(copy.prepare("SELECT count(*) AS count FROM search").get()?.count, 1);
    copy.close();

    assert.deepInclude(report.sharedExternal, {
      path: fixture.externalClaude,
      detail: "settings.json providerInstances.claudeAgent_work.config.homePath",
    });
    assert.isTrue(
      report.sharedExternal.some(
        (entry) =>
          entry.path === NodePath.join(fixture.from, "worktrees") &&
          entry.detail.includes("1 value"),
      ),
    );
    assert.deepEqual(
      report.providerInstances.map((instance) => [instance.instanceId, instance.home]),
      [
        ["claudeAgent_work", `shared: ${fixture.externalClaude}`],
        ["codex_personal", "copied with this home"],
        ["antigravity_2", "default"],
        ["claudeAgent_tilde", "shared: ~/.claude_tilde/"],
        ["opencode", "default"],
      ],
    );

    const marker = JSON.parse(NodeFS.readFileSync(to("userdata", MIGRATION_MARKER_FILE), "utf8"));
    assert.equal(marker.source, fixture.from);
    assert.isFalse(NodeFS.existsSync(`${fixture.to}.migrating-1700000000000`));

    const again = await migrateFromT3({ from: fixture.from, to: fixture.to });
    assert.equal(again.status, "already-migrated");
  });

  it("keeps the environment identity only when asked", async () => {
    const fixture = makeFixture();
    fixture.database.close();
    const report = await migrateFromT3({
      from: fixture.from,
      to: fixture.to,
      keepEnvironmentId: true,
    });
    assert.equal(report.environmentId, "kept");
    const userdata = NodePath.join(fixture.to, "userdata");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(userdata, "environment-id"), "utf8"),
      "old-environment-id",
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(userdata, "secrets", "server-signing-key.bin")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(userdata, "secrets", "peer-link-1.bin")));
  });

  it("writes nothing on a dry run", async () => {
    const fixture = makeFixture();
    fixture.database.close();
    const report = await migrateFromT3({ from: fixture.from, to: fixture.to, dryRun: true });
    assert.equal(report.status, "dry-run");
    assert.isTrue(
      report.copied.some((entry) => entry.path === NodePath.join("userdata", "statev2.sqlite")),
    );
    assert.isFalse(NodeFS.existsSync(fixture.to));
    assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(fixture.to)), [".t3"]);
  });

  it("refuses a destination with data unless forced, and then moves it aside", async () => {
    const fixture = makeFixture();
    fixture.database.close();
    write(NodePath.join(fixture.to, "userdata", "settings.json"), '{"mine":true}');

    const refused = await migrateFromT3({ from: fixture.from, to: fixture.to }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.instanceOf(refused, MigrateFromT3Error);
    assert.equal((refused as MigrateFromT3Error).code, "destination-not-empty");

    const report = await migrateFromT3({
      from: fixture.from,
      to: fixture.to,
      force: true,
      nowMs: 5,
      isProcessAlive: () => false,
    });
    assert.equal(report.replacedDestination, `${fixture.to}.replaced-5`);
    assert.equal(
      NodeFS.readFileSync(
        NodePath.join(`${fixture.to}.replaced-5`, "userdata", "settings.json"),
        "utf8",
      ),
      '{"mine":true}',
    );
  });

  it("refuses to replace a destination whose server is running", async () => {
    const fixture = makeFixture();
    fixture.database.close();
    write(
      NodePath.join(fixture.to, "userdata", "server-runtime.json"),
      JSON.stringify({ pid: 4242 }),
    );
    const refused = await migrateFromT3({
      from: fixture.from,
      to: fixture.to,
      force: true,
      isProcessAlive: (pid) => pid === 4242,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal((refused as MigrateFromT3Error).code, "destination-in-use");
  });

  it("refuses overlapping homes and missing sources", async () => {
    const fixture = makeFixture();
    fixture.database.close();
    const overlapping = await migrateFromT3({
      from: fixture.from,
      to: NodePath.join(fixture.from, "nested"),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal((overlapping as MigrateFromT3Error).code, "overlapping-paths");
    const missing = await migrateFromT3({
      from: NodePath.join(fixture.root, "nowhere"),
      to: fixture.to,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.equal((missing as MigrateFromT3Error).code, "source-missing");
  });

  it("writes credentials to the keychain instead of .bin files and skips replay markers", async () => {
    const fixture = makeFixture();
    fixture.database.close();
    write(NodePath.join(fixture.userdata, "secrets", "cloud-mint-jti-1.bin"), "jti");
    write(NodePath.join(fixture.userdata, "secrets", "provider-auth-abc.bin.deadbeef.tmp"), "tmp");
    const keychain = memoryKeychainStore();

    const dry = await migrateFromT3({
      from: fixture.from,
      to: fixture.to,
      dryRun: true,
      keychain,
    });
    assert.equal(dry.status, "dry-run");
    assert.equal(keychain.entries.size, 0);
    assert.isTrue(
      dry.copied.some(
        (entry) =>
          entry.path === NodePath.join("userdata", "secrets") &&
          entry.detail === "2 secret entries → keychain",
      ),
    );

    const report = await migrateFromT3({
      from: fixture.from,
      to: fixture.to,
      keychain,
    });
    assert.equal(report.status, "migrated");
    const secretsDir = NodePath.join(fixture.to, "userdata", "secrets");
    assert.deepEqual(NodeFS.readdirSync(secretsDir), [KEYCHAIN_MARKER_FILE]);
    const secrets = keychainSecrets(keychain, await credentialNamespace(secretsDir));
    assert.equal(
      new TextDecoder().decode(await secrets.get("provider-auth-abc")),
      "provider secret",
    );
    assert.equal(new TextDecoder().decode(await secrets.get("mcp-oauth-signing-key")), "mcp key");
    assert.isUndefined(await secrets.get("dpop-proof-x"));
    assert.isUndefined(await secrets.get("cloud-mint-jti-1"));
    assert.isUndefined(await secrets.get("server-signing-key"));
  });

  it("replaces an empty destination directory without leaving a .replaced backup", async () => {
    const fixture = makeFixture();
    fixture.database.close();
    NodeFS.mkdirSync(fixture.to, { recursive: true });
    const report = await migrateFromT3({
      from: fixture.from,
      to: fixture.to,
      nowMs: 42,
    });
    assert.equal(report.status, "migrated");
    assert.isUndefined(report.replacedDestination);
    assert.isFalse(NodeFS.existsSync(`${fixture.to}.replaced-42`));
  });

  it("snapshots a database without WAL files without creating any in the source", async () => {
    const fixture = makeFixture();
    fixture.database.close();
    assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.userdata, "statev2.sqlite-wal")));
    await migrateFromT3({ from: fixture.from, to: fixture.to });
    assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.userdata, "statev2.sqlite-wal")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(fixture.userdata, "statev2.sqlite-shm")));
  });
});

describe("shouldOfferT3Import", () => {
  it("offers only for a fresh hhhcode home next to a stock T3 Code database", async () => {
    const fixture = makeFixture();
    fixture.database.close();
    assert.isTrue(await shouldOfferT3Import({ appHome: fixture.to, stockHome: fixture.from }));
    await migrateFromT3({ from: fixture.from, to: fixture.to });
    assert.isFalse(await shouldOfferT3Import({ appHome: fixture.to, stockHome: fixture.from }));
  });
});

describe("makePathRewriter", () => {
  it("rewrites only moved folders and respects path boundaries", () => {
    const rewrite = makePathRewriter("/h/.t3", "/h/.hhh");
    assert.deepEqual(rewrite('"/h/.t3/userdata/x" "/h/.t3/userdata2" "/h/.t3/worktrees/a"'), {
      text: '"/h/.hhh/userdata/x" "/h/.t3/userdata2" "/h/.t3/worktrees/a"',
      count: 1,
    });
  });

  it("rewrites JSON-escaped and forward-slash Windows paths", () => {
    const rewrite = makePathRewriter("C:\\Users\\a\\.t3", "C:\\Users\\a\\.hhh");
    assert.equal(
      rewrite('{"p":"C:\\\\Users\\\\a\\\\.t3\\\\userdata\\\\x"}').text,
      '{"p":"C:\\\\Users\\\\a\\\\.hhh\\\\userdata\\\\x"}',
    );
    assert.equal(rewrite("C:/Users/a/.t3/userdata/x").text, "C:/Users/a/.hhh/userdata/x");
  });
});
