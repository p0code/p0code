// Node stream adapter must preserve HTTP upgrades, loopback fallback, and socket identity.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const DEFAULT_PORT_PROXY_COOKIE = "__Host-hhh-port";
const PUBLIC_TUNNEL_COOKIE_PREFIX = "__Host-p0";

async function dialLoopbackSocket(port: number): Promise<NodeNet.Socket> {
  const connect = (host: string) =>
    new Promise<NodeNet.Socket>((resolve, reject) => {
      const socket = NodeNet.createConnection({ host, port });
      const onConnect = () => {
        socket.off("error", onError);
        resolve(socket);
      };
      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        socket.destroy();
        reject(error);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  try {
    return await connect("127.0.0.1");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "EADDRNOTAVAIL") {
      return await connect("::1");
    }
    throw error;
  }
}

export function stripHopByHopHeaders(
  headers: NodeHttp.IncomingHttpHeaders,
  options?: { readonly keepUpgrade?: boolean },
): NodeHttp.OutgoingHttpHeaders {
  const result: NodeHttp.OutgoingHttpHeaders = {};
  const connectionTokens = new Set<string>();
  const connectionHeader = headers.connection;
  if (typeof connectionHeader === "string") {
    for (const token of connectionHeader.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) connectionTokens.add(normalized);
    }
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (options?.keepUpgrade && (lower === "connection" || lower === "upgrade")) {
      result[lower] = value;
      continue;
    }
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) {
      continue;
    }
    result[lower] = value;
  }
  return result;
}

export function stripCookiesFromHeader(
  cookieHeader: string | string[] | undefined,
  shouldStripName: (name: string) => boolean,
): string | undefined {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (!raw) return undefined;
  const kept = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) return false;
      const eq = part.indexOf("=");
      const name = (eq >= 0 ? part.slice(0, eq) : part).trim();
      return !shouldStripName(name);
    })
    .join("; ");
  return kept.length > 0 ? kept : undefined;
}

export function filterSetCookieHeaders(
  setCookie: string | string[] | undefined,
  options: {
    readonly dropPrefixes?: ReadonlyArray<string>;
    readonly dropNames?: ReadonlySet<string>;
    readonly stripDomain?: boolean;
  },
): string[] | undefined {
  if (setCookie === undefined) return undefined;
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const filtered: string[] = [];
  for (const raw of list) {
    const name = raw.split("=", 1)[0]?.trim() ?? "";
    if (options.dropNames?.has(name)) continue;
    if (options.dropPrefixes?.some((prefix) => name.startsWith(prefix))) continue;
    if (!options.stripDomain) {
      filtered.push(raw);
      continue;
    }
    const parts = raw
      .split(";")
      .map((part) => part.trim())
      .filter((part, index) => index === 0 || !/^domain\s*=/i.test(part));
    filtered.push(parts.join("; "));
  }
  return filtered;
}

function rewriteLocationValue(
  location: string,
  options: {
    readonly port: number;
    readonly publicOrigin: string;
    readonly pathPrefix?: string;
  },
): string {
  const prefix = options.pathPrefix ?? "";
  if (location.startsWith("/") && !location.startsWith("//")) {
    if (!prefix) return location;
    if (location === prefix || location.startsWith(`${prefix}/`)) return location;
    return `${prefix}${location}`;
  }
  try {
    const parsed = new URL(location);
    if (
      parsed.protocol === "http:" &&
      parsed.port === String(options.port) &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]")
    ) {
      const pathPart =
        prefix && parsed.pathname !== prefix && !parsed.pathname.startsWith(`${prefix}/`)
          ? `${prefix}${parsed.pathname}`
          : parsed.pathname;
      return `${options.publicOrigin}${pathPart}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Relative or non-URL Location values are passed through unchanged.
  }
  return location;
}

export function buildPublicProxyRequestHeaders(
  headers: NodeHttp.IncomingHttpHeaders,
  options: {
    readonly port: number;
    readonly publicHost: string;
    readonly publicOrigin: string;
    readonly hostHeader: "localhost" | "public";
    readonly remoteAddr?: string;
    readonly pathPrefix?: string;
    readonly keepUpgrade?: boolean;
  },
): NodeHttp.OutgoingHttpHeaders {
  const next = stripHopByHopHeaders(
    headers,
    options.keepUpgrade !== undefined ? { keepUpgrade: options.keepUpgrade } : undefined,
  );
  for (const key of Object.keys(next)) {
    if (key.startsWith("x-forwarded-") || key === "forwarded") {
      delete next[key];
    }
  }
  const cookie = stripCookiesFromHeader(
    headers.cookie,
    (name) =>
      name === DEFAULT_PORT_PROXY_COOKIE ||
      name.startsWith(PUBLIC_TUNNEL_COOKIE_PREFIX) ||
      name.startsWith("t3_session_") ||
      name.startsWith("t3_dev_session_") ||
      name.startsWith("__Host-t3_session_"),
  );
  if (cookie) next.cookie = cookie;
  else delete next.cookie;

  next.host = options.hostHeader === "public" ? options.publicHost : `localhost:${options.port}`;
  next["x-forwarded-host"] = options.publicHost;
  next["x-forwarded-proto"] = "https";
  if (options.remoteAddr) {
    next["x-forwarded-for"] = options.remoteAddr;
  }
  if (options.pathPrefix) {
    next["x-forwarded-prefix"] = options.pathPrefix;
  }
  if (headers.origin === options.publicOrigin) {
    next.origin = `http://localhost:${options.port}`;
  }
  if (typeof headers.referer === "string") {
    if (
      headers.referer === options.publicOrigin ||
      headers.referer.startsWith(`${options.publicOrigin}/`)
    ) {
      next.referer = `http://localhost:${options.port}${headers.referer.slice(options.publicOrigin.length)}`;
    }
  }
  return next;
}

export function buildPublicProxyResponseHeaders(
  headers: NodeHttp.IncomingHttpHeaders,
  options: {
    readonly port: number;
    readonly publicOrigin: string;
    readonly pathPrefix?: string;
    readonly keepUpgrade?: boolean;
  },
): NodeHttp.OutgoingHttpHeaders {
  const next = stripHopByHopHeaders(
    headers,
    options.keepUpgrade !== undefined ? { keepUpgrade: options.keepUpgrade } : undefined,
  );
  const filteredCookies = filterSetCookieHeaders(headers["set-cookie"], {
    dropPrefixes: ["__Host-hhh", PUBLIC_TUNNEL_COOKIE_PREFIX],
    stripDomain: true,
  });
  if (filteredCookies && filteredCookies.length > 0) {
    next["set-cookie"] = filteredCookies;
  } else {
    delete next["set-cookie"];
  }
  const location = headers.location;
  if (typeof location === "string") {
    next.location = rewriteLocationValue(location, options);
  }
  if (!options.keepUpgrade && next["x-robots-tag"] === undefined) {
    next["x-robots-tag"] = "noindex, nofollow";
  }
  return next;
}

export async function proxyHttpRequest(options: {
  readonly request: NodeHttp.IncomingMessage;
  readonly response: NodeHttp.ServerResponse;
  readonly port: number;
  readonly path: string;
  readonly headers: NodeHttp.OutgoingHttpHeaders;
  readonly transformResponseHeaders: (
    headers: NodeHttp.IncomingHttpHeaders,
  ) => NodeHttp.OutgoingHttpHeaders;
  readonly onComplete?: (stats: { readonly status: number; readonly bytesOut: number }) => void;
}): Promise<void> {
  const { request, response } = options;
  request.pause();
  let peerSocket: NodeNet.Socket;
  try {
    peerSocket = await dialLoopbackSocket(options.port);
  } catch {
    if (!response.headersSent) response.writeHead(502);
    response.end();
    options.onComplete?.({ status: 502, bytesOut: 0 });
    return;
  }

  let settled = false;
  let bytesOut = 0;
  let statusCode = 502;
  const finish = (status: number) => {
    if (settled) return;
    settled = true;
    options.onComplete?.({ status, bytesOut });
  };

  const upstream = NodeHttp.request(
    {
      host: "127.0.0.1",
      port: options.port,
      method: request.method,
      path: options.path,
      headers: options.headers,
      agent: false,
      createConnection: () => peerSocket,
    },
    (result) => {
      statusCode = result.statusCode ?? 502;
      response.writeHead(statusCode, options.transformResponseHeaders(result.headers));
      result.on("data", (chunk: Buffer) => {
        bytesOut += chunk.length;
      });
      result.once("end", () => finish(statusCode));
      result.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
    finish(502);
  });
  request.on("aborted", () => {
    upstream.destroy();
    finish(statusCode);
  });
  response.on("close", () => {
    upstream.destroy();
    finish(statusCode);
  });
  if (request.readableEnded) {
    upstream.end();
  } else {
    request.resume();
    request.pipe(upstream);
  }
}

export async function proxyUpgradeRequest(options: {
  readonly request: NodeHttp.IncomingMessage;
  readonly socket: NodeStream.Duplex;
  readonly head: Buffer;
  readonly port: number;
  readonly path: string;
  readonly headers: NodeHttp.OutgoingHttpHeaders;
  readonly transformResponseHeaders: (
    headers: NodeHttp.IncomingHttpHeaders,
  ) => NodeHttp.OutgoingHttpHeaders;
  readonly onHandshake?: (stats: { readonly status: number }) => void;
  readonly onClose?: () => void;
}): Promise<NodeHttp.ClientRequest | null> {
  const { socket, head } = options;
  let peerSocket: NodeNet.Socket;
  try {
    peerSocket = await dialLoopbackSocket(options.port);
  } catch {
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    options.onHandshake?.({ status: 502 });
    return null;
  }

  const upstream = NodeHttp.request({
    host: "127.0.0.1",
    port: options.port,
    method: options.request.method,
    path: options.path,
    headers: options.headers,
    agent: false,
    createConnection: () => peerSocket,
  });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    upstream.destroy();
    options.onClose?.();
  };

  upstream.on("upgrade", (result, peer, upstreamHead) => {
    const responseHeaders = options.transformResponseHeaders(result.headers);
    const lines = Object.entries(responseHeaders).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(
        (item) => `${key}: ${item}`,
      ),
    );
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) peer.write(head);
    socket.pipe(peer);
    peer.pipe(socket);
    peer.on("error", () => socket.destroy());
    socket.once("close", () => peer.destroy());
    options.onHandshake?.({ status: 101 });
  });
  upstream.on("response", (result) => {
    result.resume();
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    options.onHandshake?.({ status: result.statusCode ?? 502 });
  });
  upstream.on("error", () => {
    socket.destroy();
    cleanup();
  });
  socket.on("error", () => upstream.destroy());
  socket.once("close", cleanup);
  upstream.end();
  return upstream;
}
