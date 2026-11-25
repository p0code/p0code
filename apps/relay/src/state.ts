// Node-native relay adapter has no Effect runtime; timers and clocks follow socket/token lifetimes.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { validatePublicKey } from "@t3tools/relay-tunnel/auth";
import { parseHostLabel } from "@t3tools/relay-tunnel/mux";

export interface EnrolledEnvironment {
  slug: string;
  publicKey: string;
  createdAt: number;
  /** The account that owns this environment, or null for a token-enrolled one. */
  userId: string | null;
}
export interface RelayUser {
  username: string;
  createdAt: number;
  disabled: boolean;
}
interface UserRow {
  username: string;
  salt: string;
  hash: string;
  createdAt: number;
  disabled: number;
}
interface EnvironmentRow {
  slug: string;
  publicKey: string;
  createdAt: number;
  userId: string | null;
}
/** A wrong username, a wrong password and a disabled account fail identically. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid username or password");
  }
}
/** Authenticated, but the environment's slug or key already belongs to someone else. */
export class LinkConflictError extends Error {}
export class UserExistsError extends Error {
  constructor() {
    super("Username is already taken");
  }
}
/** Signup and CLI passwords must be at least this long. */
export const MIN_PASSWORD_LENGTH = 12;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,31}$/;
const SLUG = /^[a-z][a-z0-9]{5,31}$/;
// Verifying against this for an unknown username keeps the scrypt cost indistinguishable.
const DUMMY_SALT = "00000000000000000000000000000000";
const DUMMY_HASH = Buffer.alloc(64);

export class RelayState {
  private readonly db: NodeSqlite.DatabaseSync;
  constructor(path: string) {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    this.db = new NodeSqlite.DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS environments (slug TEXT PRIMARY KEY, publicKey TEXT NOT NULL, createdAt INTEGER NOT NULL, userId TEXT);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS blocked_labels (label TEXT PRIMARY KEY, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL, createdAt INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);`);
    this.migrate();
  }
  /** Databases predate accounts, so `environments` may not have `userId` yet. */
  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(environments)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "userId"))
      this.db.exec("ALTER TABLE environments ADD COLUMN userId TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS environments_userId ON environments(userId)");
  }
  purgeExpiredTokens(): void {
    this.db.prepare("DELETE FROM tokens WHERE expiresAt <= ?").run(Date.now());
  }
  issueToken(ttlMs = 60 * 60 * 1000): string {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Token TTL must be positive");
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO tokens VALUES (?, ?)").run(this.hash(token), Date.now() + ttlMs);
    return token;
  }
  private hash(token: string): string {
    return NodeCrypto.createHash("sha256").update(token).digest("hex");
  }
  private derive(password: string, salt: string): Buffer {
    return NodeCrypto.scryptSync(password, salt, 64, SCRYPT);
  }
  private normalizeUsername(username: string): string {
    const name = username.trim().toLowerCase();
    if (!USERNAME.test(name))
      throw new Error(
        "Username must be 3–32 lowercase letters, digits, dots, dashes or underscores",
      );
    return name;
  }
  private requirePassword(password: string): void {
    if (password.length < MIN_PASSWORD_LENGTH)
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  /** Adds a password account. `password` is never stored, only its salted scrypt hash. */
  addUser(username: string, password: string): RelayUser {
    const name = this.normalizeUsername(username);
    this.requirePassword(password);
    const salt = NodeCrypto.randomBytes(16).toString("hex");
    const hash = this.derive(password, salt).toString("hex");
    const createdAt = Date.now();
    try {
      this.db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, 0)").run(name, salt, hash, createdAt);
    } catch {
      throw new UserExistsError();
    }
    return { username: name, createdAt, disabled: false };
  }
  setPassword(username: string, password: string): boolean {
    const name = username.trim().toLowerCase();
    this.requirePassword(password);
    const salt = NodeCrypto.randomBytes(16).toString("hex");
    const hash = this.derive(password, salt).toString("hex");
    return (
      this.db
        .prepare("UPDATE users SET salt = ?, hash = ? WHERE username = ?")
        .run(salt, hash, name).changes === 1
    );
  }
  listUsers(): RelayUser[] {
    const rows = this.db
      .prepare("SELECT username, createdAt, disabled FROM users ORDER BY username")
      .all() as { username: string; createdAt: number; disabled: number }[];
    return rows.map((row) => ({
      username: row.username,
      createdAt: row.createdAt,
      disabled: row.disabled !== 0,
    }));
  }
  userCount(): number {
    return Number(
      (this.db.prepare("SELECT count(*) AS count FROM users").get() as { count: number }).count,
    );
  }
  /**
   * Removes the account and revokes every environment it owns, so their tunnels close. Environments
   * enrolled with a token have no user and are untouched.
   */
  removeUser(username: string): { removed: boolean; revoked: string[] } {
    const name = username.trim().toLowerCase();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const exists = this.db.prepare("SELECT 1 FROM users WHERE username = ?").get(name);
      if (exists === undefined) {
        this.db.exec("ROLLBACK");
        return { removed: false, revoked: [] };
      }
      const revoked = (
        this.db.prepare("SELECT slug FROM environments WHERE userId = ?").all(name) as {
          slug: string;
        }[]
      ).map((row) => row.slug);
      this.db.prepare("DELETE FROM environments WHERE userId = ?").run(name);
      this.db.prepare("DELETE FROM users WHERE username = ?").run(name);
      this.db.exec("COMMIT");
      return { removed: true, revoked };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private userRow(username: string): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username.trim().toLowerCase()) as UserRow | undefined;
  }
  /** Runs one scrypt no matter what, so a missing or disabled user costs the same as a wrong one. */
  private verifyPassword(user: UserRow | undefined, password: string): boolean {
    const actual = this.derive(password, user?.salt ?? DUMMY_SALT);
    const expected = user ? Buffer.from(user.hash, "hex") : DUMMY_HASH;
    const equal = expected.length === actual.length && NodeCrypto.timingSafeEqual(expected, actual);
    return equal && user !== undefined && user.disabled === 0;
  }
  enroll(token: string, publicKey: string, desiredSlug?: string): EnrolledEnvironment {
    validatePublicKey(publicKey);
    const slug = desiredSlug ?? `e${NodeCrypto.randomBytes(5).toString("hex")}`;
    if (!SLUG.test(slug))
      throw new Error("Slug must be 6–32 lowercase letters/digits, starting with a letter");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare("DELETE FROM tokens WHERE hash = ? AND expiresAt > ?")
        .run(this.hash(token), Date.now());
      if (result.changes !== 1) throw new Error("Invalid or expired enrollment token");
      const createdAt = Date.now();
      this.db
        .prepare(
          "INSERT INTO environments (slug, publicKey, createdAt, userId) VALUES (?, ?, ?, NULL)",
        )
        .run(slug, publicKey, createdAt);
      this.db.exec("COMMIT");
      return { slug, publicKey, createdAt, userId: null };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /**
   * Links an environment for an account. The same account re-linking the same public key keeps its
   * slug; a key or a slug that already belongs to anyone else is refused. Credential failures are
   * indistinguishable from unknown accounts.
   */
  enrollForUser(input: {
    username: string;
    password: string;
    publicKey: string;
    desiredSlug?: string;
  }): EnrolledEnvironment {
    validatePublicKey(input.publicKey);
    const user = this.userRow(input.username);
    if (!this.verifyPassword(user, input.password) || user === undefined)
      throw new InvalidCredentialsError();
    const owner = user.username;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const byKey = this.db
        .prepare("SELECT * FROM environments WHERE publicKey = ? ORDER BY createdAt")
        .all(input.publicKey) as unknown as EnvironmentRow[];
      const owned = byKey.find((environment) => environment.userId === owner);
      if (owned) {
        this.db.exec("ROLLBACK");
        return { ...owned };
      }
      if (byKey.length) throw new LinkConflictError("This environment is already linked");
      if (input.desiredSlug !== undefined && !SLUG.test(input.desiredSlug))
        throw new Error("Slug must be 6–32 lowercase letters/digits, starting with a letter");
      let slug = input.desiredSlug;
      if (slug === undefined) {
        do {
          slug = `e${NodeCrypto.randomBytes(5).toString("hex")}`;
        } while (
          this.db.prepare("SELECT 1 FROM environments WHERE slug = ?").get(slug) !== undefined
        );
      } else if (this.db.prepare("SELECT 1 FROM environments WHERE slug = ?").get(slug)) {
        throw new LinkConflictError("That slug is already in use");
      }
      const createdAt = Date.now();
      this.db
        .prepare(
          "INSERT INTO environments (slug, publicKey, createdAt, userId) VALUES (?, ?, ?, ?)",
        )
        .run(slug, input.publicKey, createdAt, owner);
      this.db.exec("COMMIT");
      return { slug, publicKey: input.publicKey, createdAt, userId: owner };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  get(slug: string): EnrolledEnvironment | undefined {
    return this.db.prepare("SELECT * FROM environments WHERE slug = ?").get(slug) as
      | EnrolledEnvironment
      | undefined;
  }
  list(): EnrolledEnvironment[] {
    return this.db
      .prepare("SELECT * FROM environments ORDER BY createdAt")
      .all() as unknown as EnrolledEnvironment[];
  }
  revoke(slug: string): boolean {
    return this.db.prepare("DELETE FROM environments WHERE slug = ?").run(slug).changes === 1;
  }
  /** Operator takedown of one public tunnel name (`docs-abcdef`) without revoking its environment. */
  block(label: string): boolean {
    this.requireNameLabel(label);
    return (
      this.db.prepare("INSERT OR IGNORE INTO blocked_labels VALUES (?, ?)").run(label, Date.now())
        .changes === 1
    );
  }
  unblock(label: string): boolean {
    this.requireNameLabel(label);
    return this.db.prepare("DELETE FROM blocked_labels WHERE label = ?").run(label).changes === 1;
  }
  /**
   * Blocking a bare `<slug>` or `<port>-<slug>` label would take down the environment's own host
   * without revoking it; those are `revoke`'s job, and ports are not public takedown units.
   */
  private requireNameLabel(label: string): void {
    const parsed = parseHostLabel(label);
    if (!parsed) throw new Error(`Not a relay hostname label: ${label}`);
    if (parsed.name === undefined)
      throw new Error(`Blocked labels are public tunnel names like docs-abcdef, not: ${label}`);
  }
  isBlocked(label: string): boolean {
    return this.db.prepare("SELECT 1 FROM blocked_labels WHERE label = ?").get(label) !== undefined;
  }
  blockedLabels(): string[] {
    return this.db
      .prepare("SELECT label FROM blocked_labels ORDER BY createdAt")
      .all()
      .map((row) => String(row.label));
  }
  close(): void {
    this.db.close();
  }
}
