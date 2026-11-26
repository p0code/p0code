// @effect-diagnostics nodeBuiltinImport:off -- The integration test starts the real CLI and server in an isolated home.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NetService from "@t3tools/shared/Net";
import { assert, it } from "@effect/vitest";
import { GlobalFlag } from "effect/cli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { deriveServerPaths } from "../config.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { withPlugins } from "./plugin.ts";

const entry = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
const serverDir = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
const layer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  FetchHttpClient.layer,
);

it.live(
  "manages a fixture through the headless CLI and invokes its action and HTTP route on the running server",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "p0-plugin-cli-" });
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !/^(T3CODE_|P0CODE_|HHHCODE_|VITE_)/.test(name),
        ),
      );
      env.T3CODE_HOME = root;
      env.P0CODE_SECRET_BACKEND = "file";
      const server = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            [entry, "serve", "--base-dir", root, "--host", "127.0.0.1", "--no-browser"],
            { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] },
          );
          return child;
        }),
        (child) =>
          Effect.promise(async () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            await new Promise<void>((resolve) => {
              child.once("exit", () => resolve());
              child.kill("SIGTERM");
            });
          }),
      );
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            let output = "";
            const onOutput = (chunk: Buffer) => {
              output += chunk.toString();
              if (output.includes("p0code server is ready.")) resolve();
            };
            server.stdout.on("data", onOutput);
            server.stderr.on("data", onOutput);
            server.once("error", reject);
            server.once("exit", (code) =>
              reject(new Error(`Fixture server exited (${code}): ${output}`)),
            );
          }),
      );
      const cli = (args: ReadonlyArray<string>) =>
        Effect.promise(
          () =>
            new Promise<string>((resolve, reject) => {
              const child = NodeChildProcess.spawn(
                process.execPath,
                [entry, "plugin", ...args, "--base-dir", root],
                { cwd: serverDir, env, stdio: ["ignore", "pipe", "pipe"] },
              );
              let stdout = "";
              let stderr = "";
              child.stdout.on("data", (chunk: Buffer) => {
                stdout += chunk.toString();
              });
              child.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString();
              });
              child.once("error", reject);
              child.once("exit", (code) =>
                code === 0
                  ? resolve(stdout)
                  : reject(
                      new Error(`p0 plugin ${args[0]} failed (${code}): ${stderr}\n${stdout}`),
                    ),
              );
            }),
        );
      const fixture = (version: string) =>
        Effect.promise(async () => {
          const dir = NodePath.join(root, `fixture-${version}`);
          const manifest = {
            id: "cli-fixture",
            version,
            name: "CLI fixture",
            description: "Fixture",
            unofficial: true,
            capabilities: ["http:routes"],
            httpRoutes: ["/api/cli-fixture/ping"],
            externalServices: [],
          };
          await NodeFSP.mkdir(dir);
          await NodeFSP.writeFile(NodePath.join(dir, "manifest.json"), JSON.stringify(manifest));
          await NodeFSP.writeFile(
            NodePath.join(dir, "plugin.mjs"),
            `import * as Effect from 'effect/Effect'; import { PluginContext } from '@t3tools/plugin-api'; export default { manifest: ${JSON.stringify(manifest)}, start: Effect.gen(function* () { const context = yield* PluginContext; yield* context.storage.set('token', 'retained-secret'); return { invoke: () => Effect.succeed(${JSON.stringify(version)}), routes: new Map([['/api/cli-fixture/ping', () => Effect.succeed({ status: 200, body: ${JSON.stringify(version)} })]]) }; }) };`,
          );
          return dir;
        });
      const v1 = yield* fixture("1.0.0");
      assert.include(yield* cli(["add", v1, "--yes"]), "activated, disabled");
      const invoke = () =>
        withPlugins(Option.some(root), (client) =>
          Effect.gen(function* () {
            yield* client["plugins.setEnabled"]({ pluginId: "cli-fixture", enabled: true });
            return yield* client["plugins.invoke"]({
              pluginId: "cli-fixture",
              action: "echo",
              input: null,
            });
          }),
        );
      assert.equal(yield* invoke(), "1.0.0");
      const paths = yield* deriveServerPaths(root, undefined, { baseDirIsExplicit: true });
      const state = yield* readLiveServerRuntimeState(paths.serverRuntimeStatePath);
      assert.isTrue(Option.isSome(state));
      const origin = Option.getOrThrow(state).origin;
      const response = yield* HttpClient.execute(
        HttpClientRequest.post(`${origin}/api/cli-fixture/ping`).pipe(
          HttpClientRequest.setHeader("origin", origin),
        ),
      );
      assert.equal(response.status, 200);
      assert.equal(yield* response.json, "1.0.0");
      const v2 = yield* fixture("2.0.0");
      assert.include(yield* cli(["update", "cli-fixture", v2, "--yes"]), "2.0.0 activated");
      assert.equal(yield* invoke(), "2.0.0");
      assert.include(yield* cli(["rollback", "cli-fixture"]), "restored to 1.0.0");
      assert.equal(yield* invoke(), "1.0.0");
      assert.include(yield* cli(["list"]), '"origin": "bundled"');
      const data = NodePath.join(root, "userdata", "plugins", "cli-fixture", "keep");
      yield* fs.writeFileString(data, "retained");
      assert.include(yield* cli(["remove", "cli-fixture"]), "data retained");
      assert.equal(yield* fs.readFileString(data), "retained");
      const secret = NodePath.join(root, "userdata", "secrets", "plugin-cli-fixture-token.bin");
      assert.equal(yield* fs.readFileString(secret), "retained-secret");
      assert.include(yield* cli(["remove", "cli-fixture", "--purge-data"]), "data purged");
      assert.isFalse(yield* fs.exists(data));
      assert.isFalse(yield* fs.exists(secret));
    }).pipe(
      Effect.scoped,
      Effect.provideService(GlobalFlag.LogLevel, Option.none()),
      Effect.provide(layer),
    ),
);
