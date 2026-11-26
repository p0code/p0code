// Node HTTP server adapter over multiplexed TLS sockets from RelayTunnelClient.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeTls from "node:tls";
import {
  isValidPublicTunnelSlug,
  type PublicTunnel,
  type PublicTunnelId,
} from "@t3tools/contracts";
import type { StreamLabel } from "@t3tools/relay-tunnel/mux";
import { atExpiry } from "../selfRelay/expiry.ts";
import {
  buildPublicProxyRequestHeaders,
  buildPublicProxyResponseHeaders,
  proxyHttpRequest,
  proxyUpgradeRequest,
} from "../selfRelay/loopbackProxy.ts";
import { serveStaticTunnelRequest, type StaticFileIdentity } from "./staticFiles.ts";
import type { PendingPublicTunnelVisit } from "./visitLog.ts";

const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 60_000;
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_PER_TUNNEL = 64;
const RATE_LIMIT_RPS = 20;
const RATE_LIMIT_BURST = 100;
const MAX_RATE_BUCKETS = 4096;
const PUBLIC_TUNNEL_RID_PATTERN = /^[0-9a-hjkmnp-tv-z]{10}$/;
const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface PublicTunnelRuntimeRecord {
  readonly tunnel: PublicTunnel;
  readonly pinnedIdentity?: StaticFileIdentity;
}

interface ConnectionMetadata {
  readonly sniName: string;
  readonly remoteAddr: string | undefined;
}

interface RateBucket {
  tokens: number;
  lastRefillMs: number;
}

interface PublicHttpOptions {
  readonly now: () => number;
  readonly ownPorts: () => ReadonlySet<number>;
  readonly resolveExpectedHost: (sniName: string) => string | null;
  readonly resolvePathTunnel: (slug: string, rid: string) => PublicTunnelRuntimeRecord | null;
  readonly resolveSubdomainTunnel: (slug: string) => PublicTunnelRuntimeRecord | null;
  readonly isGloballyAllowed: () => boolean;
  readonly validateLinkToken: (tunnelId: PublicTunnelId, token: string) => boolean;
  readonly recordVisit: (visit: PendingPublicTunnelVisit) => void;
}

export interface PublicHttpServerHandle {
  readonly accept: (socket: NodeTls.TLSSocket, metadata: StreamLabel) => void;
  readonly revokeTunnel: (tunnelId: PublicTunnelId) => void;
  readonly revokeAll: () => void;
  readonly close: () => void;
}

function sourceKey(address: string | undefined): string {
  if (!address) return "unknown";
  const mapped = address.startsWith("::ffff:") ? address.slice(7) : address;
  const zone = mapped.indexOf("%");
  const normalized = zone >= 0 ? mapped.slice(0, zone) : mapped;
  if (NodeNet.isIPv6(normalized)) {
    const [head, tail = ""] = normalized.split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const full = [
      ...left,
      ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"),
      ...right,
    ];
    return `${full
      .slice(0, 4)
      .map((part) => part.padStart(4, "0"))
      .join(":")}/64`;
  }
  return normalized;
}

function parseHostnameFromHostHeader(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const closeBracket = trimmed.indexOf("]");
    return closeBracket > 0 ? trimmed.slice(0, closeBracket + 1) : "";
  }
  return trimmed.split(":", 1)[0] ?? "";
}

function parseCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const prefix = `${name}=`;
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return undefined;
}

function sendPlainText(
  response: NodeHttp.ServerResponse,
  status: number,
  bodyText: string,
  extraHeaders?: Record<string, string>,
): void {
  if (response.headersSent) return;
  const body = Buffer.from(bodyText, "utf8");
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
    ...extraHeaders,
  });
  if (response.req?.method === "HEAD") {
    response.end();
    return;
  }
  response.end(body);
}

function sendUpgradeError(socket: NodeNet.Socket, statusLine: string): void {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  }
}

export function createPublicHttpServer(options: PublicHttpOptions): PublicHttpServerHandle {
  const connections = new WeakMap<NodeNet.Socket, ConnectionMetadata>();
  const socketsByTunnel = new Map<PublicTunnelId, Map<NodeNet.Socket, () => void>>();
  const activeCountByTunnel = new Map<PublicTunnelId, number>();
  const rateBuckets = new Map<string, RateBucket>();

  const takeRateToken = (ipKey: string): boolean => {
    const currentNow = options.now();
    let bucket = rateBuckets.get(ipKey);
    if (!bucket) {
      if (rateBuckets.size >= MAX_RATE_BUCKETS) {
        const oldestKey = rateBuckets.keys().next().value;
        if (oldestKey !== undefined) rateBuckets.delete(oldestKey);
      }
      bucket = { tokens: RATE_LIMIT_BURST, lastRefillMs: currentNow };
    } else {
      rateBuckets.delete(ipKey);
      const elapsedSeconds = Math.max(0, (currentNow - bucket.lastRefillMs) / 1000);
      bucket.tokens = Math.min(RATE_LIMIT_BURST, bucket.tokens + elapsedSeconds * RATE_LIMIT_RPS);
      bucket.lastRefillMs = currentNow;
    }
    rateBuckets.set(ipKey, bucket);
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  };

  const trackTunnelSocket = (socket: NodeNet.Socket, tunnel: PublicTunnel) => {
    let perTunnel = socketsByTunnel.get(tunnel.id);
    if (!perTunnel) {
      perTunnel = new Map();
      socketsByTunnel.set(tunnel.id, perTunnel);
    }
    if (perTunnel.has(socket)) return;
    const cancelExpiry =
      tunnel.expiresAt !== null
        ? atExpiry(tunnel.expiresAt, options.now, () => socket.destroy())
        : () => {};
    perTunnel.set(socket, cancelExpiry);
    socket.once("close", () => {
      cancelExpiry();
      const currentMap = socketsByTunnel.get(tunnel.id);
      if (currentMap) {
        currentMap.delete(socket);
        if (currentMap.size === 0) socketsByTunnel.delete(tunnel.id);
      }
    });
  };

  const acquireSlot = (tunnelId: PublicTunnelId): (() => void) | null => {
    const current = activeCountByTunnel.get(tunnelId) ?? 0;
    if (current >= MAX_CONCURRENT_PER_TUNNEL) return null;
    activeCountByTunnel.set(tunnelId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (activeCountByTunnel.get(tunnelId) ?? 1) - 1;
      if (next <= 0) activeCountByTunnel.delete(tunnelId);
      else activeCountByTunnel.set(tunnelId, next);
    };
  };

  const resolveRequestTarget = (
    request: NodeHttp.IncomingMessage,
  ):
    | {
        readonly ok: true;
        readonly meta: ConnectionMetadata;
        readonly ipKey: string;
        readonly record: PublicTunnelRuntimeRecord;
        readonly subpath: string;
        readonly rawQuery: string;
        readonly pathPrefix: string | undefined;
        readonly expectedHost: string;
        readonly redirectTrailingSlash: string | null;
      }
    | {
        readonly ok: false;
        readonly status: number;
        readonly statusText: string;
        readonly body: string;
        readonly extraHeaders?: Record<string, string>;
      } => {
    if (!options.isGloballyAllowed()) {
      return { ok: false, status: 404, statusText: "Not Found", body: "Not found" };
    }
    const meta = connections.get(request.socket);
    if (!meta || !meta.sniName) {
      return { ok: false, status: 403, statusText: "Forbidden", body: "Forbidden" };
    }
    const expectedHost = options.resolveExpectedHost(meta.sniName);
    const requestHostname = parseHostnameFromHostHeader(request.headers.host);
    if (!expectedHost || !requestHostname || requestHostname !== expectedHost.toLowerCase()) {
      return { ok: false, status: 403, statusText: "Forbidden", body: "Host mismatch" };
    }
    const ipKey = sourceKey(meta.remoteAddr);
    if (!takeRateToken(ipKey)) {
      return {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        body: "Too many requests",
        extraHeaders: { "retry-after": "1" },
      };
    }

    const rawUrl = request.url ?? "/";
    const hashIdx = rawUrl.indexOf("#");
    const withoutHash = hashIdx >= 0 ? rawUrl.slice(0, hashIdx) : rawUrl;
    const queryIdx = withoutHash.indexOf("?");
    const rawPath = queryIdx >= 0 ? withoutHash.slice(0, queryIdx) : withoutHash;
    const rawQuery = queryIdx >= 0 ? withoutHash.slice(queryIdx + 1) : "";

    let record: PublicTunnelRuntimeRecord | null = null;
    let subpath = rawPath || "/";
    let pathPrefix: string | undefined;
    let redirectTrailingSlash: string | null = null;

    if (meta.sniName === "pub") {
      const match = /^\/([^/]+)\/([^/]+)(\/.*)?$/.exec(rawPath);
      if (!match) {
        return { ok: false, status: 404, statusText: "Not Found", body: "Not found" };
      }
      const slug = match[1] ?? "";
      const rid = match[2] ?? "";
      const rest = match[3] ?? "";
      if (!isValidPublicTunnelSlug(slug) || !PUBLIC_TUNNEL_RID_PATTERN.test(rid)) {
        return { ok: false, status: 404, statusText: "Not Found", body: "Not found" };
      }
      record = options.resolvePathTunnel(slug, rid);
      if (!record) {
        return { ok: false, status: 404, statusText: "Not Found", body: "Not found" };
      }
      pathPrefix = `/${slug}/${rid}`;
      if (rest === "") {
        redirectTrailingSlash = `/${slug}/${rid}/${rawQuery ? `?${rawQuery}` : ""}`;
        subpath = "/";
      } else {
        subpath = rest;
      }
    } else {
      record = options.resolveSubdomainTunnel(meta.sniName);
      if (!record) {
        return { ok: false, status: 404, statusText: "Not Found", body: "Not found" };
      }
    }

    const { tunnel } = record;
    const currentNow = options.now();
    if (tunnel.status === "paused") {
      return {
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        body: "Tunnel paused",
      };
    }
    if (
      tunnel.status === "expired" ||
      (tunnel.expiresAt !== null && tunnel.expiresAt <= currentNow)
    ) {
      return { ok: false, status: 410, statusText: "Gone", body: "Tunnel expired" };
    }
    if (tunnel.status !== "live") {
      return { ok: false, status: 404, statusText: "Not Found", body: "Not found" };
    }

    return {
      ok: true,
      meta,
      ipKey,
      record,
      subpath,
      rawQuery,
      pathPrefix,
      expectedHost,
      redirectTrailingSlash,
    };
  };

  const authorizeLinkAccess = (
    request: NodeHttp.IncomingMessage,
    tunnel: PublicTunnel,
    rawQuery: string,
    publicOrigin: string,
    upgrade: boolean,
  ):
    | {
        readonly authorized: true;
        readonly cleanQuery: string;
        readonly token: string | null;
        readonly suppliedQueryToken: boolean;
      }
    | { readonly authorized: false } => {
    const params = new URLSearchParams(rawQuery);
    const queryToken = params.get("t");
    if (queryToken !== null) {
      params.delete("t");
    }
    const cleanQuery = params.toString();

    if (tunnel.access !== "link") {
      return {
        authorized: true,
        cleanQuery: rawQuery,
        token: null,
        suppliedQueryToken: false,
      };
    }

    const method = (request.method ?? "GET").toUpperCase();
    if (request.headers.origin !== undefined && request.headers.origin !== publicOrigin) {
      return { authorized: false };
    }
    const fetchSite = request.headers["sec-fetch-site"];
    if (
      request.headers.origin === undefined &&
      typeof fetchSite === "string" &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none" &&
      (upgrade || !SAFE_HTTP_METHODS.has(method))
    ) {
      return { authorized: false };
    }

    const cookieName = `__Host-p0-t-${tunnel.id}`;
    const cookieToken = parseCookieValue(request.headers.cookie, cookieName);
    const token = queryToken ?? cookieToken;
    if (!token || token.length > 4096 || !options.validateLinkToken(tunnel.id, token)) {
      return { authorized: false };
    }

    return {
      authorized: true,
      cleanQuery,
      token,
      suppliedQueryToken: queryToken !== null,
    };
  };

  const linkCookieHeader = (tunnelId: PublicTunnelId, token: string) =>
    `__Host-p0-t-${tunnelId}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`;

  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      const resolved = resolveRequestTarget(request);
      if (!resolved.ok) {
        sendPlainText(response, resolved.status, resolved.body, resolved.extraHeaders);
        return;
      }

      const {
        meta,
        ipKey,
        record,
        subpath,
        rawQuery,
        pathPrefix,
        expectedHost,
        redirectTrailingSlash,
      } = resolved;
      const { tunnel } = record;
      trackTunnelSocket(request.socket, tunnel);

      const publicHost = request.headers.host ?? expectedHost;
      const publicOrigin = `https://${publicHost}`;
      const auth = authorizeLinkAccess(request, tunnel, rawQuery, publicOrigin, false);
      if (!auth.authorized) {
        sendPlainText(response, 401, "Tunnel access token required.");
        return;
      }

      if (redirectTrailingSlash !== null) {
        const cleanRedirect = auth.suppliedQueryToken
          ? `${pathPrefix}/${auth.cleanQuery ? `?${auth.cleanQuery}` : ""}`
          : redirectTrailingSlash;
        response.writeHead(308, {
          location: cleanRedirect,
          "cache-control": "no-store",
          "x-robots-tag": "noindex, nofollow",
          ...(auth.suppliedQueryToken && auth.token
            ? { "set-cookie": linkCookieHeader(tunnel.id, auth.token) }
            : {}),
        });
        response.end();
        return;
      }

      if (auth.suppliedQueryToken && auth.token) {
        const redirectTarget = `${pathPrefix ?? ""}${subpath}${auth.cleanQuery ? `?${auth.cleanQuery}` : ""}`;
        response.writeHead(303, {
          location: redirectTarget,
          "set-cookie": linkCookieHeader(tunnel.id, auth.token),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-robots-tag": "noindex, nofollow",
        });
        response.end();
        return;
      }

      const releaseSlot = acquireSlot(tunnel.id);
      if (!releaseSlot) {
        sendPlainText(response, 503, "Tunnel concurrency limit reached.");
        return;
      }

      const method = request.method ?? "GET";
      const userAgent =
        typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null;
      let visitRecorded = false;
      const recordOutcome = (status: number, bytes: number) => {
        if (visitRecorded) return;
        visitRecorded = true;
        options.recordVisit({
          tunnelId: tunnel.id,
          at: options.now(),
          ip: ipKey,
          method,
          path: subpath,
          status,
          bytes,
          ua: userAgent,
        });
      };

      try {
        if (tunnel.target.kind === "port") {
          const targetPort = tunnel.target.port;
          if (options.ownPorts().has(targetPort)) {
            sendPlainText(response, 502, "Refusing to proxy environment port.");
            recordOutcome(502, 0);
            releaseSlot();
            return;
          }
          const upstreamPath = `${subpath}${auth.cleanQuery ? `?${auth.cleanQuery}` : ""}`;
          await proxyHttpRequest({
            request,
            response,
            port: targetPort,
            path: upstreamPath,
            headers: buildPublicProxyRequestHeaders(request.headers, {
              port: targetPort,
              publicHost,
              publicOrigin,
              hostHeader: tunnel.target.hostHeader ?? "localhost",
              ...(meta.remoteAddr ? { remoteAddr: meta.remoteAddr } : {}),
              ...(pathPrefix ? { pathPrefix } : {}),
            }),
            transformResponseHeaders: (upstreamHeaders) =>
              buildPublicProxyResponseHeaders(upstreamHeaders, {
                port: targetPort,
                publicOrigin,
                ...(pathPrefix ? { pathPrefix } : {}),
              }),
            onComplete: ({ status, bytesOut }) => {
              recordOutcome(status, bytesOut);
              releaseSlot();
            },
          });
          return;
        }

        const staticResult = await serveStaticTunnelRequest({
          request,
          response,
          target: tunnel.target,
          rawSubpath: subpath,
          ...(record.pinnedIdentity ? { pinnedIdentity: record.pinnedIdentity } : {}),
        });
        recordOutcome(staticResult.status, staticResult.bytesOut);
        releaseSlot();
      } catch {
        releaseSlot();
        if (!response.headersSent) {
          sendPlainText(response, 502, "Bad Gateway");
        } else {
          response.end();
        }
        recordOutcome(502, 0);
      }
    })().catch(() => {
      if (!response.headersSent) {
        sendPlainText(response, 502, "Bad Gateway");
      } else {
        response.end();
      }
    });
  });

  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  server.on("upgrade", (request, socket: NodeNet.Socket, head) => {
    const resolved = resolveRequestTarget(request);
    if (!resolved.ok) {
      sendUpgradeError(socket, `${resolved.status} ${resolved.statusText}`);
      return;
    }

    const { meta, ipKey, record, subpath, rawQuery, pathPrefix, expectedHost } = resolved;
    const { tunnel } = record;
    trackTunnelSocket(socket, tunnel);

    const publicHost = request.headers.host ?? expectedHost;
    const publicOrigin = `https://${publicHost}`;
    const auth = authorizeLinkAccess(request, tunnel, rawQuery, publicOrigin, true);
    if (!auth.authorized) {
      sendUpgradeError(socket, "401 Unauthorized");
      return;
    }

    if (tunnel.target.kind !== "port") {
      sendUpgradeError(socket, "400 Bad Request");
      return;
    }

    const targetPort = tunnel.target.port;
    if (options.ownPorts().has(targetPort)) {
      sendUpgradeError(socket, "502 Bad Gateway");
      return;
    }

    const releaseSlot = acquireSlot(tunnel.id);
    if (!releaseSlot) {
      sendUpgradeError(socket, "503 Service Unavailable");
      return;
    }

    const method = request.method ?? "GET";
    const userAgent =
      typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null;
    const upstreamPath = `${subpath}${auth.cleanQuery ? `?${auth.cleanQuery}` : ""}`;

    void proxyUpgradeRequest({
      request,
      socket,
      head,
      port: targetPort,
      path: upstreamPath,
      headers: buildPublicProxyRequestHeaders(request.headers, {
        port: targetPort,
        publicHost,
        publicOrigin,
        hostHeader: tunnel.target.hostHeader ?? "localhost",
        ...(meta.remoteAddr ? { remoteAddr: meta.remoteAddr } : {}),
        ...(pathPrefix ? { pathPrefix } : {}),
        keepUpgrade: true,
      }),
      transformResponseHeaders: (upstreamHeaders) => {
        const headers = buildPublicProxyResponseHeaders(upstreamHeaders, {
          port: targetPort,
          publicOrigin,
          ...(pathPrefix ? { pathPrefix } : {}),
          keepUpgrade: true,
        });
        if (auth.suppliedQueryToken && auth.token) {
          const existing = Array.isArray(headers["set-cookie"])
            ? headers["set-cookie"]
            : typeof headers["set-cookie"] === "string"
              ? [headers["set-cookie"]]
              : [];
          headers["set-cookie"] = [...existing, linkCookieHeader(tunnel.id, auth.token)];
        }
        return headers;
      },
      onHandshake: ({ status }) => {
        options.recordVisit({
          tunnelId: tunnel.id,
          at: options.now(),
          ip: ipKey,
          method,
          path: subpath,
          status,
          bytes: 0,
          ua: userAgent,
        });
      },
      onClose: () => {
        releaseSlot();
      },
    })
      .then((upstream) => {
        if (upstream === null) releaseSlot();
      })
      .catch(() => {
        releaseSlot();
        socket.destroy();
      });
  });

  const revokeTunnel = (tunnelId: PublicTunnelId) => {
    const perTunnel = socketsByTunnel.get(tunnelId);
    if (!perTunnel) return;
    for (const [socket, cancelExpiry] of Array.from(perTunnel.entries())) {
      cancelExpiry();
      socket.destroy();
    }
    socketsByTunnel.delete(tunnelId);
  };

  const revokeAll = () => {
    for (const perTunnel of Array.from(socketsByTunnel.values())) {
      for (const [socket, cancelExpiry] of Array.from(perTunnel.entries())) {
        cancelExpiry();
        socket.destroy();
      }
    }
    socketsByTunnel.clear();
  };

  return {
    accept: (socket, metadata) => {
      connections.set(socket, {
        sniName: metadata.name ?? "",
        remoteAddr: metadata.remoteAddr,
      });
      server.emit("connection", socket);
    },
    revokeTunnel,
    revokeAll,
    close: () => {
      revokeAll();
      server.close();
      server.closeAllConnections();
    },
  };
}
