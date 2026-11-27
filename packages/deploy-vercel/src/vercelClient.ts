/*
 * MIT License
 * Copyright (c) 2026 p0code contributors
 * Ported from https://github.com/p0code/deploy-vercel (v0.2.0)
 */
import type {
  DeployDomain,
  DeploymentState,
  DeploymentStatus,
  DeployProviderProject,
  DeployResult,
} from "@t3tools/contracts";
import { PluginError } from "@t3tools/plugin-api";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const DEFAULT_VERCEL_API_BASE_URL = "https://api.vercel.com";
export const EXPIRED_TOKEN_MESSAGE = "Vercel token expired, link again.";
const REQUEST_TIMEOUT = Duration.seconds(20);

export type EnvTarget = "production" | "preview" | "development";
export type EnvType = "encrypted" | "plain" | "sensitive";

export class VercelAuthExpiredError extends Schema.TaggedError<VercelAuthExpiredError>()(
  "VercelAuthExpiredError",
  {
    message: Schema.String,
  },
) {}

export class VercelApiError extends Schema.TaggedError<VercelApiError>()("VercelApiError", {
  status: Schema.Number,
  code: Schema.optionalKey(Schema.String),
  message: Schema.String,
}) {}

export type VercelClientError = VercelAuthExpiredError | VercelApiError | PluginError;

/** Strips raw tokens, bearer headers, and extra secrets so values never leak in errors or logs. */
export function redactSecrets(
  text: string,
  token?: string,
  extraSecrets: ReadonlyArray<string> = [],
): string {
  let sanitized = text;
  if (token !== undefined && token.length > 0) {
    sanitized = sanitized.replaceAll(token, "[REDACTED]");
  }
  for (const secret of extraSecrets) {
    const trimmed = secret.trim();
    if (trimmed.length >= 4) {
      sanitized = sanitized.replaceAll(trimmed, "[REDACTED]");
    }
  }
  return sanitized
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bvcp_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

function isSafePathSegment(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== "." && trimmed !== ".." && !/[/\\\0]/.test(value);
}

function encodePathSegment(value: string, label: string): Effect.Effect<string, PluginError> {
  if (!isSafePathSegment(value)) {
    return Effect.fail(new PluginError({ message: `Invalid Vercel ${label}.` }));
  }
  return Effect.succeed(encodeURIComponent(value.trim()));
}

function validateOptionalSegment(
  value: string | undefined,
  label: string,
): Effect.Effect<string | undefined, PluginError> {
  if (value === undefined) return Effect.undefined;
  if (!isSafePathSegment(value)) {
    return Effect.fail(new PluginError({ message: `Invalid Vercel ${label}.` }));
  }
  return Effect.succeed(value.trim());
}

function normalizeDeploymentUrl(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined) return undefined;
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function mapVercelDeploymentState(rawState: string | undefined): DeploymentState {
  switch ((rawState ?? "").toUpperCase()) {
    case "QUEUED":
      return "queued";
    case "INITIALIZING":
    case "BUILDING":
      return "building";
    case "READY":
      return "ready";
    case "ERROR":
      return "error";
    case "CANCELED":
    case "CANCELLED":
      return "canceled";
    default:
      return "queued";
  }
}

const VercelErrorEnvelope = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
  message: Schema.optional(Schema.String),
});

const VercelUserResponse = Schema.Struct({
  user: Schema.Struct({
    id: Schema.optional(Schema.String),
    uid: Schema.optional(Schema.String),
    username: Schema.optional(Schema.String),
    email: Schema.optional(Schema.String),
    name: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

const VercelGitLink = Schema.Struct({
  type: Schema.String,
  repo: Schema.optional(Schema.String),
  org: Schema.optional(Schema.String),
  repoId: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  productionBranch: Schema.optional(Schema.NullOr(Schema.String)),
});

const VercelLatestDeployment = Schema.Struct({
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

const VercelProjectResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  link: Schema.optional(Schema.NullOr(VercelGitLink)),
  latestDeployments: Schema.optional(Schema.Array(VercelLatestDeployment)),
});

const VercelProjectsListResponse = Schema.Struct({
  projects: Schema.Array(VercelProjectResponse),
});

const VercelDeploymentResponse = Schema.Struct({
  id: Schema.optional(Schema.String),
  uid: Schema.optional(Schema.String),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  readyState: Schema.optional(Schema.String),
  state: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.NullOr(Schema.String)),
});

const VercelDeploymentsListResponse = Schema.Struct({
  deployments: Schema.Array(VercelDeploymentResponse),
});

const VercelEventPayload = Schema.Struct({
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  date: Schema.optional(Schema.Number),
});

const VercelDeploymentEventRow = Schema.Struct({
  id: Schema.optional(Schema.String),
  serial: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Number),
  date: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
  payload: Schema.optional(VercelEventPayload),
});

const VercelEventsResponse = Schema.Array(VercelDeploymentEventRow);

const VercelDomainRow = Schema.Struct({
  name: Schema.String,
  verified: Schema.Boolean,
});

const VercelDomainsListResponse = Schema.Struct({
  domains: Schema.Array(VercelDomainRow),
});

export interface VercelUser {
  readonly id: string;
  readonly accountLabel: string;
  readonly username: string | null;
  readonly email: string | null;
}

export interface VercelProjectDetail {
  readonly id: string;
  readonly name: string;
  readonly gitLink: {
    readonly type: string;
    readonly repoId?: string | number;
    readonly repo?: string;
    readonly org?: string;
    readonly productionBranch?: string;
  } | null;
}

export interface VercelDeploymentListItem {
  readonly deploymentId: string;
  readonly url?: string;
}

export interface VercelLogEvent {
  readonly id?: string;
  readonly type: string;
  readonly created: number;
  readonly text: string;
}

export interface UploadedFileRef {
  readonly file: string;
  readonly sha: string;
  readonly size: number;
}

export interface CreateDeploymentBody {
  readonly name: string;
  readonly project: string;
  readonly target?: "production";
  readonly gitSource?: {
    readonly type: string;
    readonly ref: string;
    readonly repoId?: string | number;
    readonly org?: string;
    readonly repo?: string;
  };
  readonly files?: ReadonlyArray<UploadedFileRef>;
  readonly prebuilt?: boolean;
  readonly projectSettings?: {
    readonly framework?: string | null;
  };
}

export interface UpsertEnvItem {
  readonly key: string;
  readonly value: string;
  readonly type: EnvType;
  readonly target: ReadonlyArray<EnvTarget>;
}

const decodeErrorEnvelope = HttpClientResponse.schemaBodyJson(VercelErrorEnvelope);
const encodeJsonBody = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const params = new URLSearchParams();
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && String(value).length > 0) {
        params.set(key, String(value));
      }
    }
  }
  const search = params.toString();
  return search.length > 0 ? `${normalizedBase}${path}?${search}` : `${normalizedBase}${path}`;
}

function toProviderProject(raw: typeof VercelProjectResponse.Type): DeployProviderProject {
  const latestUrl = normalizeDeploymentUrl(raw.latestDeployments?.[0]?.url);
  return {
    kind: "vercel-project",
    id: raw.id.trim(),
    name: raw.name.trim(),
    ...(latestUrl !== undefined ? { url: latestUrl } : {}),
  };
}

function toDeploymentStatus(
  raw: typeof VercelDeploymentResponse.Type,
  fallbackId: string,
  token: string,
): DeploymentStatus {
  const deploymentId = (raw.id ?? raw.uid ?? fallbackId).trim();
  const state = mapVercelDeploymentState(raw.readyState ?? raw.state ?? raw.status);
  const url = normalizeDeploymentUrl(raw.url);
  const message =
    raw.errorMessage !== undefined &&
    raw.errorMessage !== null &&
    raw.errorMessage.trim().length > 0
      ? redactSecrets(raw.errorMessage.trim(), token)
      : undefined;
  return {
    deploymentId,
    state,
    ...(url !== undefined ? { url } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

export function makeVercelClient(
  httpClient: HttpClient.HttpClient,
  baseUrl: string = DEFAULT_VERCEL_API_BASE_URL,
) {
  const execute = Effect.fn("vercel.client.execute")(function* (
    request: HttpClientRequest.HttpClientRequest,
    token: string,
    extraSecrets: ReadonlyArray<string> = [],
  ) {
    // Never attach the raw HttpClientError as `cause`, because it holds the outgoing request
    // headers including `Authorization: Bearer <token>`.
    const response = yield* httpClient
      .execute(request.pipe(HttpClientRequest.bearerToken(token)))
      .pipe(
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(
          () =>
            new PluginError({
              message: "Could not reach Vercel API.",
            }),
        ),
      );
    if (response.status === 401) {
      return yield* new VercelAuthExpiredError({ message: EXPIRED_TOKEN_MESSAGE });
    }
    if (response.status >= 400) {
      const envelope = yield* decodeErrorEnvelope(response).pipe(Effect.option);
      const rawMessage = Option.match(envelope, {
        onNone: () => `Vercel API request failed (${response.status}).`,
        onSome: (body) =>
          body.error?.message ?? body.message ?? `Vercel API request failed (${response.status}).`,
      });
      const code = Option.flatMap(envelope, (body) => Option.fromUndefinedOr(body.error?.code));
      return yield* new VercelApiError({
        status: response.status,
        ...(Option.isSome(code) ? { code: code.value } : {}),
        message: redactSecrets(rawMessage, token, extraSecrets),
      });
    }
    return response;
  });

  const decodeJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
    response: HttpClientResponse.HttpClientResponse,
    schema: S,
    label: string,
  ) =>
    HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(
        () =>
          new PluginError({
            message: `Unexpected response from Vercel (${label}).`,
          }),
      ),
    );

  const getUser = Effect.fn("vercel.client.getUser")(function* (token: string) {
    const response = yield* execute(HttpClientRequest.get(buildUrl(baseUrl, "/v2/user")), token);
    const body = yield* decodeJson(response, VercelUserResponse, "GET /v2/user");
    const user = body.user;
    const id = (user.id ?? user.uid ?? user.username ?? user.email ?? "unknown").trim();
    const accountLabel = (
      user.username ??
      user.email ??
      (user.name && user.name.trim().length > 0 ? user.name : id)
    ).trim();
    return {
      id,
      accountLabel: accountLabel.length > 0 ? accountLabel : "vercel",
      username: user.username ?? null,
      email: user.email ?? null,
    } satisfies VercelUser;
  });

  const getTeam = Effect.fn("vercel.client.getTeam")(function* (token: string, teamId: string) {
    const teamSegment = yield* encodePathSegment(teamId, "teamId");
    const response = yield* execute(
      HttpClientRequest.get(buildUrl(baseUrl, `/v2/teams/${teamSegment}`)),
      token,
    );
    const team = yield* decodeJson(
      response,
      Schema.Struct({ id: Schema.String, name: Schema.String }),
      "GET /v2/teams/{teamId}",
    );
    return { id: team.id, accountLabel: team.name };
  });

  const listProjects = Effect.fn("vercel.client.listProjects")(function* (
    token: string,
    options?: { readonly limit?: number; readonly search?: string; readonly teamId?: string },
  ) {
    const teamId = yield* validateOptionalSegment(options?.teamId, "teamId");
    const url = buildUrl(baseUrl, "/v9/projects", {
      limit: options?.limit,
      search: options?.search,
      teamId,
    });
    const response = yield* execute(HttpClientRequest.get(url), token);
    const body = yield* decodeJson(response, VercelProjectsListResponse, "GET /v9/projects");
    return body.projects
      .map(toProviderProject)
      .filter((project) => project.id.length > 0 && project.name.length > 0);
  });

  const getProject = Effect.fn("vercel.client.getProject")(function* (
    token: string,
    projectId: string,
    teamId?: string,
  ) {
    const projectSegment = yield* encodePathSegment(projectId, "projectId");
    const validTeamId = yield* validateOptionalSegment(teamId, "teamId");
    const url = buildUrl(baseUrl, `/v9/projects/${projectSegment}`, { teamId: validTeamId });
    const response = yield* execute(HttpClientRequest.get(url), token);
    const raw = yield* decodeJson(response, VercelProjectResponse, "GET /v9/projects/{id}");
    const link = raw.link ?? null;
    return {
      id: raw.id.trim(),
      name: raw.name.trim(),
      gitLink:
        link === null
          ? null
          : {
              type: link.type,
              ...(link.repoId !== undefined ? { repoId: link.repoId } : {}),
              ...(link.repo !== undefined ? { repo: link.repo } : {}),
              ...(link.org !== undefined ? { org: link.org } : {}),
              ...(link.productionBranch !== undefined && link.productionBranch !== null
                ? { productionBranch: link.productionBranch }
                : {}),
            },
    } satisfies VercelProjectDetail;
  });

  const uploadFile = Effect.fn("vercel.client.uploadFile")(function* (
    token: string,
    input: { readonly sha1: string; readonly bytes: Uint8Array; readonly teamId?: string },
  ) {
    const teamId = yield* validateOptionalSegment(input.teamId, "teamId");
    const url = buildUrl(baseUrl, "/v2/files", { teamId });
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("x-vercel-digest", input.sha1),
      HttpClientRequest.setHeader("content-length", String(input.bytes.byteLength)),
      HttpClientRequest.bodyUint8Array(input.bytes, "application/octet-stream"),
    );
    yield* execute(request, token);
  });

  const createDeployment = Effect.fn("vercel.client.createDeployment")(function* (
    token: string,
    payload: CreateDeploymentBody,
    teamId?: string,
  ) {
    const validTeamId = yield* validateOptionalSegment(teamId, "teamId");
    const url = buildUrl(baseUrl, "/v13/deployments", { teamId: validTeamId });
    const json = yield* encodeJsonBody(payload).pipe(
      Effect.mapError(() => new PluginError({ message: "Failed to encode deployment request." })),
    );
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bodyText(json, "application/json"),
    );
    const response = yield* execute(request, token);
    const raw = yield* decodeJson(response, VercelDeploymentResponse, "POST /v13/deployments");
    const deploymentId = (raw.id ?? raw.uid ?? "").trim();
    if (deploymentId.length === 0) {
      return yield* new PluginError({
        message: "Vercel did not return a deployment ID.",
      });
    }
    const urlStr = normalizeDeploymentUrl(raw.url);
    return {
      deploymentId,
      ...(urlStr !== undefined ? { url: urlStr } : {}),
    } satisfies DeployResult;
  });

  const getDeployment = Effect.fn("vercel.client.getDeployment")(function* (
    token: string,
    id: string,
    teamId?: string,
  ) {
    const depSegment = yield* encodePathSegment(id, "deploymentId");
    const validTeamId = yield* validateOptionalSegment(teamId, "teamId");
    const url = buildUrl(baseUrl, `/v13/deployments/${depSegment}`, { teamId: validTeamId });
    const response = yield* execute(HttpClientRequest.get(url), token);
    const raw = yield* decodeJson(response, VercelDeploymentResponse, "GET /v13/deployments/{id}");
    return toDeploymentStatus(raw, id, token);
  });

  const listDeployments = Effect.fn("vercel.client.listDeployments")(function* (
    token: string,
    options?: {
      readonly projectId?: string;
      readonly limit?: number;
      readonly target?: string;
      readonly state?: string;
      readonly teamId?: string;
    },
  ) {
    const projectId = yield* validateOptionalSegment(options?.projectId, "projectId");
    const teamId = yield* validateOptionalSegment(options?.teamId, "teamId");
    const url = buildUrl(baseUrl, "/v6/deployments", {
      projectId,
      limit: options?.limit,
      target: options?.target,
      state: options?.state,
      teamId,
    });
    const response = yield* execute(HttpClientRequest.get(url), token);
    const body = yield* decodeJson(response, VercelDeploymentsListResponse, "GET /v6/deployments");
    return body.deployments
      .map((raw): VercelDeploymentListItem => {
        const deploymentId = (raw.uid ?? raw.id ?? "").trim();
        const urlStr = normalizeDeploymentUrl(raw.url);
        return {
          deploymentId,
          ...(urlStr !== undefined ? { url: urlStr } : {}),
        };
      })
      .filter((item) => item.deploymentId.length > 0);
  });

  const getDeploymentEvents = Effect.fn("vercel.client.getDeploymentEvents")(function* (
    token: string,
    id: string,
    options?: {
      readonly limit?: number;
      readonly since?: number;
      readonly teamId?: string;
    },
  ) {
    const depSegment = yield* encodePathSegment(id, "deploymentId");
    const teamId = yield* validateOptionalSegment(options?.teamId, "teamId");
    const url = buildUrl(baseUrl, `/v2/deployments/${depSegment}/events`, {
      builds: 1,
      direction: "forward",
      limit: options?.limit,
      since: options?.since,
      teamId,
    });
    const response = yield* execute(HttpClientRequest.get(url), token);
    const rows = yield* decodeJson(
      response,
      VercelEventsResponse,
      "GET /v2/deployments/{id}/events",
    );
    return rows.map((row): VercelLogEvent => {
      const idVal = row.serial ?? row.id ?? row.payload?.id;
      const text = redactSecrets(row.text ?? row.payload?.text ?? "", token);
      return {
        ...(idVal !== undefined ? { id: idVal } : {}),
        type: row.type ?? "log",
        created: row.created ?? row.date ?? row.payload?.date ?? 0,
        text,
      };
    });
  });

  const rollbackDeployment = Effect.fn("vercel.client.rollbackDeployment")(function* (
    token: string,
    projectId: string,
    deploymentId: string,
    teamId?: string,
  ) {
    const projectSegment = yield* encodePathSegment(projectId, "projectId");
    const depSegment = yield* encodePathSegment(deploymentId, "deploymentId");
    const validTeamId = yield* validateOptionalSegment(teamId, "teamId");
    const url = buildUrl(baseUrl, `/v1/projects/${projectSegment}/rollback/${depSegment}`, {
      teamId: validTeamId,
    });
    yield* execute(HttpClientRequest.post(url), token);
  });

  const promoteDeployment = Effect.fn("vercel.client.promoteDeployment")(function* (
    token: string,
    projectId: string,
    deploymentId: string,
    teamId?: string,
  ) {
    const projectSegment = yield* encodePathSegment(projectId, "projectId");
    const depSegment = yield* encodePathSegment(deploymentId, "deploymentId");
    const validTeamId = yield* validateOptionalSegment(teamId, "teamId");
    const url = buildUrl(baseUrl, `/v10/projects/${projectSegment}/promote/${depSegment}`, {
      teamId: validTeamId,
    });
    yield* execute(HttpClientRequest.post(url), token);
  });

  const listDomains = Effect.fn("vercel.client.listDomains")(function* (
    token: string,
    projectId: string,
    options?: { readonly limit?: number; readonly teamId?: string },
  ) {
    const projectSegment = yield* encodePathSegment(projectId, "projectId");
    const teamId = yield* validateOptionalSegment(options?.teamId, "teamId");
    const url = buildUrl(baseUrl, `/v9/projects/${projectSegment}/domains`, {
      limit: options?.limit,
      teamId,
    });
    const response = yield* execute(HttpClientRequest.get(url), token);
    const body = yield* decodeJson(
      response,
      VercelDomainsListResponse,
      "GET /v9/projects/{id}/domains",
    );
    return body.domains
      .map((domain): DeployDomain => ({
        name: domain.name.trim(),
        verified: domain.verified,
      }))
      .filter((domain) => domain.name.length > 0);
  });

  const upsertEnv = Effect.fn("vercel.client.upsertEnv")(function* (
    token: string,
    projectId: string,
    entries: ReadonlyArray<UpsertEnvItem>,
    teamId?: string,
    extraSecrets: ReadonlyArray<string> = [],
  ) {
    const projectSegment = yield* encodePathSegment(projectId, "projectId");
    const validTeamId = yield* validateOptionalSegment(teamId, "teamId");
    const url = buildUrl(baseUrl, `/v9/projects/${projectSegment}/env`, {
      upsert: true,
      teamId: validTeamId,
    });
    const payload = entries.length === 1 ? entries[0] : entries;
    const bodyJson = yield* encodeJsonBody(payload).pipe(
      Effect.mapError(
        () => new PluginError({ message: "Failed to encode environment variables payload." }),
      ),
    );
    const sensitiveValues = entries
      .filter((entry) => entry.type === "sensitive" || entry.type === "encrypted")
      .map((entry) => entry.value);
    yield* execute(
      HttpClientRequest.post(url).pipe(HttpClientRequest.bodyText(bodyJson, "application/json")),
      token,
      [...sensitiveValues, ...extraSecrets],
    );
  });

  const removeEnv = Effect.fn("vercel.client.removeEnv")(function* (
    token: string,
    projectId: string,
    keys: ReadonlyArray<string>,
    environment: EnvTarget,
    teamId?: string,
  ) {
    if (keys.length === 0) return;
    const projectSegment = yield* encodePathSegment(projectId, "projectId");
    const validTeamId = yield* validateOptionalSegment(teamId, "teamId");
    const response = yield* execute(
      HttpClientRequest.get(
        buildUrl(baseUrl, `/v9/projects/${projectSegment}/env`, { teamId: validTeamId }),
      ),
      token,
    );
    const body = yield* decodeJson(
      response,
      Schema.Struct({
        envs: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            key: Schema.String,
            target: Schema.Array(Schema.String),
          }),
        ),
      }),
      "GET project env",
    );
    for (const entry of body.envs) {
      if (!keys.includes(entry.key) || !entry.target.includes(environment)) continue;
      const remaining = entry.target.filter((target) => target !== environment);
      const envIdSegment = yield* encodePathSegment(entry.id, "envId");
      const url = buildUrl(baseUrl, `/v9/projects/${projectSegment}/env/${envIdSegment}`, {
        teamId: validTeamId,
      });
      if (remaining.length === 0) {
        yield* execute(HttpClientRequest.delete(url), token);
      } else {
        const json = yield* encodeJsonBody({ target: remaining }).pipe(
          Effect.mapError(() => new PluginError({ message: "Could not encode env targets." })),
        );
        yield* execute(
          HttpClientRequest.patch(url).pipe(HttpClientRequest.bodyText(json, "application/json")),
          token,
        );
      }
    }
  });

  return {
    getUser,
    getTeam,
    listProjects,
    getProject,
    uploadFile,
    createDeployment,
    getDeployment,
    listDeployments,
    getDeploymentEvents,
    rollbackDeployment,
    promoteDeployment,
    listDomains,
    upsertEnv,
    removeEnv,
  };
}

export type VercelClient = ReturnType<typeof makeVercelClient>;
