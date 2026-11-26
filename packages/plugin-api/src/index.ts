import {
  DeployAccountRef,
  DeployDeploymentRequest,
  DeployDomain,
  DeployLinkInput,
  DeployLinkResult,
  DeployLogsRequest,
  DeployProviderDeployInput,
  DeployProviderProject,
  DeployProviderSetEnvInput,
  DeployProviderStatus,
  DeployResult,
  DeployRollbackInput,
  DeployTargetRequest,
  DeploymentStatus,
} from "@t3tools/contracts";
import type {
  DataSnapshotManifest,
  PendingRestore,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  PluginManifest,
  PluginOrigin,
  ThreadId,
} from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import type * as Digest from "effect/crypto/Digest";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type * as Signature from "effect/crypto/Signature";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** A failure a plugin reports to its caller; the message is shown to people. */
export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export { DataSnapshotManifest, PendingRestore } from "@t3tools/contracts";

/** The plugin API this server speaks. A manifest asking for a higher one is refused at load. */
export const PLUGIN_API_VERSION = 1;

export type ActivityState = AgentAwarenessState;

export interface UsageDailyTotal {
  /** `YYYY-MM-DD` in the requested time zone. */
  readonly day: string;
  /** A `UsageProviderKind`, typed as string so a newer host cannot break an older plugin. */
  readonly provider: string;
  readonly model: string;
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  /** Includes reasoning tokens, as in `UsageTokenTotals`. */
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number;
  readonly records: number;
  /** Records with no known price; their cost is missing from `costUsd`. */
  readonly unpricedRecords: number;
}

/** Everything the host lends a running plugin. It lives as long as the plugin stays enabled. */
export class PluginContext extends Context.Service<
  PluginContext,
  {
    readonly pluginId: string;
    /** A directory only this plugin writes, kept across restarts. */
    readonly dataDir: string;
    /** Values kept in the server's secret store, namespaced to the plugin. */
    readonly storage: {
      readonly get: (key: string) => Effect.Effect<Option.Option<string>, PluginError>;
      readonly set: (key: string, value: string) => Effect.Effect<void, PluginError>;
      readonly remove: (key: string) => Effect.Effect<void, PluginError>;
    };
    /**
     * Present only with http:routes. Host-issued per-plugin bearer secret, stable across
     * restarts and enable/disable; removed with the plugin's installation. Give callers
     * x-p0code-plugin-route-secret or append p0_route to declared route URLs. Keep it private.
     */
    readonly routes?: { readonly secret: string };
    /** The one-line status shown beside the plugin; null clears it. */
    readonly reportStatus: (message: string | null) => Effect.Effect<void>;
    readonly environment: {
      readonly environmentId: Effect.Effect<EnvironmentId>;
      readonly descriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
      /** This server's own loopback HTTP origin, for helpers that must reach it. */
      readonly localOrigin: Effect.Effect<string, PluginError>;
    };
    /** Requires the `auth:issue-device-credentials` capability. */
    readonly deviceAccess: {
      /**
       * A short-lived one-time pairing credential bound to a device's DPoP key. Sessions it
       * creates belong to this plugin and end when the plugin is disabled.
       */
      readonly issueCredential: (input: {
        readonly proofKeyThumbprint: string;
        readonly label: string;
      }) => Effect.Effect<
        { readonly credential: string; readonly expiresAt: DateTime.Utc },
        PluginError
      >;
      readonly revokeAll: Effect.Effect<void, PluginError>;
    };
    /** Requires the `orchestration:read-activity` capability. */
    readonly agentActivity: {
      /** Threads whose activity may have changed. */
      readonly changes: Stream.Stream<ThreadId>;
      readonly read: (threadId: ThreadId) => Effect.Effect<ActivityState | null, PluginError>;
      /** Listed threads that are working or waiting now. */
      readonly activeThreadIds: Effect.Effect<ReadonlyArray<ThreadId>, PluginError>;
    };
    /** Requires the `data:backup` capability. */
    readonly dataBackup: {
      readonly snapshot: Effect.Effect<
        { readonly directory: string; readonly manifest: DataSnapshotManifest },
        PluginError,
        Scope.Scope
      >;
      readonly stageRestore: (directory: string) => Effect.Effect<PendingRestore, PluginError>;
      readonly pendingRestore: Effect.Effect<PendingRestore | null, PluginError>;
      readonly cancelRestore: Effect.Effect<void, PluginError>;
    };
    /** Requires the `usage:read` capability. */
    readonly usage: {
      /** Daily totals per provider and model; days with no usage are absent. */
      readonly dailyTotals: (input: {
        readonly sinceDay: string;
        readonly untilDay: string;
        readonly timeZone: string;
      }) => Effect.Effect<ReadonlyArray<UsageDailyTotal>, PluginError>;
    };
  }
>()("@t3tools/plugin-api/PluginContext") {}

export type PluginServices =
  | PluginContext
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | PtyAdapter.PtyAdapter
  | Digest.Digest
  | SecureRandom.SecureRandom
  | Signature.Signature;

export interface PluginActionSchema {
  readonly input: Schema.Codec<unknown, unknown>;
  readonly output: Schema.Codec<unknown, unknown>;
}
export type PluginActionSchemas = Readonly<Record<string, PluginActionSchema>>;

/** A JSON request to a declared route; the response is JSON with no caching. */
export type PluginRouteHandler = (
  body: unknown,
) => Effect.Effect<{ readonly status: number; readonly body: unknown }>;

export interface PluginInstance<Actions extends PluginActionSchemas> {
  readonly actions: {
    readonly [K in keyof Actions]: (
      input: Actions[K]["input"]["Type"],
    ) => Effect.Effect<Actions[K]["output"]["Type"], PluginError>;
  };
  readonly routes?: Readonly<Record<string, PluginRouteHandler>>;
  /** Optional text appended to every agent turn; requires `agent:instructions`. */
  readonly agentInstructions?: Effect.Effect<string | null>;
}

/** What the host runs. Built by `definePlugin`, which owns decoding at the wire. */
export interface Plugin {
  readonly manifest: PluginManifest;
  /** Where the code came from. Bundled plugins omit it; the loader marks installed ones. */
  readonly origin?: PluginOrigin;
  /** Runs in the plugin's scope; closing it is how the host stops the plugin. */
  readonly start: Effect.Effect<StartedPlugin, PluginError, PluginServices | Scope.Scope>;
}

export interface StartedPlugin {
  readonly invoke: (action: string, input: unknown) => Effect.Effect<unknown, PluginError>;
  readonly routes: ReadonlyMap<string, PluginRouteHandler>;
  readonly agentInstructions?: Effect.Effect<string | null>;
  /** Present for plugins built with `defineDeployProvider`; every call is schema-checked. */
  readonly deployProvider?: StartedDeployProvider;
}

export function definePlugin<Actions extends PluginActionSchemas>(definition: {
  readonly manifest: PluginManifest;
  readonly actions: Actions;
  readonly start: Effect.Effect<PluginInstance<Actions>, PluginError, PluginServices | Scope.Scope>;
}): Plugin {
  const startInstance = instanceStarter(definition.manifest, definition.actions);
  return {
    manifest: definition.manifest,
    start: definition.start.pipe(Effect.flatMap(startInstance)),
  };
}

/** Checks a started instance against its manifest and wraps its actions with their codecs. */
function instanceStarter<Actions extends PluginActionSchemas>(
  manifest: PluginManifest,
  actions: Actions,
) {
  // Compiled once per plugin, not per call.
  const codecs = new Map(
    Object.entries(actions).map(([action, schema]) => [
      action,
      {
        decode: Schema.decodeUnknownEffect(schema.input),
        encode: Schema.encodeEffect(schema.output),
      },
    ]),
  );
  return (instance: PluginInstance<Actions>): Effect.Effect<StartedPlugin, PluginError> => {
    const routes = new Map(Object.entries(instance.routes ?? {}));
    if (manifest.httpRoutes.length > 0 && !manifest.capabilities.includes("http:routes")) {
      return Effect.fail(new PluginError({ message: "Capability http:routes is not declared." }));
    }
    for (const path of routes.keys()) {
      if (!manifest.httpRoutes.includes(path)) {
        return Effect.fail(new PluginError({ message: `Route ${path} is not declared.` }));
      }
    }
    if (
      instance.agentInstructions !== undefined &&
      !manifest.capabilities.includes("agent:instructions")
    ) {
      return Effect.fail(
        new PluginError({ message: "Capability agent:instructions is not declared." }),
      );
    }
    const invoke = (action: string, input: unknown) => {
      const codec = codecs.get(action);
      const handler = Object.hasOwn(instance.actions, action)
        ? instance.actions[action]
        : undefined;
      if (codec === undefined || handler === undefined) {
        return Effect.fail(new PluginError({ message: `Unknown action ${action}.` }));
      }
      return codec.decode(input).pipe(
        Effect.mapError((cause) => new PluginError({ message: "Invalid action input.", cause })),
        Effect.flatMap(handler),
        Effect.flatMap((output) =>
          codec
            .encode(output)
            .pipe(
              Effect.mapError(
                (cause) => new PluginError({ message: "Invalid action output.", cause }),
              ),
            ),
        ),
      );
    };
    return Effect.succeed({
      invoke,
      routes,
      ...(instance.agentInstructions === undefined
        ? {}
        : { agentInstructions: instance.agentInstructions }),
    } satisfies StartedPlugin);
  };
}

// ── Deploy providers ───────────────────────────────────────────────────────────────────────────

export type {
  DeployAccountRef,
  DeployDeploymentRequest,
  DeployDomain,
  DeployEnvTarget,
  DeployEnvVars,
  DeployLinkInput,
  DeployLinkResult,
  DeployLogsRequest,
  DeployProviderDeployInput,
  DeployProviderProject,
  DeployProviderSetEnvInput,
  DeployProviderStatus,
  DeployResult,
  DeployRollbackInput,
  DeployTarget,
  DeployTargetKind,
  DeployTargetRequest,
  DeployWarning,
  DeploymentStatus,
} from "@t3tools/contracts";

/**
 * What a deploy provider plugin implements. One provider can have several linked accounts: every
 * call names its `account`, and the plugin keeps each account's credential in
 * `PluginContext.storage` keyed by `account.accountId`. Make API calls with the lent `HttpClient`
 * (declare `network:outbound`); the host never stores, reads, or returns a provider token.
 * Messages in `PluginError` are shown to people, so never put a token in one.
 */
export interface DeployProvider {
  /**
   * Validates and stores `token` for `account` when one is given; otherwise starts or completes
   * the provider's own sign-in, answering `pending` with a URL to open until it completes.
   */
  readonly link: (input: DeployLinkInput) => Effect.Effect<DeployLinkResult, PluginError>;
  /** Forgets this account's stored credential. */
  readonly unlink: (account: DeployAccountRef) => Effect.Effect<void, PluginError>;
  /** Non-fatal problems (a missing optional scope) go in `warnings`, not in `message`. */
  readonly status: (account: DeployAccountRef) => Effect.Effect<DeployProviderStatus, PluginError>;
  readonly listProjects: (
    account: DeployAccountRef,
  ) => Effect.Effect<ReadonlyArray<DeployProviderProject>, PluginError>;
  /** `source.projectRoot` and `source.directory` are absolute paths the host already checked. */
  readonly deploy: (input: DeployProviderDeployInput) => Effect.Effect<DeployResult, PluginError>;
  readonly deploymentStatus: (
    input: DeployDeploymentRequest,
  ) => Effect.Effect<DeploymentStatus, PluginError>;
  /** Log lines; with `follow`, the stream stays open until the deployment finishes. */
  readonly logs: (input: DeployLogsRequest) => Stream.Stream<string, PluginError>;
  readonly rollback: (input: DeployRollbackInput) => Effect.Effect<DeployResult, PluginError>;
  readonly listDomains: (
    input: DeployTargetRequest,
  ) => Effect.Effect<ReadonlyArray<DeployDomain>, PluginError>;
  /** Sets `vars` and deletes `remove` in one environment, as secrets when `secret`. */
  readonly setEnv: (input: DeployProviderSetEnvInput) => Effect.Effect<void, PluginError>;
}

export interface DeployProviderDescriptor {
  /** Stable id of the provider, e.g. `vercel`. */
  readonly id: string;
  readonly label: string;
  /** A lucide icon name or an `https:`/`data:` image URL. */
  readonly icon?: string;
}

/** The provider as the host sees it once started: the same calls, checked at the boundary. */
export interface StartedDeployProvider extends DeployProvider {
  readonly descriptor: DeployProviderDescriptor;
}

const invalid = (what: string) => (cause: unknown) =>
  new PluginError({ message: `The deploy provider returned an invalid ${what}.`, cause });
const invalidInput = (cause: unknown) =>
  new PluginError({ message: "Invalid deploy provider input.", cause });

const checked = <A>(schema: Schema.Codec<A, unknown>, what: string) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return <E, R>(effect: Effect.Effect<unknown, E, R>) =>
    effect.pipe(Effect.flatMap((value) => decode(value).pipe(Effect.mapError(invalid(what)))));
};
/** Decodes a host-built input before the plugin sees it, then runs `call` on it. */
const input = <I>(schema: Schema.Codec<I, unknown>) => {
  const decode = Schema.decodeUnknownEffect(schema);
  return <A, E, R>(call: (value: I) => Effect.Effect<A, E, R>) =>
    (value: unknown) =>
      decode(value).pipe(Effect.mapError(invalidInput), Effect.flatMap(call));
};

const checkLink = checked(DeployLinkResult, "link result");
const checkStatus = checked(DeployProviderStatus, "status");
const checkProjects = checked(Schema.Array(DeployProviderProject), "project list");
const checkResult = checked(DeployResult, "deploy result");
const checkDeployment = checked(DeploymentStatus, "deployment status");
const checkDomains = checked(Schema.Array(DeployDomain), "domain list");
const linkInput = input(DeployLinkInput);
const accountInput = input(DeployAccountRef);
const deployInput = input(DeployProviderDeployInput);
const deploymentInput = input(DeployDeploymentRequest);
const targetInput = input(DeployTargetRequest);
const rollbackInput = input(DeployRollbackInput);
const envInput = input(DeployProviderSetEnvInput);
const decodeLogsInput = Schema.decodeUnknownEffect(DeployLogsRequest);

/** Wraps a provider so a plugin cannot hand the host data outside the contract. */
const checkProvider = (
  descriptor: DeployProviderDescriptor,
  provider: DeployProvider,
): StartedDeployProvider => ({
  descriptor,
  link: (value) => checkLink(linkInput(provider.link)(value)),
  unlink: accountInput(provider.unlink),
  status: (account) => checkStatus(accountInput(provider.status)(account)),
  listProjects: (account) => checkProjects(accountInput(provider.listProjects)(account)),
  deploy: (value) => checkResult(deployInput(provider.deploy)(value)),
  deploymentStatus: (value) => checkDeployment(deploymentInput(provider.deploymentStatus)(value)),
  logs: (value) =>
    Stream.unwrap(
      decodeLogsInput(value).pipe(
        Effect.mapError(invalidInput),
        Effect.map((decoded) =>
          provider
            .logs(decoded)
            .pipe(
              Stream.mapEffect((line) =>
                typeof line === "string"
                  ? Effect.succeed(line)
                  : Effect.fail(
                      new PluginError({ message: "The deploy provider sent a non-text log." }),
                    ),
              ),
            ),
        ),
      ),
    ),
  rollback: (value) => checkResult(rollbackInput(provider.rollback)(value)),
  listDomains: (value) => checkDomains(targetInput(provider.listDomains)(value)),
  setEnv: envInput(provider.setEnv),
});

/**
 * A plugin that is a deploy provider, mirroring `definePlugin`. The manifest must declare
 * `deploy:provider`. Extra `actions` (for example a settings panel's own) work as in
 * `definePlugin`; the provider's calls are not plugin actions, so `plugins.invoke` cannot reach
 * a deploy around the host's approval rule.
 */
export function defineDeployProvider<Actions extends PluginActionSchemas = {}>(definition: {
  readonly manifest: PluginManifest;
  readonly provider: DeployProviderDescriptor;
  readonly actions?: Actions;
  readonly start: Effect.Effect<
    Omit<PluginInstance<Actions>, "actions"> & {
      readonly actions?: PluginInstance<Actions>["actions"];
      readonly deploy: DeployProvider;
    },
    PluginError,
    PluginServices | Scope.Scope
  >;
}): Plugin {
  const startInstance = instanceStarter(definition.manifest, definition.actions ?? ({} as Actions));
  return {
    manifest: definition.manifest,
    start: definition.start.pipe(
      Effect.flatMap((instance) => {
        if (!definition.manifest.capabilities.includes("deploy:provider")) {
          return Effect.fail(
            new PluginError({ message: "Capability deploy:provider is not declared." }),
          );
        }
        const { deploy, actions, ...rest } = instance;
        return startInstance({
          ...rest,
          actions: actions ?? ({} as PluginInstance<Actions>["actions"]),
        }).pipe(
          Effect.map((started): StartedPlugin => ({
            ...started,
            deployProvider: checkProvider(definition.provider, deploy),
          })),
        );
      }),
    ),
  };
}
