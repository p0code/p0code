// Node stream adapter must preserve HTTP upgrades and TLS socket identity.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import type * as NodeTls from "node:tls";
import type { StreamLabel } from "@t3tools/relay-tunnel/mux";

const COOKIE = "__Host-hhh-port";
function applicationHeaders(headers: NodeHttp.IncomingHttpHeaders) {
  const result = { ...headers };
  if (result.cookie) {
    const cookie = result.cookie
      .split(";")
      .filter((part) => part.trim().split("=", 1)[0] !== COOKIE)
      .map((part) => part.trim())
      .join("; ");
    if (cookie.trim()) result.cookie = cookie;
    else delete result.cookie;
  }
  return result;
}
function responseHeaders(headers: NodeHttp.IncomingHttpHeaders) {
  const result = { ...headers };
  if (result["set-cookie"])
    result["set-cookie"] = result["set-cookie"].filter(
      (cookie) => cookie.split("=", 1)[0]?.trim() !== COOKIE,
    );
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
      const upstream = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: auth.port,
          method: request.method,
          path: auth.path,
          headers: { ...applicationHeaders(request.headers), host: `127.0.0.1:${auth.port}` },
        },
        (result) => {
          response.writeHead(result.statusCode ?? 502, responseHeaders(result.headers));
          result.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.on("aborted", () => upstream.destroy());
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
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
        const upstream = NodeHttp.request({
          host: "127.0.0.1",
          port: auth.port,
          method: request.method,
          path: auth.path,
          headers: { ...applicationHeaders(request.headers), host: `127.0.0.1:${auth.port}` },
        });
        upstream.on("upgrade", (result, peer, upstreamHead) => {
          const headers = responseHeaders(result.headers);
          if (auth.suppliedToken)
            headers["set-cookie"] = [...(headers["set-cookie"] ?? []), cookieHeader(auth.token)];
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n${Object.entries(headers)
              .flatMap(([key, value]) =>
                (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(
                  (item) => `${key}: ${item}`,
                ),
              )
              .join("\r\n")}\r\n\r\n`,
          );
          if (upstreamHead.length) socket.write(upstreamHead);
          if (head.length) peer.write(head);
          socket.pipe(peer);
          peer.pipe(socket);
          peer.on("error", () => socket.destroy());
          socket.once("close", () => peer.destroy());
        });
        upstream.on("response", (result) => {
          result.resume();
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        socket.once("close", () => {
          clearInterval(timer);
          upstream.destroy();
        });
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
        upstream.end();
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
