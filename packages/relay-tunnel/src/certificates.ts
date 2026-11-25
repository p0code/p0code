import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeTls from "node:tls";
import { Client, crypto, directory } from "acme-client";

export class HttpChallengeStore {
  private readonly entries = new Map<string, string>();
  set(hostname: string, token: string, authorization: string): void {
    this.entries.set(`${hostname.toLowerCase()}/${token}`, authorization);
  }
  delete(hostname: string, token: string): void {
    this.entries.delete(`${hostname.toLowerCase()}/${token}`);
  }
  get(hostname: string, path: string): string | undefined {
    const match = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(path);
    return match ? this.entries.get(`${hostname.toLowerCase()}/${match[1]}`) : undefined;
  }
}
export interface CertificateFiles {
  cert: string;
  key: string;
}
/** Holds private keys outside the certificate folder, e.g. in the OS keychain. */
export interface CertificateKeyStore {
  get(name: string): Promise<Buffer | undefined>;
  set(name: string, value: Buffer): Promise<void>;
}
export interface CertificateManagerOptions {
  directory: string;
  /** Without one, private keys are files in `directory`. */
  keys?: CertificateKeyStore;
  challenges: HttpChallengeStore;
  email?: string;
  directoryUrl?: string;
  byo?: CertificateFiles;
  onError?: (error: Error) => void;
}
interface CertificateEntry {
  context: NodeTls.SecureContext;
  renewAt: number;
  expiresAt: number;
  hostname: string;
}
export const acmeDirectories = {
  production: directory.letsencrypt.production,
  staging: directory.letsencrypt.staging,
};

export class AcmeCertificateManager {
  private readonly entries = new Map<string, CertificateEntry>();
  private readonly pending = new Map<string, Promise<NodeTls.SecureContext>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private accountKey: Promise<Buffer> | undefined;
  private stopped = false;
  accountUri: string | null = null;
  private readonly options: CertificateManagerOptions;
  constructor(options: CertificateManagerOptions) {
    this.options = options;
  }
  getSecureContext(hostname: string): Promise<NodeTls.SecureContext> {
    if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(hostname) || hostname.includes(".."))
      return Promise.reject(new Error("Invalid certificate hostname"));
    const cached = this.entries.get(hostname);
    if (cached && cached.renewAt > Date.now()) return Promise.resolve(cached.context);
    const existing = this.pending.get(hostname);
    if (existing) return existing;
    const result = this.load(hostname)
      .catch((error: unknown) => {
        const valid = this.entries.get(hostname);
        if (!valid || valid.expiresAt <= Date.now()) throw error;
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        this.schedule(hostname, 60_000);
        return valid.context;
      })
      .finally(() => this.pending.delete(hostname));
    this.pending.set(hostname, result);
    return result;
  }
  private async persist(path: string, bytes: string | Buffer): Promise<void> {
    const temporary = `${path}.${NodeCrypto.randomBytes(8).toString("hex")}.tmp`;
    await NodeFSP.writeFile(temporary, bytes, { mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  }
  private async getAccountKey(): Promise<Buffer> {
    const path = NodePath.join(this.options.directory, "account.key");
    const keys = this.options.keys;
    const stored = await keys?.get("account");
    if (stored) return stored;
    try {
      const key = await NodeFSP.readFile(path);
      if (keys) {
        await keys.set("account", key);
        await NodeFSP.rm(path, { force: true });
      }
      return key;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const key = await crypto.createPrivateKey();
      if (keys) await keys.set("account", key);
      else await this.persist(path, key);
      return key;
    }
  }
  private async load(hostname: string): Promise<NodeTls.SecureContext> {
    await NodeFSP.mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    if (!this.accountUri && !this.options.byo) {
      try {
        const stored: unknown = JSON.parse(
          await NodeFSP.readFile(NodePath.join(this.options.directory, "account.json"), "utf8"),
        );
        if (
          stored &&
          typeof stored === "object" &&
          "directoryUrl" in stored &&
          stored.directoryUrl === (this.options.directoryUrl ?? acmeDirectories.production) &&
          "uri" in stored &&
          typeof stored.uri === "string"
        )
          this.accountUri = stored.uri;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    let cert: Buffer | undefined;
    let key: Buffer | undefined;
    const path = NodePath.join(this.options.directory, `${hostname}.json`);
    if (this.options.byo) {
      [cert, key] = await Promise.all([
        NodeFSP.readFile(this.options.byo.cert),
        NodeFSP.readFile(this.options.byo.key),
      ]);
    } else {
      try {
        const stored: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
        if (
          stored &&
          typeof stored === "object" &&
          "cert" in stored &&
          typeof stored.cert === "string"
        ) {
          cert = Buffer.from(stored.cert);
          const fileKey =
            "key" in stored && typeof stored.key === "string" ? Buffer.from(stored.key) : undefined;
          const keys = this.options.keys;
          if (keys && fileKey) {
            // Written by an earlier version; the key moves out of the file.
            await keys.set(`tls-${hostname}`, fileKey);
            await this.persist(path, JSON.stringify({ cert: stored.cert }));
          }
          key = fileKey ?? (await keys?.get(`tls-${hostname}`));
          // A crash between saving a renewed key and its certificate leaves a pair that
          // does not match; issue again instead of failing every handshake.
          if (
            key &&
            !new NodeCrypto.X509Certificate(cert).checkPrivateKey(NodeCrypto.createPrivateKey(key))
          )
            key = undefined;
        } else throw new Error("Invalid stored certificate");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    const renewal = (pem: Buffer): number => {
      const parsed = new NodeCrypto.X509Certificate(pem);
      if (!parsed.checkHost(hostname)) throw new Error("Certificate does not cover hostname");
      const start = Date.parse(parsed.validFrom);
      return start + ((Date.parse(parsed.validTo) - start) * 2) / 3;
    };
    if (
      cert &&
      key &&
      !this.entries.has(hostname) &&
      Date.parse(new NodeCrypto.X509Certificate(cert).validTo) > Date.now()
    ) {
      this.entries.set(hostname, {
        context: NodeTls.createSecureContext({ cert, key, minVersion: "TLSv1.2" }),
        renewAt: renewal(cert),
        expiresAt: Date.parse(new NodeCrypto.X509Certificate(cert).validTo),
        hostname,
      });
    }
    if (!cert || !key || (!this.options.byo && renewal(cert) <= Date.now())) {
      this.accountKey ??= this.getAccountKey();
      const directoryUrl = this.options.directoryUrl ?? acmeDirectories.production;
      const accountPath = NodePath.join(this.options.directory, "account.json");
      try {
        const stored: unknown = JSON.parse(await NodeFSP.readFile(accountPath, "utf8"));
        if (
          stored &&
          typeof stored === "object" &&
          "directoryUrl" in stored &&
          stored.directoryUrl === directoryUrl &&
          "uri" in stored &&
          typeof stored.uri === "string"
        )
          this.accountUri = stored.uri;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const client = new Client({
        directoryUrl,
        accountKey: await this.accountKey,
        ...(this.accountUri ? { accountUrl: this.accountUri } : {}),
      });
      if (!this.accountUri) {
        await client.createAccount({
          termsOfServiceAgreed: true,
          ...(this.options.email ? { contact: [`mailto:${this.options.email}`] } : {}),
        });
        this.accountUri = client.getAccountUrl();
        await this.persist(accountPath, JSON.stringify({ directoryUrl, uri: this.accountUri }));
      }
      const [newKey, csr] = await crypto.createCsr({ commonName: hostname });
      const newCert = await client.auto({
        csr,
        ...(this.options.email ? { email: this.options.email } : {}),
        termsOfServiceAgreed: true,
        challengePriority: ["http-01"],
        challengeCreateFn: async (authz, challenge, authorization) => {
          this.options.challenges.set(authz.identifier.value, challenge.token, authorization);
        },
        challengeRemoveFn: async (authz, challenge) => {
          this.options.challenges.delete(authz.identifier.value, challenge.token);
        },
      });
      cert = Buffer.from(newCert);
      key = newKey;
      if (this.options.keys) {
        await this.options.keys.set(`tls-${hostname}`, key);
        await this.persist(path, JSON.stringify({ cert: cert.toString() }));
      } else {
        await this.persist(path, JSON.stringify({ cert: cert.toString(), key: key.toString() }));
      }
    }
    const context = NodeTls.createSecureContext({ cert, key, minVersion: "TLSv1.2" });
    const renewAt = renewal(cert);
    this.entries.set(hostname, {
      context,
      renewAt,
      expiresAt: Date.parse(new NodeCrypto.X509Certificate(cert).validTo),
      hostname,
    });
    this.schedule(hostname, Math.max(60_000, renewAt - Date.now()));
    return context;
  }
  private schedule(hostname: string, delay: number): void {
    clearTimeout(this.timers.get(hostname));
    if (this.stopped) return;
    const timer = setTimeout(
      () => {
        void this.getSecureContext(hostname).catch((error: unknown) => {
          this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
          this.schedule(hostname, 60_000);
        });
      },
      Math.min(delay, 2_147_483_647),
    );
    timer.unref();
    this.timers.set(hostname, timer);
  }
  close(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
