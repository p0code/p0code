/*
 * MIT License
 * Copyright (c) 2026 p0code
 * Ported from https://github.com/p0code/deploy-cloudflare (v0.3.0)
 */
import type {
  DeployAccountRef,
  DeployDeploymentRequest,
  DeployDomain,
  DeployLinkInput,
  DeployLogsRequest,
  DeployProvider,
  DeployProviderDeployInput,
  DeployProviderProject,
  DeployProviderSetEnvInput,
  DeployProviderStatus,
  DeployProviderStorage,
  DeployRollbackInput,
  DeployTarget,
  DeployTargetRequest,
  DeployWarning,
  DeploymentStatus,
} from "@t3tools/plugin-api";
import { PluginError } from "@t3tools/plugin-api";
import type * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Cf from "./cloudflareApi.ts";
import { collectPagesAssets, loadWorkerBundle, readPageAssetBase64 } from "./deployFiles.ts";
import { redactSecrets } from "./redact.ts";

/** Scopes a Cloudflare API token should grant depending on which products you deploy. */
const REQUIRED_TOKEN_SCOPES = [
  "Account Settings:Read",
  "Pages:Edit",
  "Workers Scripts:Edit",
] as const;

const STORAGE_TOKEN_KEY = "api_token";
const STORAGE_META_KEY = "account_meta";
const storageKey = (account: DeployAccountRef, key: string) => `${account.accountId}:${key}`;

const LINK_AGAIN = "Link Cloudflare again in Settings → Deploy with a new API token.";
const DEFAULT_LOG_POLL_INTERVAL_MS = 3_000;
const DEFAULT_FOLLOW_MAX_POLLS = 240;
const DEFAULT_MAX_LOG_LINES = 1_000;
const UPLOAD_BATCH_MAX_FILES = 50;
const UPLOAD_BATCH_MAX_BYTES = 10 * 1024 * 1024;

const StoredAccountMeta = Schema.Struct({
  accountId: Schema.String,
  accountLabel: Schema.String,
  tokenId: Schema.String,
  expiresAt: Schema.optionalKey(Schema.String),
  warnings: Schema.optionalKey(
    Schema.Array(Schema.Struct({ code: Schema.String, message: Schema.String })),
  ),
  accounts: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
type StoredAccountMeta = typeof StoredAccountMeta.Type;

const decodeMetaJson = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredAccountMeta));
const encodeMetaJson = Schema.encodeEffect(Schema.fromJsonString(StoredAccountMeta));

/** The host services a provider call uses. */
type Lent = HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Digest.Digest;

type ProjectKind = "pages" | "worker";
type DeploymentState = DeploymentStatus["state"];

// Ids travel through the host as opaque strings, so they carry the product and project name.
const makeProjectId = (kind: ProjectKind, name: string): string => `${kind}:${name}`;

const makeDeploymentId = (kind: ProjectKind, name: string, rawId: string): string =>
  `${kind}:${name}:${rawId}`;

function parseProjectId(projectId: string): {
  readonly kind: ProjectKind;
  readonly name: string;
} {
  if (projectId.startsWith("worker:")) return { kind: "worker", name: projectId.slice(7) };
  if (projectId.startsWith("pages:")) return { kind: "pages", name: projectId.slice(6) };
  return { kind: "pages", name: projectId };
}

const resolveTarget = (target: DeployTarget) => {
  if (target.kind === "vercel-project")
    return Effect.fail(
      new PluginError({ message: "Cloudflare requires a pages or worker target." }),
    );
  const parsed = parseProjectId(target.id);
  const prefixed = target.id.startsWith("pages:") || target.id.startsWith("worker:");
  if (prefixed && parsed.kind !== target.kind)
    return Effect.fail(new PluginError({ message: "Cloudflare target kind and id disagree." }));
  return Effect.succeed({ kind: target.kind, name: prefixed ? parsed.name : target.id });
};

function parseDeploymentRef(
  id: string,
  projectId?: string,
): { readonly kind: ProjectKind; readonly name: string; readonly rawId: string } | null {
  const match = /^(pages|worker):([^:]+):(.+)$/.exec(id);
  if (match?.[1] && match[2] && match[3]) {
    return { kind: match[1] === "worker" ? "worker" : "pages", name: match[2], rawId: match[3] };
  }
  if (projectId !== undefined) {
    const project = parseProjectId(projectId);
    return { ...project, rawId: id };
  }
  return null;
}

function pagesState(stage: Cf.CfPagesDeployment["latest_stage"]): {
  readonly state: DeploymentState;
  readonly message?: string;
} {
  switch (stage?.status) {
    case "success":
      // A Pages deployment is ready only once its last stage ("deploy") succeeds.
      return stage.name === "deploy"
        ? { state: "ready" }
        : { state: "building", message: `${stage.name} done` };
    case "active":
      return { state: "building", message: stage.name };
    case "failure":
      return { state: "error", message: `Cloudflare Pages ${stage.name} stage failed.` };
    case "canceled":
    case "cancelled":
      return { state: "canceled" };
    default:
      return { state: "queued" };
  }
}

const isFinal = (state: DeploymentState) =>
  state === "ready" || state === "error" || state === "canceled";

const pagesDashboardUrl = (accountId: string, project: string, deploymentId: string) =>
  `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/pages/view/${encodeURIComponent(project)}/${encodeURIComponent(deploymentId)}`;

const workerLogsDashboardUrl = (accountId: string, script: string) =>
  `https://dash.cloudflare.com/${encodeURIComponent(accountId)}/workers/services/view/${encodeURIComponent(script)}/production/observability/logs`;

export interface CloudflareProviderOptions {
  readonly storage: DeployProviderStorage;
  readonly logsPollIntervalMs?: number;
  readonly logsMaxPolls?: number;
  readonly maxLogLines?: number;
  readonly maxPagesFiles?: number;
  readonly maxPagesBytes?: number;
}

export const makeCloudflareProvider = Effect.fn("CloudflareProvider.make")(function* (
  options: CloudflareProviderOptions,
) {
  const { storage } = options;
  const logPollIntervalMs = options.logsPollIntervalMs ?? DEFAULT_LOG_POLL_INTERVAL_MS;
  const followMaxPolls = options.logsMaxPolls ?? DEFAULT_FOLLOW_MAX_POLLS;
  const maxLogLines = options.maxLogLines ?? DEFAULT_MAX_LOG_LINES;
  const pathService = yield* Path.Path;
  const services = yield* Effect.context<Lent>();

  const readMeta = (account: DeployAccountRef) =>
    storage
      .get(storageKey(account, STORAGE_META_KEY))
      .pipe(
        Effect.flatMap((maybe) =>
          Option.isSome(maybe)
            ? decodeMetaJson(maybe.value).pipe(Effect.orElseSucceed(() => null))
            : Effect.succeed(null),
        ),
      );
  const readToken = (account: DeployAccountRef) =>
    storage.get(storageKey(account, STORAGE_TOKEN_KEY)).pipe(Effect.map(Option.getOrNull));

  /**
   * Every provider call runs with the host's lent services, and every message it fails with is
   * scrubbed of the stored token once more, since the host only redacts the token it was handed
   * on `link`.
   */
  const guarded = <A>(
    account: DeployAccountRef,
    effect: Effect.Effect<A, PluginError, Lent>,
  ): Effect.Effect<A, PluginError> =>
    readToken(account).pipe(
      Effect.flatMap((token) =>
        Effect.provideContext(effect, services).pipe(
          Effect.mapError(
            (error) =>
              new PluginError({ message: redactSecrets(error.message, token ? [token] : []) }),
          ),
        ),
      ),
    );

  const requireLinked = Effect.fn("CloudflareProvider.requireLinked")(function* (
    account: DeployAccountRef,
  ) {
    const token = yield* readToken(account);
    const meta = yield* readMeta(account);
    if (!token || !meta) {
      return yield* new PluginError({
        message:
          "Cloudflare is not linked. Paste a Cloudflare API token in Settings → Deploy first.",
      });
    }
    return { token, meta };
  });

  /** An auth failure on a stored token means it expired or was revoked; say how to recover. */
  const cfError = (error: Cf.CloudflareApiError) =>
    new PluginError({
      message: error.isAuthError ? `${error.message} ${LINK_AGAIN}` : error.message,
    });

  const scopeWarnings = Effect.fn("CloudflareProvider.scopeWarnings")(function* (
    token: string,
    accountId: string,
  ) {
    const warnings: Array<DeployWarning> = [];
    const checks = [
      { scope: "Pages:Edit", effect: Cf.listPagesProjects(token, accountId).pipe(Effect.asVoid) },
      {
        scope: "Workers Scripts:Edit",
        effect: Cf.listWorkerScripts(token, accountId).pipe(Effect.asVoid),
      },
    ];
    for (const check of checks) {
      const result = yield* check.effect.pipe(Effect.asVoid, Effect.result);
      if (result._tag === "Failure" && result.failure.isScopeError)
        warnings.push({
          code: "missing-scope",
          message: `Token lacks ${check.scope}; related projects or routes may be hidden.`,
        });
    }
    const zones = yield* Cf.listZones(token, accountId).pipe(Effect.result);
    if (zones._tag === "Failure" && zones.failure.isScopeError)
      warnings.push({
        code: "missing-scope",
        message: "Token lacks Zone:Read; zone routes are hidden.",
      });
    if (zones._tag === "Success") {
      for (const zone of zones.success) {
        const routes = yield* Cf.listZoneWorkerRoutes(token, zone.id).pipe(Effect.result);
        if (routes._tag === "Failure" && routes.failure.isScopeError) {
          warnings.push({
            code: "missing-scope",
            message: "Token lacks Workers Routes:Read; zone routes are hidden.",
          });
          break;
        }
      }
    }
    return warnings;
  });

  const resolveWorkersSubdomain = (token: string, accountId: string) =>
    Cf.getWorkersSubdomain(token, accountId).pipe(
      Effect.map((res) => res.subdomain),
      Effect.orElseSucceed(() => undefined),
    );

  const workerUrl = (name: string, subdomain: string | undefined) =>
    subdomain ? `https://${name}.${subdomain}.workers.dev` : undefined;

  // ── link / unlink / status ──────────────────────────────────────────────────────────────────

  const link = Effect.fn("CloudflareProvider.link")(function* (input: DeployLinkInput) {
    const token = input.token?.trim() ?? "";
    if (token.length === 0) {
      return yield* new PluginError({
        message: `Cloudflare links with an API token, not a browser sign-in. Create a Custom API Token (${REQUIRED_TOKEN_SCOPES.join(", ")}) under Cloudflare Dashboard → My Profile → API Tokens and paste it here.`,
      });
    }

    const verified = yield* Cf.verifyToken(token).pipe(Effect.mapError(Cf.toPluginError));
    if (verified.status !== "active") {
      return yield* new PluginError({
        message: `Cloudflare API token is not active (status: ${verified.status}). Create an active token with ${REQUIRED_TOKEN_SCOPES.join(", ")}.`,
      });
    }

    const accounts = yield* Cf.listAccounts(token).pipe(Effect.mapError(Cf.toPluginError));
    const chosen = input.account.teamId
      ? accounts.find((account) => account.id === input.account.teamId)
      : accounts[0];
    if (!chosen) {
      return yield* new PluginError({
        message:
          'Cloudflare API token cannot access the requested account (or returned no accounts). Ensure the token grants "Account Settings:Read" on at least one account.',
      });
    }

    const accountLabel = chosen.name;
    const warnings = yield* scopeWarnings(token, chosen.id);
    const meta: StoredAccountMeta = {
      accountId: chosen.id,
      accountLabel,
      tokenId: verified.id,
      warnings,
      ...(verified.expires_on ? { expiresAt: verified.expires_on } : {}),
      accounts: accounts.map((acct) => ({ id: acct.id, name: acct.name })),
    };
    const encodedMeta = yield* encodeMetaJson(meta).pipe(
      Effect.mapError(
        () => new PluginError({ message: "Could not save Cloudflare account metadata." }),
      ),
    );

    yield* storage.set(storageKey(input.account, STORAGE_TOKEN_KEY), token);
    yield* storage.set(storageKey(input.account, STORAGE_META_KEY), encodedMeta);
    return { _tag: "linked" as const, accountLabel, teamId: chosen.id, warnings };
  });

  const unlink = Effect.fn("CloudflareProvider.unlink")(function* (account: DeployAccountRef) {
    yield* storage.remove(storageKey(account, STORAGE_TOKEN_KEY));
    yield* storage.remove(storageKey(account, STORAGE_META_KEY));
  });

  const status = Effect.fn("CloudflareProvider.status")(function* (account: DeployAccountRef) {
    const token = yield* readToken(account);
    const meta = yield* readMeta(account);
    if (!token || !meta) {
      return {
        state: "unlinked",
        accountLabel: null,
        message: null,
      } satisfies DeployProviderStatus;
    }
    const expired = (message: string): DeployProviderStatus => ({
      state: "expired",
      accountLabel: meta.accountLabel,
      message: `${message} ${LINK_AGAIN}`,
    });

    if (meta.expiresAt !== undefined) {
      const expiresAt = DateTime.make(meta.expiresAt);
      if (Option.isSome(expiresAt) && DateTime.isLessThan(expiresAt.value, yield* DateTime.now)) {
        return expired(`The Cloudflare API token expired on ${meta.expiresAt}.`);
      }
    }

    const verified = yield* Cf.verifyToken(token).pipe(Effect.result);
    if (verified._tag === "Failure") {
      const error = verified.failure;
      if (error.isAuthError || error.status === 403) {
        return expired("Cloudflare rejected the stored API token (expired or revoked).");
      }
      return {
        state: "error",
        accountLabel: meta.accountLabel,
        message: error.message,
      } satisfies DeployProviderStatus;
    }
    if (verified.success.status !== "active") {
      return expired(`The Cloudflare API token is ${verified.success.status}.`);
    }
    return {
      state: "linked",
      accountLabel: meta.accountLabel,
      message: null,
      warnings: yield* scopeWarnings(token, meta.accountId),
    } satisfies DeployProviderStatus;
  });

  // ── projects ────────────────────────────────────────────────────────────────────────────────

  const listProjects = Effect.fn("CloudflareProvider.listProjects")(function* (
    account: DeployAccountRef,
  ) {
    const { token, meta } = yield* requireLinked(account);
    const projects: Array<DeployProviderProject> = [];
    const missing: Array<string> = [];

    const pages = yield* Cf.listPagesProjects(token, meta.accountId).pipe(Effect.result);
    if (pages._tag === "Success") {
      for (const proj of pages.success) {
        projects.push({
          kind: "pages",
          id: makeProjectId("pages", proj.name),
          name: `${proj.name} (Pages)`,
          ...(proj.subdomain ? { url: `https://${proj.subdomain}` } : {}),
        });
      }
    } else if (pages.failure.isScopeError) {
      missing.push("Pages:Edit");
    } else {
      return yield* cfError(pages.failure);
    }

    const workers = yield* Cf.listWorkerScripts(token, meta.accountId).pipe(Effect.result);
    if (workers._tag === "Success") {
      const subdomain = yield* resolveWorkersSubdomain(token, meta.accountId);
      for (const script of workers.success) {
        const url = workerUrl(script.id, subdomain);
        projects.push({
          kind: "worker",
          id: makeProjectId("worker", script.id),
          name: `${script.id} (Worker)`,
          ...(url ? { url } : {}),
        });
      }
    } else if (workers.failure.isScopeError) {
      missing.push("Workers Scripts:Edit");
    } else {
      return yield* cfError(workers.failure);
    }

    if (missing.length === 2) {
      return yield* new PluginError({
        message:
          'Cloudflare API token lacks both "Pages:Edit" and "Workers Scripts:Edit" scopes. Grant at least one in Cloudflare Dashboard → My Profile → API Tokens.',
      });
    }
    return projects;
  });

  // ── deploy ──────────────────────────────────────────────────────────────────────────────────

  const requireBuildDirectory = (input: DeployProviderDeployInput, what: string) => {
    const directory = input.source.directory;
    if (directory === undefined) {
      return Effect.fail(
        new PluginError({
          message: `${what} needs the built output directory, and p0code did not send one. Deploy from a Git branch instead, or pass an absolute build directory.`,
        }),
      );
    }
    if (!pathService.isAbsolute(directory)) {
      return Effect.fail(
        new PluginError({
          message: `${what} got the relative directory "${directory}", but the host must resolve it against source.projectRoot before calling the provider.`,
        }),
      );
    }
    return Effect.succeed(directory);
  };

  const deployPages = Effect.fn("CloudflareProvider.deployPages")(function* (
    token: string,
    meta: StoredAccountMeta,
    project: string,
    input: DeployProviderDeployInput,
  ) {
    if (input.envVars && Object.keys(input.envVars).length > 0) {
      // Pages has no per-deployment variables; they live on the project's environment.
      const vars = Object.fromEntries(
        Object.entries(input.envVars).map(([key, value]) => [
          key,
          { type: "plain_text" as const, value },
        ]),
      );
      yield* Cf.patchPagesProjectEnv(token, meta.accountId, project, input.environment, vars).pipe(
        Effect.mapError(cfError),
      );
    }

    let manifest: Record<string, string> | undefined;
    if (input.source.kind === "local-build") {
      const directory = yield* requireBuildDirectory(input, "A Cloudflare Pages Direct Upload");
      const assets = yield* collectPagesAssets(directory, {
        ...(input.source.projectRoot !== undefined
          ? { projectRoot: input.source.projectRoot }
          : {}),
        ...(options.maxPagesFiles !== undefined ? { maxFiles: options.maxPagesFiles } : {}),
        ...(options.maxPagesBytes !== undefined ? { maxTotalBytes: options.maxPagesBytes } : {}),
      });
      const hashes = assets.map((asset) => asset.hash);
      const upload = yield* Cf.getPagesUploadToken(token, meta.accountId, project).pipe(
        Effect.mapError(cfError),
      );
      const missingHashes = new Set(
        yield* Cf.checkMissingPagesAssets(upload.jwt, hashes, token).pipe(Effect.mapError(cfError)),
      );
      const missingAssets = assets.filter((asset) => missingHashes.has(asset.hash));
      // Read and upload missing assets in bounded batches so peak memory stays small.
      let batch: Array<Cf.PagesAssetUploadItem> = [];
      let batchBytes = 0;
      const flushBatch = () =>
        batch.length === 0
          ? Effect.void
          : Cf.uploadPagesAssets(upload.jwt, batch, token).pipe(
              Effect.mapError(cfError),
              Effect.tap(() =>
                Effect.sync(() => {
                  batch = [];
                  batchBytes = 0;
                }),
              ),
            );
      for (const asset of missingAssets) {
        if (
          batch.length >= UPLOAD_BATCH_MAX_FILES ||
          (batch.length > 0 && batchBytes + asset.size > UPLOAD_BATCH_MAX_BYTES)
        ) {
          yield* flushBatch();
        }
        const base64 = yield* readPageAssetBase64(asset.filePath);
        batch.push({
          key: asset.hash,
          value: base64,
          metadata: { contentType: asset.contentType },
          base64: true as const,
        });
        batchBytes += asset.size;
      }
      yield* flushBatch();
      yield* Cf.upsertPagesHashes(upload.jwt, hashes, token).pipe(Effect.mapError(cfError));
      manifest = Object.fromEntries(assets.map((asset) => [asset.routePath, asset.hash]));
    }

    const branch = input.source.branch ?? (input.environment === "preview" ? "preview" : undefined);
    const deployment = yield* Cf.createPagesDeployment(token, meta.accountId, project, {
      ...(branch ? { branch } : {}),
      ...(manifest ? { manifest } : {}),
    }).pipe(Effect.mapError(cfError));
    return {
      deploymentId: makeDeploymentId("pages", project, deployment.id),
      ...(deployment.url ? { url: deployment.url } : {}),
    };
  });

  const deployWorker = Effect.fn("CloudflareProvider.deployWorker")(function* (
    token: string,
    meta: StoredAccountMeta,
    script: string,
    input: DeployProviderDeployInput,
  ) {
    if (input.source.kind !== "local-build") {
      return yield* new PluginError({
        message:
          'Cloudflare cannot build Workers from Git over its API. Deploy with "Local build" and a built Worker directory (with its wrangler.toml / wrangler.jsonc).',
      });
    }
    const directory = yield* requireBuildDirectory(input, "A Cloudflare Workers upload");
    const bundle = yield* loadWorkerBundle({
      directory,
      ...(input.source.projectRoot !== undefined ? { projectRoot: input.source.projectRoot } : {}),
      ...(input.environment === "preview" ? { envName: "preview" } : {}),
      ...(input.envVars ? { envVars: input.envVars } : {}),
    });
    const uploaded = yield* Cf.uploadWorkerScript(token, meta.accountId, script, bundle).pipe(
      Effect.mapError(cfError),
    );
    const versionId = yield* Cf.listWorkerVersions(token, meta.accountId, script).pipe(
      Effect.map((list) => list.items[0]?.id),
      Effect.orElseSucceed(() => undefined),
    );
    const customDomains = yield* Cf.listWorkerDomains(token, meta.accountId, script).pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<Cf.CfWorkerDomain>),
    );
    const route = bundle.routes[0];
    const url = customDomains[0]
      ? `https://${customDomains[0].hostname}`
      : route
        ? route.startsWith("http")
          ? route
          : `https://${route.replace(/\*$/, "")}`
        : workerUrl(script, yield* resolveWorkersSubdomain(token, meta.accountId));
    return {
      deploymentId: makeDeploymentId(
        "worker",
        script,
        versionId ?? uploaded.etag ?? uploaded.id ?? script,
      ),
      ...(url ? { url } : {}),
    };
  });

  const deploy = Effect.fn("CloudflareProvider.deploy")(function* (
    input: DeployProviderDeployInput,
  ) {
    const { token, meta } = yield* requireLinked(input.account);
    if (input.source.env && Object.keys(input.source.env).length > 0) {
      return yield* new PluginError({
        message:
          "Cloudflare takes no build variables per deployment. Set them on the project with environment variables instead.",
      });
    }
    const target = yield* resolveTarget(input.target);
    return target.kind === "pages"
      ? yield* deployPages(token, meta, target.name, input)
      : yield* deployWorker(token, meta, target.name, input);
  });

  // ── status and logs ─────────────────────────────────────────────────────────────────────────

  const requireRef = (deploymentId: string) => {
    const ref = parseDeploymentRef(deploymentId);
    return ref
      ? Effect.succeed(ref)
      : Effect.fail(
          new PluginError({
            message: `"${deploymentId}" is not a Cloudflare deployment id ("pages:<project>:<id>" or "worker:<script>:<version>").`,
          }),
        );
  };

  const deploymentStatus = Effect.fn("CloudflareProvider.deploymentStatus")(function* (
    input: DeployDeploymentRequest,
  ) {
    const { deploymentId } = input;
    const { token, meta } = yield* requireLinked(input.account);
    const ref = yield* requireRef(deploymentId);
    if (ref.kind === "pages") {
      const dep = yield* Cf.getPagesDeployment(token, meta.accountId, ref.name, ref.rawId).pipe(
        Effect.mapError(cfError),
      );
      const { state, message } = pagesState(dep.latest_stage);
      return {
        deploymentId,
        state,
        ...(dep.url ? { url: dep.url } : {}),
        ...(message ? { message } : {}),
      } satisfies DeploymentStatus;
    }
    // A Worker upload is live once the API accepts it; there is no build to wait on.
    const version = yield* Cf.getWorkerVersion(token, meta.accountId, ref.name, ref.rawId).pipe(
      Effect.mapError(cfError),
    );
    const url = workerUrl(ref.name, yield* resolveWorkersSubdomain(token, meta.accountId));
    return {
      deploymentId: makeDeploymentId("worker", ref.name, version.id),
      state: "ready",
      ...(url ? { url } : {}),
    } satisfies DeploymentStatus;
  });

  const pagesLogLines = (token: string, accountId: string, project: string, rawId: string) =>
    Cf.getPagesDeploymentLogs(token, accountId, project, rawId).pipe(
      Effect.map((result) =>
        (result.data ?? []).map((row) => (row.ts ? `${row.ts} ${row.line}` : row.line)),
      ),
    );

  const logs = (input: DeployLogsRequest): Stream.Stream<string, PluginError> =>
    Stream.unwrap(
      guarded(
        input.account,
        Effect.gen(function* () {
          const { deploymentId } = input;
          const { token, meta } = yield* requireLinked(input.account);
          const ref = yield* requireRef(deploymentId);

          if (ref.kind === "worker") {
            // Cloudflare keeps no stored deployment or runtime logs for Workers over REST.
            return Stream.make(
              `Cloudflare keeps no stored logs for Worker deployments over its API. Live and recent logs: ${workerLogsDashboardUrl(meta.accountId, ref.name)}`,
            );
          }

          const dashboard = pagesDashboardUrl(meta.accountId, ref.name, ref.rawId);
          const noLogs = `Cloudflare has no build log for this Pages deployment (Direct Upload runs no remote build). Details: ${dashboard}`;
          const readLines = pagesLogLines(token, meta.accountId, ref.name, ref.rawId).pipe(
            Effect.catch((error) =>
              error.isAuthError || error.isScopeError
                ? Effect.fail(cfError(error))
                : Effect.succeed(null),
            ),
          );

          if (!input.follow) {
            const lines = yield* readLines;
            return Stream.fromIterable(
              lines === null || lines.length === 0 ? [noLogs] : lines.slice(0, maxLogLines),
            );
          }

          interface PollState {
            readonly seen: number;
            readonly polls: number;
            readonly emitted: number;
          }

          // Follow: poll the build log and stop once settled or poll/line caps are reached.
          const poll = Effect.fn("CloudflareProvider.pollPagesLogs")(function* (state: PollState) {
            const lines = (yield* readLines) ?? [];
            const dep = yield* Cf.getPagesDeployment(
              token,
              meta.accountId,
              ref.name,
              ref.rawId,
            ).pipe(Effect.mapError(cfError));
            const remaining = Math.max(0, maxLogLines - state.emitted);
            const fresh = lines.slice(state.seen, state.seen + remaining);
            const done = isFinal(pagesState(dep.latest_stage).state);
            if (done && state.seen === 0 && lines.length === 0) {
              return [[noLogs], Option.none<PollState>()] as const;
            }
            const emitted = state.emitted + fresh.length;
            const polls = state.polls + 1;
            const capped = emitted >= maxLogLines || polls >= followMaxPolls;
            if (!done && !capped && fresh.length === 0 && logPollIntervalMs > 0) {
              yield* Effect.sleep(Duration.millis(logPollIntervalMs));
            }
            return [
              fresh,
              done || capped
                ? Option.none<PollState>()
                : Option.some<PollState>({ seen: state.seen + fresh.length, polls, emitted }),
            ] as const;
          }, Effect.provideContext(services));
          return Stream.paginate<PollState, string, PluginError>(
            { seen: 0, polls: 0, emitted: 0 },
            poll,
          );
        }),
      ),
    );

  // ── rollback, domains, env ──────────────────────────────────────────────────────────────────

  const rollback = Effect.fn("CloudflareProvider.rollback")(function* (input: DeployRollbackInput) {
    const { token, meta } = yield* requireLinked(input.account);
    const project = yield* resolveTarget(input.target);
    const ref =
      input.deploymentId === undefined
        ? null
        : parseDeploymentRef(input.deploymentId, makeProjectId(project.kind, project.name));

    if (project.kind === "pages") {
      let targetId = ref?.rawId;
      if (targetId === undefined) {
        const deployments = yield* Cf.listPagesDeployments(
          token,
          meta.accountId,
          project.name,
        ).pipe(Effect.mapError(cfError));
        targetId = deployments.filter(
          (dep) =>
            (dep.environment ?? "production") === "production" &&
            dep.latest_stage?.status === "success",
        )[1]?.id;
        if (targetId === undefined) {
          return yield* new PluginError({
            message: `No earlier successful production deployment of Pages project "${project.name}" to roll back to.`,
          });
        }
      }
      const dep = yield* Cf.rollbackPagesDeployment(
        token,
        meta.accountId,
        project.name,
        targetId,
      ).pipe(Effect.mapError(cfError));
      return {
        deploymentId: makeDeploymentId("pages", project.name, dep.id),
        ...(dep.url ? { url: dep.url } : {}),
      };
    }

    let versionId = ref?.rawId;
    if (versionId === undefined) {
      const [versions, deployments] = yield* Effect.all([
        Cf.listWorkerVersions(token, meta.accountId, project.name).pipe(Effect.mapError(cfError)),
        Cf.listWorkerDeployments(token, meta.accountId, project.name).pipe(
          Effect.orElseSucceed(() => ({ deployments: [] as ReadonlyArray<Cf.CfWorkerDeployment> })),
        ),
      ]);
      const active = deployments.deployments[0]?.versions?.[0]?.version_id;
      versionId = (active ? versions.items.find((item) => item.id !== active) : versions.items[1])
        ?.id;
      if (versionId === undefined) {
        return yield* new PluginError({
          message: `No earlier version of Worker "${project.name}" to roll back to.`,
        });
      }
    }
    yield* Cf.createWorkerDeployment(
      token,
      meta.accountId,
      project.name,
      versionId,
      `Rollback to version ${versionId} via p0code`,
    ).pipe(Effect.mapError(cfError));
    const url = workerUrl(project.name, yield* resolveWorkersSubdomain(token, meta.accountId));
    return {
      deploymentId: makeDeploymentId("worker", project.name, versionId),
      ...(url ? { url } : {}),
    };
  });

  const listDomains = Effect.fn("CloudflareProvider.listDomains")(function* (
    input: DeployTargetRequest,
  ) {
    const { token, meta } = yield* requireLinked(input.account);
    const target = yield* resolveTarget(input.target);
    const domains: Array<DeployDomain> = [];

    if (target.kind === "pages") {
      const custom = yield* Cf.listPagesDomains(token, meta.accountId, target.name).pipe(
        Effect.mapError(cfError),
      );
      for (const item of custom)
        domains.push({ name: item.name, verified: item.status === "active" });
      const project = yield* Cf.getPagesProject(token, meta.accountId, target.name).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (project?.subdomain) domains.push({ name: project.subdomain, verified: true });
      return domains;
    }

    const custom = yield* Cf.listWorkerDomains(token, meta.accountId, target.name).pipe(
      Effect.mapError(cfError),
    );
    for (const item of custom) domains.push({ name: item.hostname, verified: true });
    const subdomain = yield* resolveWorkersSubdomain(token, meta.accountId);
    if (subdomain)
      domains.push({ name: `${target.name}.${subdomain}.workers.dev`, verified: true });

    // Zone routes need the optional Zone:Read + Workers Routes:Read scopes; skip them without.
    const zones = yield* Cf.listZones(token, meta.accountId).pipe(Effect.orElseSucceed(() => []));
    for (const zone of zones) {
      const routes = yield* Cf.listZoneWorkerRoutes(token, zone.id).pipe(Effect.result);
      if (routes._tag === "Failure") break;
      for (const route of routes.success) {
        if (route.script === target.name) domains.push({ name: route.pattern });
      }
    }
    return domains;
  });

  const setEnv = Effect.fn("CloudflareProvider.setEnv")(function* (
    input: DeployProviderSetEnvInput,
  ) {
    const { token, meta } = yield* requireLinked(input.account);
    const target = yield* resolveTarget(input.target);

    if (target.kind === "pages") {
      if (input.environment === "development")
        return yield* new PluginError({
          message: "Cloudflare Pages has no development environment. Choose production or preview.",
        });
      const patch: Record<string, { type: "plain_text" | "secret_text"; value: string } | null> =
        Object.fromEntries(
          Object.entries(input.vars).map(([key, value]) => [
            key,
            { type: input.secret ? ("secret_text" as const) : ("plain_text" as const), value },
          ]),
        );
      for (const key of input.remove) patch[key] = null;
      yield* Cf.patchPagesProjectEnv(
        token,
        meta.accountId,
        target.name,
        input.environment,
        patch,
      ).pipe(Effect.mapError(cfError));
      return;
    }

    // Cloudflare's Worker settings PATCH replaces every binding, which would drop KV/D1/R2 and
    // secrets, so Worker variables stay read-only here.
    const settings = yield* Cf.getWorkerSettings(token, meta.accountId, target.name).pipe(
      Effect.mapError(cfError),
    );
    const names = (settings.bindings ?? []).map((binding) => `${binding.name} (${binding.type})`);
    return yield* new PluginError({
      message: `Worker variables are read-only here: Cloudflare's settings API replaces every binding at once and would drop KV, D1, R2 and secrets. Put vars in wrangler.toml / wrangler.jsonc and redeploy, or use the Cloudflare dashboard.${names.length > 0 ? ` Current bindings: ${names.join(", ")}.` : ""}`,
    });
  });

  return {
    link: (input) => guarded(input.account, link(input)),
    unlink: (account) => guarded(account, unlink(account)),
    status: (account) => guarded(account, status(account)),
    listProjects: (account) => guarded(account, listProjects(account)),
    deploy: (input) => guarded(input.account, deploy(input)),
    deploymentStatus: (input) => guarded(input.account, deploymentStatus(input)),
    logs,
    rollback: (input) => guarded(input.account, rollback(input)),
    listDomains: (input) => guarded(input.account, listDomains(input)),
    setEnv: (input) => guarded(input.account, setEnv(input)),
  } satisfies DeployProvider;
});
