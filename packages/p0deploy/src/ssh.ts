import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { SSH_CONNECTION_FAILED, quoteArg, sshArgv, sshBootstrapArgv } from "./commands.ts";
import { DeployError } from "./errors.ts";
import { Shell, type ExecResult } from "./shell.ts";
import { resolveSshKeyPath } from "./sshKey.ts";

/** Agents that cannot answer a hidden prompt carry the password here instead. */
export const SSH_PASSWORD_ENV = "P0DEPLOY_SSH_PASSWORD";

/** Who can reach a host right now; doctor reports this per target. */
export type SshAuthMethod = "dedicated-key" | "existing-ssh" | "none";

export interface SshAuthState {
  readonly auth: SshAuthMethod;
  /** Which key to use for the following commands; null means leave identities to ssh. */
  readonly identity: string | null;
}

export interface DeployKey {
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
  readonly publicKey: string;
}

export interface SshBootstrapResult {
  readonly host: string;
  readonly via: Exclude<SshAuthMethod, "none"> | "password";
  readonly action: "already-authorized" | "installed";
}

export interface SshSetupResult extends SshBootstrapResult {
  readonly publicKeyPath: string;
}

const OUTPUT_TAIL = 2_000;

const tail = (text: string): string =>
  text.length <= OUTPUT_TAIL ? text.trim() : text.slice(-OUTPUT_TAIL).trim();

/**
 * Appends the key only when it is not already there, so rerunning setup (or
 * running it after a partial install) never duplicates the authorized_keys line.
 */
export const authorizedKeysScript = (publicKey: string): string => {
  const key = quoteArg(publicKey);
  return [
    "set -e",
    "umask 077",
    'mkdir -p "$HOME/.ssh"',
    'chmod 700 "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    `grep -qxF ${key} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${key} >> "$HOME/.ssh/authorized_keys"`,
    'chmod 600 "$HOME/.ssh/authorized_keys"',
  ].join("\n");
};

/** The askpass helper only ever reads the private temp file; the password is never on its command line. */
export const askpassScript = (secretPath: string): string =>
  ["#!/bin/sh", `exec cat ${quoteArg(secretPath)}`].join("\n");

export const sshSetupHint = (address: string): string =>
  `Cannot log in to ${address} yet. Pass --password to be prompted, set ${SSH_PASSWORD_ENV} for agents, or run \`p0deploy ssh key\` and paste the public key into ~/.ssh/authorized_keys on the host.`;

export const noPasswordError = (address: string): DeployError =>
  new DeployError({ code: "COMMAND_FAILED", message: sshSetupHint(address) });

export const passwordFailedError = (address: string, result: ExecResult): DeployError =>
  new DeployError({
    code: "COMMAND_FAILED",
    message: `Could not install the p0deploy key on ${address}. Check the password, then run \`p0deploy ssh setup ${address}\` again; \`p0deploy ssh key\` prints the key for a manual paste.`,
    ...(result.exitCode === SSH_CONNECTION_FAILED
      ? {}
      : { output: tail(result.stderr || result.stdout) }),
  });

export const notLocalError = (address: string): DeployError =>
  new DeployError({
    code: "CONFIG_INVALID",
    message: `ssh setup needs a remote destination, not "${address}".`,
  });

const keyFileError = (path: string, cause: string): DeployError =>
  new DeployError({
    code: "COMMAND_FAILED",
    message: `Could not set up the p0deploy ssh key at ${path}: ${cause}`,
  });

/** Creates the install's own ed25519 key once, mode 0600, and returns it with its public half. */
export const ensureDeployKey = Effect.fn("p0deploy.ssh.ensureDeployKey")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const shell = yield* Shell;
  const privateKeyPath = yield* resolveSshKeyPath();
  const publicKeyPath = `${privateKeyPath}.pub`;
  const directory = path.dirname(privateKeyPath);

  yield* fs
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError((error) => keyFileError(directory, error.message)));
  yield* fs.chmod(directory, 0o700).pipe(Effect.orElseSucceed(() => undefined));

  const exists = yield* fs.exists(privateKeyPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    const generated = yield* shell.exec([
      "ssh-keygen",
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "p0deploy",
      "-f",
      privateKeyPath,
    ]);
    if (generated.exitCode !== 0) {
      return yield* keyFileError(
        privateKeyPath,
        tail(generated.stderr || generated.stdout) || "ssh-keygen failed",
      );
    }
  }
  yield* fs.chmod(privateKeyPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));

  const publicKey = yield* fs
    .readFileString(publicKeyPath)
    .pipe(Effect.mapError(() => keyFileError(publicKeyPath, "no public key was written")));
  return { privateKeyPath, publicKeyPath, publicKey: publicKey.trim() } satisfies DeployKey;
});

const askpassSetupError = (cause: { readonly message: string }): DeployError =>
  new DeployError({
    code: "COMMAND_FAILED",
    message: `Could not create the temporary askpass helper: ${cause.message}`,
  });

/**
 * Runs ssh with a temporary SSH_ASKPASS helper. The password lives only in a
 * 0600 temp file that the helper cats; nothing secret enters argv or the script.
 */
export const withAskpass = <A, E, R>(
  password: string,
  run: (env: Readonly<Record<string, string>>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DeployError, R | FileSystem.FileSystem | Path.Path> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs
        .makeTempDirectoryScoped({ prefix: "p0deploy-askpass-" })
        .pipe(Effect.mapError(askpassSetupError));
      const secretPath = path.join(directory, "password");
      const scriptPath = path.join(directory, "askpass.sh");
      yield* fs
        .writeFileString(secretPath, `${password}\n`, { mode: 0o600 })
        .pipe(Effect.mapError(askpassSetupError));
      yield* fs
        .writeFileString(scriptPath, askpassScript(secretPath), { mode: 0o700 })
        .pipe(Effect.mapError(askpassSetupError));
      yield* fs.chmod(scriptPath, 0o700).pipe(Effect.orElseSucceed(() => undefined));
      const display = yield* Config.String("DISPLAY").pipe(
        Config.option,
        Effect.orElseSucceed(() => Option.none<string>()),
        Effect.map((value) => Option.getOrElse(value, () => "p0deploy")),
      );
      return yield* run({
        SSH_ASKPASS: scriptPath,
        SSH_ASKPASS_REQUIRE: "force",
        // OpenSSH only consults askpass when it believes a display is available.
        DISPLAY: display.trim() || "p0deploy",
      });
    }),
  );

/** Reads a line without echoing it. Returns null when stdin is not a terminal or the user cancels. */
const readHidden = (prompt: string): Promise<string | null> =>
  new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      resolve(null);
      return;
    }
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (result: string | null) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      resolve(result);
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish(value);
          return;
        }
        if (character === "\u0003") {
          finish(null);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    stdin.on("data", onData);
  });

/** P0DEPLOY_SSH_PASSWORD for agents (and scripts); a hidden prompt on a terminal; null otherwise. */
export const resolvePassword = Effect.fn("p0deploy.ssh.resolvePassword")(function* (input: {
  readonly address: string;
  readonly forcePrompt?: boolean | undefined;
}) {
  if (!input.forcePrompt) {
    const configured = yield* Config.String(SSH_PASSWORD_ENV).pipe(
      Config.option,
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isSome(configured) && configured.value.length > 0) return configured.value;
  }
  if (!process.stdin.isTTY) return null;
  return yield* Effect.promise(() => readHidden(`Password for ${input.address}: `));
});

export const sshAuth = Effect.fn("p0deploy.ssh.auth")(function* (
  address: string,
): Effect.fn.Return<SshAuthState, never, Shell> {
  const shell = yield* Shell;
  const identity = shell.identity;
  if (identity !== undefined) {
    const dedicated = yield* shell.exec(sshArgv(address, "true", identity));
    if (dedicated.exitCode === 0) return { auth: "dedicated-key", identity };
  }
  const existing = yield* shell.exec(sshArgv(address, "true"));
  return existing.exitCode === 0
    ? { auth: "existing-ssh", identity: null }
    : { auth: "none", identity: null };
});

const authDetails: Record<SshAuthMethod, (address: string) => string> = {
  "dedicated-key": () => "dedicated key",
  "existing-ssh": (address) =>
    `existing ssh; run \`p0deploy ssh setup ${address}\` to add p0deploy's key`,
  none: (address) => `none; run \`p0deploy ssh setup ${address}\``,
};

export const describeAuth = (state: SshAuthState, address: string): string =>
  authDetails[state.auth](address);

/**
 * Tries the dedicated key, then the user's existing ssh/agent, then (only if
 * given or prompted) the account password through askpass.
 */
export const bootstrapSsh = Effect.fn("p0deploy.ssh.bootstrap")(function* (input: {
  readonly address: string;
  readonly key: DeployKey;
  /** undefined resolves from the env or a prompt; null means skip the password path entirely. */
  readonly password?: string | null | undefined;
  readonly forcePrompt?: boolean | undefined;
}): Effect.fn.Return<SshBootstrapResult, DeployError, Shell | FileSystem.FileSystem | Path.Path> {
  const shell = yield* Shell;
  const address = input.address;
  const install = authorizedKeysScript(input.key.publicKey);

  // 1. Already done: the dedicated key logs in.
  const dedicated = yield* shell.exec(sshBootstrapArgv(address, "true", input.key.privateKeyPath));
  if (dedicated.exitCode === 0) {
    return { host: address, via: "dedicated-key", action: "already-authorized" };
  }

  // 2. The keys and agent the user already had: append ours, then prove it works.
  const existing = yield* shell.exec(sshBootstrapArgv(address, install));
  if (existing.exitCode === 0) {
    const verified = yield* shell.exec(sshArgv(address, "true", input.key.privateKeyPath));
    if (verified.exitCode === 0) {
      return { host: address, via: "existing-ssh", action: "installed" };
    }
  }

  // 3. Password, either supplied by an agent or typed into a hidden prompt.
  const password =
    input.password === undefined
      ? yield* resolvePassword({ address, forcePrompt: input.forcePrompt })
      : input.password;
  if (password === null) return yield* noPasswordError(address);

  const installed = yield* withAskpass(password, (env) =>
    shell.exec(sshBootstrapArgv(address, install, undefined, { batchMode: false }), { env }),
  );
  if (installed.exitCode !== 0) return yield* passwordFailedError(address, installed);
  const verified = yield* shell.exec(sshArgv(address, "true", input.key.privateKeyPath));
  if (verified.exitCode !== 0) return yield* passwordFailedError(address, verified);
  return { host: address, via: "password", action: "installed" };
});

export const sshSetup = Effect.fn("p0deploy.ssh.setup")(function* (input: {
  readonly host: string;
  readonly password?: string | null | undefined;
  readonly forcePrompt?: boolean | undefined;
}) {
  if (input.host === "local") return yield* notLocalError(input.host);
  const key = yield* ensureDeployKey();
  const result = yield* bootstrapSsh({
    address: input.host,
    key,
    password: input.password,
    forcePrompt: input.forcePrompt,
  });
  return { ...result, publicKeyPath: key.publicKeyPath } satisfies SshSetupResult;
});

export const sshKey = Effect.fn("p0deploy.ssh.key")(function* () {
  const key = yield* ensureDeployKey();
  return { path: key.publicKeyPath, publicKey: key.publicKey };
});
