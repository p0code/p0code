// @effect-diagnostics nodeBuiltinImport:off -- Native proxy integration exercises real HTTP and upgraded sockets.
import * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import type * as NodeTls from "node:tls";
import WebSocket, { WebSocketServer } from "ws";
import { expect, it, vi } from "vite-plus/test";
import { createPortProxy } from "./portProxy.ts";

it("isolates forwarded origins, preserves app authentication, accepts WS token grants, and revokes live upgrades", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let valid = true;
  let requests = 0;
  const app = NodeHttp.createServer((req, res) => {
    requests++;
    res.setHeader("set-cookie", ["app=ok; Path=/", "__Host-hhh-port=overwrite; Path=/; Secure"]);
    res.end(
      JSON.stringify({ cookie: req.headers.cookie, authorization: req.headers.authorization }),
    );
  });
  const upgrades = new WebSocketServer({ server: app });
  const proxy = createPortProxy({
    publicOrigin: async () => "https://abcdef.relay.test",
    authorize: async (_, token) => valid && token === "grant",
  });
  app.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(app, "listening");
  const address = app.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const port = address.port;
  const origin = `https://${port}-abcdef.relay.test`;
  const listener = NodeNet.createServer();
  listener.on("connection", (socket) =>
    proxy.accept(socket as NodeTls.TLSSocket, { label: `${port}-abcdef`, port, kind: "tls" }),
  );
  listener.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(listener, "listening");
  const bound = listener.address();
  if (!bound || typeof bound === "string") throw new Error("Missing address");
  const request = (method: string, headers: NodeHttp.OutgoingHttpHeaders) =>
    new Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const req = NodeHttp.request(
          { host: "127.0.0.1", port: bound.port, method, headers, agent: false },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
  let ws: WebSocket | undefined;
  try {
    const headers = {
      cookie: "__Host-hhh-port=grant; app=session",
      authorization: "Bearer app-token",
      origin,
    };
    const success = await request("POST", headers);
    expect(success.status).toBe(200);
    expect(JSON.parse(success.body)).toEqual({
      cookie: "app=session",
      authorization: "Bearer app-token",
    });
    expect(success.headers["set-cookie"]).toEqual(["app=ok; Path=/"]);
    for (const malicious of ["https://other.relay.test", "null", "https://abcdef.relay.test"]) {
      expect((await request("POST", { ...headers, origin: malicious })).status).toBe(303);
    }
    expect(requests).toBe(1);
    const rejected = new WebSocket(`ws://127.0.0.1:${bound.port}/`, {
      headers: { ...headers, origin: "https://other.relay.test" },
    });
    const status = new Promise<number>((resolve) =>
      rejected.once("unexpected-response", (_, res) => {
        resolve(res.statusCode ?? 0);
        res.destroy();
        rejected.terminate();
      }),
    );
    rejected.on("error", () => {});
    expect(await status).toBe(401);
    ws = new WebSocket(`ws://127.0.0.1:${bound.port}/?t=grant`, {
      headers: { origin, cookie: "app=session", authorization: "Bearer app-token" },
    });
    const upgraded = new Promise<NodeHttp.IncomingMessage>((resolve) =>
      ws!.once("upgrade", resolve),
    );
    const opened = NodeEvents.EventEmitter.once(ws, "open");
    expect((await upgraded).headers["set-cookie"]?.[0]).toContain("__Host-hhh-port=grant");
    await opened;
    const closed = NodeEvents.EventEmitter.once(ws, "close");
    valid = false;
    await vi.advanceTimersByTimeAsync(1000);
    await closed;
  } finally {
    ws?.terminate();
    proxy.close();
    upgrades.close();
    app.closeAllConnections();
    await Promise.all(
      [app, listener].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    vi.useRealTimers();
  }
});
