/*
 * MIT License
 * Copyright (c) 2026 p0code
 * Ported from https://github.com/p0code/deploy-cloudflare (v0.3.0)
 */
// @effect-diagnostics effectFnOpportunity:off -- Fake host services are one-line stand-ins.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { DeployProviderStorage } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export const TEST_TOKEN = "cf_secret_tok_NEVER_LEAK_9876543210";
export const TEST_ACCOUNT_ID = "acct_0123456789abcdef";
export const TEST_ACCOUNT_NAME = "Acme Engineering";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: HttpClientRequest.HttpClientRequest["body"];
}

export type MockRouteHandler = (
  request: RecordedRequest,
  rawRequest: HttpClientRequest.HttpClientRequest,
) => Response | Promise<Response> | { readonly networkError: string };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function cfSuccess(result: unknown, status = 200): Response {
  return jsonResponse({ success: true, errors: [], messages: [], result }, status);
}

export function cfError(
  errors: ReadonlyArray<{ readonly code: number; readonly message: string }>,
  status = 403,
): Response {
  return jsonResponse({ success: false, errors, messages: [], result: null }, status);
}

/**
 * Pure in-memory HttpClient mock. Guarantees zero real network traffic in tests.
 */
export function makeMockHttpClient(handler: MockRouteHandler) {
  const recorded: Array<RecordedRequest> = [];

  const client = HttpClient.make((request) =>
    Effect.suspend(() => {
      const auth = request.headers.authorization;
      const query = UrlParams.toString(request.urlParams);
      const fullUrl =
        query.length > 0
          ? `${request.url}${request.url.includes("?") ? "&" : "?"}${query}`
          : request.url;
      const entry: RecordedRequest = {
        method: request.method,
        url: fullUrl,
        authorization: auth,
        body: request.body,
      };
      recorded.push(entry);

      return Effect.tryPromise({
        try: async () => {
          const outcome = await handler(entry, request);
          if ("networkError" in outcome) {
            throw new Error(outcome.networkError);
          }
          return HttpClientResponse.fromWeb(request, outcome);
        },
        catch: (cause) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause,
            }),
          }),
      });
    }),
  );

  return {
    layer: Layer.succeed(HttpClient.HttpClient, client),
    recorded,
  };
}

export function fakeStorage(initialStorage: Readonly<Record<string, string>> = {}) {
  const stored = new Map<string, string>(Object.entries(initialStorage));
  const storage: DeployProviderStorage = {
    get: (key) => Effect.sync(() => Option.fromNullishOr(stored.get(key))),
    set: (key, value) => Effect.sync(() => void stored.set(key, value)),
    remove: (key) => Effect.sync(() => void stored.delete(key)),
  };
  return { storage, stored };
}

export function makeTestPlatform(httpLayer: Layer.Layer<HttpClient.HttpClient>) {
  return Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, httpLayer);
}

export const FIXTURE_TOKEN_ACTIVE = {
  id: "tok_abc123",
  status: "active",
  not_before: "2026-01-01T00:00:00Z",
  expires_on: "2027-01-01T00:00:00Z",
};

export const FIXTURE_ACCOUNTS = [
  { id: TEST_ACCOUNT_ID, name: TEST_ACCOUNT_NAME },
  { id: "acct_secondary", name: "Personal Sandbox" },
];

export const FIXTURE_PAGES_PROJECTS = [
  {
    id: "pg_1",
    name: "marketing-site",
    subdomain: "marketing-site.pages.dev",
    production_branch: "main",
    created_on: "2026-02-01T10:00:00Z",
    source: { type: "github", config: { owner: "acme", repo_name: "marketing" } },
    deployment_configs: {
      production: {
        env_vars: {
          PUBLIC_SITE_URL: { type: "plain_text", value: "https://acme.example" },
          API_SECRET: { type: "secret_text", value: null },
        },
      },
      preview: {
        env_vars: {
          PUBLIC_SITE_URL: { type: "plain_text", value: "https://preview.acme.example" },
        },
      },
    },
  },
];

export const FIXTURE_WORKER_SCRIPTS = [
  {
    id: "edge-api",
    etag: "etag-worker-1",
    compatibility_date: "2026-03-01",
    created_on: "2026-02-15T12:00:00Z",
    modified_on: "2026-05-01T12:00:00Z",
  },
];

export const FIXTURE_PAGES_DEPLOYMENT_READY = {
  id: "dep-pages-002",
  short_id: "dep002",
  project_name: "marketing-site",
  environment: "production",
  url: "https://dep002.marketing-site.pages.dev",
  created_on: "2026-06-01T08:00:00Z",
  latest_stage: {
    name: "deploy",
    status: "success",
    started_on: "2026-06-01T08:00:10Z",
    ended_on: "2026-06-01T08:00:35Z",
  },
  stages: [
    {
      name: "queued",
      status: "success",
      started_on: "2026-06-01T08:00:00Z",
      ended_on: "2026-06-01T08:00:02Z",
    },
    {
      name: "build",
      status: "success",
      started_on: "2026-06-01T08:00:02Z",
      ended_on: "2026-06-01T08:00:10Z",
    },
    {
      name: "deploy",
      status: "success",
      started_on: "2026-06-01T08:00:10Z",
      ended_on: "2026-06-01T08:00:35Z",
    },
  ],
};

export const FIXTURE_PAGES_DEPLOYMENT_PREVIOUS = {
  id: "dep-pages-001",
  short_id: "dep001",
  project_name: "marketing-site",
  environment: "production",
  url: "https://dep001.marketing-site.pages.dev",
  created_on: "2026-05-20T08:00:00Z",
  latest_stage: {
    name: "deploy",
    status: "success",
    started_on: "2026-05-20T08:00:10Z",
    ended_on: "2026-05-20T08:00:30Z",
  },
};

export const FIXTURE_PAGES_LOGS = {
  total: 3,
  includes_container_logs: true,
  data: [
    { ts: "2026-06-01T08:00:03Z", line: "Cloning repository..." },
    { ts: "2026-06-01T08:00:06Z", line: "Running pnpm build" },
    { ts: "2026-06-01T08:00:09Z", line: "Success: Assets published!" },
  ],
};

export const FIXTURE_PAGES_DOMAINS = [
  {
    id: "dom_1",
    name: "acme.example",
    status: "active",
    verification_data: { status: "active" },
    zone_tag: "zone_acme",
  },
];

export const FIXTURE_WORKER_VERSIONS = {
  items: [
    {
      id: "ver-002",
      number: 2,
      metadata: { created_on: "2026-06-01T09:00:00Z", source: "api" },
    },
    {
      id: "ver-001",
      number: 1,
      metadata: { created_on: "2026-05-15T09:00:00Z", source: "api" },
    },
  ],
};

export const FIXTURE_WORKER_DEPLOYMENTS = {
  deployments: [
    {
      id: "wdep-002",
      source: "api",
      strategy: "percentage",
      created_on: "2026-06-01T09:00:01Z",
      versions: [{ version_id: "ver-002", percentage: 100 }],
    },
  ],
};

export const FIXTURE_WORKER_DOMAINS = [
  {
    id: "wdom_1",
    hostname: "api.acme.example",
    service: "edge-api",
    environment: "production",
    zone_id: "zone_acme",
    zone_name: "acme.example",
  },
];

export const FIXTURE_WORKER_SETTINGS = {
  compatibility_date: "2026-03-01",
  bindings: [
    { name: "ENVIRONMENT", type: "plain_text" },
    { name: "CACHE_KV", type: "kv_namespace" },
    { name: "DB", type: "d1" },
    { name: "API_KEY", type: "secret_text" },
  ],
};
