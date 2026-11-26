/**
 * Settings → Deploy. Providers are `deploy:provider` plugins that keep their own token in plugin
 * storage, so nothing here holds, logs or returns one. Threads below Full access need an approval.
 * Not wired yet (p0deploy): the built-in own-server provider is stubbed in `./ownServer.ts`.
 */
import {
  type DeployDomain,
  DeployError,
  type DeployLinkResult,
  type DeployLinkRpcInput,
  type DeployMapProjectInput,
  type DeployOverview,
  type DeployPendingApproval,
  type DeployProjectMapping,
  type DeployProjectRollbackInput,
  type DeployProviderProject,
  type DeployProviderSummary,
  type DeployRecord,
  type DeployResult,
  type DeploySetEnvInput,
  type DeployStartInput,
  type DeployStartResult,
  type DeploymentStatus,
  type DeployLogsInput,
  type DeployDeploymentInput,
  type DeployDecideApprovalInput,
  type ProjectId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import type { PluginError } from "@t3tools/plugin-api";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { PluginHost } from "../plugins/PluginHost.ts";
import * as ServerSettings from "../serverSettings.ts";

/** How the deploy gate learns a thread's runtime mode; null when the thread is unknown. */
export class DeployThreadModes extends Context.Service<
  DeployThreadModes,
  { readonly runtimeMode: (threadId: ThreadId) => Effect.Effect<RuntimeMode | null> }
>()("p0/deploy/DeployService/DeployThreadModes") {}

export class DeployService extends Context.Service<
  DeployService,
  {
    readonly overview: Effect.Effect<DeployOverview, DeployError>;
    readonly link: (input: DeployLinkRpcInput) => Effect.Effect<DeployLinkResult, DeployError>;
    readonly unlink: (pluginId: string) => Effect.Effect<void, DeployError>;
    readonly listProjects: (
      pluginId: string,
    ) => Effect.Effect<ReadonlyArray<DeployProviderProject>, DeployError>;
    readonly mapProject: (input: DeployMapProjectInput) => Effect.Effect<void, DeployError>;
    /** Full-access threads and people deploy now; other threads file an approval request. */
    readonly start: (input: DeployStartInput) => Effect.Effect<DeployStartResult, DeployError>;
    readonly decideApproval: (
      input: DeployDecideApprovalInput,
    ) => Effect.Effect<DeployRecord | null, DeployError>;
    readonly status: (input: DeployDeploymentInput) => Effect.Effect<DeploymentStatus, DeployError>;
    readonly logs: (input: DeployLogsInput) => Stream.Stream<string, DeployError>;
    readonly rollback: (
      input: DeployProjectRollbackInput,
    ) => Effect.Effect<DeployResult, DeployError>;
    readonly domains: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<DeployDomain>, DeployError>;
    readonly setEnv: (input: DeploySetEnvInput) => Effect.Effect<void, DeployError>;
  }
>()("p0/deploy/DeployService") {}

/** Deploys kept for the list; older ones fall off. */
const MAX_RECORDS = 50;

const UNKNOWN_STATUS = { state: "unlinked", accountLabel: null, message: null } as const;

/** Removes a secret the caller just handed over from any text going back out. */
export const redact = (text: string, secret: string | undefined): string =>
  secret === undefined || secret.length < 4 ? text : text.split(secret).join("[redacted]");

interface HeldDeploy {
  readonly approval: DeployPendingApproval;
  readonly input: DeployStartInput;
}

const make = Effect.gen(function* () {
  const host = yield* PluginHost;
  const settings = yield* ServerSettings.ServerSettingsService;
  const threadModes = yield* DeployThreadModes;
  const random = yield* SecureRandom.SecureRandom;
  const records: Array<DeployRecord> = [];
  const held = new Map<string, HeldDeploy>();

  const providerFailed =
    (secret?: string) =>
    (error: PluginError): DeployError =>
      new DeployError({ reason: "provider-failed", message: redact(error.message, secret) });

  const requireProvider = Effect.fn("DeployService.requireProvider")(function* (pluginId: string) {
    const entries = yield* host.deployProviders;
    const entry = entries.find((candidate) => candidate.manifest.id === pluginId);
    if (entry === undefined) {
      return yield* new DeployError({
        reason: "unknown-provider",
        message: "No installed plugin provides this deploy target.",
      });
    }
    if (entry.provider === null) {
      return yield* new DeployError({
        reason: "provider-off",
        message: `Turn on ${entry.manifest.name} in Plugins first.`,
      });
    }
    return entry.provider;
  });

  const settingsFailed = (error: { readonly message: string }) =>
    new DeployError({ reason: "settings-failed", message: error.message });

  const mappings = settings.getSettings.pipe(
    Effect.map((current) => current.deployProjects),
    Effect.mapError(settingsFailed),
  );

  const requireMapping = Effect.fn("DeployService.requireMapping")(function* (
    projectId: ProjectId,
  ) {
    const mapping = (yield* mappings)[projectId];
    if (mapping === undefined) {
      return yield* new DeployError({
        reason: "not-mapped",
        message: "Choose a deploy target for this project first.",
      });
    }
    return { mapping, provider: yield* requireProvider(mapping.pluginId) };
  });

  const summarize = (
    entry: Effect.Success<typeof host.deployProviders>[number],
  ): Effect.Effect<DeployProviderSummary> => {
    const base = { pluginId: entry.manifest.id };
    if (entry.provider === null) {
      return Effect.succeed({
        ...base,
        label: entry.manifest.name,
        icon: null,
        running: false,
        status: UNKNOWN_STATUS,
      });
    }
    const { descriptor } = entry.provider;
    return entry.provider.status.pipe(
      Effect.timeout("10 seconds"),
      Effect.catchCause(() =>
        Effect.succeed({
          state: "error" as const,
          accountLabel: null,
          message: "Could not reach the provider.",
        }),
      ),
      Effect.map((status) => ({
        ...base,
        label: descriptor.label,
        icon: descriptor.icon ?? null,
        running: true,
        status,
      })),
    );
  };

  const runDeploy = Effect.fn("DeployService.runDeploy")(function* (input: DeployStartInput) {
    const { mapping, provider } = yield* requireMapping(input.projectId);
    const result = yield* provider
      .deploy({
        projectId: mapping.providerProjectId,
        environment: input.environment,
        source: {
          kind: input.sourceKind,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.directory === undefined ? {} : { directory: input.directory }),
        },
        ...(input.envVars === undefined ? {} : { envVars: input.envVars }),
      })
      .pipe(Effect.mapError(providerFailed()));
    const record: DeployRecord = {
      pluginId: mapping.pluginId,
      deploymentId: result.deploymentId,
      projectId: input.projectId,
      environment: input.environment,
      branch: input.branch ?? null,
      url: result.url ?? null,
      state: "queued",
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    records.unshift(record);
    records.splice(MAX_RECORDS);
    yield* Effect.logInfo("Deploy started", {
      plugin: record.pluginId,
      deploymentId: record.deploymentId,
      environment: record.environment,
    });
    return record;
  });

  const hold = Effect.fn("DeployService.hold")(function* (
    input: DeployStartInput,
    threadId: ThreadId,
  ) {
    // Refuse early, so an approval never asks about a deploy that cannot run.
    const { mapping } = yield* requireMapping(input.projectId);
    const approval: DeployPendingApproval = {
      id: yield* random.uuidV4(),
      projectId: input.projectId,
      pluginId: mapping.pluginId,
      providerProjectName: mapping.providerProjectName,
      environment: input.environment,
      branch: input.branch ?? null,
      threadId,
      requestedAt: DateTime.formatIso(yield* DateTime.now),
    };
    held.set(approval.id, { approval, input });
    return approval;
  });

  return DeployService.of({
    overview: Effect.gen(function* () {
      const entries = yield* host.deployProviders;
      const providers = yield* Effect.forEach(entries, summarize, { concurrency: "unbounded" });
      return {
        providers,
        mappings: yield* mappings,
        deployments: [...records],
        approvals: [...held.values()].map((entry) => entry.approval),
      };
    }),
    link: Effect.fn("DeployService.link")(function* (input) {
      const provider = yield* requireProvider(input.pluginId);
      return yield* provider
        .link(input.token === undefined ? {} : { token: input.token })
        .pipe(Effect.mapError(providerFailed(input.token)));
    }),
    unlink: Effect.fn("DeployService.unlink")(function* (pluginId) {
      const provider = yield* requireProvider(pluginId);
      yield* provider.unlink.pipe(Effect.mapError(providerFailed()));
    }),
    listProjects: Effect.fn("DeployService.listProjects")(function* (pluginId) {
      const provider = yield* requireProvider(pluginId);
      return yield* provider.listProjects.pipe(Effect.mapError(providerFailed()));
    }),
    mapProject: Effect.fn("DeployService.mapProject")(function* (input) {
      if (input.mapping !== null) yield* requireProvider(input.mapping.pluginId);
      const patch: Record<ProjectId, DeployProjectMapping | null> = {
        [input.projectId]: input.mapping,
      };
      yield* settings
        .updateSettings({ deployProjects: patch })
        .pipe(Effect.mapError(settingsFailed));
    }),
    start: Effect.fn("DeployService.start")(function* (input) {
      if (input.threadId !== undefined) {
        const mode = yield* threadModes.runtimeMode(input.threadId);
        if (mode !== "full-access") {
          return {
            _tag: "approval-required" as const,
            approval: yield* hold(input, input.threadId),
          };
        }
      }
      return { _tag: "started" as const, deployment: yield* runDeploy(input) };
    }),
    decideApproval: Effect.fn("DeployService.decideApproval")(function* (input) {
      const entry = held.get(input.approvalId);
      if (entry === undefined) {
        return yield* new DeployError({
          reason: "unknown-approval",
          message: "This deploy request was already answered.",
        });
      }
      held.delete(input.approvalId);
      return input.approve ? yield* runDeploy(entry.input) : null;
    }),
    status: Effect.fn("DeployService.status")(function* (input) {
      const provider = yield* requireProvider(input.pluginId);
      const status = yield* provider
        .deploymentStatus(input.deploymentId)
        .pipe(Effect.mapError(providerFailed()));
      const index = records.findIndex(
        (record) =>
          record.pluginId === input.pluginId && record.deploymentId === input.deploymentId,
      );
      const existing = records[index];
      if (existing !== undefined) {
        records[index] = { ...existing, state: status.state, url: status.url ?? existing.url };
      }
      return status;
    }),
    logs: (input) =>
      Stream.unwrap(
        requireProvider(input.pluginId).pipe(
          Effect.map((provider) =>
            provider
              .logs(input.deploymentId, input.follow === undefined ? {} : { follow: input.follow })
              .pipe(Stream.mapError(providerFailed())),
          ),
        ),
      ),
    rollback: Effect.fn("DeployService.rollback")(function* (input) {
      const { mapping, provider } = yield* requireMapping(input.projectId);
      return yield* provider
        .rollback({
          projectId: mapping.providerProjectId,
          ...(input.deploymentId === undefined ? {} : { deploymentId: input.deploymentId }),
        })
        .pipe(Effect.mapError(providerFailed()));
    }),
    domains: Effect.fn("DeployService.domains")(function* (projectId) {
      const { mapping, provider } = yield* requireMapping(projectId);
      return yield* provider
        .listDomains(mapping.providerProjectId)
        .pipe(Effect.mapError(providerFailed()));
    }),
    setEnv: Effect.fn("DeployService.setEnv")(function* (input) {
      const { mapping, provider } = yield* requireMapping(input.projectId);
      yield* provider
        .setEnv(mapping.providerProjectId, input.vars)
        .pipe(Effect.mapError(providerFailed()));
    }),
  });
});

export const layer = Layer.effect(DeployService, make);

/** The thread gate, read from orchestration's thread shells. */
export const layerThreadModes = Layer.effect(
  DeployThreadModes,
  Effect.map(Orchestrator.OrchestratorV2, (orchestrator) =>
    DeployThreadModes.of({
      runtimeMode: Effect.fn("DeployThreadModes.runtimeMode")((threadId) =>
        orchestrator.getThreadShell(threadId).pipe(
          Effect.map((shell) => shell?.runtimeMode ?? null),
          Effect.orElseSucceed(() => null),
        ),
      ),
    }),
  ),
);
