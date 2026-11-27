/*
 * MIT License
 * Copyright (c) 2026 p0code contributors
 * Ported from https://github.com/p0code/deploy-vercel (v0.2.0)
 */
import {
  ALL_DEPLOY_PROVIDER_OPERATIONS,
  isFinalDeploymentState,
  type DeployProviderOperation,
  type DeploySourceKind,
  type DeployTargetKind,
} from "@t3tools/contracts";
import {
  checkDeployProvider,
  type DeployAccountRef,
  type DeployDeploymentRequest,
  type DeployEnvVars,
  type DeployLinkInput,
  type DeployLinkResult,
  type DeployProvider,
  type DeployProviderDeployInput,
  type DeployProviderDescriptor,
  type DeployProviderSetEnvInput,
  type DeployProviderStatus,
  type DeployProviderStorage,
  type DeployResult,
  type DeployRollbackInput,
  type DeployTargetRequest,
  PluginError,
  type StartedDeployProvider,
} from "@t3tools/plugin-api";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { collectLocalBuildFiles, toUploadedFileRefs } from "./localBuild.ts";
import {
  DEFAULT_VERCEL_API_BASE_URL,
  type EnvTarget,
  EXPIRED_TOKEN_MESSAGE,
  makeVercelClient,
  redactSecrets,
  type UpsertEnvItem,
  VercelApiError,
  VercelAuthExpiredError,
  type VercelClientError,
  type VercelLogEvent,
} from "./vercelClient.ts";

export const VERCEL_PROVIDER_INFO = {
  id: "vercel",
  label: "Vercel",
  icon: "triangle",
  version: "0.2.0",
  description:
    "Deploy p0code projects to Vercel via Git or local builds, stream build logs, list domains, set environment variables, and roll back production releases.",
  supportedOperations: ALL_DEPLOY_PROVIDER_OPERATIONS as ReadonlyArray<DeployProviderOperation>,
  supportedTargetKinds: ["vercel-project"] as ReadonlyArray<DeployTargetKind>,
  supportedSourceKinds: ["git", "local-build"] as ReadonlyArray<DeploySourceKind>,
} as const;

const VERCEL_PROVIDER_DESCRIPTOR: DeployProviderDescriptor = {
  id: VERCEL_PROVIDER_INFO.id,
  label: VERCEL_PROVIDER_INFO.label,
  icon: VERCEL_PROVIDER_INFO.icon,
};

const isAuthExpired = Schema.is(VercelAuthExpiredError);
const isApiError = Schema.is(VercelApiError);

const TOKEN_STORAGE_KEY = "token";
const ACCOUNT_STORAGE_KEY = "account";
const storageKey = (account: DeployAccountRef, key: string) => `${account.accountId}:${key}`;
const teamWarnings = (teamId: string | undefined) =>
  teamId
    ? [
        {
          code: "team-scope",
          message: `Requests are limited to Vercel team ${teamId}; the token must grant access to that team.`,
        },
      ]
    : [];

const DEFAULT_LOGS_LIMIT = 100;
const MAX_LOGS_EVENTS = 1_000;
const DEFAULT_FOLLOW_POLL_INTERVAL_MS = 1_500;
const DEFAULT_FOLLOW_MAX_POLLS = 240;

const StoredAccount = Schema.Struct({
  accountLabel: Schema.String,
  userId: Schema.String,
  linkedAt: Schema.Number,
  expired: Schema.optionalKey(Schema.Boolean),
  teamId: Schema.optionalKey(Schema.String),
});
type StoredAccount = typeof StoredAccount.Type;

const decodeStoredAccount = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredAccount));
const encodeStoredAccount = Schema.encodeEffect(Schema.fromJsonString(StoredAccount));

export interface CreateVercelDeployProviderOptions {
  readonly storage: DeployProviderStorage;
  readonly baseUrl?: string;
  readonly logsPollIntervalMs?: number;
  readonly logsMaxPolls?: number;
}

function toUpsertEnvItems(
  vars: DeployEnvVars,
  targets: ReadonlyArray<EnvTarget>,
): ReadonlyArray<UpsertEnvItem> {
  return Object.entries(vars).map(([key, value]) => ({
    key: key.trim(),
    value,
    type: "encrypted" as const,
    target: targets,
  }));
}

function formatLogLine(event: VercelLogEvent): string {
  const text = event.text.trimEnd();
  if (text.length === 0) return "";
  return event.type.length > 0 ? `[${event.type}] ${text}` : text;
}

/**
 * Creates a schema-checked built-in Vercel deploy provider backed by the host's credential storage
 * and Effect `HttpClient` / `FileSystem` / `Path` services.
 */
export const createVercelDeployProvider = Effect.fn("createVercelDeployProvider")(function* (
  options: CreateVercelDeployProviderOptions,
): Effect.fn.Return<
  StartedDeployProvider,
  never,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
> {
  const { storage } = options;
  const httpClient = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const client = makeVercelClient(httpClient, options.baseUrl ?? DEFAULT_VERCEL_API_BASE_URL);
  const followPollIntervalMs = options.logsPollIntervalMs ?? DEFAULT_FOLLOW_POLL_INTERVAL_MS;
  const followMaxPolls = options.logsMaxPolls ?? DEFAULT_FOLLOW_MAX_POLLS;

  const readToken = (account: DeployAccountRef) =>
    storage.get(storageKey(account, TOKEN_STORAGE_KEY)).pipe(Effect.map(Option.getOrNull));

  const readAccount = (account: DeployAccountRef) =>
    storage
      .get(storageKey(account, ACCOUNT_STORAGE_KEY))
      .pipe(
        Effect.flatMap((maybe) =>
          Option.isNone(maybe)
            ? Effect.succeed(null)
            : decodeStoredAccount(maybe.value).pipe(Effect.orElseSucceed(() => null)),
        ),
      );

  const writeAccount = (ref: DeployAccountRef, account: StoredAccount) =>
    encodeStoredAccount(account).pipe(
      Effect.mapError(
        (cause) => new PluginError({ message: "Could not encode Vercel account metadata.", cause }),
      ),
      Effect.flatMap((json) => storage.set(storageKey(ref, ACCOUNT_STORAGE_KEY), json)),
    );

  const markExpired = Effect.fn("VercelDeployProvider.markExpired")(function* (
    ref: DeployAccountRef,
  ) {
    yield* storage.remove(storageKey(ref, TOKEN_STORAGE_KEY)).pipe(Effect.ignore);
    const current = yield* readAccount(ref);
    if (current !== null) {
      yield* writeAccount(ref, { ...current, expired: true }).pipe(Effect.ignore);
    }
  });

  const handleClientError =
    (ref: DeployAccountRef, token: string, extraSecrets: ReadonlyArray<string> = []) =>
    (error: VercelClientError) => {
      if (isAuthExpired(error)) {
        return markExpired(ref).pipe(
          Effect.andThen(Effect.fail(new PluginError({ message: EXPIRED_TOKEN_MESSAGE }))),
        );
      }
      return Effect.fail(
        new PluginError({ message: redactSecrets(error.message, token, extraSecrets) }),
      );
    };

  const requireAuth = Effect.fn("VercelDeployProvider.requireAuth")(function* (
    ref: DeployAccountRef,
  ) {
    const token = yield* readToken(ref);
    if (token === null || token.trim().length === 0) {
      const account = yield* readAccount(ref);
      const message =
        account?.expired === true
          ? EXPIRED_TOKEN_MESSAGE
          : "Vercel account is not linked. Link a personal access token first.";
      return yield* new PluginError({ message });
    }
    const teamId = ref.teamId ?? (yield* readAccount(ref))?.teamId;
    return { token, ...(teamId !== undefined ? { teamId } : {}) };
  });

  const status: DeployProvider["status"] = Effect.fn("VercelDeployProvider.status")(function* (
    ref: DeployAccountRef,
  ) {
    const token = yield* readToken(ref);
    const account = yield* readAccount(ref);
    const teamId = ref.teamId ?? account?.teamId;

    if (token !== null && token.trim().length > 0) {
      if (account === null) {
        return {
          state: "error",
          accountLabel: null,
          message: "Vercel account metadata is missing, link again.",
        } satisfies DeployProviderStatus;
      }
      return {
        state: "linked",
        accountLabel: account.accountLabel,
        message: null,
        warnings: teamWarnings(teamId),
      } satisfies DeployProviderStatus;
    }

    if (account?.expired === true) {
      return {
        state: "expired",
        accountLabel: account.accountLabel,
        message: EXPIRED_TOKEN_MESSAGE,
      } satisfies DeployProviderStatus;
    }

    return {
      state: "unlinked",
      accountLabel: null,
      message: null,
    } satisfies DeployProviderStatus;
  });

  const link: DeployProvider["link"] = Effect.fn("VercelDeployProvider.link")(function* (
    input: DeployLinkInput,
  ) {
    const token = input.token?.trim() ?? "";
    if (token.length === 0) {
      return yield* new PluginError({
        message:
          "Provide a Vercel personal access token (create one at https://vercel.com/account/tokens).",
      });
    }
    const user = yield* (
      input.account.teamId ? client.getTeam(token, input.account.teamId) : client.getUser(token)
    ).pipe(
      Effect.catch((error) => {
        if (isAuthExpired(error)) {
          return Effect.fail(new PluginError({ message: EXPIRED_TOKEN_MESSAGE }));
        }
        return Effect.fail(new PluginError({ message: redactSecrets(error.message, token) }));
      }),
    );
    const now = yield* Clock.currentTimeMillis;
    yield* storage.set(storageKey(input.account, TOKEN_STORAGE_KEY), token);
    yield* writeAccount(input.account, {
      accountLabel: user.accountLabel,
      userId: user.id,
      linkedAt: now,
      expired: false,
      ...(input.account.teamId ? { teamId: input.account.teamId } : {}),
    });
    return {
      _tag: "linked" as const,
      accountLabel: user.accountLabel,
      ...(input.account.teamId ? { teamId: input.account.teamId } : {}),
      warnings: teamWarnings(input.account.teamId),
    } satisfies DeployLinkResult;
  });

  const unlink: DeployProvider["unlink"] = Effect.fn("VercelDeployProvider.unlink")(function* (
    ref: DeployAccountRef,
  ) {
    yield* storage.remove(storageKey(ref, TOKEN_STORAGE_KEY));
    yield* storage.remove(storageKey(ref, ACCOUNT_STORAGE_KEY));
  });

  const listProjects: DeployProvider["listProjects"] = Effect.fn(
    "VercelDeployProvider.listProjects",
  )(function* (ref: DeployAccountRef) {
    const { token, teamId } = yield* requireAuth(ref);
    return yield* client
      .listProjects(token, {
        limit: 100,
        ...(teamId !== undefined ? { teamId } : {}),
      })
      .pipe(Effect.catch(handleClientError(ref, token)));
  });

  const deploy: DeployProvider["deploy"] = Effect.fn("VercelDeployProvider.deploy")(function* (
    input: DeployProviderDeployInput,
  ) {
    if (input.target.kind !== "vercel-project")
      return yield* new PluginError({ message: "Vercel requires a vercel-project target." });
    const { token, teamId } = yield* requireAuth(input.account);

    const mergedEnv: DeployEnvVars = {
      ...input.source.env,
      ...input.envVars,
    };
    if (Object.keys(mergedEnv).length > 0) {
      const targets: ReadonlyArray<EnvTarget> =
        input.environment === "production" ? ["production"] : ["preview"];
      yield* client
        .upsertEnv(token, input.target.id, toUpsertEnvItems(mergedEnv, targets), teamId)
        .pipe(Effect.catch(handleClientError(input.account, token)));
    }

    const project = yield* client
      .getProject(token, input.target.id, teamId)
      .pipe(Effect.catch(handleClientError(input.account, token)));

    if (input.source.kind === "git") {
      const gitLink = project.gitLink;
      if (gitLink === null) {
        return yield* new PluginError({
          message: `Vercel project "${project.name}" is not connected to a Git repository. Connect a repository in Vercel or deploy with source.kind="local-build".`,
        });
      }
      const branch = input.source.branch?.trim() || gitLink.productionBranch || "main";
      return yield* client
        .createDeployment(
          token,
          {
            name: project.name,
            project: project.id,
            ...(input.environment === "production" ? { target: "production" } : {}),
            gitSource: {
              type: gitLink.type,
              ref: branch,
              ...(gitLink.repoId !== undefined ? { repoId: gitLink.repoId } : {}),
              ...(gitLink.org !== undefined ? { org: gitLink.org } : {}),
              ...(gitLink.repo !== undefined ? { repo: gitLink.repo } : {}),
            },
          },
          teamId,
        )
        .pipe(Effect.catch(handleClientError(input.account, token)));
    }

    if (input.source.directory === undefined || input.source.directory.trim().length === 0) {
      return yield* new PluginError({
        message:
          'Local-build deploy requires source.directory (for example "dist" or ".vercel/output").',
      });
    }
    const bundle = yield* collectLocalBuildFiles(input.source.directory, {
      fs,
      path,
      ...(input.source.projectRoot !== undefined ? { projectRoot: input.source.projectRoot } : {}),
    });
    yield* Effect.forEach(
      bundle.files,
      (entry) =>
        client
          .uploadFile(token, {
            sha1: entry.sha,
            bytes: entry.bytes,
            ...(teamId !== undefined ? { teamId } : {}),
          })
          .pipe(Effect.catch(handleClientError(input.account, token))),
      { concurrency: 4, discard: true },
    );
    return yield* client
      .createDeployment(
        token,
        {
          name: project.name,
          project: project.id,
          ...(input.environment === "production" ? { target: "production" } : {}),
          files: toUploadedFileRefs(bundle.files),
          ...(bundle.prebuilt ? { prebuilt: true } : { projectSettings: { framework: null } }),
        },
        teamId,
      )
      .pipe(Effect.catch(handleClientError(input.account, token)));
  });

  const deploymentStatus: DeployProvider["deploymentStatus"] = Effect.fn(
    "VercelDeployProvider.deploymentStatus",
  )(function* (input: DeployDeploymentRequest) {
    const { deploymentId } = input;
    const { token, teamId } = yield* requireAuth(input.account);
    return yield* client
      .getDeployment(token, deploymentId, teamId)
      .pipe(Effect.catch(handleClientError(input.account, token)));
  });

  const logs: DeployProvider["logs"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { token, teamId } = yield* requireAuth(input.account);
        const { deploymentId } = input;
        const follow = input.follow === true;
        const maxPolls = follow ? followMaxPolls : 1;
        const seen = new Set<string>();

        interface PollState {
          readonly poll: number;
          readonly since: number | undefined;
          readonly emitted: number;
        }

        return Stream.paginate<PollState, string, PluginError>(
          { poll: 0, since: undefined, emitted: 0 },
          (state) =>
            Effect.gen(function* () {
              if (state.poll > 0 && followPollIntervalMs > 0) {
                yield* Effect.sleep(Duration.millis(followPollIntervalMs));
              }
              const batch = yield* client
                .getDeploymentEvents(token, deploymentId, {
                  limit: DEFAULT_LOGS_LIMIT,
                  ...(state.since !== undefined ? { since: state.since } : {}),
                  ...(teamId !== undefined ? { teamId } : {}),
                })
                .pipe(Effect.catch(handleClientError(input.account, token)));

              const lines: Array<string> = [];
              let nextSince = state.since;
              let emitted = state.emitted;

              for (const event of batch) {
                const dedupeKey = event.id ?? `${event.created}:${event.type}:${event.text}`;
                if (seen.has(dedupeKey)) continue;
                seen.add(dedupeKey);
                if (emitted >= MAX_LOGS_EVENTS) break;
                const line = formatLogLine(event);
                if (line.length > 0) {
                  lines.push(line);
                  emitted += 1;
                }
                if (event.created > 0) {
                  nextSince =
                    nextSince === undefined ? event.created : Math.max(nextSince, event.created);
                }
              }

              if (!follow || emitted >= MAX_LOGS_EVENTS || state.poll + 1 >= maxPolls) {
                return [lines, Option.none<PollState>()] as const;
              }

              const latest = yield* client
                .getDeployment(token, deploymentId, teamId)
                .pipe(Effect.catch(handleClientError(input.account, token)));
              if (isFinalDeploymentState(latest.state)) {
                return [lines, Option.none<PollState>()] as const;
              }

              return [
                lines,
                Option.some<PollState>({
                  poll: state.poll + 1,
                  since: nextSince,
                  emitted,
                }),
              ] as const;
            }),
        );
      }),
    );

  const rollback: DeployProvider["rollback"] = Effect.fn("VercelDeployProvider.rollback")(
    function* (input: DeployRollbackInput) {
      if (input.target.kind !== "vercel-project")
        return yield* new PluginError({ message: "Vercel requires a vercel-project target." });
      const { token, teamId } = yield* requireAuth(input.account);
      let targetDeploymentId = input.deploymentId;
      let targetUrl: string | undefined;

      if (targetDeploymentId !== undefined) {
        const detail = yield* client
          .getDeployment(token, targetDeploymentId, teamId)
          .pipe(Effect.catch(handleClientError(input.account, token)));
        targetUrl = detail.url;
      } else {
        const recent = yield* client
          .listDeployments(token, {
            projectId: input.target.id,
            target: "production",
            state: "READY",
            limit: 5,
            ...(teamId !== undefined ? { teamId } : {}),
          })
          .pipe(Effect.catch(handleClientError(input.account, token)));
        const previous = recent[1];
        if (previous === undefined) {
          return yield* new PluginError({
            message: "No previous ready production deployment was found to roll back to.",
          });
        }
        targetDeploymentId = previous.deploymentId;
        targetUrl = previous.url;
      }

      const resolvedDeploymentId = targetDeploymentId;
      yield* client.rollbackDeployment(token, input.target.id, resolvedDeploymentId, teamId).pipe(
        Effect.catch((error) => {
          if (isApiError(error) && (error.status === 400 || error.status === 404)) {
            return client
              .promoteDeployment(token, input.target.id, resolvedDeploymentId, teamId)
              .pipe(Effect.catch(handleClientError(input.account, token)));
          }
          return handleClientError(input.account, token)(error);
        }),
      );

      return {
        deploymentId: resolvedDeploymentId,
        ...(targetUrl !== undefined ? { url: targetUrl } : {}),
      } satisfies DeployResult;
    },
  );

  const listDomains: DeployProvider["listDomains"] = Effect.fn("VercelDeployProvider.listDomains")(
    function* (input: DeployTargetRequest) {
      if (input.target.kind !== "vercel-project")
        return yield* new PluginError({ message: "Vercel requires a vercel-project target." });
      const projectId = input.target.id;
      const { token, teamId } = yield* requireAuth(input.account);
      return yield* client
        .listDomains(token, projectId, {
          limit: 100,
          ...(teamId !== undefined ? { teamId } : {}),
        })
        .pipe(Effect.catch(handleClientError(input.account, token)));
    },
  );

  const setEnv: DeployProvider["setEnv"] = Effect.fn("VercelDeployProvider.setEnv")(function* (
    input: DeployProviderSetEnvInput,
  ) {
    if (input.target.kind !== "vercel-project")
      return yield* new PluginError({ message: "Vercel requires a vercel-project target." });
    const { token, teamId } = yield* requireAuth(input.account);
    if (input.secret && input.environment === "development" && Object.keys(input.vars).length > 0)
      return yield* new PluginError({
        message:
          "Vercel does not support sensitive variables in development. Choose a deployed environment or turn off secret storage.",
      });
    const entries = toUpsertEnvItems(input.vars, [input.environment]).map((entry) => ({
      ...entry,
      type: input.secret ? ("sensitive" as const) : ("plain" as const),
    }));
    if (entries.length === 0 && input.remove.length === 0) {
      return yield* new PluginError({ message: "Provide at least one environment variable." });
    }
    for (const entry of entries) {
      if (entry.key.length === 0) {
        return yield* new PluginError({ message: "Environment variable keys cannot be empty." });
      }
    }
    const secretValues = input.secret ? Object.values(input.vars) : [];
    yield* client
      .removeEnv(token, input.target.id, input.remove, input.environment, teamId)
      .pipe(Effect.catch(handleClientError(input.account, token, secretValues)));
    if (entries.length > 0)
      yield* client
        .upsertEnv(token, input.target.id, entries, teamId, secretValues)
        .pipe(Effect.catch(handleClientError(input.account, token, secretValues)));
  });

  return checkDeployProvider(VERCEL_PROVIDER_DESCRIPTOR, {
    link,
    unlink,
    status,
    listProjects,
    deploy,
    deploymentStatus,
    logs,
    rollback,
    listDomains,
    setEnv,
  });
});
