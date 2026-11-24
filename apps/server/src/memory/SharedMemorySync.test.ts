import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as SharedMemorySync from "./SharedMemorySync.ts";

const fixture = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2); const action = args[0];
const auth = process.platform === 'linux' ? path.join(process.env.HOME, '.config/obsidian-headless/auth_token') : path.join(process.env.HOME, '.obsidian-headless/auth_token');
if (action === 'login') {
  process.stdin.setRawMode(true); process.stdin.resume();
  const prompts = ['Email: ', 'Password: ', '2FA code: ']; const values = []; let value = '';
  process.stdout.write(prompts[0]);
  process.stdin.on('data', data => { for (const char of data.toString()) {
    if (char === '\\r') { values.push(value); value = ''; if (values.length === 3) {
      if (values.join('|') !== 'agent@example.com|password-secret|123456') process.exit(2);
      fs.mkdirSync(path.dirname(auth), { recursive: true }); fs.writeFileSync(auth, 'token-secret'); process.exit(0);
    } else process.stdout.write(prompts[values.length]); } else value += char;
  }});
} else {
  if (process.env.OBSIDIAN_AUTH_TOKEN !== 'token-secret') process.exit(2);
  if (action === 'sync') {
    const counter = path.join(process.env.HOME, 'sync-count');
    const count = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;
    fs.writeFileSync(counter, String(count));
    if (count === 2) process.exit(1);
  }
  if (action === 'sync-list-remote') console.log(JSON.stringify({ vaults: [{ id: 'vault-1', name: 'Memory', region: 'us' }], shared: [] }));
  if (action === 'sync-setup') fs.mkdirSync(args[args.indexOf('--path') + 1], { recursive: true });
}
`;

it.live(
  "logs in privately, persists only the token, initializes a pulled vault and stops on logout",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-shared-memory-" });
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const binary = `${config.stateDir}/fake-ob.cjs`;
        yield* fs.writeFileString(binary, fixture);
        yield* fs.chmod(binary, 0o700);
        const memoryLayer = SharedMemorySync.layer.pipe(
          Layer.provide(NodePtyAdapter.layer),
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(Layer.succeed(SharedMemorySync.Binary, binary)),
        );
        yield* Effect.gen(function* () {
          const memory = yield* SharedMemorySync.SharedMemorySync;
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          assert.equal((yield* memory.status).connected, false);
          yield* memory.command({
            action: "login",
            email: "agent@example.com",
            password: "password-secret",
            mfa: "123456",
          });
          const saved = yield* secrets.get("obsidian-shared-memory-token");
          assert.isTrue(Option.isSome(saved));
          if (Option.isSome(saved))
            assert.equal(Buffer.from(saved.value).toString(), "token-secret");
          const vaults = yield* memory.vaults;
          assert.equal(vaults.vaults[0]?.id, "vault-1");
          const restarted = yield* fs.watch(`${config.stateDir}/obsidian-headless-home`).pipe(
            Stream.filterEffect(() =>
              fs.readFileString(`${config.stateDir}/obsidian-headless-home/sync-count`).pipe(
                Effect.map((value) => Number(value) >= 3),
                Effect.orElseSucceed(() => false),
              ),
            ),
            Stream.runHead,
            Effect.forkScoped,
          );
          const state = yield* memory.command({
            action: "configure",
            vault: "vault-1",
            folder: "",
          });
          yield* Fiber.join(restarted);
          assert.isNotEmpty(state.agentId);
          assert.equal(state.enabled, false);
          assert.isUndefined(yield* memory.instructions);
          for (const name of ["agent.json", "MEMORY.md", "README.md", "issues", "notes"])
            assert.isTrue(yield* fs.exists(`${state.folder}/${name}`));
          const initialIdentity = yield* fs.readFileString(`${state.folder}/agent.json`);
          yield* memory.command({ action: "preferences", enabled: true, agentId: "" });
          assert.deepEqual(yield* memory.instructions, {
            folder: state.folder,
            agentId: state.agentId,
          });
          yield* memory.command({ action: "pause" });
          assert.equal((yield* memory.status).phase, "idle");
          yield* memory.command({ action: "configure", vault: "vault-1", folder: state.folder });
          yield* memory.command({ action: "pause" });
          assert.equal(yield* fs.readFileString(`${state.folder}/agent.json`), initialIdentity);
          yield* memory.command({ action: "resume" });
          yield* memory.command({ action: "pause" });
          assert.equal(yield* fs.readFileString(`${state.folder}/agent.json`), initialIdentity);
          const preferences = yield* fs.readFileString(`${config.stateDir}/shared-memory.json`);
          assert.notInclude(preferences, "password-secret");
          assert.notInclude(preferences, "token-secret");
          assert.notInclude(preferences, "123456");
          const loggedOut = yield* memory.command({ action: "logout" });
          assert.equal(loggedOut.connected, false);
          assert.isUndefined(yield* memory.instructions);
          assert.isTrue(Option.isNone(yield* secrets.get("obsidian-shared-memory-token")));
        }).pipe(Effect.provide(memoryLayer.pipe(Layer.provideMerge(ServerSecretStore.layer))));
      }).pipe(Effect.provide(configLayer));
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(NodeServices.layer, NodeCrypto.layer))),
);
