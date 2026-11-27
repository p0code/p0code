/**
 * NON-FUNCTIONAL STUB (p0deploy): the planned "own server" deploy path, driving
 * `packages/p0deploy` (SSH + Docker) behind the `StartedDeployProvider` interface. Every call
 * refuses. It is deliberately absent from `BuiltinDeployProviders` and the deploy overview; nothing
 * outside tests imports it until it is implemented and wired into `DeployService`.
 */
import { PluginError, type StartedDeployProvider } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const notYet = new PluginError({ message: "Deploying to your own server is not available yet." });

export const ownServerDeployProvider: StartedDeployProvider = {
  descriptor: { id: "p0deploy", label: "Own server (p0deploy)", icon: "server" },
  link: () => Effect.fail(notYet),
  unlink: () => Effect.fail(notYet),
  status: () => Effect.succeed({ state: "unlinked", accountLabel: null, message: null }),
  listProjects: () => Effect.succeed([]),
  deploy: () => Effect.fail(notYet),
  deploymentStatus: () => Effect.fail(notYet),
  logs: () => Stream.fail(notYet),
  rollback: () => Effect.fail(notYet),
  listDomains: () => Effect.succeed([]),
  setEnv: () => Effect.fail(notYet),
};
