// Native filesystem, crypto, OS home lookup, and HTTP environment-descriptor probing back tunnel safety checks.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeTls from "node:tls";
import {
  isValidPublicTunnelSlug,
  ProjectId,
  PUBLIC_TUNNEL_AGENT_DEFAULT_EXPIRY_SECONDS,
  PUBLIC_TUNNEL_AGENT_MAX_EXPIRY_SECONDS,
  PUBLIC_TUNNEL_DEFAULT_EXPIRY_SECONDS,
  PUBLIC_TUNNEL_MAX_EXPIRY_SECONDS,
  PUBLIC_TUNNEL_MIN_EXPIRY_SECONDS,
  PUBLIC_TUNNEL_SLUG_MAX_LENGTH,
  PUBLIC_TUNNEL_TITLE_MAX_LENGTH,
  PublicTunnel,
  PublicTunnelAccess,
  PublicTunnelCreatedBy,
  PublicTunnelId,
  PublicTunnelLinkResult,
  PublicTunnelLinkState,
  PublicTunnelListInput,
  PublicTunnelListResult,
  PublicTunnelOperationError,
  PublicTunnelRidMode,
  PublicTunnelRouting,
  PublicTunnelSlug,
  PublicTunnelStatus,
  PublicTunnelStopAllResult,
  PublicTunnelStreamEvent,
  PublicTunnelTarget,
  PublicTunnelUpdateInput,
  PublicTunnelVisitsInput,
  PublicTunnelVisitsResult,
  type AuthSessionId,
  type PublicTunnelCreateInput,
  type PublicTunnelCreateResult,
  type PublicTunnelDecideRequestInput,
  type PublicTunnelRotateResult,
} from "@t3tools/contracts";
import type { StreamLabel } from "@t3tools/relay-tunnel/mux";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectStoreV2 from "../orchestration-v2/ProjectStore.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as SelfRelay from "../selfRelay/SelfRelay.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { createPublicHttpServer, type PublicTunnelRuntimeRecord } from "./publicHttp.ts";
import { validateStaticTarget, type StaticFileIdentity } from "./staticFiles.ts";
import { makeVisitLog } from "./visitLog.ts";

const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const LINK_HMAC_KEY_NAME = "public-tunnel-link-key";
const ENV_DESCRIPTOR_PATHS = ["/.well-known/p0/environment", "/.well-known/t3/environment"];
const PORT_PROBE_TIMEOUT_MS = 500;

interface PublicTunnelRow {
  readonly id: string;
  readonly title: string;
  readonly target_kind: string;
  readonly target_json: string;
  readonly routing: string;
  readonly slug: string;
  readonly rid: string | null;
  readonly rid_mode: string;
  readonly access: string;
  readonly status: string;
  readonly expires_at: number | null;
  readonly created_at: number;
  readonly created_by_json: string;
  readonly project_id: string | null;
  readonly thread_id: string | null;
  readonly target_dev: string | null;
  readonly target_ino: string | null;
  readonly host_label: string;
  readonly link_secret_id: string | null;
  readonly visit_count: number;
  readonly last_visit_at: number | null;
  readonly bytes_out: number;
}

interface RuntimeTunnelEntry {
  readonly tunnel: PublicTunnel;
  readonly hostLabel: string;
  readonly linkSecretId: string | null;
  readonly pinnedIdentity?: StaticFileIdentity;
}

const decodeTargetJson = Schema.decodeUnknownSync(Schema.fromJsonString(PublicTunnelTarget));
const encodeTargetJson = Schema.encodeSync(Schema.fromJsonString(PublicTunnelTarget));
const decodeCreatedByJson = Schema.decodeUnknownSync(Schema.fromJsonString(PublicTunnelCreatedBy));
const encodeCreatedByJson = Schema.encodeSync(Schema.fromJsonString(PublicTunnelCreatedBy));
const isPublicTunnelError = Schema.is(PublicTunnelOperationError);

function randomCrockford(length: number): string {
  const bytes = NodeCrypto.randomBytes(length);
  let output = "";
  for (let index = 0; index < length; index++) {
    output += CROCKFORD_ALPHABET[bytes[index]! % CROCKFORD_ALPHABET.length];
  }
  return output;
}

function slugFromTitle(title: string | undefined): PublicTunnelSlug {
  const normalized = (title ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, PUBLIC_TUNNEL_SLUG_MAX_LENGTH)
    .replaceAll(/-+$/g, "");
  if (isValidPublicTunnelSlug(normalized)) {
    return normalized as PublicTunnelSlug;
  }
  return `tunnel-${randomCrockford(4)}` as PublicTunnelSlug;
}

function defaultTitleForTarget(target: PublicTunnelTarget): string {
  switch (target.kind) {
    case "port":
      return `Port ${target.port}`;
    case "file":
      return (NodePath.basename(target.path) || "File").slice(0, PUBLIC_TUNNEL_TITLE_MAX_LENGTH);
    case "folder":
      return (NodePath.basename(target.path) || "Folder").slice(0, PUBLIC_TUNNEL_TITLE_MAX_LENGTH);
  }
}

function isWithinCanonicalDir(candidate: string, root: string): boolean {
  const normalizedRoot = root.endsWith(NodePath.sep)
    ? root.slice(0, -NodePath.sep.length) || NodePath.sep
    : root;
  if (normalizedRoot === NodePath.sep) return candidate.startsWith(NodePath.sep);
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}${NodePath.sep}`);
}

function fail(
  reason: PublicTunnelOperationError["reason"],
  message: string,
): PublicTunnelOperationError {
  return new PublicTunnelOperationError({ reason, message });
}

function probeDescriptorOnHost(host: string, port: number, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (match: boolean) => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve(match);
    };
    const req = NodeHttp.request(
      {
        host,
        port,
        path,
        method: "GET",
        headers: { accept: "application/json", connection: "close" },
        timeout: PORT_PROBE_TIMEOUT_MS,
      },
      (response) => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          done(false);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total <= 16_384) chunks.push(chunk);
        });
        response.once("end", () => {
          try {
            const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const looksLikeEnv =
              typeof parsed === "object" &&
              parsed !== null &&
              "environmentId" in parsed &&
              typeof parsed.environmentId === "string";
            done(looksLikeEnv);
          } catch {
            done(false);
          }
        });
        response.on("error", () => done(false));
      },
    );
    req.on("timeout", () => done(false));
    req.on("error", () => done(false));
    req.end();
  });
}

async function probeOwnEnvironmentDescriptor(port: number): Promise<boolean> {
  for (const host of ["127.0.0.1", "::1"]) {
    for (const descriptorPath of ENV_DESCRIPTOR_PATHS) {
      if (await probeDescriptorOnHost(host, port, descriptorPath)) {
        return true;
      }
    }
  }
  return false;
}

export class PublicTunnels extends Context.Service<
  PublicTunnels,
  {
    readonly list: (
      input?: PublicTunnelListInput,
    ) => Effect.Effect<PublicTunnelListResult, PublicTunnelOperationError>;
    readonly get: (id: PublicTunnelId) => Effect.Effect<PublicTunnel, PublicTunnelOperationError>;
    readonly create: (
      input: PublicTunnelCreateInput,
      caller: PublicTunnelCreateOptions["caller"],
      options?: Omit<PublicTunnelCreateOptions, "caller">,
    ) => Effect.Effect<PublicTunnelCreateResult, PublicTunnelOperationError>;
    readonly update: (
      input: PublicTunnelUpdateInput,
    ) => Effect.Effect<PublicTunnel, PublicTunnelOperationError>;
    readonly rotate: (
      id: PublicTunnelId,
    ) => Effect.Effect<PublicTunnelRotateResult, PublicTunnelOperationError>;
    readonly remove: (id: PublicTunnelId) => Effect.Effect<void, PublicTunnelOperationError>;
    readonly stopAll: () => Effect.Effect<PublicTunnelStopAllResult, PublicTunnelOperationError>;
    readonly visits: (
      input: PublicTunnelVisitsInput,
    ) => Effect.Effect<PublicTunnelVisitsResult, PublicTunnelOperationError>;
    readonly link: (
      id: PublicTunnelId,
    ) => Effect.Effect<PublicTunnelLinkResult, PublicTunnelOperationError>;
    readonly decideRequest: (
      input: PublicTunnelDecideRequestInput,
      approverSessionId: AuthSessionId,
    ) => Effect.Effect<PublicTunnel, PublicTunnelOperationError>;
    /** An agent's path, resolved as `create` will, and whether it names a file or a folder. */
    readonly resolveAgentPath: (
      path: string,
      scope: { readonly projectId: ProjectId; readonly workingDir: string | null },
    ) => Effect.Effect<
      { readonly kind: "file" | "folder"; readonly path: string },
      PublicTunnelOperationError
    >;
    readonly linkState: Effect.Effect<PublicTunnelLinkState>;
    readonly changes: Stream.Stream<PublicTunnelStreamEvent>;
    readonly allowName: (name: string) => boolean;
    readonly activeNames: () => ReadonlyArray<string>;
    readonly accept: (socket: NodeTls.TLSSocket, metadata: StreamLabel) => void;
    readonly closeSockets: () => void;
    readonly registerServerPort: (port: number) => void;
  }
>()("p0/tunnels/PublicTunnels") {}

export interface PublicTunnelCreateOptions {
  readonly caller: PublicTunnelCreatedBy;
  readonly requireApproval?: boolean;
  readonly scopeProjectId?: ProjectId | null;
  /**
   * Agent callers: the thread's worktree. Relative file/folder paths resolve against it (or the
   * project's workspace root without one), and it counts as part of the project's scope.
   */
  readonly workingDir?: string | null;
}

/** An agent's request nobody answers in this long is denied, so it never lingers as pending. */
const PUBLIC_TUNNEL_REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selfRelay = yield* SelfRelay.SelfRelay;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const policy = yield* ManagedPolicy.ManagedPolicy;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const config = yield* ServerConfig.ServerConfig;
  const clock = yield* Clock.Clock;
  const maybeProjectStore = yield* Effect.serviceOption(ProjectStoreV2.ProjectStoreV2);

  const policyAllowed = ManagedLimits.allowsPublicTunnels(policy);
  const deniedRoots = {
    stateDir: config.stateDir,
    secretsDir: config.secretsDir,
    homeDir: NodeOS.homedir(),
  };

  const lock = Semaphore.makeUnsafe(1);
  const changesPubSub = yield* PubSub.unbounded<PublicTunnelStreamEvent>();
  const rescheduleQueue = yield* Queue.unbounded<void>();
  const knownOwnPorts = new Set<number>(config.port > 0 ? [config.port] : []);
  const runtimeEntries = new Map<PublicTunnelId, RuntimeTunnelEntry>();
  const lastVisitPublishAt = new Map<PublicTunnelId, number>();

  const linkHmacKey = yield* secrets.getOrCreateRandom(LINK_HMAC_KEY_NAME, 32);

  let settingEnabled = (yield* serverSettings.getSettings).publicTunnels.enabled;
  let relayState: SelfRelay.SelfRelayPublicState = {
    linked: false,
    connected: false,
    slug: null,
    relayUrl: null,
    publicHosts: false,
    publicDomain: null,
  };

  const nowMs = () => clock.currentTimeMillisUnsafe();

  const resolvePublicBaseDomain = (): string | null => {
    if (relayState.publicDomain) return relayState.publicDomain;
    if (!relayState.relayUrl) return null;
    try {
      return new URL(relayState.relayUrl).hostname;
    } catch {
      return null;
    }
  };

  const resolvePublicOrigin = (): string | null => {
    if (!policyAllowed || !relayState.linked || !relayState.slug) return null;
    const baseDomain = resolvePublicBaseDomain();
    return baseDomain ? `https://pub-${relayState.slug}.${baseDomain}` : null;
  };

  const computeLinkState = (): PublicTunnelLinkState => {
    const publicOrigin = resolvePublicOrigin();
    let availability: PublicTunnelLinkState["availability"] = "ready";
    if (!policyAllowed) availability = "policy";
    else if (!settingEnabled) availability = "setting_off";
    else if (!relayState.linked) availability = "relay_unlinked";
    else if (!relayState.publicHosts) availability = "relay_no_public_hosts";
    return {
      linked: relayState.linked,
      connected: relayState.connected,
      publicHosts: relayState.publicHosts,
      publicDomain: relayState.publicDomain,
      publicOrigin,
      availability,
    };
  };

  const buildPublicUrl = (row: {
    readonly routing: string;
    readonly slug: string;
    readonly rid: string | null;
    readonly status: string;
  }): string | null => {
    // A pending request carries the URL it would get, so the person approving sees the hostname.
    if (row.status !== "live" && row.status !== "paused" && row.status !== "pending_approval") {
      return null;
    }
    if (!policyAllowed || !relayState.linked || !relayState.slug) return null;
    const domain = resolvePublicBaseDomain();
    if (!domain) return null;
    if (row.routing === "subdomain") {
      return `https://${row.slug}-${relayState.slug}.${domain}/`;
    }
    if (!row.rid) return null;
    return `https://pub-${relayState.slug}.${domain}/${row.slug}/${row.rid}/`;
  };

  const rowToTunnel = (row: PublicTunnelRow): PublicTunnel => {
    const target = decodeTargetJson(row.target_json);
    const routing = row.routing as PublicTunnelRouting;
    const access = row.access as PublicTunnelAccess;
    const status = row.status as PublicTunnelStatus;
    const createdBy = decodeCreatedByJson(row.created_by_json);
    return {
      id: row.id as PublicTunnelId,
      title: row.title,
      target,
      routing,
      slug: row.slug as PublicTunnelSlug,
      rid: row.rid,
      ...(routing === "path" ? { ridMode: row.rid_mode as PublicTunnelRidMode } : {}),
      access,
      url: buildPublicUrl(row),
      status,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      createdBy,
      projectId: row.project_id as ProjectId | null,
      visits: {
        count: Math.max(0, row.visit_count),
        lastAt: row.last_visit_at,
        bytesOut: Math.max(0, row.bytes_out),
      },
    };
  };

  const signLinkToken = (entry: RuntimeTunnelEntry): string | null => {
    if (!entry.linkSecretId) return null;
    const payload = Buffer.from(
      JSON.stringify({
        tid: entry.tunnel.id,
        sid: entry.linkSecretId,
        exp: entry.tunnel.expiresAt,
      }),
      "utf8",
    ).toString("base64url");
    const sig = NodeCrypto.createHmac("sha256", linkHmacKey)
      .update(`public-tunnel-v1:${payload}`)
      .digest("base64url");
    return `${payload}.${sig}`;
  };

  const validateLinkToken = (tunnelId: PublicTunnelId, token: string): boolean => {
    const entry = runtimeEntries.get(tunnelId);
    if (!entry || entry.tunnel.status !== "live" || !entry.linkSecretId) return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const [payload, signature] = parts;
    if (!payload || !signature) return false;
    const expected = NodeCrypto.createHmac("sha256", linkHmacKey)
      .update(`public-tunnel-v1:${payload}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      return false;
    }
    if (actual.length !== expected.length || !NodeCrypto.timingSafeEqual(actual, expected)) {
      return false;
    }
    try {
      const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (typeof claims !== "object" || claims === null) return false;
      const tid = "tid" in claims ? claims.tid : undefined;
      const sid = "sid" in claims ? claims.sid : undefined;
      const exp = "exp" in claims ? claims.exp : undefined;
      if (tid !== tunnelId || sid !== entry.linkSecretId) return false;
      if (exp !== null && typeof exp === "number" && exp <= nowMs()) return false;
      if (entry.tunnel.expiresAt !== null && entry.tunnel.expiresAt <= nowMs()) return false;
      return true;
    } catch {
      return false;
    }
  };

  const findLiveEntry = (
    predicate: (entry: RuntimeTunnelEntry) => boolean,
  ): PublicTunnelRuntimeRecord | null => {
    for (const entry of runtimeEntries.values()) {
      if (predicate(entry)) {
        return {
          tunnel: entry.tunnel,
          ...(entry.pinnedIdentity ? { pinnedIdentity: entry.pinnedIdentity } : {}),
        };
      }
    }
    return null;
  };

  let httpServer: ReturnType<typeof createPublicHttpServer>;

  const visitLog = yield* makeVisitLog({
    onFlushed: Effect.fn("PublicTunnels.onVisitsFlushed")(function* (tunnelIds) {
      const currentNow = nowMs();
      yield* Effect.gen(function* () {
        for (const tunnelId of tunnelIds) {
          const prevPublish = lastVisitPublishAt.get(tunnelId) ?? 0;
          if (currentNow - prevPublish < 1_000) continue;
          const rows = yield* sql<PublicTunnelRow>`
            SELECT * FROM public_tunnels WHERE id = ${tunnelId}
          `;
          const row = rows[0];
          if (!row) continue;
          const tunnel = rowToTunnel(row);
          const existing = runtimeEntries.get(tunnelId);
          if (existing) {
            runtimeEntries.set(tunnelId, { ...existing, tunnel });
          }
          lastVisitPublishAt.set(tunnelId, currentNow);
          yield* PubSub.publish(changesPubSub, { version: 1, type: "upserted", tunnel });
        }
      }).pipe(Effect.ignoreCause({ log: true }));
    }),
  });

  httpServer = createPublicHttpServer({
    now: nowMs,
    ownPorts: () => knownOwnPorts,
    resolveExpectedHost: (sniName) => {
      if (!relayState.slug) return null;
      const domain = resolvePublicBaseDomain();
      if (!domain) return null;
      return `${sniName}-${relayState.slug}.${domain}`;
    },
    resolvePathTunnel: (slug, rid) =>
      findLiveEntry(
        (entry) =>
          entry.tunnel.routing === "path" && entry.tunnel.slug === slug && entry.tunnel.rid === rid,
      ),
    resolveSubdomainTunnel: (slug) =>
      findLiveEntry((entry) => entry.tunnel.routing === "subdomain" && entry.tunnel.slug === slug),
    isGloballyAllowed: () => policyAllowed && settingEnabled && relayState.publicHosts,
    validateLinkToken,
    recordVisit: (visit) => visitLog.record(visit),
  });

  const disarmRuntime = (tunnelId: PublicTunnelId) => {
    runtimeEntries.delete(tunnelId);
    httpServer.revokeTunnel(tunnelId);
  };

  const syncRuntimeFromRow = (row: PublicTunnelRow): PublicTunnel => {
    const tunnel = rowToTunnel(row);
    const id = tunnel.id;
    if (policyAllowed && settingEnabled && tunnel.status === "live") {
      if (tunnel.expiresAt !== null && tunnel.expiresAt <= nowMs()) {
        runtimeEntries.delete(id);
        httpServer.revokeTunnel(id);
        Queue.offerUnsafe(rescheduleQueue, undefined);
        return tunnel;
      }
      const pinnedIdentity =
        row.target_dev && row.target_ino ? { dev: row.target_dev, ino: row.target_ino } : undefined;
      runtimeEntries.set(id, {
        tunnel,
        hostLabel: row.host_label,
        linkSecretId: row.link_secret_id,
        ...(pinnedIdentity ? { pinnedIdentity } : {}),
      });
      if (tunnel.expiresAt !== null) {
        Queue.offerUnsafe(rescheduleQueue, undefined);
      }
    } else {
      runtimeEntries.delete(id);
      httpServer.revokeTunnel(id);
    }
    return tunnel;
  };

  const expireRowIfDue = Effect.fn("PublicTunnels.expireRowIfDue")(function* (
    row: PublicTunnelRow,
  ) {
    const currentNow = nowMs();
    if (
      row.status === "pending_approval" &&
      row.created_at <= currentNow - PUBLIC_TUNNEL_REQUEST_TIMEOUT_MS
    ) {
      yield* sql`
        UPDATE public_tunnels SET status = 'denied'
        WHERE id = ${row.id} AND status = 'pending_approval'
      `;
      return { ...row, status: "denied" };
    }
    if (row.status === "live" && row.expires_at !== null && row.expires_at <= currentNow) {
      yield* sql`
        UPDATE public_tunnels SET status = 'expired'
        WHERE id = ${row.id} AND status = 'live'
      `;
      const updated = { ...row, status: "expired" };
      disarmRuntime(row.id as PublicTunnelId);
      return updated;
    }
    return row;
  });

  const expireDueRows = Effect.fn("PublicTunnels.expireDueRows")(function* () {
    const currentNow = nowMs();
    const timedOut = yield* sql<PublicTunnelRow>`
      SELECT * FROM public_tunnels
      WHERE status = 'pending_approval' AND created_at <= ${currentNow - PUBLIC_TUNNEL_REQUEST_TIMEOUT_MS}
    `;
    if (timedOut.length > 0) {
      yield* sql`
        UPDATE public_tunnels SET status = 'denied'
        WHERE status = 'pending_approval'
          AND created_at <= ${currentNow - PUBLIC_TUNNEL_REQUEST_TIMEOUT_MS}
      `;
      for (const row of timedOut) {
        yield* PubSub.publish(changesPubSub, {
          version: 1,
          type: "upserted",
          tunnel: rowToTunnel({ ...row, status: "denied" }),
        });
      }
    }
    const expired = yield* sql<PublicTunnelRow>`
      SELECT * FROM public_tunnels
      WHERE status = 'live' AND expires_at IS NOT NULL AND expires_at <= ${currentNow}
    `;
    if (expired.length === 0) return;
    yield* sql`
      UPDATE public_tunnels
      SET status = 'expired'
      WHERE status = 'live' AND expires_at IS NOT NULL AND expires_at <= ${currentNow}
    `;
    for (const row of expired) {
      const updated = { ...row, status: "expired" };
      disarmRuntime(row.id as PublicTunnelId);
      yield* PubSub.publish(changesPubSub, {
        version: 1,
        type: "upserted",
        tunnel: rowToTunnel(updated),
      });
    }
  });

  const hydrateFromDb = Effect.fn("PublicTunnels.hydrateFromDb")(function* () {
    yield* expireDueRows();
    const rows = yield* sql<PublicTunnelRow>`
      SELECT * FROM public_tunnels WHERE status = 'live'
    `;
    for (const row of rows) {
      const target = decodeTargetJson(row.target_json);
      if (target.kind === "port" && knownOwnPorts.has(target.port)) {
        yield* sql`UPDATE public_tunnels SET status = 'paused' WHERE id = ${row.id}`;
        continue;
      }
      syncRuntimeFromRow(row);
    }
  });

  yield* hydrateFromDb();

  // Single Effect-clock-aware scheduler for tunnel expiration; closes sockets and marks rows expired.
  yield* Effect.gen(function* () {
    let soonestExpiresAt: number | null = null;
    for (const entry of runtimeEntries.values()) {
      if (entry.tunnel.expiresAt !== null) {
        soonestExpiresAt =
          soonestExpiresAt === null
            ? entry.tunnel.expiresAt
            : Math.min(soonestExpiresAt, entry.tunnel.expiresAt);
      }
    }
    if (soonestExpiresAt === null) {
      yield* Queue.take(rescheduleQueue);
    } else {
      const remaining = Math.max(0, soonestExpiresAt - nowMs());
      if (remaining > 0) {
        yield* Effect.raceFirst(
          Effect.sleep(Duration.millis(remaining)),
          Queue.take(rescheduleQueue),
        );
      }
      yield* expireDueRows().pipe(lock.withPermits(1));
    }
  }).pipe(Effect.ignoreCause, Effect.forever, Effect.forkScoped);

  // Immediately close all active public sockets when the global setting turns off.
  const settingsStream = yield* serverSettings.subscribeChanges;
  yield* settingsStream.pipe(
    Stream.runForEach((next) =>
      Effect.sync(() => {
        const nextEnabled = next.publicTunnels.enabled;
        if (settingEnabled && !nextEnabled) {
          settingEnabled = false;
          httpServer.revokeAll();
        } else {
          settingEnabled = nextEnabled;
        }
      }).pipe(Effect.andThen(hydrateFromDb().pipe(lock.withPermits(1), Effect.ignore))),
    ),
    Effect.forkScoped,
  );

  const allowName = (name: string): boolean => {
    if (!policyAllowed || !settingEnabled) return false;
    const currentNow = nowMs();
    for (const entry of runtimeEntries.values()) {
      if (entry.tunnel.status !== "live") continue;
      if (entry.tunnel.expiresAt !== null && entry.tunnel.expiresAt <= currentNow) continue;
      if (entry.hostLabel === name) return true;
    }
    return false;
  };

  const activeNames = (): ReadonlyArray<string> => {
    if (!policyAllowed || !settingEnabled) return [];
    const currentNow = nowMs();
    const names = new Set<string>();
    for (const entry of runtimeEntries.values()) {
      if (entry.tunnel.status !== "live") continue;
      if (entry.tunnel.expiresAt !== null && entry.tunnel.expiresAt <= currentNow) continue;
      names.add(entry.hostLabel);
    }
    return Array.from(names);
  };

  const closeSockets = () => {
    httpServer.revokeAll();
  };

  yield* selfRelay.attachPublicTunnels({
    allowName,
    activeNames,
    accept: (socket: NodeTls.TLSSocket, metadata: StreamLabel) =>
      httpServer.accept(socket, metadata),
    closeSockets,
    onStateChange: (nextRelay) => {
      relayState = nextRelay;
    },
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      runtimeEntries.clear();
      httpServer.close();
    }),
  );

  const assertPortAllowed = Effect.fn("PublicTunnels.assertPortAllowed")(function* (port: number) {
    if (knownOwnPorts.has(port)) {
      return yield* fail("port_refused", "Refusing to publish p0code's own server port.");
    }
    const isOwnDescriptor = yield* Effect.tryPromise({
      try: () => probeOwnEnvironmentDescriptor(port),
      catch: () => fail("internal", "Port descriptor check failed."),
    });
    if (isOwnDescriptor) {
      return yield* fail("port_refused", "Refusing to publish a p0code environment server.");
    }
  });

  const validateAgentProjectScope = Effect.fn("PublicTunnels.validateAgentProjectScope")(function* (
    projectId: ProjectId | null,
    target: PublicTunnelTarget,
    workingDir: string | null,
  ) {
    if (!projectId) {
      return yield* fail(
        "scope_refused",
        "Agent-published tunnels must belong to an active project.",
      );
    }
    if (Option.isNone(maybeProjectStore)) {
      return yield* fail(
        "scope_refused",
        "Project store unavailable to verify agent tunnel scope.",
      );
    }
    const projectOpt = yield* maybeProjectStore.value
      .get(projectId)
      .pipe(Effect.mapError(() => fail("internal", "Could not inspect project scope.")));
    if (Option.isNone(projectOpt)) {
      return yield* fail("scope_refused", "Unknown project for agent-published tunnel.");
    }
    if (target.kind === "port") {
      return target;
    }
    const project = projectOpt.value;
    const allowedRootsRaw = [
      project.workspaceRoot,
      ...project.trackedFolders.map((folder) => folder.path),
      ...(workingDir ? [workingDir] : []),
    ];
    const allowedRoots = yield* Effect.tryPromise({
      try: () =>
        Promise.all(
          allowedRootsRaw.map(async (root) => {
            const resolved = NodePath.resolve(root);
            let real = resolved;
            try {
              real = await NodeFSP.realpath(resolved);
            } catch {
              real = resolved;
            }
            return { resolved, real };
          }),
        ),
      catch: () => fail("internal", "Could not resolve project workspace roots."),
    });

    const resolvedTarget = NodePath.resolve(workingDir ?? project.workspaceRoot, target.path);
    const realTarget = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(resolvedTarget),
      catch: () => fail("invalid_input", "Target path does not exist."),
    });
    const inProject = allowedRoots.some(
      (root) =>
        (isWithinCanonicalDir(resolvedTarget, root.resolved) ||
          isWithinCanonicalDir(resolvedTarget, root.real)) &&
        isWithinCanonicalDir(realTarget, root.real),
    );
    if (!inProject) {
      return yield* fail(
        "scope_refused",
        "Agent-published files and folders must stay within the project workspace.",
      );
    }
    return { ...target, path: resolvedTarget };
  });

  const resolveAgentPath = Effect.fn("PublicTunnels.resolveAgentPath")(function* (
    path: string,
    scope: { readonly projectId: ProjectId; readonly workingDir: string | null },
  ) {
    let base = scope.workingDir;
    if (base === null && Option.isSome(maybeProjectStore)) {
      const project = yield* maybeProjectStore.value
        .get(scope.projectId)
        .pipe(Effect.mapError(() => fail("internal", "Could not inspect project scope.")));
      if (Option.isSome(project)) base = project.value.workspaceRoot;
    }
    if (base === null) {
      return yield* fail("scope_refused", "Unknown project for agent-published tunnel.");
    }
    const resolved = NodePath.resolve(base, path);
    const stat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(resolved),
      catch: () => fail("invalid_input", `Target path does not exist: ${path}`),
    });
    return { kind: stat.isDirectory() ? ("folder" as const) : ("file" as const), path: resolved };
  });

  const validateTargetAndPin = Effect.fn("PublicTunnels.validateTargetAndPin")(function* (
    target: PublicTunnelTarget,
  ) {
    if (target.kind === "port") {
      yield* assertPortAllowed(target.port);
      return {
        normalizedTarget: target,
        identity: undefined as StaticFileIdentity | undefined,
      };
    }
    const validation = yield* Effect.tryPromise({
      try: () => validateStaticTarget(target, deniedRoots),
      catch: () => fail("internal", "Failed to validate target path."),
    });
    if (!validation.ok) {
      return yield* fail(
        validation.reason === "denied" ? "path_refused" : "invalid_input",
        validation.message,
      );
    }
    const normalizedTarget: PublicTunnelTarget =
      target.kind === "file"
        ? { ...target, path: validation.canonicalPath }
        : { ...target, path: validation.canonicalPath };
    return {
      normalizedTarget,
      identity: validation.identity,
    };
  });

  const requireReadyToPublish = Effect.fn("PublicTunnels.requireReadyToPublish")(function* () {
    if (!policyAllowed) {
      return yield* fail("policy", ManagedLimits.refusePublicTunnels(policy).message);
    }
    const currentSettings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => fail("internal", "Could not read server settings.")),
    );
    settingEnabled = currentSettings.publicTunnels.enabled;
    if (!settingEnabled) {
      return yield* fail("disabled", "Public tunnels are disabled in server settings.");
    }
    if (!relayState.linked) {
      return yield* fail("relay_unlinked", "Link this environment to a self-hosted relay first.");
    }
    if (relayState.connected && !relayState.publicHosts) {
      return yield* fail(
        "relay_unsupported",
        "The connected relay does not advertise public host support (--public-hosts).",
      );
    }
    return currentSettings.publicTunnels;
  });

  const resolveOrAllocateProjectRid = Effect.fn("PublicTunnels.resolveOrAllocateProjectRid")(
    function* (projectId: ProjectId) {
      const existing = yield* sql<{ readonly rid: string }>`
        SELECT rid FROM public_tunnel_project_rids WHERE project_id = ${projectId}
      `;
      if (existing[0]) return existing[0].rid;
      const fresh = randomCrockford(10);
      yield* sql`
        INSERT INTO public_tunnel_project_rids (project_id, rid)
        VALUES (${projectId}, ${fresh})
        ON CONFLICT (project_id) DO NOTHING
      `;
      const reread = yield* sql<{ readonly rid: string }>`
        SELECT rid FROM public_tunnel_project_rids WHERE project_id = ${projectId}
      `;
      return reread[0]?.rid ?? fresh;
    },
  );

  const list = Effect.fn("PublicTunnels.list")(function* (input?: PublicTunnelListInput) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* expireDueRows();
          const currentSettings = yield* serverSettings.getSettings.pipe(
            Effect.orElseSucceed(() => null),
          );
          if (currentSettings) settingEnabled = currentSettings.publicTunnels.enabled;

          const rows = input?.threadId
            ? yield* sql<PublicTunnelRow>`
                SELECT * FROM public_tunnels WHERE thread_id = ${input.threadId}
                ORDER BY created_at DESC, id ASC
              `
            : input?.projectId
              ? yield* sql<PublicTunnelRow>`
                  SELECT * FROM public_tunnels WHERE project_id = ${input.projectId}
                  ORDER BY created_at DESC, id ASC
                `
              : yield* sql<PublicTunnelRow>`
                  SELECT * FROM public_tunnels
                  ORDER BY created_at DESC, id ASC
                `;

          return {
            tunnels: rows.map(rowToTunnel),
            linkState: computeLinkState(),
          } satisfies PublicTunnelListResult;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPublicTunnelError(error) ? error : fail("internal", "Could not list public tunnels."),
        ),
      );
  });

  const get = Effect.fn("PublicTunnels.get")(function* (id: PublicTunnelId) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const rows = yield* sql<PublicTunnelRow>`
            SELECT * FROM public_tunnels WHERE id = ${id}
          `;
          const raw = rows[0];
          if (!raw) return yield* fail("not_found", `Tunnel ${id} not found.`);
          const row = yield* expireRowIfDue(raw);
          return rowToTunnel(row);
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPublicTunnelError(error) ? error : fail("internal", "Could not load tunnel."),
        ),
      );
  });

  const create = Effect.fn("PublicTunnels.create")(function* (
    input: PublicTunnelCreateInput,
    caller: PublicTunnelCreateOptions["caller"],
    options?: Omit<PublicTunnelCreateOptions, "caller">,
  ) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const settings = yield* requireReadyToPublish();
          yield* expireDueRows();

          const projectId =
            caller.kind === "agent"
              ? (options?.scopeProjectId ?? caller.projectId ?? input.projectId ?? null)
              : (input.projectId ?? null);
          const threadId = caller.kind === "agent" ? caller.threadId : null;

          const target =
            caller.kind === "agent"
              ? yield* validateAgentProjectScope(
                  projectId,
                  input.target,
                  options?.workingDir ?? null,
                )
              : input.target;

          const { normalizedTarget, identity } = yield* validateTargetAndPin(target);

          const routing = input.routing ?? "path";
          const access = input.access ?? "public";
          const currentNow = nowMs();

          let expiresAt: number | null;
          if (caller.kind === "agent") {
            if (input.expiresInSeconds === null) {
              return yield* fail(
                "invalid_input",
                "Agent-published tunnels cannot be permanent; max lifetime is 24 hours.",
              );
            }
            const seconds = input.expiresInSeconds ?? PUBLIC_TUNNEL_AGENT_DEFAULT_EXPIRY_SECONDS;
            if (
              seconds < PUBLIC_TUNNEL_MIN_EXPIRY_SECONDS ||
              seconds > PUBLIC_TUNNEL_AGENT_MAX_EXPIRY_SECONDS
            ) {
              return yield* fail(
                "invalid_input",
                `Agent tunnel expiry must be between ${PUBLIC_TUNNEL_MIN_EXPIRY_SECONDS} and ${PUBLIC_TUNNEL_AGENT_MAX_EXPIRY_SECONDS} seconds.`,
              );
            }
            expiresAt = currentNow + seconds * 1000;
          } else {
            const rawExpiry =
              input.expiresInSeconds === undefined
                ? settings.defaultExpirySeconds
                : input.expiresInSeconds;
            if (rawExpiry === null) {
              expiresAt = null;
            } else {
              if (
                rawExpiry < PUBLIC_TUNNEL_MIN_EXPIRY_SECONDS ||
                rawExpiry > PUBLIC_TUNNEL_MAX_EXPIRY_SECONDS
              ) {
                return yield* fail(
                  "invalid_input",
                  `Tunnel expiry must be between ${PUBLIC_TUNNEL_MIN_EXPIRY_SECONDS} and ${PUBLIC_TUNNEL_MAX_EXPIRY_SECONDS} seconds.`,
                );
              }
              expiresAt = currentNow + rawExpiry * 1000;
            }
          }

          const explicitSlug = input.slug;
          if (explicitSlug !== undefined && !isValidPublicTunnelSlug(explicitSlug)) {
            return yield* fail("invalid_input", `Slug "${explicitSlug}" is invalid or reserved.`);
          }
          let slug = explicitSlug ?? slugFromTitle(input.title);

          let rid: string | null = null;
          let ridMode: PublicTunnelRidMode = "tunnel";
          if (routing === "path") {
            ridMode = input.ridMode ?? "tunnel";
            if (ridMode === "project" && projectId !== null) {
              rid = yield* resolveOrAllocateProjectRid(projectId);
            } else {
              ridMode = "tunnel";
              rid = randomCrockford(10);
            }
            const existingPath = yield* sql<{ readonly id: string }>`
              SELECT id FROM public_tunnels
              WHERE routing = 'path' AND slug = ${slug} AND rid = ${rid}
                AND status IN ('pending_approval', 'live', 'paused')
            `;
            if (existingPath.length > 0) {
              if (explicitSlug !== undefined) {
                return yield* fail(
                  "conflict",
                  `An active path tunnel already uses slug "${slug}" with that project id.`,
                );
              }
              slug =
                `${slug.slice(0, PUBLIC_TUNNEL_SLUG_MAX_LENGTH - 5)}-${randomCrockford(4)}`.replaceAll(
                  /^-+/g,
                  "t-",
                ) as PublicTunnelSlug;
            }
          } else {
            const existingSub = yield* sql<{ readonly id: string }>`
              SELECT id FROM public_tunnels
              WHERE routing = 'subdomain' AND slug = ${slug}
                AND status IN ('pending_approval', 'live', 'paused')
            `;
            if (existingSub.length > 0) {
              return yield* fail(
                "conflict",
                `Subdomain slug "${slug}" is already in use by an active tunnel.`,
              );
            }
          }

          const id = NodeCrypto.randomUUID() as PublicTunnelId;
          const status: PublicTunnelStatus = options?.requireApproval ? "pending_approval" : "live";
          const title = (input.title ?? defaultTitleForTarget(normalizedTarget)).slice(
            0,
            PUBLIC_TUNNEL_TITLE_MAX_LENGTH,
          );
          const hostLabel = routing === "path" ? "pub" : slug;
          const linkSecretId = access === "link" ? randomCrockford(12) : null;

          const row: PublicTunnelRow = {
            id,
            title,
            target_kind: normalizedTarget.kind,
            target_json: encodeTargetJson(normalizedTarget),
            routing,
            slug,
            rid,
            rid_mode: ridMode,
            access,
            status,
            expires_at: expiresAt,
            created_at: currentNow,
            created_by_json: encodeCreatedByJson(caller),
            project_id: projectId,
            thread_id: threadId,
            target_dev: identity?.dev ?? null,
            target_ino: identity?.ino ?? null,
            host_label: hostLabel,
            link_secret_id: linkSecretId,
            visit_count: 0,
            last_visit_at: null,
            bytes_out: 0,
          };

          yield* sql`
            INSERT INTO public_tunnels (
              id, title, target_kind, target_json, routing, slug, rid, rid_mode,
              access, status, expires_at, created_at, created_by_json,
              project_id, thread_id, target_dev, target_ino, host_label, link_secret_id,
              visit_count, last_visit_at, bytes_out
            ) VALUES (
              ${row.id}, ${row.title}, ${row.target_kind}, ${row.target_json},
              ${row.routing}, ${row.slug}, ${row.rid}, ${row.rid_mode},
              ${row.access}, ${row.status}, ${row.expires_at}, ${row.created_at},
              ${row.created_by_json}, ${row.project_id}, ${row.thread_id},
              ${row.target_dev}, ${row.target_ino}, ${row.host_label}, ${row.link_secret_id},
              0, NULL, 0
            )
          `;

          const tunnel = syncRuntimeFromRow(row);
          yield* PubSub.publish(changesPubSub, { version: 1, type: "upserted", tunnel });

          const runtime = runtimeEntries.get(id);
          const token = access === "link" && runtime ? signLinkToken(runtime) : null;
          const accessUrl = tunnel.url && token ? `${tunnel.url}?t=${token}` : tunnel.url;

          return {
            tunnel,
            accessUrl,
          } satisfies PublicTunnelCreateResult;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPublicTunnelError(error) ? error : fail("internal", "Could not create public tunnel."),
        ),
      );
  });

  const update = Effect.fn("PublicTunnels.update")(function* (input: PublicTunnelUpdateInput) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const rows = yield* sql<PublicTunnelRow>`
            SELECT * FROM public_tunnels WHERE id = ${input.id}
          `;
          const raw = rows[0];
          if (!raw) return yield* fail("not_found", `Tunnel ${input.id} not found.`);
          let row = yield* expireRowIfDue(raw);
          const createdBy = decodeCreatedByJson(row.created_by_json);
          const currentNow = nowMs();

          if (input.enabled === true) {
            yield* requireReadyToPublish();
            if (row.status === "denied" || row.status === "pending_approval") {
              return yield* fail("invalid_input", `Cannot enable tunnel in status ${row.status}.`);
            }
          }

          let nextExpiresAt = row.expires_at;
          if (input.expiresAt !== undefined) {
            if (createdBy.kind === "agent") {
              if (
                input.expiresAt === null ||
                input.expiresAt <= currentNow ||
                input.expiresAt - currentNow > PUBLIC_TUNNEL_AGENT_MAX_EXPIRY_SECONDS * 1000
              ) {
                return yield* fail(
                  "invalid_input",
                  "Agent tunnel expiry cannot exceed 24 hours from now.",
                );
              }
            } else if (
              input.expiresAt !== null &&
              (input.expiresAt <= currentNow ||
                input.expiresAt - currentNow > PUBLIC_TUNNEL_MAX_EXPIRY_SECONDS * 1000)
            ) {
              return yield* fail("invalid_input", "Invalid tunnel expiration timestamp.");
            }
            nextExpiresAt = input.expiresAt;
          } else if (input.enabled === true && row.status === "expired") {
            const defaultSecs =
              createdBy.kind === "agent"
                ? PUBLIC_TUNNEL_AGENT_DEFAULT_EXPIRY_SECONDS
                : PUBLIC_TUNNEL_DEFAULT_EXPIRY_SECONDS;
            nextExpiresAt = currentNow + defaultSecs * 1000;
          }

          let nextSlug = row.slug;
          let nextHostLabel = row.host_label;
          if (input.slug !== undefined && input.slug !== row.slug) {
            if (!isValidPublicTunnelSlug(input.slug)) {
              return yield* fail("invalid_input", `Slug "${input.slug}" is invalid or reserved.`);
            }
            if (row.routing === "subdomain") {
              const conflict = yield* sql<{ readonly id: string }>`
                SELECT id FROM public_tunnels
                WHERE routing = 'subdomain' AND slug = ${input.slug} AND id != ${row.id}
                  AND status IN ('pending_approval', 'live', 'paused')
              `;
              if (conflict.length > 0) {
                return yield* fail("conflict", `Subdomain slug "${input.slug}" is already active.`);
              }
              nextHostLabel = input.slug;
            } else if (row.rid) {
              const conflict = yield* sql<{ readonly id: string }>`
                SELECT id FROM public_tunnels
                WHERE routing = 'path' AND slug = ${input.slug} AND rid = ${row.rid} AND id != ${row.id}
                  AND status IN ('pending_approval', 'live', 'paused')
              `;
              if (conflict.length > 0) {
                return yield* fail("conflict", `Path slug "${input.slug}" is already active.`);
              }
            }
            nextSlug = input.slug;
          }

          let nextStatus = row.status;
          if (input.enabled === false) {
            if (row.status === "live") nextStatus = "paused";
          } else if (input.enabled === true) {
            if (nextExpiresAt !== null && nextExpiresAt <= currentNow) {
              return yield* fail(
                "invalid_input",
                "Specify a future expiry to resume an expired tunnel.",
              );
            }
            const parsedTarget = decodeTargetJson(row.target_json);
            const validated = yield* validateTargetAndPin(parsedTarget);
            row = {
              ...row,
              target_json: encodeTargetJson(validated.normalizedTarget),
              target_dev: validated.identity?.dev ?? null,
              target_ino: validated.identity?.ino ?? null,
            };
            nextStatus = "live";
          } else if (
            row.status === "expired" &&
            nextExpiresAt !== null &&
            nextExpiresAt > currentNow
          ) {
            nextStatus = "live";
          }

          const nextTitle = input.title ?? row.title;
          const updated: PublicTunnelRow = {
            ...row,
            title: nextTitle,
            slug: nextSlug,
            host_label: nextHostLabel,
            status: nextStatus,
            expires_at: nextExpiresAt,
          };

          yield* sql`
            UPDATE public_tunnels
            SET title = ${updated.title},
                slug = ${updated.slug},
                host_label = ${updated.host_label},
                status = ${updated.status},
                expires_at = ${updated.expires_at},
                target_json = ${updated.target_json},
                target_dev = ${updated.target_dev},
                target_ino = ${updated.target_ino}
            WHERE id = ${updated.id}
          `;

          if (input.slug !== undefined && input.slug !== raw.slug) {
            httpServer.revokeTunnel(updated.id as PublicTunnelId);
          }
          const tunnel = syncRuntimeFromRow(updated);
          yield* PubSub.publish(changesPubSub, { version: 1, type: "upserted", tunnel });
          return tunnel;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPublicTunnelError(error) ? error : fail("internal", "Could not update tunnel."),
        ),
      );
  });

  const rotate = Effect.fn("PublicTunnels.rotate")(function* (id: PublicTunnelId) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          if (!policyAllowed) {
            return yield* fail("policy", ManagedLimits.refusePublicTunnels(policy).message);
          }
          const rows = yield* sql<PublicTunnelRow>`
            SELECT * FROM public_tunnels WHERE id = ${id}
          `;
          const raw = rows[0];
          if (!raw) return yield* fail("not_found", `Tunnel ${id} not found.`);
          const row = yield* expireRowIfDue(raw);
          if (row.status !== "live" && row.status !== "paused") {
            return yield* fail("invalid_input", `Cannot rotate tunnel in status ${row.status}.`);
          }

          // User decision #2: assign a fresh per-tunnel rid so siblings aren't broken.
          const nextRid = row.routing === "path" ? randomCrockford(10) : row.rid;
          const nextRidMode = row.routing === "path" ? "tunnel" : row.rid_mode;
          const nextSecretId = row.access === "link" ? randomCrockford(12) : row.link_secret_id;

          const updated: PublicTunnelRow = {
            ...row,
            rid: nextRid,
            rid_mode: nextRidMode,
            link_secret_id: nextSecretId,
          };

          yield* sql`
            UPDATE public_tunnels
            SET rid = ${updated.rid},
                rid_mode = ${updated.rid_mode},
                link_secret_id = ${updated.link_secret_id}
            WHERE id = ${id}
          `;

          httpServer.revokeTunnel(id);
          const tunnel = syncRuntimeFromRow(updated);
          yield* PubSub.publish(changesPubSub, { version: 1, type: "upserted", tunnel });

          const runtime = runtimeEntries.get(id);
          const token =
            updated.access === "link"
              ? signLinkToken(
                  runtime ?? {
                    tunnel,
                    hostLabel: updated.host_label,
                    linkSecretId: updated.link_secret_id,
                  },
                )
              : null;
          const accessUrl = tunnel.url && token ? `${tunnel.url}?t=${token}` : tunnel.url;

          return {
            tunnel,
            accessUrl,
          } satisfies PublicTunnelRotateResult;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPublicTunnelError(error) ? error : fail("internal", "Could not rotate tunnel."),
        ),
      );
  });

  const remove = Effect.fn("PublicTunnels.remove")(function* (id: PublicTunnelId) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* sql<{ readonly id: string }>`
            SELECT id FROM public_tunnels WHERE id = ${id}
          `;
          if (existing.length === 0) {
            return yield* fail("not_found", `Tunnel ${id} not found.`);
          }
          yield* visitLog.flush();
          disarmRuntime(id);
          yield* sql`DELETE FROM public_tunnel_visits WHERE tunnel_id = ${id}`;
          yield* sql`DELETE FROM public_tunnels WHERE id = ${id}`;
          yield* PubSub.publish(changesPubSub, { version: 1, type: "removed", id });
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPublicTunnelError(error) ? error : fail("internal", "Could not stop tunnel."),
        ),
      );
  });

  const stopAll = Effect.fn("PublicTunnels.stopAll")(function* () {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* visitLog.flush();
          const existing = yield* sql<{ readonly id: string }>`
            SELECT id FROM public_tunnels
          `;
          runtimeEntries.clear();
          httpServer.revokeAll();
          yield* sql`DELETE FROM public_tunnel_visits`;
          yield* sql`DELETE FROM public_tunnels`;
          for (const row of existing) {
            yield* PubSub.publish(changesPubSub, {
              version: 1,
              type: "removed",
              id: row.id as PublicTunnelId,
            });
          }
          return { stoppedCount: existing.length } satisfies PublicTunnelStopAllResult;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPublicTunnelError(error)
            ? error
            : fail("internal", "Could not stop all public tunnels."),
        ),
      );
  });

  const visits = Effect.fn("PublicTunnels.visits")(function* (input: PublicTunnelVisitsInput) {
    return yield* Effect.gen(function* () {
      const existing = yield* sql<{ readonly id: string }>`
        SELECT id FROM public_tunnels WHERE id = ${input.id}
      `;
      if (existing.length === 0) {
        return yield* fail("not_found", `Tunnel ${input.id} not found.`);
      }
      return yield* visitLog.query(input.id, {
        ...(input.before !== undefined ? { before: input.before } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
    }).pipe(
      Effect.mapError((error) =>
        isPublicTunnelError(error) ? error : fail("internal", "Could not query tunnel visits."),
      ),
    );
  });

  const link = Effect.fn("PublicTunnels.link")(function* (id: PublicTunnelId) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          if (!policyAllowed) {
            return yield* fail("policy", ManagedLimits.refusePublicTunnels(policy).message);
          }
          const rows = yield* sql<PublicTunnelRow>`
            SELECT * FROM public_tunnels WHERE id = ${id}
          `;
          const raw = rows[0];
          if (!raw) return yield* fail("not_found", `Tunnel ${id} not found.`);
          const row = yield* expireRowIfDue(raw);
          const tunnel = rowToTunnel(row);
          if (tunnel.status !== "live" || !tunnel.url) {
            return yield* fail("invalid_input", "Tunnel is not currently live.");
          }
          if (tunnel.access !== "link") {
            return { url: tunnel.url } satisfies PublicTunnelLinkResult;
          }
          const entry = runtimeEntries.get(id) ?? {
            tunnel,
            hostLabel: row.host_label,
            linkSecretId: row.link_secret_id,
          };
          const token = signLinkToken(entry);
          if (!token) {
            return yield* fail("internal", "Tunnel link secret is missing.");
          }
          return { url: `${tunnel.url}?t=${token}` } satisfies PublicTunnelLinkResult;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPublicTunnelError(error) ? error : fail("internal", "Could not generate tunnel link."),
        ),
      );
  });

  const decideRequest = Effect.fn("PublicTunnels.decideRequest")(function* (
    input: PublicTunnelDecideRequestInput,
    approverSessionId: AuthSessionId,
  ) {
    return yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          const rows = yield* sql<PublicTunnelRow>`
            SELECT * FROM public_tunnels WHERE id = ${input.id}
          `;
          const found = rows[0];
          if (!found) return yield* fail("not_found", `Tunnel ${input.id} not found.`);
          const raw = yield* expireRowIfDue(found);
          if (raw.status !== "pending_approval") {
            return yield* fail("invalid_input", "Tunnel request is not pending approval.");
          }
          const createdBy = decodeCreatedByJson(raw.created_by_json);
          const nextCreatedBy: PublicTunnelCreatedBy =
            createdBy.kind === "agent"
              ? { ...createdBy, approvedBySessionId: approverSessionId }
              : createdBy;

          if (!input.approve) {
            const deniedRow: PublicTunnelRow = {
              ...raw,
              status: "denied",
              created_by_json: encodeCreatedByJson(nextCreatedBy),
            };
            yield* sql`
              UPDATE public_tunnels
              SET status = 'denied',
                  created_by_json = ${deniedRow.created_by_json}
              WHERE id = ${input.id}
            `;
            const tunnel = syncRuntimeFromRow(deniedRow);
            yield* PubSub.publish(changesPubSub, { version: 1, type: "upserted", tunnel });
            return tunnel;
          }

          yield* requireReadyToPublish();
          const currentNow = nowMs();
          // The requested lifetime starts when the request is approved, not when it was asked.
          let nextExpiresAt =
            raw.expires_at === null ? null : currentNow + (raw.expires_at - raw.created_at);
          if (input.expiresAt !== undefined) {
            if (
              createdBy.kind === "agent" &&
              (input.expiresAt === null ||
                input.expiresAt <= currentNow ||
                input.expiresAt - currentNow > PUBLIC_TUNNEL_AGENT_MAX_EXPIRY_SECONDS * 1000)
            ) {
              return yield* fail(
                "invalid_input",
                "Agent tunnel expiry cannot exceed 24 hours from now.",
              );
            }
            nextExpiresAt = input.expiresAt;
          }
          const nextRouting = input.routing ?? (raw.routing as PublicTunnelRouting);
          const nextSlug = input.slug ?? raw.slug;
          if (!isValidPublicTunnelSlug(nextSlug)) {
            return yield* fail("invalid_input", `Slug "${nextSlug}" is invalid or reserved.`);
          }
          const nextRid = nextRouting === "path" ? (raw.rid ?? randomCrockford(10)) : null;
          if (nextRouting === "subdomain") {
            const conflict = yield* sql<{ readonly id: string }>`
              SELECT id FROM public_tunnels
              WHERE routing = 'subdomain' AND slug = ${nextSlug} AND id != ${raw.id}
                AND status IN ('pending_approval', 'live', 'paused')
            `;
            if (conflict.length > 0) {
              return yield* fail("conflict", `Subdomain slug "${nextSlug}" is already active.`);
            }
          } else if (nextRid) {
            const conflict = yield* sql<{ readonly id: string }>`
              SELECT id FROM public_tunnels
              WHERE routing = 'path' AND slug = ${nextSlug} AND rid = ${nextRid} AND id != ${raw.id}
                AND status IN ('pending_approval', 'live', 'paused')
            `;
            if (conflict.length > 0) {
              return yield* fail("conflict", `Path slug "${nextSlug}" is already active.`);
            }
          }
          const nextHostLabel = nextRouting === "path" ? "pub" : nextSlug;
          const parsedTarget = decodeTargetJson(raw.target_json);
          const validated = yield* validateTargetAndPin(parsedTarget);

          const approvedRow: PublicTunnelRow = {
            ...raw,
            status: "live",
            routing: nextRouting,
            slug: nextSlug,
            rid: nextRid,
            host_label: nextHostLabel,
            expires_at: nextExpiresAt,
            created_by_json: encodeCreatedByJson(nextCreatedBy),
            target_json: encodeTargetJson(validated.normalizedTarget),
            target_dev: validated.identity?.dev ?? null,
            target_ino: validated.identity?.ino ?? null,
          };

          yield* sql`
            UPDATE public_tunnels
            SET status = 'live',
                routing = ${approvedRow.routing},
                slug = ${approvedRow.slug},
                rid = ${approvedRow.rid},
                host_label = ${approvedRow.host_label},
                expires_at = ${approvedRow.expires_at},
                created_by_json = ${approvedRow.created_by_json},
                target_json = ${approvedRow.target_json},
                target_dev = ${approvedRow.target_dev},
                target_ino = ${approvedRow.target_ino}
            WHERE id = ${input.id}
          `;
          const tunnel = syncRuntimeFromRow(approvedRow);
          yield* PubSub.publish(changesPubSub, { version: 1, type: "upserted", tunnel });
          return tunnel;
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isPublicTunnelError(error) ? error : fail("internal", "Could not decide tunnel request."),
        ),
      );
  });

  const changes: Stream.Stream<PublicTunnelStreamEvent> = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading the snapshot, so no change between the two is lost.
      const subscription = yield* PubSub.subscribe(changesPubSub);
      const initial = yield* list();
      const snapshot: PublicTunnelStreamEvent = {
        version: 1,
        type: "snapshot",
        tunnels: initial.tunnels,
      };
      return Stream.concat(Stream.succeed(snapshot), Stream.fromSubscription(subscription));
    }).pipe(Effect.orDie),
  );

  return {
    list,
    get,
    create,
    update,
    rotate,
    remove,
    stopAll,
    visits,
    link,
    decideRequest,
    resolveAgentPath,
    linkState: Effect.sync(computeLinkState),
    changes,
    allowName,
    activeNames,
    accept: (socket: NodeTls.TLSSocket, metadata: StreamLabel) =>
      httpServer.accept(socket, metadata),
    closeSockets,
    registerServerPort: (port: number) => {
      if (port > 0) knownOwnPorts.add(port);
    },
  };
});

export const layer = Layer.effect(PublicTunnels, make);
