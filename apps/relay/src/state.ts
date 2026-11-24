// Node-native relay adapter has no Effect runtime; timers and clocks follow socket/token lifetimes.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { validatePublicKey } from "@t3tools/relay-tunnel/auth";

export interface EnrolledEnvironment {
  slug: string;
  publicKey: string;
  createdAt: number;
}
export class RelayState {
  private readonly db: NodeSqlite.DatabaseSync;
  constructor(path: string) {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    this.db = new NodeSqlite.DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS environments (slug TEXT PRIMARY KEY, publicKey TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL);`);
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
  enroll(token: string, publicKey: string, desiredSlug?: string): EnrolledEnvironment {
    validatePublicKey(publicKey);
    const slug = desiredSlug ?? `e${NodeCrypto.randomBytes(5).toString("hex")}`;
    if (!/^[a-z][a-z0-9]{5,31}$/.test(slug))
      throw new Error("Slug must be 6–32 lowercase letters/digits, starting with a letter");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare("DELETE FROM tokens WHERE hash = ? AND expiresAt > ?")
        .run(this.hash(token), Date.now());
      if (result.changes !== 1) throw new Error("Invalid or expired enrollment token");
      const createdAt = Date.now();
      this.db.prepare("INSERT INTO environments VALUES (?, ?, ?)").run(slug, publicKey, createdAt);
      this.db.exec("COMMIT");
      return { slug, publicKey, createdAt };
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
  close(): void {
    this.db.close();
  }
}
