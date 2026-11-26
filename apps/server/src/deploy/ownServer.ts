/**
 * Not wired yet (p0deploy): the built-in "own server" deploy path, driving `packages/p0deploy`
 * (SSH + Docker) behind the plugin providers' `StartedDeployProvider` interface. Nothing imports
 * or lists it until it is wired into `DeployService`.
 */
import { PluginError, type StartedDeployProvider } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const notYet = new PluginError({ message: "Deploying to your own server is not available yet." });

export const ownServerDeployProvider: StartedDeployProvider = {
  descriptor: { id: "p0deploy", label: "Own server (p0deploy)", icon: "server" },
  link: () => Effect.fail(notYet),
  unlink: Effect.fail(notYet),
  status: Effect.succeed({ state: "unlinked", accountLabel: null, message: null }),
  listProjects: Effect.succeed([]),
  deploy: () => Effect.fail(notYet),
  deploymentStatus: () => Effect.fail(notYet),
  logs: () => Stream.fail(notYet),
  rollback: () => Effect.fail(notYet),
  listDomains: () => Effect.succeed([]),
  setEnv: () => Effect.fail(notYet),
};
