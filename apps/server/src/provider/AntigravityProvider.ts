import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  type AntigravitySettings,
  type ProviderSetupError,
  type RuntimeMode,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { parseSessionModeState } from "@t3tools/provider-acp/server/runtimeModel";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import {
  DeferringFailedCheck,
  makeManagedServerProvider,
} from "@t3tools/provider-core/server/managedProvider";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  buildServerProvider,
  isCommandMissingCause,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/provider-core/server/usageLimits";
import { antigravityThinkingConfig } from "./acp/AntigravityAcpSupport.ts";
import type { AntigravityAccountState } from "./AntigravityAccount.ts";

const EMPTY_MODEL_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAX_WORKSPACE_SNAPSHOTS = 32;
const HEALTH_CHECK_TIMEOUT_MS = 90_000;
const SIGN_IN_MESSAGE = "Sign in with Google to use Antigravity.";
const AUTH_UNCHECKED_MESSAGE =
  "Antigravity is installed. Google account access is not checked yet.";
// Set while a finished quota read republishes, so that health check does not read again.
const PublishingUsage = Context.Reference<boolean>("p0/provider/AntigravityPublishingUsage", {
  defaultValue: () => false,
});

type SessionSetupResult = Pick<
  AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
  "configOptions" | "models"
>;

type ThinkingConfig = NonNullable<ReturnType<typeof antigravityThinkingConfig>>;

/** Thinking options each model reported when selected; `null` means it has none. */
export type AntigravityThinkingLevels = ReadonlyMap<string, ThinkingConfig | null>;

function thinkingCapabilities(config: ThinkingConfig | null | undefined) {
  const descriptor = config
    ? acpProviderOptionDescriptors({ configOptions: [config], modeState: undefined })[0]
    : undefined;
  if (descriptor?.type !== "select") return EMPTY_MODEL_CAPABILITIES;
  return createModelCapabilities({ optionDescriptors: [descriptor] });
}

export function buildAntigravityModelsFromSession(
  setup: SessionSetupResult,
  thinkingLevels: AntigravityThinkingLevels = new Map(),
): ReadonlyArray<ServerProviderModel> {
  const config = setup.configOptions?.find(
    (option) => option.id === "model" || option.category === "model",
  );
  const currentValue =
    config?.type === "select" ? config.currentValue : setup.models?.currentModelId;
  const entries =
    config?.type === "select"
      ? config.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options))
      : config === undefined
        ? (setup.models?.availableModels.map((model) => ({
            value: model.modelId,
            name: model.name,
          })) ?? [])
        : [];
  const currentThinking = antigravityThinkingConfig(setup.configOptions);
  const seen = new Set<string>();
  // The agent can list two IDs under one name; label the later ones so the picker tells them apart.
  const names = new Set<string>();
  return entries.flatMap((entry): ServerProviderModel[] => {
    if (!entry.value.trim() || seen.has(entry.value)) return [];
    seen.add(entry.value);
    const baseName = entry.name.trim() ? entry.name : entry.value;
    const name = names.has(baseName) ? `${baseName} (${entry.value})` : baseName;
    names.add(baseName);
    const observed =
      entry.value === currentValue ? (currentThinking ?? null) : thinkingLevels.get(entry.value);
    return [
      {
        slug: entry.value,
        name,
        isCustom: false,
        ...(entry.value === currentValue
          ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] }
          : {}),
        // Levels differ per model; an unobserved model reports none so the registry keeps its cached ones.
        capabilities: thinkingCapabilities(observed),
      },
    ];
  });
}

function nativeCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command): ServerProviderSlashCommand[] => {
    if (!command.name.trim() || seen.has(command.name)) return [];
    seen.add(command.name);
    const description = command.description.trim();
    const hint = command.input?.hint.trim();
    return [
      {
        name: command.name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

function isMissingInstallation(error: EffectAcpErrors.AcpError | ProviderSetupError): boolean {
  if (error._tag === "AcpSpawnError") {
    return (
      isCommandMissingCause(error.cause) ||
      (Predicate.isObject(error.cause) && error.cause.code === "ENOENT")
    );
  }
  return (
    error._tag === "ProviderSetupError" &&
    error.operation === "resolve" &&
    /not installed|missing|incomplete|changed on disk|does not publish/i.test(error.detail)
  );
}

interface AntigravityProviderState {
  readonly draft: ServerProviderDraft;
  readonly authRevision: number;
}

interface AntigravityProviderOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly stampIdentity: (snapshot: ServerProviderDraft) => Effect.Effect<ServerProvider>;
  readonly probe: Effect.Effect<
    EffectAcpSchema.InitializeResponse,
    EffectAcpErrors.AcpError | ProviderSetupError
  >;
  readonly supportsTextGeneration: Effect.Effect<boolean>;
  /** Reads the account's remaining quota windows, such as from the CLI's `/usage` prompt. */
  readonly probeUsage?: Effect.Effect<ReadonlyArray<ServerProviderUsageWindow>>;
  readonly clearUsage?: Effect.Effect<void>;
  readonly maintenanceCapabilities?: ProviderMaintenanceCapabilities;
  readonly auth?: { readonly type: string; readonly label: string };
  /** What the saved sign-in says about its account, if the driver can read it. */
  readonly readAccount?: Effect.Effect<AntigravityAccountState>;
  /** Drops the stored account identity after an explicit sign-out. */
  readonly forgetAccount?: Effect.Effect<void>;
  /** Modes the last session advertised, saved because initialize alone does not report them. */
  readonly rememberedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  readonly rememberRuntimeModes?: (modes: ReadonlyArray<RuntimeMode>) => Effect.Effect<void>;
}

const RUNTIME_MODES_WITHOUT_AUTO = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const;

/** Auto is offered only where the session advertises agy's own Auto; elsewhere it runs Supervised. */
function antigravityRuntimeModes(
  sessionSetupResult: AcpSessionRuntime.AcpSessionRuntimeStartResult["sessionSetupResult"],
): ReadonlyArray<RuntimeMode> {
  return parseSessionModeState(sessionSetupResult)?.availableModes.some(
    (mode) => mode.id === "auto",
  )
    ? ["approval-required", "auto-accept-edits", "auto", "full-access"]
    : RUNTIME_MODES_WITHOUT_AUTO;
}

export const makeAntigravityProvider = Effect.fn("makeAntigravityProvider")(function* (
  settings: AntigravitySettings,
  options: AntigravityProviderOptions,
) {
  const usesCredentials =
    options.auth?.type === "gemini-api-key" || options.auth?.type === "agent-platform";
  const signInMessage = usesCredentials
    ? `Connect with ${options.auth.label} to use Antigravity and load models.`
    : SIGN_IN_MESSAGE;
  const authUncheckedMessage = usesCredentials
    ? `Antigravity is installed. Connect with ${options.auth.label} to load models.`
    : AUTH_UNCHECKED_MESSAGE;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const initialAccount = options.readAccount ? yield* options.readAccount : undefined;
  const accountAuth = (account: AntigravityAccountState | undefined) =>
    account === undefined
      ? {}
      : {
          ...(account.email ? { email: account.email } : {}),
          ...(account.expiresAt ? { expiresAt: account.expiresAt } : {}),
          ...(account.credentialStatus !== "unknown"
            ? { credentialStatus: account.credentialStatus }
            : {}),
          canRenewCredential: account.canRenew,
        };
  const initialDraft = {
    ...buildServerProvider({
      presentation: {
        displayName: "Antigravity",
        showInteractionModeToggle: false,
        supportedRuntimeModes: options.rememberedRuntimeModes ?? RUNTIME_MODES_WITHOUT_AUTO,
      },
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: {
          status: initialAccount?.hasSignIn ? "authenticated" : "unknown",
          ...(options.auth ? { type: options.auth.type } : {}),
          ...accountAuth(initialAccount),
        },
        message: settings.enabled
          ? "Checking Antigravity availability."
          : "Antigravity is disabled in p0code settings.",
      },
    }),
    setup: { canAuthenticate: true, canInstall: true },
    supportsConversationRollback: true,
    supportsTextGeneration: false,
    workspaceSnapshots: [],
  } satisfies ServerProviderDraft;
  const metadata = yield* SubscriptionRef.make<AntigravityProviderState>({
    draft: initialDraft,
    authRevision: 0,
  });
  // Preserve disk-discovered skills when callbacks replace workspace commands; the registry will not rescan them.
  const discoveredSkills = new Map<string, ServerProvider["skills"]>();
  const thinkingLevels = new Map<string, ThinkingConfig | null>();
  const observeThinkingLevels = (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  ) => {
    const model = configOptions?.find(
      (option) => option.id === "model" || option.category === "model",
    );
    if (model?.type === "select" && model.currentValue) {
      thinkingLevels.set(model.currentValue, antigravityThinkingConfig(configOptions) ?? null);
    }
  };
  const rememberRuntimeModes = Effect.fn("AntigravityProvider.rememberRuntimeModes")(function* (
    previous: ReadonlyArray<RuntimeMode> | undefined,
    next: ReadonlyArray<RuntimeMode>,
  ) {
    if (options.rememberRuntimeModes && previous?.join() !== next.join()) {
      yield* options.rememberRuntimeModes(next);
    }
  });
  const getSnapshot = SubscriptionRef.get(metadata).pipe(
    Effect.flatMap((state) => options.stampIdentity(state.draft)),
  );

  // The CLI's `/usage` prompt unpacks the agent and can take 20 seconds, so it never blocks
  // readiness or a session start. One read runs at a time; sign-out interrupts it so a stale
  // account never lands.
  const usageRead = yield* FiberHandle.make();
  const republish = yield* Deferred.make<Effect.Effect<ServerProvider>>();
  const scope = yield* Effect.scope;
  // No windows means no answer, never a fresh allowance; keep whatever was published before.
  const usageLimitsOf = (windows: ReadonlyArray<ServerProviderUsageWindow>) =>
    Effect.map(DateTime.now, (now) => {
      const checkedAt = DateTime.formatIso(now);
      return windows.length === 0
        ? makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message:
              "Antigravity's CLI did not report any quota. Refresh provider status to retry.",
          })
        : makeUsageLimits({ checkedAt, windows });
    });
  const refreshUsage = Effect.fn("AntigravityProvider.refreshUsage")(function* () {
    if (!options.probeUsage || (yield* PublishingUsage)) return;
    yield* FiberHandle.run(
      usageRead,
      options.probeUsage.pipe(
        Effect.flatMap(usageLimitsOf),
        Effect.flatMap((probed) =>
          SubscriptionRef.update(metadata, (state) => ({
            ...state,
            draft: {
              ...state.draft,
              usageLimits: resolveUsageLimitsAfterProbe({
                published: state.draft.usageLimits,
                probed,
              }),
            },
          })),
        ),
        // Enrichment cannot change published limits; a health check publishes them.
        Effect.andThen(
          Deferred.await(republish).pipe(
            Effect.flatten,
            Effect.provideService(PublishingUsage, true),
            Effect.ignoreCause({ log: true }),
            Effect.forkIn(scope),
          ),
        ),
      ),
      // Store the fiber before it runs, so a sign-out during the read can interrupt it.
      { onlyIfMissing: true, startImmediately: false },
    );
  });
  const resetUsage = Effect.gen(function* () {
    yield* FiberHandle.clear(usageRead);
    if (options.clearUsage) yield* options.clearUsage;
  });

  const checkProvider = Effect.fn("checkAntigravityProvider")(function* () {
    if (!settings.enabled) return yield* getSnapshot;
    const before = yield* SubscriptionRef.get(metadata);
    const timeoutMs = resolveProviderProbeTimeoutMs(
      "antigravity",
      HEALTH_CHECK_TIMEOUT_MS,
      options.environment,
    );
    const result = yield* options.probe.pipe(Effect.timeoutOption(timeoutMs), Effect.result);
    const initialized =
      Result.isSuccess(result) && Option.isSome(result.success) ? result.success.value : undefined;
    const version = initialized?.agentInfo?.version;
    const failure = Result.isFailure(result) ? result.failure : undefined;
    const missingInstallation = failure !== undefined && isMissingInstallation(failure);
    const errorMessage =
      initialized !== undefined
        ? undefined
        : failure?._tag === "ProviderSetupError"
          ? failure.detail.trim() || "Antigravity could not complete its local health check."
          : missingInstallation
            ? "Antigravity ACP runtime is not installed or its executable could not be found."
            : failure
              ? "Antigravity could not complete its local health check."
              : `Antigravity did not respond to its local health check within ${timeoutMs / 1_000} seconds.`;
    const supportsTextGeneration =
      initialized !== undefined ? yield* options.supportsTextGeneration : false;
    const account = options.readAccount ? yield* options.readAccount : undefined;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const applyCheck = (state: AntigravityProviderState) => {
      if (state.authRevision !== before.authRevision) return state;
      const { message: _previousMessage, ...draft } = state.draft;
      const auth = {
        ...draft.auth,
        ...accountAuth(account),
        ...(draft.auth.status === "unknown" && account?.hasSignIn
          ? { status: "authenticated" as const }
          : {}),
      };
      const authenticated = auth.status === "authenticated";
      const expired = auth.credentialStatus === "expired";
      const message =
        errorMessage ??
        (authenticated && !expired
          ? undefined
          : auth.status === "unauthenticated"
            ? signInMessage
            : expired
              ? undefined
              : authUncheckedMessage);
      return {
        ...state,
        draft: {
          ...draft,
          auth,
          installed: !missingInstallation,
          // Lightweight custom-launcher probes lack versions; preserve the real handshake's version.
          version: version === "unknown" ? draft.version : version || draft.version,
          status: errorMessage
            ? "error"
            : expired
              ? "warning"
              : authenticated
                ? "ready"
                : "warning",
          checkedAt: updatedAt,
          usageLimits: missingInstallation ? undefined : draft.usageLimits,
          ...(missingInstallation
            ? {
                models: [],
                slashCommands: [],
                skills: [],
                workspaceSnapshots: [],
                supportsTextGeneration: false,
              }
            : {}),
          ...(initialized !== undefined
            ? {
                supportsTextGeneration: supportsTextGeneration && auth.status !== "unauthenticated",
              }
            : {}),
          ...(message ? { message } : {}),
        },
      } satisfies AntigravityProviderState;
    };
    // This state is published as it changes, so a failure the managed provider discards stays out.
    const deferFailure = errorMessage !== undefined && (yield* DeferringFailedCheck);
    const next = yield* SubscriptionRef.modifySome(metadata, (state) => {
      const checked = applyCheck(state);
      const stored = deferFailure && state.draft.status === "ready" ? state : checked;
      return [checked, stored === state ? Option.none() : Option.some(stored)];
    });
    if (initialized !== undefined) yield* refreshUsage();
    return yield* options.stampIdentity(next.draft);
  });

  const maintenanceCapabilities =
    options.maintenanceCapabilities ??
    makeManualOnlyProviderMaintenanceCapabilities({
      provider: ProviderDriverKind.make("antigravity"),
      packageName: null,
    });
  const managed = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed(maintenanceCapabilities),
    getSettings: Effect.succeed(settings),
    streamSettings: Stream.empty,
    haveSettingsChanged: () => false,
    initialSnapshot: () => getSnapshot,
    checkProvider: checkProvider(),
    enrichSnapshot: ({ publishSnapshot }) =>
      SubscriptionRef.changes(metadata).pipe(
        Stream.runForEach((state) =>
          options.stampIdentity(state.draft).pipe(Effect.flatMap(publishSnapshot)),
        ),
      ),
  });
  yield* Deferred.succeed(republish, managed.refresh);

  const onSessionStarted = Effect.fn("AntigravityProvider.onSessionStarted")(function* (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd?: string,
  ) {
    if (!settings.enabled) return;
    observeThinkingLevels(started.sessionSetupResult.configOptions);
    const before = yield* SubscriptionRef.get(metadata);
    const accountState = options.readAccount ? yield* options.readAccount : undefined;
    const supportsTextGeneration = yield* options.supportsTextGeneration;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const supportedRuntimeModes = antigravityRuntimeModes(started.sessionSetupResult);
    const previousModes = yield* SubscriptionRef.modify(metadata, (state) => {
      if (
        state.authRevision !== before.authRevision &&
        state.draft.auth.status === "unauthenticated"
      ) {
        return [supportedRuntimeModes, state] as const;
      }
      const { message: _previousMessage, ...draft } = state.draft;
      const workspaces = draft.workspaceSnapshots ?? [];
      const workspace = cwd ? workspaces.find((entry) => entry.cwd === cwd) : undefined;
      const next = {
        authRevision: state.authRevision + 1,
        draft: {
          ...draft,
          installed: true,
          status: "ready",
          version: started.initializeResult.agentInfo?.version || draft.version,
          auth: {
            status: "authenticated",
            type: options.auth?.type ?? "oauth-personal",
            label: options.auth?.label ?? "Google account",
            ...accountAuth(accountState),
          },
          checkedAt: updatedAt,
          models: buildAntigravityModelsFromSession(started.sessionSetupResult, thinkingLevels),
          supportedRuntimeModes,
          supportsTextGeneration,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...workspaces.filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands: workspace?.slashCommands ?? draft.slashCommands,
                    skills: workspace?.skills ?? discoveredSkills.get(cwd) ?? [],
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      } satisfies AntigravityProviderState;
      return [draft.supportedRuntimeModes, next] as const;
    });
    yield* rememberRuntimeModes(previousModes, supportedRuntimeModes);
    if (!before.draft.usageLimits || before.draft.usageLimits.unavailable) yield* refreshUsage();
  });

  const onConfigOptionsUpdated = Effect.fn("AntigravityProvider.onConfigOptionsUpdated")(function* (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  ) {
    observeThinkingLevels(configOptions);
    const models = buildAntigravityModelsFromSession({ configOptions }, thinkingLevels);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (state.draft.auth.status !== "authenticated") return state;
      return { ...state, draft: { ...state.draft, models } };
    });
  });

  const onAvailableCommands = Effect.fn("AntigravityProvider.onAvailableCommands")(function* (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    cwd?: string,
  ) {
    if (!settings.enabled) return;
    const slashCommands = nativeCommands(commands);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(metadata, (state) => {
      if (state.draft.auth.status === "unauthenticated") return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          slashCommands,
          ...(cwd
            ? {
                workspaceSnapshots: [
                  ...(state.draft.workspaceSnapshots ?? []).filter((entry) => entry.cwd !== cwd),
                  {
                    cwd,
                    checkedAt: updatedAt,
                    slashCommands,
                    skills:
                      state.draft.workspaceSnapshots?.find((entry) => entry.cwd === cwd)?.skills ??
                      discoveredSkills.get(cwd) ??
                      [],
                  },
                ].slice(-MAX_WORKSPACE_SNAPSHOTS),
              }
            : {}),
        },
      };
    });
  });

  const clearAccountMetadata = Effect.fn("AntigravityProvider.clearAccountMetadata")(function* (
    keepSavedAccount: boolean,
  ) {
    yield* resetUsage;
    if (!settings.enabled) return;
    const account =
      keepSavedAccount && options.readAccount ? yield* options.readAccount : undefined;
    const keepsAccount = account?.hasSignIn === true;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const previousModes = yield* SubscriptionRef.modify(metadata, (state) => {
      const { message: _previousMessage, ...draft } = state.draft;
      return [
        state.draft.supportedRuntimeModes,
        {
          authRevision: state.authRevision + 1,
          draft: {
            ...draft,
            auth: keepsAccount
              ? {
                  ...state.draft.auth,
                  status: "authenticated",
                  ...(usesCredentials ? options.auth : {}),
                  ...accountAuth(account),
                }
              : {
                  status: "unauthenticated",
                  ...(usesCredentials ? options.auth : {}),
                },
            status: "warning",
            ...(keepsAccount ? {} : { message: signInMessage }),
            checkedAt: updatedAt,
            usageLimits: undefined,
            ...(keepsAccount
              ? {}
              : {
                  models: [],
                  slashCommands: [],
                  skills: [],
                  workspaceSnapshots: [],
                  supportedRuntimeModes: RUNTIME_MODES_WITHOUT_AUTO,
                  supportsTextGeneration: false,
                }),
          },
        } satisfies AntigravityProviderState,
      ] as const;
    });
    if (!keepsAccount) {
      yield* rememberRuntimeModes(previousModes, RUNTIME_MODES_WITHOUT_AUTO);
      discoveredSkills.clear();
      thinkingLevels.clear();
    }
  });

  const snapshotForCwd = Effect.fn("AntigravityProvider.snapshotForCwd")(function* (
    cwd: string,
    skills?: ServerProvider["skills"],
  ) {
    if (skills) {
      discoveredSkills.set(cwd, skills);
      yield* SubscriptionRef.update(metadata, (state) =>
        state.draft.workspaceSnapshots?.some((entry) => entry.cwd === cwd)
          ? {
              ...state,
              draft: {
                ...state.draft,
                workspaceSnapshots: state.draft.workspaceSnapshots.map((entry) =>
                  entry.cwd === cwd ? { ...entry, skills } : entry,
                ),
              },
            }
          : state,
      );
    }
    const snapshot = yield* getSnapshot;
    const workspace = snapshot.workspaceSnapshots?.find((entry) => entry.cwd === cwd);
    const resolvedSkills = skills ?? workspace?.skills ?? discoveredSkills.get(cwd) ?? [];
    return workspace
      ? { ...snapshot, slashCommands: workspace.slashCommands, skills: resolvedSkills }
      : { ...snapshot, skills: resolvedSkills };
  });

  return {
    snapshot: { ...managed, getSnapshot },
    onSessionStarted,
    onConfigOptionsUpdated,
    onAvailableCommands,
    onSignedOut: clearAccountMetadata(false).pipe(
      Effect.andThen(options.forgetAccount ?? Effect.void),
    ),
    // Keep a lapsed account visible; only an explicit sign-out forgets who it was.
    onAuthRequired: clearAccountMetadata(true),
    snapshotForCwd,
  };
});
