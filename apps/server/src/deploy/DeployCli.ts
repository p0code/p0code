import * as NodeOS from "node:os";

import type { DeployAccountRef, DeployCliStatus } from "@t3tools/contracts";
import { PluginError } from "@t3tools/plugin-api";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPaths } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ProcessRunner } from "../processRunner.ts";

const json = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  Schema.decodeUnknownOption(Schema.fromJsonString(schema));

const SafeId = Schema.String.check(Schema.isPattern(/^[\w-]{1,128}$/));
const IdentityText = Schema.String.check(Schema.isPattern(/^[^\p{C}]{1,200}$/u));
const VercelIdentity = json(
  Schema.Struct({
    username: SafeId,
    team: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: SafeId, name: IdentityText }))),
  }),
);
const VercelConfig = json(Schema.Struct({ currentTeam: Schema.optionalKey(SafeId) }));
const VercelAuth = json(Schema.Struct({ token: Schema.String }));
const WranglerIdentity = json(
  Schema.Struct({
    loggedIn: Schema.Literal(true),
    authType: Schema.Literal("OAuth Token"),
    email: IdentityText,
    accounts: Schema.Array(Schema.Struct({ id: SafeId, name: IdentityText })),
  }),
);
const WranglerAuth = json(Schema.Struct({ type: Schema.Literal("oauth"), token: Schema.String }));

export const make = Effect.fn("DeployCli.make")(function* (provider: "vercel" | "cloudflare") {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner;
  const platform = yield* HostProcess.Platform;
  const hostEnv = yield* HostProcess.Environment;
  const lock = yield* Semaphore.make(1);
  const digest = yield* Digest.Digest;
  const subjectOf = (name: string) =>
    digest
      .digest(Digest.sha256, new TextEncoder().encode(name.toLowerCase()))
      .pipe(Effect.map(Hex.encode));
  const command = provider === "vercel" ? "vercel" : "wrangler";
  const name = provider === "vercel" ? "Vercel CLI" : "Wrangler";
  const home = (platform === "win32" ? hostEnv.USERPROFILE : hostEnv.HOME) || NodeOS.homedir();
  const dataHome =
    hostEnv.XDG_DATA_HOME ||
    (platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? path.join(hostEnv.APPDATA || path.join(home, "AppData", "Roaming"), "xdg.data")
        : path.join(home, ".local", "share"));
  const defaultConfig = path.resolve(dataHome, "com.vercel.cli");
  const missing = { state: "missing" } as const;
  const signedOut = { state: "signed-out" } as const;
  const failed = { state: "error" } as const;
  const error = (message: string) => new PluginError({ message });

  const executable = resolveCommandPaths(command, { env: hostEnv, until: () => true }).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.map(([found]) => found),
    Effect.timeoutOption("2 seconds"),
    Effect.map(Option.getOrUndefined),
  );

  const withCli = Effect.fn("DeployCli.withCli")(function* (binary: string) {
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "p0-deploy-cli-" });
    const legacyConfig = path.join(home, ".now");
    const configDir =
      provider === "vercel" &&
      !(yield* fs.exists(defaultConfig)) &&
      (yield* fs.exists(legacyConfig))
        ? legacyConfig
        : defaultConfig;

    const readVercelFile = Effect.fn("DeployCli.readVercelFile")(
      function* (file: "auth.json" | "config.json") {
        const root = yield* fs.realPath(configDir);
        const resolved = yield* fs.realPath(path.join(root, file));
        if (path.dirname(resolved) !== root) return "";
        const info = yield* fs.stat(resolved);
        if (info.type !== "File" || info.size > 64_000n) return "";
        return yield* fs.readFileString(resolved);
      },
      Effect.orElseSucceed(() => ""),
    );

    const run = (args: ReadonlyArray<string>, login = false) =>
      runner.run({
        command: binary,
        args: provider === "vercel" ? [...args, "--global-config", configDir] : args,
        cwd,
        timeout: login ? "3 minutes" : "8 seconds",
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 128 * 1024,
        env: {
          CI: login ? undefined : "true",
          NO_COLOR: "1",
          VERCEL_TOKEN: undefined,
          VERCEL_TELEMETRY_DISABLED: "1",
          CLOUDFLARE_API_TOKEN: undefined,
          CLOUDFLARE_API_KEY: undefined,
          CLOUDFLARE_EMAIL: undefined,
          CLOUDFLARE_ACCOUNT_ID: undefined,
          WRANGLER_API_TOKEN: undefined,
          WRANGLER_LOG: "none",
          WRANGLER_LOG_SANITIZE: "true",
          WRANGLER_WRITE_LOGS: "false",
          WRANGLER_SEND_METRICS: "false",
        },
      });

    const session = Effect.fn("DeployCli.session")(function* (teamId?: string) {
      if (provider === "vercel") {
        const result = yield* run(["whoami", "--format", "json", "--non-interactive"]);
        if (result.timedOut) return failed;
        if (result.code !== 0) return signedOut;
        const identity = Option.getOrUndefined(VercelIdentity(result.stdout));
        if (!identity) return failed;
        const auth = Option.getOrUndefined(VercelAuth(yield* readVercelFile("auth.json")));
        if (!auth?.token.trim()) return signedOut;
        const currentTeam =
          identity.team === undefined
            ? Option.getOrUndefined(VercelConfig(yield* readVercelFile("config.json")))?.currentTeam
            : identity.team?.id;
        return {
          state: "signed-in" as const,
          label: identity.team?.name ?? identity.username,
          teamId: currentTeam ?? null,
          subject: yield* subjectOf(identity.username),
          token: Redacted.make(auth.token),
        };
      }

      const result = yield* run(["whoami", "--json"]);
      if (result.timedOut) return failed;
      if (result.code !== 0) return signedOut;
      const identity = Option.getOrUndefined(WranglerIdentity(result.stdout));
      if (!identity) return failed;
      const account = teamId
        ? identity.accounts.find((item) => item.id === teamId)
        : identity.accounts[0];
      if (!account) return signedOut;
      const credentials = yield* run(["auth", "token", "--json"]);
      if (credentials.timedOut) return failed;
      if (credentials.code !== 0) return failed;
      const auth = Option.getOrUndefined(WranglerAuth(credentials.stdout));
      if (!auth?.token.trim()) return signedOut;
      return {
        state: "signed-in" as const,
        label: account.name,
        teamId: account.id,
        subject: yield* subjectOf(identity.email),
        token: Redacted.make(auth.token),
      };
    });

    return { run, session };
  });

  const probe = Effect.fn("DeployCli.probe")(
    function* (teamId: string | undefined) {
      const binary = yield* executable;
      if (!binary) return missing;
      const cli = yield* withCli(binary);
      return yield* cli.session(teamId);
    },
    Effect.scoped,
    lock.withPermits(1),
    Effect.timeout("9 seconds"),
    Effect.orElseSucceed(() => failed),
  );

  const status = Effect.fn("DeployCli.status")(function* (): Effect.fn.Return<DeployCliStatus> {
    const session = yield* probe(undefined);
    if (session.state !== "signed-in") return session;
    return { state: "signed-in", label: session.label, teamId: session.teamId };
  });

  const login = Effect.fn("DeployCli.login")(
    function* () {
      const binary = yield* executable;
      if (!binary) return yield* error(`Install ${name} on the deploy host first.`);
      const cli = yield* withCli(binary).pipe(
        Effect.mapError(() => error(`Could not start ${name} sign-in.`)),
      );
      const result = yield* cli
        .run(["login"], true)
        .pipe(Effect.mapError(() => error(`Could not run ${name} sign-in.`)));
      if (result.timedOut) return yield* error(`${name} sign-in timed out. Try again.`);
      if (result.code !== 0) return yield* error(`${name} sign-in did not finish. Try again.`);
    },
    Effect.scoped,
    lock.withPermitsIfAvailable(1),
    Effect.flatMap((result) =>
      Option.isSome(result) ? Effect.void : Effect.fail(error(`${name} is busy. Try again.`)),
    ),
  );

  const session = Effect.fn("DeployCli.linkSession")(function* (account?: DeployAccountRef) {
    const current = yield* probe(account?.teamId);
    if (current.state === "missing")
      return yield* error(`Install ${name} on the deploy host first.`);
    if (current.state === "error") {
      return yield* error(`Could not check the ${name} session. Update the CLI and try again.`);
    }
    if (
      current.state !== "signed-in" ||
      (account?.cliSubject !== undefined && current.subject !== account.cliSubject)
    ) {
      return yield* error(`Sign in to the linked account with ${name} on the deploy host.`);
    }
    return current;
  });

  return { status, login, session };
});

export type DeployCli = Effect.Success<ReturnType<typeof make>>;
