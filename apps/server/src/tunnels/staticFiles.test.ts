// Native filesystem and HTTP server fixtures exercise traversal, symlink, and pinning defenses.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  isDeniedPublicTunnelPath,
  serveStaticTunnelRequest,
  validateStaticTarget,
} from "./staticFiles.ts";

async function withTempDirs<T>(
  run: (dirs: { root: string; served: string; outside: string }) => Promise<T>,
): Promise<T> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p0-static-test-"));
  const served = NodePath.join(root, "served");
  const outside = NodePath.join(root, "outside");
  await NodeFSP.mkdir(NodePath.join(served, "sub"), { recursive: true });
  await NodeFSP.mkdir(outside, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "TOP_SECRET", "utf8");
  await NodeFSP.writeFile(NodePath.join(served, "index.html"), "<h1>Index</h1>", "utf8");
  await NodeFSP.writeFile(NodePath.join(served, "sub", "app.js"), "console.log('ok');", "utf8");
  await NodeFSP.writeFile(NodePath.join(served, ".env"), "SECRET_KEY=1", "utf8");
  await NodeFSP.writeFile(NodePath.join(served, "sub", ".hidden"), "hidden", "utf8");
  await NodeFSP.writeFile(NodePath.join(served, "blob.custombin"), "binarydata", "utf8");
  await NodeFSP.symlink(
    NodePath.join(outside, "secret.txt"),
    NodePath.join(served, "symlink-out.txt"),
  );
  await NodeFSP.symlink(
    NodePath.join(served, "sub", "app.js"),
    NodePath.join(served, "symlink-in.js"),
  );
  try {
    return await run({ root, served, outside });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

async function sendStaticRequest(
  serverHandler: (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => Promise<void>,
  method: string,
  rawUrl: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: NodeHttp.IncomingHttpHeaders; body: string }> {
  const server = NodeHttp.createServer((req, res) => {
    void serverHandler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Missing server address");
  }
  try {
    return await new Promise((resolve, reject) => {
      const req = NodeHttp.request(
        {
          host: "127.0.0.1",
          port: address.port,
          method,
          path: rawUrl,
          headers,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

it("blocks the traversal corpus while permitting in-root symlinks and detecting swapped folders", async () => {
  await withTempDirs(async ({ root, served }) => {
    const validated = await validateStaticTarget(
      { kind: "folder", path: served },
      {
        stateDir: NodePath.join(root, "state"),
        secretsDir: NodePath.join(root, "secrets"),
        homeDir: NodePath.join(root, "home"),
      },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const target = {
      kind: "folder" as const,
      path: validated.canonicalPath,
      listing: true,
      spa: false,
    };
    const serve = (urlPath: string, method = "GET", headers?: Record<string, string>) =>
      sendStaticRequest(
        async (req, res) => {
          await serveStaticTunnelRequest({
            request: req,
            response: res,
            target,
            rawSubpath: urlPath,
          });
        },
        method,
        urlPath,
        headers,
      );

    expect((await serve("/")).status).toBe(200);
    expect((await serve("/sub/app.js")).status).toBe(200);
    expect((await serve("/symlink-in.js")).status).toBe(200);

    // Traversal variants, encoding attacks, dotfiles, outside symlink, and disallowed methods
    const cases: Array<{ path: string; method?: string; statuses: number[] }> = [
      { path: "/../outside/secret.txt", statuses: [403] },
      { path: "/sub/../../outside/secret.txt", statuses: [403] },
      { path: "/%2e%2e/outside/secret.txt", statuses: [403] },
      { path: "/%2E%2E/outside/secret.txt", statuses: [403] },
      { path: "/%252e%252e/outside/secret.txt", statuses: [400] },
      { path: "/sub/%2f..%2f..%2foutside/secret.txt", statuses: [400] },
      { path: "/..\\outside\\secret.txt", statuses: [400] },
      { path: "/%5c..%5coutside%5csecret.txt", statuses: [400] },
      { path: "/index.html%00.png", statuses: [400] },
      { path: "/.env", statuses: [403] },
      { path: "/%2eenv", statuses: [403] },
      { path: "/sub/.hidden", statuses: [403] },
      { path: "/symlink-out.txt", statuses: [403] },
      { path: "/index.html", method: "POST", statuses: [405] },
    ];
    for (const testCase of cases) {
      const response = await serve(testCase.path, testCase.method ?? "GET");
      expect(testCase.statuses, `${testCase.method ?? "GET"} ${testCase.path}`).toContain(
        response.status,
      );
      expect(response.body).not.toContain("TOP_SECRET");
      expect(response.body).not.toContain("SECRET_KEY");
    }

    // Swapped folder root returns 410 Gone
    const swappedPath = NodePath.join(root, "served-swapped");
    const replacement = NodePath.join(root, "replacement");
    await NodeFSP.mkdir(replacement, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(replacement, "index.html"), "swapped", "utf8");
    await NodeFSP.rename(served, swappedPath);
    await NodeFSP.symlink(replacement, served);
    const swappedResponse = await serve("/");
    expect(swappedResponse.status).toBe(410);
    await NodeFSP.unlink(served);
    await NodeFSP.rename(swappedPath, served);
  });
});

it("sandboxes single-file HTML/SVG unless runAsPage is enabled and detects replaced files (410)", async () => {
  await withTempDirs(async ({ root, served }) => {
    const htmlPath = NodePath.join(served, "widget.html");
    await NodeFSP.writeFile(htmlPath, "<script>1</script>", "utf8");
    const roots = {
      stateDir: NodePath.join(root, "state"),
      secretsDir: NodePath.join(root, "secrets"),
      homeDir: NodePath.join(root, "home"),
    };
    const validated = await validateStaticTarget({ kind: "file", path: htmlPath }, roots);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const sandboxed = await sendStaticRequest(
      async (req, res) => {
        await serveStaticTunnelRequest({
          request: req,
          response: res,
          target: { kind: "file", path: validated.canonicalPath, runAsPage: false },
          rawSubpath: "/",
          ...(validated.identity ? { pinnedIdentity: validated.identity } : {}),
        });
      },
      "GET",
      "/",
    );
    expect(sandboxed.status).toBe(200);
    expect(sandboxed.headers["content-security-policy"]).toBe("sandbox");
    expect(sandboxed.headers["x-robots-tag"]).toBe("noindex, nofollow");

    const asPage = await sendStaticRequest(
      async (req, res) => {
        await serveStaticTunnelRequest({
          request: req,
          response: res,
          target: { kind: "file", path: validated.canonicalPath, runAsPage: true },
          rawSubpath: "/",
          ...(validated.identity ? { pinnedIdentity: validated.identity } : {}),
        });
      },
      "GET",
      "/",
    );
    expect(asPage.status).toBe(200);
    expect(asPage.headers["content-security-policy"]).toBeUndefined();

    // Unknown file extension serves as attachment
    const binValidated = await validateStaticTarget(
      { kind: "file", path: NodePath.join(served, "blob.custombin") },
      roots,
    );
    expect(binValidated.ok).toBe(true);
    if (binValidated.ok) {
      const binRes = await sendStaticRequest(
        async (req, res) => {
          await serveStaticTunnelRequest({
            request: req,
            response: res,
            target: { kind: "file", path: binValidated.canonicalPath },
            rawSubpath: "/",
            ...(binValidated.identity ? { pinnedIdentity: binValidated.identity } : {}),
          });
        },
        "GET",
        "/",
      );
      expect(binRes.status).toBe(200);
      expect(binRes.headers["content-disposition"]).toContain("attachment");
    }

    // Replace file with a new inode -> 410 Gone
    const replacement = NodePath.join(served, "widget.tmp");
    await NodeFSP.writeFile(replacement, "<p>replaced</p>", "utf8");
    await NodeFSP.rename(replacement, validated.canonicalPath);
    const replacedRes = await sendStaticRequest(
      async (req, res) => {
        await serveStaticTunnelRequest({
          request: req,
          response: res,
          target: { kind: "file", path: validated.canonicalPath },
          rawSubpath: "/",
          ...(validated.identity ? { pinnedIdentity: validated.identity } : {}),
        });
      },
      "GET",
      "/",
    );
    expect(replacedRes.status).toBe(410);
  });
});

it("refuses denylist roots, state/secrets directories, home directories, and symlinks into denied paths", async () => {
  await withTempDirs(async ({ root, served }) => {
    const fakeHome = NodePath.join(root, "home");
    const roots = {
      stateDir: NodePath.join(root, "state"),
      secretsDir: NodePath.join(root, "secrets"),
      homeDir: fakeHome,
    };
    const deniedCandidates = [
      "/",
      fakeHome,
      roots.stateDir,
      roots.secretsDir,
      NodePath.join(fakeHome, ".p0code"),
      NodePath.join(fakeHome, ".t3", "userdata"),
      NodePath.join(fakeHome, ".ssh"),
      NodePath.join(fakeHome, ".aws", "credentials"),
      NodePath.join(fakeHome, ".config", "gcloud"),
      NodePath.join(fakeHome, ".gnupg"),
    ];
    for (const candidate of deniedCandidates) {
      expect(await isDeniedPublicTunnelPath(candidate, roots), candidate).toBe(true);
    }

    await NodeFSP.mkdir(NodePath.join(fakeHome, ".ssh"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(fakeHome, ".ssh", "id_ed25519"), "KEY", "utf8");
    const sshLink = NodePath.join(served, "ssh-link");
    await NodeFSP.symlink(NodePath.join(fakeHome, ".ssh", "id_ed25519"), sshLink);
    expect(await isDeniedPublicTunnelPath(sshLink, roots)).toBe(true);
    const validation = await validateStaticTarget({ kind: "file", path: sshLink }, roots);
    expect(validation).toMatchObject({ ok: false, reason: "denied" });
  });
});
