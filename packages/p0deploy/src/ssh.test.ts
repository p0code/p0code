import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { onHost, sshArgv, sshBootstrapArgv, type Argv } from "./commands.ts";
import { runOn } from "./deploy.ts";
import {
  SSH_PASSWORD_ENV,
  askpassScript,
  authorizedKeysScript,
  bootstrapSsh,
  resolvePassword,
  sshAuth,
  sshSetupHint,
  withAskpass,
  type DeployKey,
} from "./ssh.ts";
import { APP_HOME_ENV, SSH_KEY_FILE_NAME, appHomeFromEnv, resolveSshKeyPath } from "./sshKey.ts";
import { Shell, type ExecResult } from "./shell.ts";

const key: DeployKey = {
  privateKeyPath: "/home/howard/.p0code/deploy/keys/p0deploy_ed25519",
  publicKeyPath: "/home/howard/.p0code/deploy/keys/p0deploy_ed25519.pub",
  publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey p0deploy",
};

interface Call {
  readonly argv: Argv;
  readonly env: Readonly<Record<string, string>> | undefined;
}

/** Answers each exec in order; everything a caller does not override succeeds. */
const queuedShell = (
  results: ReadonlyArray<Partial<ExecResult>>,
  options: { readonly identity?: string | undefined } = {},
) => {
  const calls: Array<Call> = [];
  let index = 0;
  const layer = Layer.succeed(
    Shell,
    Shell.of({
      exec: (argv, execOptions) =>
        Effect.sync(() => {
          calls.push({ argv, env: execOptions?.env });
          const result = results[index] ?? {};
          index += 1;
          return { exitCode: 0, stdout: "", stderr: "", ...result };
        }),
      pipe: () => Effect.die("unexpected pipe"),
      note: () => Effect.void,
      ...(options.identity === undefined ? {} : { identity: options.identity }),
    }),
  );
  return { calls, layer };
};

const withConfig = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

describe("ssh argv", () => {
  it("offers the dedicated key first and keeps BatchMode for ordinary commands", () => {
    assert.deepEqual(onHost({ kind: "ssh", address: "deploy@example.com" }, "docker ps"), [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "deploy@example.com",
      "docker ps",
    ]);
    assert.deepEqual(sshArgv("deploy@example.com", "docker ps", key.privateKeyPath), [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-i",
      key.privateKeyPath,
      "-o",
      "IdentitiesOnly=yes",
      "deploy@example.com",
      "docker ps",
    ]);
  });

  it("accepts a new host key once while bootstrapping, and only drops BatchMode for askpass", () => {
    const argv = sshBootstrapArgv("deploy@example.com", "true", key.privateKeyPath);
    assert.includeMembers(
      [...argv],
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-i",
        key.privateKeyPath,
        "-o",
        "IdentitiesOnly=yes",
      ],
    );
    assert.isBelow(argv.indexOf("-i"), argv.indexOf("deploy@example.com"));
    assert.strictEqual(argv.at(-1), "true");

    const password = sshBootstrapArgv("deploy@example.com", "true", undefined, {
      batchMode: false,
    });
    assert.notInclude(password.join(" "), "BatchMode");
    assert.include(password.join(" "), "StrictHostKeyChecking=accept-new");
  });

  it("lets a caller force no identity for hosts still on the user's own keys", () => {
    assert.deepEqual(
      onHost({ kind: "ssh", address: "h", identity: null }, "true"),
      sshArgv("h", "true"),
    );
  });

  it.effect("every ordinary command inherits the install's key", () =>
    Effect.gen(function* () {
      const shell = queuedShell([{ exitCode: 0 }], { identity: key.privateKeyPath });
      yield* runOn({ kind: "ssh", address: "deploy@example.com" }, "docker ps").pipe(
        Effect.provide(shell.layer),
      );
      const argv = shell.calls[0]?.argv.join(" ") ?? "";
      assert.include(argv, `-i ${key.privateKeyPath}`);
      assert.include(argv, "BatchMode=yes");
    }),
  );
});

describe("authorized_keys script", () => {
  it("greps before it appends, so reruns never duplicate the key", () => {
    const script = authorizedKeysScript(key.publicKey);
    assert.include(script, 'mkdir -p "$HOME/.ssh"');
    assert.include(script, 'chmod 700 "$HOME/.ssh"');
    assert.include(script, 'chmod 600 "$HOME/.ssh/authorized_keys"');
    assert.include(script, "grep -qxF");
    assert.include(script, key.publicKey);
    assert.isAtMost(script.split(">>").length - 1, 1, "only the guarded branch appends");
    assert.isBelow(script.indexOf("grep -qxF"), script.indexOf(">>"));
  });
});

describe("key location", () => {
  it("prefers P0CODE_HOME, then the names p0code used before", () => {
    assert.strictEqual(appHomeFromEnv({ P0CODE_HOME: "/a", T3CODE_HOME: "/b" }), "/a");
    assert.strictEqual(appHomeFromEnv({ P0CODE_HOME: "  ", T3CODE_HOME: " /b " }), "/b");
    assert.isUndefined(appHomeFromEnv({}));
  });

  it.effect("puts the key under the p0code data directory", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* resolveSshKeyPath(),
        `/tmp/p0home/deploy/keys/${SSH_KEY_FILE_NAME}`,
      );
    }).pipe(Effect.provide(NodeServices.layer), withConfig({ [APP_HOME_ENV]: "/tmp/p0home" })),
  );
});

describe("bootstrap", () => {
  it.effect("does nothing when the dedicated key already logs in", () =>
    Effect.gen(function* () {
      const shell = queuedShell([{ exitCode: 0 }]);
      const result = yield* bootstrapSsh({ address: "deploy@example.com", key }).pipe(
        Effect.provide([shell.layer, NodeServices.layer]),
      );
      assert.strictEqual(result.via, "dedicated-key");
      assert.strictEqual(result.action, "already-authorized");
      assert.lengthOf(shell.calls, 1);
      assert.include(shell.calls[0]?.argv.join(" ") ?? "", `-i ${key.privateKeyPath}`);
    }),
  );

  it.effect("installs through the user's existing ssh, then verifies with the new key", () =>
    Effect.gen(function* () {
      const shell = queuedShell([{ exitCode: 255 }, { exitCode: 0 }, { exitCode: 0 }]);
      const result = yield* bootstrapSsh({ address: "deploy@example.com", key }).pipe(
        Effect.provide([shell.layer, NodeServices.layer]),
      );
      assert.strictEqual(result.via, "existing-ssh");
      assert.strictEqual(result.action, "installed");
      const install = shell.calls[1]?.argv.join(" ") ?? "";
      assert.include(install, "authorized_keys");
      assert.include(install, "BatchMode=yes");
      assert.notInclude(install, "-i");
      assert.include(shell.calls[2]?.argv.join(" ") ?? "", `-i ${key.privateKeyPath}`);
    }),
  );

  it.effect("uses askpass for the password and keeps it out of argv", () =>
    Effect.gen(function* () {
      const password = "hunter2-super-secret";
      const shell = queuedShell([
        { exitCode: 255 },
        { exitCode: 255 },
        { exitCode: 0 },
        { exitCode: 0 },
      ]);
      const result = yield* bootstrapSsh({
        address: "deploy@example.com",
        key,
        password,
      }).pipe(Effect.provide([shell.layer, NodeServices.layer]));
      assert.strictEqual(result.via, "password");
      assert.strictEqual(result.action, "installed");

      const install = shell.calls[2];
      assert.strictEqual(install?.env?.SSH_ASKPASS_REQUIRE, "force");
      assert.isString(install?.env?.SSH_ASKPASS);
      assert.isDefined(install?.env?.DISPLAY);
      assert.notInclude(install?.argv.join(" ") ?? "", "BatchMode");
      for (const call of shell.calls) assert.notInclude(call.argv.join(" "), password);
    }),
  );

  it.effect("asks for a password or the manual key when nothing works", () =>
    Effect.gen(function* () {
      const shell = queuedShell([{ exitCode: 255 }, { exitCode: 255 }]);
      const error = yield* Effect.flip(
        bootstrapSsh({ address: "deploy@example.com", key, password: null }).pipe(
          Effect.provide([shell.layer, NodeServices.layer]),
        ),
      );
      assert.strictEqual(error.code, "COMMAND_FAILED");
      assert.strictEqual(error.message, sshSetupHint("deploy@example.com"));
      assert.include(error.message, "--password");
      assert.include(error.message, SSH_PASSWORD_ENV);
      assert.include(error.message, "p0deploy ssh key");
    }),
  );

  it.effect("does not echo a rejected password", () =>
    Effect.gen(function* () {
      const password = "wrong-password-9f3";
      const shell = queuedShell([
        { exitCode: 255 },
        { exitCode: 255 },
        { exitCode: 5, stderr: "Permission denied (publickey,password).\n" },
      ]);
      const error = yield* Effect.flip(
        bootstrapSsh({ address: "deploy@example.com", key, password }).pipe(
          Effect.provide([shell.layer, NodeServices.layer]),
        ),
      );
      assert.strictEqual(error.code, "COMMAND_FAILED");
      assert.notInclude(error.message, password);
      assert.notInclude(error.output ?? "", password);
      assert.include(error.output ?? "", "Permission denied");
      assert.include(error.message, "p0deploy ssh key");
    }),
  );

  it.effect("reads P0DEPLOY_SSH_PASSWORD for agents", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* resolvePassword({ address: "h" }), "from-env");
      assert.isNull(yield* resolvePassword({ address: "h", forcePrompt: true }));
    }).pipe(withConfig({ [SSH_PASSWORD_ENV]: "from-env" })),
  );
});

describe("doctor auth", () => {
  it.effect("prefers the dedicated key, then existing ssh, then none", () =>
    Effect.gen(function* () {
      const dedicated = queuedShell([{ exitCode: 0 }], { identity: key.privateKeyPath });
      assert.deepEqual(yield* sshAuth("deploy@example.com").pipe(Effect.provide(dedicated.layer)), {
        auth: "dedicated-key",
        identity: key.privateKeyPath,
      });

      const existing = queuedShell([{ exitCode: 255 }, { exitCode: 0 }], {
        identity: key.privateKeyPath,
      });
      assert.deepEqual(yield* sshAuth("deploy@example.com").pipe(Effect.provide(existing.layer)), {
        auth: "existing-ssh",
        identity: null,
      });
      assert.notInclude(existing.calls[1]?.argv.join(" ") ?? "", "-i");

      const none = queuedShell([{ exitCode: 255 }]);
      assert.deepEqual(yield* sshAuth("deploy@example.com").pipe(Effect.provide(none.layer)), {
        auth: "none",
        identity: null,
      });
    }),
  );
});

describe("askpass", () => {
  it("never puts the password in the helper script", () => {
    const script = askpassScript("/tmp/p0deploy-askpass-abc/password");
    assert.strictEqual(script, "#!/bin/sh\nexec cat /tmp/p0deploy-askpass-abc/password");
    assert.notInclude(script, "hunter2");
  });

  it.effect("writes a private temp file and removes it afterwards", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      let scriptPath = "";
      let secretPath = "";
      yield* withAskpass("hunter2-super-secret", (env) =>
        Effect.gen(function* () {
          scriptPath = env.SSH_ASKPASS ?? "";
          const script = yield* fs.readFileString(scriptPath);
          assert.notInclude(script, "hunter2-super-secret");
          secretPath = script.split("\n")[1]?.slice("exec cat ".length) ?? "";
          assert.strictEqual((yield* fs.readFileString(secretPath)).trim(), "hunter2-super-secret");
          assert.strictEqual(env.SSH_ASKPASS_REQUIRE, "force");
          assert.isDefined(env.DISPLAY);
          return null;
        }),
      ).pipe(Effect.provide(NodeServices.layer));
      assert.isFalse(yield* fs.exists(scriptPath));
      assert.isFalse(yield* fs.exists(secretPath));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
