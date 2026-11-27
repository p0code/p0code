/*
 * MIT License
 * Copyright (c) 2026 p0code
 * Ported from https://github.com/p0code/deploy-cloudflare (v0.3.0)
 */
import { PluginError } from "@t3tools/plugin-api";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

import { redactSecrets, safeErrorMessage } from "./redact.ts";
import type { WorkerBinding } from "./wranglerConfig.ts";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT = Duration.seconds(20);

export class CloudflareApiError extends Schema.TaggedError<CloudflareApiError>()(
  "CloudflareApiError",
  {
    status: Schema.Number,
    message: Schema.String,
    requiredScope: Schema.optionalKey(Schema.String),
    isScopeError: Schema.Boolean,
    isAuthError: Schema.Boolean,
    codes: Schema.Array(Schema.Number),
  },
) {}

export function toPluginError(error: CloudflareApiError): PluginError {
  return new PluginError({ message: error.message });
}

const CloudflareMessage = Schema.Struct({
  code: Schema.optionalKey(Schema.Number),
  message: Schema.optionalKey(Schema.String),
});

const CloudflareEnvelopeRaw = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  errors: Schema.optionalKey(Schema.Array(CloudflareMessage)),
  messages: Schema.optionalKey(Schema.Array(CloudflareMessage)),
  result: Schema.optionalKey(Schema.Unknown),
});
const decodeEnvelopeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudflareEnvelopeRaw));

const CfTokenVerifyResult = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  not_before: Schema.optionalKey(Schema.NullOr(Schema.String)),
  expires_on: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CfAccount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const CfPagesEnvVar = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CfPagesDeploymentConfig = Schema.Struct({
  env_vars: Schema.optionalKey(
    Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(CfPagesEnvVar))),
  ),
});

const CfPagesProject = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  subdomain: Schema.optionalKey(Schema.NullOr(Schema.String)),
  production_branch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_on: Schema.optionalKey(Schema.NullOr(Schema.String)),
  domains: Schema.optionalKey(Schema.Array(Schema.String)),
  source: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  deployment_configs: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        production: Schema.optionalKey(Schema.NullOr(CfPagesDeploymentConfig)),
        preview: Schema.optionalKey(Schema.NullOr(CfPagesDeploymentConfig)),
      }),
    ),
  ),
});

const CfPagesStage = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  started_on: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ended_on: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CfPagesDeployment = Schema.Struct({
  id: Schema.String,
  short_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  project_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  environment: Schema.optionalKey(Schema.NullOr(Schema.String)),
  url: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_on: Schema.optionalKey(Schema.NullOr(Schema.String)),
  latest_stage: Schema.optionalKey(Schema.NullOr(CfPagesStage)),
  stages: Schema.optionalKey(Schema.Array(CfPagesStage)),
});
export type CfPagesDeployment = typeof CfPagesDeployment.Type;

const CfPagesUploadToken = Schema.Struct({
  jwt: Schema.String,
});

const CfPagesLogsResult = Schema.Struct({
  total: Schema.optionalKey(Schema.Number),
  includes_container_logs: Schema.optionalKey(Schema.Boolean),
  data: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ts: Schema.optionalKey(Schema.NullOr(Schema.String)),
        line: Schema.String,
      }),
    ),
  ),
});

const CfPagesDomain = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  verification_data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        status: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  zone_tag: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CfWorkerScript = Schema.Struct({
  id: Schema.String,
  etag: Schema.optionalKey(Schema.NullOr(Schema.String)),
  compatibility_date: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_on: Schema.optionalKey(Schema.NullOr(Schema.String)),
  modified_on: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CfWorkersSubdomain = Schema.Struct({
  subdomain: Schema.String,
});

const CfWorkerUploadResult = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  etag: Schema.optionalKey(Schema.NullOr(Schema.String)),
  modified_on: Schema.optionalKey(Schema.NullOr(Schema.String)),
  compatibility_date: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CfWorkerVersionItem = Schema.Struct({
  id: Schema.String,
  number: Schema.optionalKey(Schema.Number),
  metadata: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        created_on: Schema.optionalKey(Schema.NullOr(Schema.String)),
        source: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const CfWorkerVersionsList = Schema.Struct({
  items: Schema.Array(CfWorkerVersionItem),
});

const CfWorkerDeployment = Schema.Struct({
  id: Schema.String,
  source: Schema.optionalKey(Schema.NullOr(Schema.String)),
  strategy: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_on: Schema.optionalKey(Schema.NullOr(Schema.String)),
  versions: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        version_id: Schema.String,
        percentage: Schema.Number,
      }),
    ),
  ),
});
export type CfWorkerDeployment = typeof CfWorkerDeployment.Type;

const CfWorkerDeploymentsList = Schema.Struct({
  deployments: Schema.Array(CfWorkerDeployment),
});

const CfWorkerSettings = Schema.Struct({
  bindings: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        type: Schema.String,
      }),
    ),
  ),
  compatibility_date: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const CfWorkerDomain = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  hostname: Schema.String,
  service: Schema.optionalKey(Schema.NullOr(Schema.String)),
  environment: Schema.optionalKey(Schema.NullOr(Schema.String)),
  zone_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  zone_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CfWorkerDomain = typeof CfWorkerDomain.Type;

const CfZone = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const CfWorkerRoute = Schema.Struct({
  id: Schema.String,
  pattern: Schema.String,
  script: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const WorkerMetadataSchema = Schema.Struct({
  main_module: Schema.String,
  compatibility_date: Schema.optionalKey(Schema.String),
  compatibility_flags: Schema.optionalKey(Schema.Array(Schema.String)),
  bindings: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  keep_bindings: Schema.optionalKey(Schema.Array(Schema.String)),
});
const encodeWorkerMetadataJson = Schema.encodeEffect(Schema.fromJsonString(WorkerMetadataSchema));

const PagesManifestSchema = Schema.Record(Schema.String, Schema.String);
const encodePagesManifestJson = Schema.encodeEffect(Schema.fromJsonString(PagesManifestSchema));

// Scope errors: 10000 auth (often a missing scope), 9109 unauthorized, 9106 bad permissions,
// 8000018 insufficient Pages permissions.
const SCOPE_ERROR_CODES = new Set([10000, 9109, 9106, 8000018]);

function isPermissionMessage(detail: string): boolean {
  const lower = detail.toLowerCase();
  return (
    lower.includes("permission") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("not allowed") ||
    lower.includes("authentication error")
  );
}

function buildScopeErrorMessage(
  requiredScope: string,
  actionLabel: string,
  detail: string,
): string {
  const suffix = detail.length > 0 ? ` (Cloudflare: ${detail})` : "";
  return `Cloudflare API token lacks the "${requiredScope}" scope required to ${actionLabel}. Edit your token in Cloudflare Dashboard -> My Profile -> API Tokens and grant "${requiredScope}".${suffix}`;
}

interface CloudflareRequestOptions {
  readonly token: string;
  readonly secretsToRedact?: ReadonlyArray<string>;
  readonly requiredScope: string;
  readonly actionLabel: string;
}

const sendRequest = Effect.fn("cloudflareApi.sendRequest")(function* <A, I>(
  request: HttpClientRequest.HttpClientRequest,
  resultSchema: Schema.Codec<A, I>,
  options: CloudflareRequestOptions,
) {
  const client = yield* HttpClient.HttpClient;
  const secrets = [options.token, ...(options.secretsToRedact ?? [])];
  const authed = HttpClientRequest.bearerToken(request, options.token);

  const response = yield* client.execute(authed).pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError(
      (cause) =>
        new CloudflareApiError({
          status: 0,
          message: `Failed to reach Cloudflare API while attempting to ${options.actionLabel}: ${safeErrorMessage(cause, secrets)}`,
          requiredScope: options.requiredScope,
          isScopeError: false,
          isAuthError: false,
          codes: [],
        }),
    ),
  );

  const rawText = yield* response.text.pipe(
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.mapError(
      (cause) =>
        new CloudflareApiError({
          status: response.status,
          message: `Failed reading Cloudflare API response: ${safeErrorMessage(cause, secrets)}`,
          requiredScope: options.requiredScope,
          isScopeError: false,
          isAuthError: false,
          codes: [],
        }),
    ),
  );

  const parsed = yield* decodeEnvelopeJson(rawText).pipe(Effect.orElseSucceed(() => undefined));

  const errors = parsed?.errors ?? [];
  const codes = errors
    .map((entry) => entry.code)
    .filter((code): code is number => typeof code === "number");
  const detail = redactSecrets(
    errors
      .map((entry) => entry.message)
      .filter((msg): msg is string => typeof msg === "string" && msg.length > 0)
      .join("; "),
    secrets,
  );

  const isFailed = response.status < 200 || response.status >= 300 || parsed?.success === false;
  if (isFailed) {
    if (response.status === 401) {
      return yield* new CloudflareApiError({
        status: response.status,
        message: `Cloudflare API token is invalid, expired, or revoked.${detail ? ` (${detail})` : ""}`,
        requiredScope: options.requiredScope,
        isScopeError: false,
        isAuthError: true,
        codes,
      });
    }

    const scopeDenied =
      response.status === 403 ||
      codes.some((code) => SCOPE_ERROR_CODES.has(code)) ||
      (response.status === 400 && isPermissionMessage(detail));

    if (scopeDenied) {
      return yield* new CloudflareApiError({
        status: response.status,
        message: buildScopeErrorMessage(options.requiredScope, options.actionLabel, detail),
        requiredScope: options.requiredScope,
        isScopeError: true,
        isAuthError: false,
        codes,
      });
    }

    const fallback = detail.length > 0 ? detail : `HTTP ${response.status}`;
    return yield* new CloudflareApiError({
      status: response.status,
      message: `Cloudflare API error while attempting to ${options.actionLabel}: ${fallback}`,
      requiredScope: options.requiredScope,
      isScopeError: false,
      isAuthError: false,
      codes,
    });
  }

  return yield* Schema.decodeUnknownEffect(resultSchema)(parsed?.result).pipe(
    Effect.mapError(
      (cause) =>
        new CloudflareApiError({
          status: response.status,
          message: `Unexpected Cloudflare API response while attempting to ${options.actionLabel}: ${safeErrorMessage(cause, secrets)}`,
          requiredScope: options.requiredScope,
          isScopeError: false,
          isAuthError: false,
          codes: [],
        }),
    ),
  );
});

const enc = encodeURIComponent;

export const verifyToken = (token: string) =>
  sendRequest(
    HttpClientRequest.get(`${CLOUDFLARE_API_BASE}/user/tokens/verify`),
    CfTokenVerifyResult,
    {
      token,
      requiredScope: "Account Settings:Read",
      actionLabel: "verify the Cloudflare API token",
    },
  );

export const listAccounts = (token: string) =>
  sendRequest(HttpClientRequest.get(`${CLOUDFLARE_API_BASE}/accounts`), Schema.Array(CfAccount), {
    token,
    requiredScope: "Account Settings:Read",
    actionLabel: "list Cloudflare accounts",
  });

export const listPagesProjects = (token: string, accountId: string) =>
  sendRequest(
    HttpClientRequest.get(`${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/pages/projects`),
    Schema.Array(CfPagesProject),
    {
      token,
      requiredScope: "Pages:Edit",
      actionLabel: "list Cloudflare Pages projects",
    },
  );

export const getPagesProject = (token: string, accountId: string, projectName: string) =>
  sendRequest(
    HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/pages/projects/${enc(projectName)}`,
    ),
    CfPagesProject,
    {
      token,
      requiredScope: "Pages:Edit",
      actionLabel: `read Pages project "${projectName}"`,
    },
  );

export const getPagesUploadToken = (token: string, accountId: string, projectName: string) =>
  sendRequest(
    HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/pages/projects/${enc(projectName)}/upload-token`,
    ),
    CfPagesUploadToken,
    {
      token,
      requiredScope: "Pages:Edit",
      actionLabel: `obtain a Pages direct-upload token for "${projectName}"`,
    },
  );

export const checkMissingPagesAssets = (
  uploadJwt: string,
  hashes: ReadonlyArray<string>,
  apiToken: string,
) =>
  sendRequest(
    HttpClientRequest.post(`${CLOUDFLARE_API_BASE}/pages/assets/check-missing`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ hashes }),
    ),
    Schema.Array(Schema.String),
    {
      token: uploadJwt,
      secretsToRedact: [apiToken],
      requiredScope: "Pages:Edit",
      actionLabel: "check missing Pages direct-upload assets",
    },
  );

export interface PagesAssetUploadItem {
  readonly key: string;
  readonly value: string;
  readonly metadata: { readonly contentType: string };
  readonly base64: true;
}

export const uploadPagesAssets = (
  uploadJwt: string,
  items: ReadonlyArray<PagesAssetUploadItem>,
  apiToken: string,
) =>
  sendRequest(
    HttpClientRequest.post(`${CLOUDFLARE_API_BASE}/pages/assets/upload`).pipe(
      HttpClientRequest.bodyJsonUnsafe(items),
    ),
    Schema.NullOr(Schema.Unknown),
    {
      token: uploadJwt,
      secretsToRedact: [apiToken],
      requiredScope: "Pages:Edit",
      actionLabel: "upload Pages static assets",
    },
  );

export const upsertPagesHashes = (
  uploadJwt: string,
  hashes: ReadonlyArray<string>,
  apiToken: string,
) =>
  sendRequest(
    HttpClientRequest.post(`${CLOUDFLARE_API_BASE}/pages/assets/upsert-hashes`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ hashes }),
    ),
    Schema.NullOr(Schema.Unknown),
    {
      token: uploadJwt,
      secretsToRedact: [apiToken],
      requiredScope: "Pages:Edit",
      actionLabel: "register Pages asset hashes",
    },
  );

export const createPagesDeployment = Effect.fn("cloudflareApi.createPagesDeployment")(function* (
  token: string,
  accountId: string,
  projectName: string,
  options: {
    readonly branch?: string;
    readonly manifest?: Readonly<Record<string, string>>;
  },
) {
  const form = new FormData();
  if (options.branch && options.branch.trim().length > 0) {
    form.append("branch", options.branch.trim());
  }
  if (options.manifest) {
    const manifestJson = yield* encodePagesManifestJson(options.manifest).pipe(
      Effect.mapError(
        (cause) =>
          new CloudflareApiError({
            status: 0,
            message: `Could not encode Pages deployment manifest: ${safeErrorMessage(cause, [token])}`,
            requiredScope: "Pages:Edit",
            isScopeError: false,
            isAuthError: false,
            codes: [],
          }),
      ),
    );
    form.append("manifest", manifestJson);
  }
  return yield* sendRequest(
    HttpClientRequest.post(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/pages/projects/${enc(projectName)}/deployments`,
    ).pipe(HttpClientRequest.bodyFormData(form)),
    CfPagesDeployment,
    {
      token,
      requiredScope: "Pages:Edit",
      actionLabel: `deploy Pages project "${projectName}"`,
    },
  );
});

export const listPagesDeployments = (token: string, accountId: string, projectName: string) =>
  sendRequest(
    HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/pages/projects/${enc(projectName)}/deployments`,
    ),
    Schema.Array(CfPagesDeployment),
    {
      token,
      requiredScope: "Pages:Edit",
      actionLabel: `list deployments for Pages project "${projectName}"`,
    },
  );

export const getPagesDeployment = (
  token: string,
  accountId: string,
  projectName: string,
  deploymentId: string,
) =>
  sendRequest(
    HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/pages/projects/${enc(projectName)}/deployments/${enc(deploymentId)}`,
    ),
    CfPagesDeployment,
    {
      token,
      requiredScope: "Pages:Edit",
      actionLabel: `read deployment "${deploymentId}" for Pages project "${projectName}"`,
    },
  );

export const getPagesDeploymentLogs = (
  token: string,
  accountId: string,
  projectName: string,
  deploymentId: string,
) =>
  sendRequest(
    HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/pages/projects/${enc(projectName)}/deployments/${enc(deploymentId)}/history/logs`,
    ),
    CfPagesLogsResult,
    {
      token,
      requiredScope: "Pages:Edit",
      actionLabel: `read build logs for Pages deployment "${deploymentId}"`,
    },
  );

export const rollbackPagesDeployment = (
  token: string,
  accountId: string,
  projectName: string,
  deploymentId: string,
) =>
  sendRequest(
    HttpClientRequest.post(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/pages/projects/${enc(projectName)}/deployments/${enc(deploymentId)}/rollback`,
    ),
    CfPagesDeployment,
    {
      token,
      requiredScope: "Pages:Edit",
      actionLabel: `roll back Pages project "${projectName}" to "${deploymentId}"`,
    },
  );

export const listPagesDomains = (token: string, accountId: string, projectName: string) =>
  sendRequest(
    HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/pages/projects/${enc(projectName)}/domains`,
    ),
    Schema.Array(CfPagesDomain),
    {
      token,
      requiredScope: "Pages:Edit",
      actionLabel: `list custom domains for Pages project "${projectName}"`,
    },
  );

export const patchPagesProjectEnv = (
  token: string,
  accountId: string,
  projectName: string,
  environment: "preview" | "production",
  envVars: Readonly<
    Record<string, { readonly type: "plain_text" | "secret_text"; readonly value: string } | null>
  >,
) =>
  sendRequest(
    HttpClientRequest.patch(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/pages/projects/${enc(projectName)}`,
    ).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        deployment_configs: {
          [environment]: {
            env_vars: envVars,
          },
        },
      }),
    ),
    CfPagesProject,
    {
      token,
      requiredScope: "Pages:Edit",
      actionLabel: `update ${environment} environment variables for Pages project "${projectName}"`,
    },
  );

export const listWorkerScripts = (token: string, accountId: string) =>
  sendRequest(
    HttpClientRequest.get(`${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/workers/scripts`),
    Schema.Array(CfWorkerScript),
    {
      token,
      requiredScope: "Workers Scripts:Edit",
      actionLabel: "list Cloudflare Workers scripts",
    },
  );

export const getWorkersSubdomain = (token: string, accountId: string) =>
  sendRequest(
    HttpClientRequest.get(`${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/workers/subdomain`),
    CfWorkersSubdomain,
    {
      token,
      requiredScope: "Workers Scripts:Edit",
      actionLabel: "read workers.dev subdomain",
    },
  );

export const uploadWorkerScript = Effect.fn("cloudflareApi.uploadWorkerScript")(function* (
  token: string,
  accountId: string,
  scriptName: string,
  bundle: {
    readonly mainModule: string;
    readonly scriptContent: Uint8Array;
    readonly compatibilityDate?: string;
    readonly compatibilityFlags: ReadonlyArray<string>;
    readonly bindings: ReadonlyArray<WorkerBinding>;
  },
) {
  const metadata = {
    main_module: bundle.mainModule,
    ...(bundle.compatibilityDate ? { compatibility_date: bundle.compatibilityDate } : {}),
    ...(bundle.compatibilityFlags.length > 0
      ? { compatibility_flags: bundle.compatibilityFlags }
      : {}),
    ...(bundle.bindings.length > 0 ? { bindings: bundle.bindings } : {}),
    keep_bindings: ["secret_text"],
  };
  const metadataJson = yield* encodeWorkerMetadataJson(metadata).pipe(
    Effect.mapError(
      (cause) =>
        new CloudflareApiError({
          status: 0,
          message: `Could not encode Worker metadata: ${safeErrorMessage(cause, [token])}`,
          requiredScope: "Workers Scripts:Edit",
          isScopeError: false,
          isAuthError: false,
          codes: [],
        }),
    ),
  );
  const form = new FormData();
  form.append("metadata", new Blob([metadataJson], { type: "application/json" }), "metadata.json");
  const scriptBytes = new Uint8Array(bundle.scriptContent);
  form.append(
    bundle.mainModule,
    new Blob([scriptBytes], { type: "application/javascript+module" }),
    bundle.mainModule,
  );
  return yield* sendRequest(
    HttpClientRequest.put(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}`,
    ).pipe(HttpClientRequest.bodyFormData(form)),
    CfWorkerUploadResult,
    {
      token,
      requiredScope: "Workers Scripts:Edit",
      actionLabel: `upload Worker script "${scriptName}"`,
    },
  );
});

export const listWorkerVersions = (token: string, accountId: string, scriptName: string) =>
  sendRequest(
    HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/versions`,
    ),
    CfWorkerVersionsList,
    {
      token,
      requiredScope: "Workers Scripts:Edit",
      actionLabel: `list versions for Worker "${scriptName}"`,
    },
  );

export const getWorkerVersion = (
  token: string,
  accountId: string,
  scriptName: string,
  versionId: string,
) =>
  sendRequest(
    HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/versions/${enc(versionId)}`,
    ),
    CfWorkerVersionItem,
    {
      token,
      requiredScope: "Workers Scripts:Edit",
      actionLabel: `read version "${versionId}" for Worker "${scriptName}"`,
    },
  );

export const listWorkerDeployments = (token: string, accountId: string, scriptName: string) =>
  sendRequest(
    HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/deployments`,
    ),
    CfWorkerDeploymentsList,
    {
      token,
      requiredScope: "Workers Scripts:Edit",
      actionLabel: `list deployments for Worker "${scriptName}"`,
    },
  );

export const createWorkerDeployment = (
  token: string,
  accountId: string,
  scriptName: string,
  versionId: string,
  message: string,
) =>
  sendRequest(
    HttpClientRequest.post(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/deployments`,
    ).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        strategy: "percentage",
        versions: [{ version_id: versionId, percentage: 100 }],
        annotations: { "workers/message": message },
      }),
    ),
    CfWorkerDeployment,
    {
      token,
      requiredScope: "Workers Scripts:Edit",
      actionLabel: `deploy version "${versionId}" for Worker "${scriptName}"`,
    },
  );

export const getWorkerSettings = (token: string, accountId: string, scriptName: string) =>
  sendRequest(
    HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/workers/scripts/${enc(scriptName)}/settings`,
    ),
    CfWorkerSettings,
    {
      token,
      requiredScope: "Workers Scripts:Edit",
      actionLabel: `read settings and bindings for Worker "${scriptName}"`,
    },
  );

export const listWorkerDomains = (token: string, accountId: string, scriptName: string) =>
  sendRequest(
    HttpClientRequest.get(`${CLOUDFLARE_API_BASE}/accounts/${enc(accountId)}/workers/domains`).pipe(
      HttpClientRequest.setUrlParams({ service: scriptName }),
    ),
    Schema.Array(CfWorkerDomain),
    {
      token,
      requiredScope: "Workers Scripts:Edit",
      actionLabel: `list custom domains for Worker "${scriptName}"`,
    },
  );

export const listZones = (token: string, accountId: string) =>
  sendRequest(
    HttpClientRequest.get(`${CLOUDFLARE_API_BASE}/zones`).pipe(
      HttpClientRequest.setUrlParams({ "account.id": accountId, per_page: "50" }),
    ),
    Schema.Array(CfZone),
    {
      token,
      requiredScope: "Zone:Read",
      actionLabel: "list zones to inspect Worker routes",
    },
  );

export const listZoneWorkerRoutes = (token: string, zoneId: string) =>
  sendRequest(
    HttpClientRequest.get(`${CLOUDFLARE_API_BASE}/zones/${enc(zoneId)}/workers/routes`),
    Schema.Array(CfWorkerRoute),
    {
      token,
      requiredScope: "Workers Routes:Read",
      actionLabel: `list Worker routes in zone "${zoneId}"`,
    },
  );
