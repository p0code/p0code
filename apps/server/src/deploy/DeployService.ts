/**
 * Settings → Deploy host service. Provider ids resolve to a built-in (Vercel, Cloudflare) first,
 * then a `deploy:provider` plugin. Accounts are profile-scoped; non-full-access threads need
 * approval. Own-server (`./ownServer.ts`) is a non-functional stub and is not wired.
 */
import {
  type AccountProfileId,
  ALL_DEPLOY_PROVIDER_OPERATIONS,
  type DeployAccount,
  type DeployAccountRef,
  type DeployAccountSummary,
  type DeployDecideApprovalInput,
  type DeployDeploymentInput,
  type DeployDomain,
  DeployError,
  type DeployLinkRpcInput,
  type DeployLinkRpcResult,
  type DeployLogsInput,
  type DeployMapProjectInput,
  type DeployOverview,
  type DeployPendingApproval,
  type DeployProjectMapping,
  type DeployProjectRollbackInput,
  type DeployProviderProject,
  type DeployProviderStatus,
  type DeployProviderSummary,
  type DeployRecord,
  type DeployResult,
  type DeploySetEnvInput,
  type DeployStartInput,
  type DeployStartResult,
  type DeployUpdateAccountInput,
  type DeploymentStatus,
  isDeployAccountInProfile,
  type ProjectId,
  resolveActiveAccountProfile,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import type { PluginError, StartedDeployProvider } from "@t3tools/plugin-api";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { PluginHost } from "../plugins/PluginHost.ts";
import { ProjectService } from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BuiltinDeployProviders } from "./BuiltinDeployProviders.ts";
import { DeployStore } from "./DeployStore.ts";

/** What the deploy gate and the folder check need to know about threads and projects. */
export class DeployWorkspace extends Context.Service<
  DeployWorkspace,
  {
    /** Null when the thread is unknown. */
    readonly thread: (threadId: ThreadId) => Effect.Effect<{
      readonly runtimeMode: RuntimeMode;
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
    } | null>;
    /** The project's folder on this machine; null when the project is unknown. */
    readonly projectRoot: (projectId: ProjectId) => Effect.Effect<string | null>;
  }
>()("p0/deploy/DeployService/DeployWorkspace") {}

export class DeployService extends Context.Service<
  DeployService,
  {
    readonly overview: Effect.Effect<DeployOverview, DeployError>;
    readonly link: (input: DeployLinkRpcInput) => Effect.Effect<DeployLinkRpcResult, DeployError>;
    readonly unlink: (accountId: string) => Effect.Effect<void, DeployError>;
    readonly updateAccount: (input: DeployUpdateAccountInput) => Effect.Effect<void, DeployError>;
    readonly listProjects: (
      accountId: string,
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

const UNLINKED: DeployProviderStatus = { state: "unlinked", accountLabel: null, message: null };

/** Removes a secret the caller just handed over from any text going back out. */
export const redact = (text: string, secret: string | undefined): string =>
  secret === undefined || secret.length < 4 ? text : text.split(secret).join("[redacted]");

const refOf = (account: DeployAccount): DeployAccountRef => ({
  accountId: account.id,
  ...(account.teamId === null ? {} : { teamId: account.teamId }),
});

const make = Effect.gen(function* () {
  const host = yield* PluginHost;
  const builtins = yield* BuiltinDeployProviders;
  const settings = yield* ServerSettings.ServerSettingsService;
  const workspace = yield* DeployWorkspace;
  const store = yield* DeployStore;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;

  const fail = (reason: DeployError["reason"], message: string) =>
    Effect.fail(new DeployError({ reason, message }));

  const providerFailed =
    (secret?: string) =>
    (error: PluginError): DeployError =>
      new DeployError({ reason: "provider-failed", message: redact(error.message, secret) });

  // Unreadable settings leave every account visible, as thread launches do.
  const activeProfile: Effect.Effect<AccountProfileId | null> = settings.getSettings.pipe(
    Effect.map((current) => resolveActiveAccountProfile(current)?.id ?? null),
    Effect.orElseSucceed(() => null),
  );

  const builtinFor = (providerId: string) =>
    builtins.find((builtin) => builtin.info.id === providerId);

  /** Plugin providers whose id a built-in does not already claim. */
  const pluginProviders = host.deployProviders.pipe(
    Effect.map((entries) => entries.filter((entry) => builtinFor(entry.manifest.id) === undefined)),
  );

  /** The running provider for an id (built-in first, then plugins); null when off or unknown. */
  const runningProvider = Effect.fn("DeployService.runningProvider")(function* (
    providerId: string,
  ) {
    const builtin = builtinFor(providerId);
    if (builtin !== undefined) return builtin.provider;
    const entry = (yield* pluginProviders).find(
      (candidate) => candidate.manifest.id === providerId,
    );
    return entry?.provider ?? null;
  });

  const requireProvider = Effect.fn("DeployService.requireProvider")(function* (pluginId: string) {
    const builtin = builtinFor(pluginId);
    if (builtin !== undefined) return builtin.provider;
    const entries = yield* pluginProviders;
    const entry = entries.find((candidate) => candidate.manifest.id === pluginId);
    if (entry === undefined) {
      return yield* fail(
        "unknown-provider",
        "No built-in provider or installed plugin provides this deploy target.",
      );
    }
    if (entry.provider === null) {
      return yield* fail("provider-off", `Turn on ${entry.manifest.name} in Plugins first.`);
    }
    return entry.provider;
  });

  /** The account, if it exists and the active profile shows it. */
  const requireAccount = Effect.fn("DeployService.requireAccount")(function* (accountId: string) {
    const account = yield* store.getAccount(accountId);
    if (account === null)
      return yield* fail("unknown-account", "This deploy account is not linked.");
    if (!isDeployAccountInProfile(account, yield* activeProfile)) {
      return yield* fail(
        "not-in-profile",
        "This deploy account is not in the active profile. Add it to the profile in Settings → Deploy.",
      );
    }
    return account;
  });

  const requireAccountProvider = Effect.fn("DeployService.requireAccountProvider")(function* (
    accountId: string,
  ) {
    const account = yield* requireAccount(accountId);
    return { account, ref: refOf(account), provider: yield* requireProvider(account.pluginId) };
  });

  const requireMapping = Effect.fn("DeployService.requireMapping")(function* (
    projectId: ProjectId,
  ) {
    const mapping = yield* store.getMapping(projectId);
    if (mapping === null) {
      return yield* fail("not-mapped", "Choose a deploy target for this project first.");
    }
    return { mapping, ...(yield* requireAccountProvider(mapping.accountId)) };
  });

  /**
   * The project's root (a thread's own worktree when the thread belongs to the project) and the
   * folder to deploy from, refusing one outside the root unless the caller allowed it.
   */
  const resolveSource = Effect.fn("DeployService.resolveSource")(function* (
    input: DeployStartInput,
    mapping: DeployProjectMapping,
  ) {
    const thread = input.threadId === undefined ? null : yield* workspace.thread(input.threadId);
    const projectRoot =
      thread !== null && thread.projectId === input.projectId && thread.worktreePath !== null
        ? thread.worktreePath
        : yield* workspace.projectRoot(input.projectId);
    if (projectRoot === null) {
      return yield* fail("unknown-project", "This project's folder is not known on this server.");
    }
    const requested = Object.hasOwn(input, "directory") ? input.directory : mapping.directory;
    const directory = requested === undefined ? projectRoot : path.resolve(projectRoot, requested);
    const relative = path.relative(projectRoot, directory);
    const outside =
      relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    const allowOutsideProject =
      Object.hasOwn(input, "allowOutsideProject") && input.allowOutsideProject === true;
    if (outside && !allowOutsideProject) {
      return yield* fail(
        "outside-project",
        `${directory} is outside the project folder. Allow deploying from outside the project to use it.`,
      );
    }
    return { projectRoot, directory, thread };
  });

  const builtinSummaries: ReadonlyArray<DeployProviderSummary> = builtins.map(({ info }) => ({
    pluginId: info.id,
    label: info.label,
    icon: info.icon,
    running: true,
    origin: "builtin",
    version: info.version,
    description: info.description,
    supportedOperations: info.supportedOperations,
    supportedTargetKinds: info.supportedTargetKinds,
    supportedSourceKinds: info.supportedSourceKinds,
  }));

  const summarizePlugin = (
    entry: Effect.Success<typeof host.deployProviders>[number],
  ): DeployProviderSummary => ({
    pluginId: entry.manifest.id,
    label: entry.provider?.descriptor.label ?? entry.manifest.name,
    icon: entry.provider?.descriptor.icon ?? null,
    running: entry.provider !== null,
    origin: "plugin",
    version: entry.manifest.version,
    description: entry.manifest.description,
    // The plugin API requires every operation.
    supportedOperations: ALL_DEPLOY_PROVIDER_OPERATIONS,
  });

  const summarizeAccount = (
    account: DeployAccount,
    provider: StartedDeployProvider | null,
  ): Effect.Effect<DeployAccountSummary> =>
    (provider === null
      ? Effect.succeed(UNLINKED)
      : provider.status(refOf(account)).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchCause(() =>
            Effect.succeed<DeployProviderStatus>({
              state: "error",
              accountLabel: null,
              message: "Could not reach the provider.",
            }),
          ),
        )
    ).pipe(Effect.map((status) => ({ ...account, status })));

  const runDeploy = Effect.fn("DeployService.runDeploy")(function* (input: DeployStartInput) {
    const { mapping, account, ref, provider } = yield* requireMapping(input.projectId);
    if (input.accountId !== account.id) {
      return yield* fail(
        "account-mismatch",
        "This project now deploys to a different account. Start the deploy again.",
      );
    }
    const { projectRoot, directory } = yield* resolveSource(input, mapping);
    const environment = input.environment ?? mapping.defaultEnvironment;
    const result = yield* provider
      .deploy({
        account: ref,
        target: { kind: mapping.targetKind, id: mapping.targetId },
        environment,
        source: {
          kind: input.sourceKind,
          projectRoot,
          directory,
          ...(input.branch === undefined ? {} : { branch: input.branch }),
        },
        ...(input.envVars === undefined ? {} : { envVars: input.envVars }),
      })
      .pipe(Effect.mapError(providerFailed()));
    const record: DeployRecord = {
      pluginId: account.pluginId,
      accountId: account.id,
      deploymentId: result.deploymentId,
      projectId: input.projectId,
      threadId: input.threadId ?? null,
      targetKind: mapping.targetKind,
      targetName: mapping.targetName,
      environment,
      branch: input.branch ?? null,
      url: result.url ?? null,
      state: "queued",
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* store.insertRecord(record);
    yield* Effect.logInfo("Deploy started", {
      plugin: record.pluginId,
      account: record.accountId,
      deploymentId: record.deploymentId,
      environment: record.environment,
    });
    return record;
  });

  const hold = Effect.fn("DeployService.hold")(function* (
    input: DeployStartInput,
    threadId: ThreadId,
    mapping: DeployProjectMapping,
    account: DeployAccount,
    directory: string,
  ) {
    const approval: DeployPendingApproval = {
      id: yield* random.uuidV4(),
      projectId: input.projectId,
      pluginId: account.pluginId,
      accountId: account.id,
      targetName: mapping.targetName,
      environment: input.environment ?? mapping.defaultEnvironment,
      branch: input.branch ?? null,
      directory,
      threadId,
      requestedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* store.insertApproval({ approval, request: input });
    return approval;
  });

  return DeployService.of({
    overview: Effect.gen(function* () {
      const activeProfileId = yield* activeProfile;
      const entries = yield* pluginProviders;
      const visible = (yield* store.listAccounts).filter((account) =>
        isDeployAccountInProfile(account, activeProfileId),
      );
      const accounts = yield* Effect.forEach(
        visible,
        (account) =>
          runningProvider(account.pluginId).pipe(
            Effect.flatMap((provider) => summarizeAccount(account, provider)),
          ),
        { concurrency: "unbounded" },
      );
      const shown = new Set(visible.map((account) => account.id));
      const mappings: Record<string, DeployProjectMapping> = {};
      for (const mapping of yield* store.listMappings) {
        if (shown.has(mapping.accountId)) mappings[mapping.projectId] = mapping;
      }
      return {
        activeProfileId,
        providers: [...builtinSummaries, ...entries.map(summarizePlugin)],
        accounts,
        mappings,
        deployments: (yield* store.listRecords).filter((record) => shown.has(record.accountId)),
        approvals: (yield* store.listApprovals).filter((approval) => shown.has(approval.accountId)),
      };
    }),
    link: Effect.fn("DeployService.link")(function* (input) {
      const provider = yield* requireProvider(input.pluginId);
      let account: DeployAccount;
      let created = false;
      if (input.accountId !== undefined) {
        account = yield* requireAccount(input.accountId);
        if (account.pluginId !== input.pluginId) {
          return yield* fail("unknown-account", "This account belongs to another provider.");
        }
        if (
          (input.label !== undefined && input.label !== account.label) ||
          (input.teamId !== undefined && input.teamId !== account.teamId)
        ) {
          yield* store.updateAccount(account.id, {
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
          });
          account = {
            ...account,
            ...(input.label === undefined ? {} : { label: input.label }),
            ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
          };
        }
      } else {
        const activeProfileId = yield* activeProfile;
        account = {
          id: yield* random.uuidV4(),
          pluginId: input.pluginId,
          label: input.label ?? null,
          teamId: input.teamId ?? null,
          profileIds: input.profileIds ?? (activeProfileId === null ? [] : [activeProfileId]),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* store.insertAccount(account);
        created = true;
      }
      const result = yield* provider
        .link({
          account: refOf(account),
          ...(input.token === undefined ? {} : { token: input.token }),
        })
        .pipe(
          Effect.mapError(providerFailed(input.token)),
          // A new account the provider refused is not kept.
          Effect.tapError(() => (created ? store.deleteAccount(account.id) : Effect.void)),
        );
      if (result._tag === "linked" && result.teamId !== undefined && account.teamId === null) {
        yield* store.updateAccount(account.id, { teamId: result.teamId });
      }
      return { accountId: account.id, result };
    }),
    unlink: Effect.fn("DeployService.unlink")(function* (accountId) {
      const account = yield* requireAccount(accountId);
      const known =
        builtinFor(account.pluginId) !== undefined ||
        (yield* pluginProviders).some((candidate) => candidate.manifest.id === account.pluginId);
      // A removed plugin took its storage with it; only the record is left to forget.
      if (known) {
        const provider = yield* requireProvider(account.pluginId);
        yield* provider.unlink(refOf(account)).pipe(Effect.mapError(providerFailed()));
      }
      yield* store.deleteAccount(account.id);
    }),
    updateAccount: Effect.fn("DeployService.updateAccount")(function* (input) {
      const account = yield* requireAccount(input.accountId);
      yield* store.updateAccount(account.id, {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.profileIds === undefined ? {} : { profileIds: input.profileIds }),
      });
    }),
    listProjects: Effect.fn("DeployService.listProjects")(function* (accountId) {
      const { ref, provider } = yield* requireAccountProvider(accountId);
      return yield* provider.listProjects(ref).pipe(Effect.mapError(providerFailed()));
    }),
    mapProject: Effect.fn("DeployService.mapProject")(function* (input) {
      const existing = yield* store.getMapping(input.projectId);
      // Another profile's mapping stays out of reach, even to clear.
      if (existing !== null) yield* requireAccount(existing.accountId);
      if (input.mapping === null) {
        yield* store.deleteMapping(input.projectId);
        return;
      }
      yield* requireAccountProvider(input.mapping.accountId);
      yield* store.setMapping({ projectId: input.projectId, ...input.mapping });
    }),
    start: Effect.fn("DeployService.start")(function* (input) {
      // Refuse early, so an approval never asks about a deploy that cannot run.
      const { mapping, account } = yield* requireMapping(input.projectId);
      if (input.accountId !== account.id) {
        return yield* fail(
          "account-mismatch",
          "This project deploys to a different account than the one asked for.",
        );
      }
      const { directory, thread } = yield* resolveSource(input, mapping);
      if (input.threadId !== undefined && thread?.runtimeMode !== "full-access") {
        return {
          _tag: "approval-required" as const,
          approval: yield* hold(input, input.threadId, mapping, account, directory),
        };
      }
      return { _tag: "started" as const, deployment: yield* runDeploy(input) };
    }),
    decideApproval: Effect.fn("DeployService.decideApproval")(function* (input) {
      const held = yield* store.getApproval(input.approvalId);
      if (held === null) {
        return yield* fail("unknown-approval", "This deploy request was already answered.");
      }
      yield* requireAccount(held.approval.accountId);
      if (!(yield* store.deleteApproval(input.approvalId))) {
        return yield* fail("unknown-approval", "This deploy request was already answered.");
      }
      return input.approve ? yield* runDeploy(held.request) : null;
    }),
    status: Effect.fn("DeployService.status")(function* (input) {
      const { ref, provider } = yield* requireAccountProvider(input.accountId);
      const status = yield* provider
        .deploymentStatus({ account: ref, deploymentId: input.deploymentId })
        .pipe(Effect.mapError(providerFailed()));
      yield* store.updateRecord(
        input.accountId,
        input.deploymentId,
        status.state,
        status.url ?? null,
      );
      return status;
    }),
    logs: (input) =>
      Stream.unwrap(
        requireAccountProvider(input.accountId).pipe(
          Effect.map(({ ref, provider }) =>
            provider
              .logs({
                account: ref,
                deploymentId: input.deploymentId,
                ...(input.follow === undefined ? {} : { follow: input.follow }),
              })
              .pipe(Stream.mapError(providerFailed())),
          ),
        ),
      ),
    rollback: Effect.fn("DeployService.rollback")(function* (input) {
      const { mapping, ref, provider } = yield* requireMapping(input.projectId);
      return yield* provider
        .rollback({
          account: ref,
          target: { kind: mapping.targetKind, id: mapping.targetId },
          ...(input.deploymentId === undefined ? {} : { deploymentId: input.deploymentId }),
        })
        .pipe(Effect.mapError(providerFailed()));
    }),
    domains: Effect.fn("DeployService.domains")(function* (projectId) {
      const { mapping, ref, provider } = yield* requireMapping(projectId);
      return yield* provider
        .listDomains({ account: ref, target: { kind: mapping.targetKind, id: mapping.targetId } })
        .pipe(Effect.mapError(providerFailed()));
    }),
    setEnv: Effect.fn("DeployService.setEnv")(function* (input) {
      const { mapping, ref, provider } = yield* requireMapping(input.projectId);
      yield* provider
        .setEnv({
          account: ref,
          target: { kind: mapping.targetKind, id: mapping.targetId },
          environment: input.environment,
          vars: input.vars,
          secret: input.secret ?? false,
          remove: input.remove ?? [],
        })
        .pipe(Effect.mapError(providerFailed()));
    }),
  });
});

export const layer = Layer.effect(DeployService, make);

/** Threads from orchestration's thread shells, project folders from the project service. */
export const layerWorkspace = Layer.effect(
  DeployWorkspace,
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectService;
    return DeployWorkspace.of({
      thread: Effect.fn("DeployWorkspace.thread")((threadId) =>
        orchestrator.getThreadShell(threadId).pipe(
          Effect.map((shell) =>
            shell === null
              ? null
              : {
                  runtimeMode: shell.runtimeMode,
                  projectId: shell.projectId,
                  worktreePath: shell.worktreePath,
                },
          ),
          Effect.orElseSucceed(() => null),
        ),
      ),
      projectRoot: Effect.fn("DeployWorkspace.projectRoot")((projectId) =>
        projects.getById(projectId).pipe(
          Effect.map(
            Option.match({ onNone: () => null, onSome: (project) => project.workspaceRoot }),
          ),
          Effect.orElseSucceed(() => null),
        ),
      ),
    });
  }),
);
