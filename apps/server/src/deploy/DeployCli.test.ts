import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { createCloudflareDeployProvider } from "@t3tools/deploy-cloudflare";
import { createVercelDeployProvider } from "@t3tools/deploy-vercel";
import type { DeployProviderStorage } from "@t3tools/plugin-api";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as DeployCli from "./DeployCli.ts";

const platform = Layer.mergeAll(
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
  NodeCrypto.layer,
  NodeServices.layer,
);

const token = "fake-oauth-credential-never-persisted";
const storage: DeployProviderStorage = {
  get: () => Effect.die("CLI deployments should not read stored credentials"),
  set: () => Effect.die("CLI deployments should not write stored credentials"),
  remove: () => Effect.die("CLI deployments should not delete stored credentials"),
};

const installFakeCli = Effect.fn("DeployCli.test.installFakeCli")(function* (
  provider: "vercel" | "cloudflare",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "p0-deploy-cli-test-" });
  const binary = path.join(root, provider === "vercel" ? "vercel" : "wrangler");
  const state = path.join(root, "state.json");
  const env = { HOME: root, PATH: root, XDG_DATA_HOME: root };
  const source = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)};
const token = ${JSON.stringify(token)};
const isVercel = ${provider === "vercel"};
const account = { id: "team_test", name: "Test Team" };
if (args[0] === 'login') {
  if (fs.existsSync(state + ".hang")) {
    setInterval(() => {}, 5000);
  } else {
    if (isVercel) {
      const dir = args[2];
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ token }));
    }
    fs.writeFileSync(state, JSON.stringify({ username: "test-user", email: "test@example.test" }));
    console.error("private CLI output " + token);
  }
} else if (!fs.existsSync(state)) {
  console.error("private CLI output " + token);
  process.exitCode = 1;
} else if (args[0] === "whoami") {
  const identity = JSON.parse(fs.readFileSync(state));
  console.log(JSON.stringify(isVercel ? { ...identity, team: account } : {
    loggedIn: true, authType: "OAuth Token", email: identity.email, accounts: [account]
  }));
} else if (args[0] === "auth" && args[1] === "token") {
  console.log(JSON.stringify({ type: "oauth", token }));
} else {
  process.exitCode = 2;
}
`;
  const install = fs.writeFileString(binary, source).pipe(Effect.andThen(fs.chmod(binary, 0o700)));
  const cli = yield* DeployCli.make(provider).pipe(
    Effect.provideService(HostProcess.Environment, env),
  );
  return { cli, install, state };
});

describe("deploy CLI authentication", () => {
  for (const provider of ["vercel", "cloudflare"] as const) {
    it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
      `${provider} deploys with the CLI's own session`,
      () =>
        Effect.gen(function* () {
          const { cli, install, state } = yield* installFakeCli(provider);
          const fs = yield* FileSystem.FileSystem;
          expect(yield* cli.status()).toEqual({ state: "missing" });
          yield* install;
          expect(yield* cli.status()).toEqual({ state: "signed-out" });
          yield* cli.login();
          const status = yield* cli.status();
          expect(status).toEqual({ state: "signed-in", label: "Test Team", teamId: "team_test" });
          const identity = yield* cli.session();
          expect(JSON.stringify(identity)).not.toContain(token);
          const account = {
            accountId: "local-account",
            cliSubject: identity.subject,
            teamId: "team_test",
          };

          const api = HttpClient.make((request) =>
            Effect.sync(() => {
              expect(request.headers.authorization).toBe(`Bearer ${token}`);
              const route = new URL(request.url);
              let payload: unknown;
              if (provider === "cloudflare") {
                expect(route.pathname).toBe(
                  "/client/v4/accounts/team_test/pages/projects/web/deployments",
                );
                payload = {
                  success: true,
                  result: { id: "deploy_test", url: "https://test.pages.dev" },
                };
              } else {
                expect(route.searchParams.get("teamId")).toBe("team_test");
                payload =
                  request.method === "GET"
                    ? { id: "web", name: "web", link: { type: "github", repoId: 42 } }
                    : { id: "deploy_test", url: "test.vercel.app" };
              }
              return HttpClientResponse.fromWeb(request, Response.json(payload));
            }),
          );
          const adapter = yield* (
            provider === "vercel"
              ? createVercelDeployProvider({ storage, cliSession: cli.session })
              : createCloudflareDeployProvider({ storage, cliSession: cli.session })
          ).pipe(Effect.provideService(HttpClient.HttpClient, api));
          const result = yield* adapter.deploy({
            account,
            target: {
              kind: provider === "vercel" ? "vercel-project" : "pages",
              id: "web",
            },
            environment: "preview",
            source: { kind: "git", branch: "feature" },
          });
          expect(result.deploymentId).toContain("deploy_test");
          expect(JSON.stringify(result)).not.toContain(token);

          yield* fs.writeFileString(
            state,
            JSON.stringify({ username: "different", email: "other@example.test" }),
          );
          expect((yield* adapter.status(account)).state).toBe("expired");
          const error = yield* Effect.flip(cli.session(account));
          expect(error.message).not.toContain(token);
        }).pipe(Effect.scoped, Effect.provide(platform)),
    );
  }

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "releases the login slot after canceling or timing out",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runner = yield* ProcessRunner.ProcessRunner;
        const started = yield* Deferred.make<void>();
        let shortDeadline = false;
        const { cli, install, state } = yield* installFakeCli("vercel").pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, {
            run: (input) =>
              runner.run({
                ...input,
                ...(shortDeadline ? { timeout: "5 millis" } : {}),
                onSpawn: () => Deferred.doneUnsafe(started, Effect.void),
              }),
          }),
        );
        yield* install;
        yield* fs.writeFileString(state + ".hang", "");
        const login = yield* cli.login().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(login);
        shortDeadline = true;
        const timeout = yield* Effect.flip(cli.login());
        expect(timeout.message).toContain("sign-in timed out");
        shortDeadline = false;
        yield* fs.remove(state + ".hang");
        yield* cli.login();
        expect((yield* cli.status()).state).toBe("signed-in");
      }).pipe(Effect.scoped, Effect.provide(platform)),
  );
});
