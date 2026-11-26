// Node stream adapter must preserve HTTP upgrades and TLS socket identity.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import type * as NodeTls from "node:tls";
import type { StreamLabel } from "@t3tools/relay-tunnel/mux";
import {
  filterSetCookieHeaders,
  proxyHttpRequest,
  proxyUpgradeRequest,
  stripCookiesFromHeader,
  stripHopByHopHeaders,
} from "./loopbackProxy.ts";

const COOKIE = "__Host-hhh-port";
const COOKIE_NAMES = new Set([COOKIE]);

function applicationHeaders(
  headers: NodeHttp.IncomingHttpHeaders,
  options?: { readonly keepUpgrade?: boolean },
): NodeHttp.OutgoingHttpHeaders {
  const result = stripHopByHopHeaders(headers, options);
  const cookie = stripCookiesFromHeader(headers.cookie, (name) => COOKIE_NAMES.has(name));
  if (cookie) result.cookie = cookie;
  else delete result.cookie;
  return result;
}

function responseHeaders(
  headers: NodeHttp.IncomingHttpHeaders,
  options?: { readonly keepUpgrade?: boolean },
): NodeHttp.OutgoingHttpHeaders {
  const result = stripHopByHopHeaders(headers, options);
  const filtered = filterSetCookieHeaders(headers["set-cookie"], { dropNames: COOKIE_NAMES });
  if (filtered !== undefined) result["set-cookie"] = filtered;
  return result;
}

/** Node HTTP adapter: the application supplies current environment authorization. */
export function createPortProxy(options: {
  authorize: (port: number, token: string) => Promise<boolean>;
  publicOrigin: () => Promise<string | null>;
}) {
  const ports = new WeakMap<NodeNet.Socket, number>();
  const sockets = new Set<NodeNet.Socket>();
  const authenticate = async (request: NodeHttp.IncomingMessage, upgrade = false) => {
    const port = ports.get(request.socket);
    if (!port) return null;
    const environmentOrigin = await options.publicOrigin();
    if (!environmentOrigin) return null;
    const origin = new URL(environmentOrigin);
    origin.hostname = `${port}-${origin.hostname}`;
    // Cookie SameSite does not isolate sibling environment and forwarded hosts.
    if (request.headers.origin !== undefined && request.headers.origin !== origin.origin)
      return null;
    if (
      request.headers.origin === undefined &&
      request.headers["sec-fetch-site"] !== undefined &&
      (upgrade || !["GET", "HEAD", "OPTIONS"].includes(request.method ?? ""))
    )
      return null;
    const url = new URL(request.url ?? "/", origin);
    const token =
      url.searchParams.get("t") ??
      request.headers.cookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${COOKIE}=`))
        ?.slice(COOKIE.length + 1);
    if (!token || token.length > 4096 || !(await options.authorize(port, token))) return null;
    const suppliedToken = url.searchParams.has("t");
    url.searchParams.delete("t");
    return { port, token, suppliedToken, path: `${url.pathname}${url.search}` };
  };
  const cookieHeader = (token: string) =>
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      const auth = await authenticate(request);
      if (!auth) {
        const origin = await options.publicOrigin();
        response
          .writeHead(origin ? 303 : 401, {
            ...(origin ? { location: origin + "/settings/access" } : {}),
            "cache-control": "no-store",
          })
          .end("Port authorization required.");
        return;
      }
      if (auth.suppliedToken) {
        response
          .writeHead(303, {
            location: auth.path,
            "set-cookie": cookieHeader(auth.token),
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          })
          .end();
        return;
      }
      await proxyHttpRequest({
        request,
        response,
        port: auth.port,
        path: auth.path,
        headers: { ...applicationHeaders(request.headers), host: `127.0.0.1:${auth.port}` },
        transformResponseHeaders: (upstreamHeaders) => responseHeaders(upstreamHeaders),
      });
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  server.on("upgrade", (request, socket, head) => {
    void authenticate(request, true)
      .then((auth) => {
        if (!auth) {
          socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          return;
        }
        // Upgraded connections must lose access when their granting session expires or is revoked.
        // @effect-diagnostics-next-line globalTimers:off -- Native upgraded sockets need ongoing grant validation.
        const timer = setInterval(() => {
          void options.authorize(auth.port, auth.token).then(
            (valid) => {
              if (!valid) socket.destroy();
            },
            () => socket.destroy(),
          );
        }, 1000);
        timer.unref();
        void proxyUpgradeRequest({
          request,
          socket,
          head,
          port: auth.port,
          path: auth.path,
          headers: {
            ...applicationHeaders(request.headers, { keepUpgrade: true }),
            host: `127.0.0.1:${auth.port}`,
          },
          transformResponseHeaders: (upstreamHeaders) => {
            const headers = responseHeaders(upstreamHeaders, { keepUpgrade: true });
            if (auth.suppliedToken) {
              const existing = Array.isArray(headers["set-cookie"])
                ? headers["set-cookie"]
                : typeof headers["set-cookie"] === "string"
                  ? [headers["set-cookie"]]
                  : [];
              headers["set-cookie"] = [...existing, cookieHeader(auth.token)];
            }
            return headers;
          },
          onClose: () => clearInterval(timer),
        });
      })
      .catch(() => socket.destroy());
  });
  return {
    accept(socket: NodeTls.TLSSocket, metadata: StreamLabel) {
      if (metadata.port === undefined) {
        socket.destroy();
        return;
      }
      ports.set(socket, metadata.port);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      server.emit("connection", socket);
    },
    close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
    },
  };
}
