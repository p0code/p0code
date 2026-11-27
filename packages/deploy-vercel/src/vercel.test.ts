/*
 * MIT License
 * Copyright (c) 2026 p0code contributors
 * Ported from https://github.com/p0code/deploy-vercel (v0.2.0)
 */
// @effect-diagnostics nodeBuiltinImport:off -- Uses temp directories to test local-build upload without touching the repo.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DeployProviderStorage } from "@t3tools/plugin-api";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { createVercelDeployProvider, VERCEL_PROVIDER_INFO } from "./index.ts";
import { EXPIRED_TOKEN_MESSAGE } from "./vercelClient.ts";

const TEST_ACCOUNT = { accountId: "fixture-account" };

const TEST_TOKEN = "vcp_super_secret_test_token_1234567890";
const EXPIRED_TOKEN = "vcp_expired_token_9876543210";

/** Mirrors `DeployService.redact` in p0code so we prove host redaction composes cleanly. */
const hostRedact = (text: string, secret: string | undefined): string =>
  secret === undefined || secret.length < 4 ? text : text.split(secret).join("[redacted]");

interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyText: string;
}

type FakeRouteResult = {
  readonly status: number;
  readonly body?: unknown;
};

type FakeHttpHandler = (req: RecordedRequest) => FakeRouteResult;

function readRequestBody(request: HttpClientRequest.HttpClientRequest): string {
  const body = request.body;
  if (body._tag === "Uint8Array") {
    return new TextDecoder().decode(body.body);
  }
  return "";
}

function makeFakeHttpLayer(handler: FakeHttpHandler) {
  const requests: Array<RecordedRequest> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers[key.toLowerCase()] = value;
      }
      const recorded: RecordedRequest = {
        method: request.method,
        url,
        headers,
        bodyText: readRequestBody(request),
      };
      requests.push(recorded);
      const reply = handler(recorded);
      const payload = reply.body === undefined ? "" : JSON.stringify(reply.body);
      const webResponse = new Response(payload, {
        status: reply.status,
        headers: { "content-type": "application/json" },
      });
      return HttpClientResponse.fromWeb(request, webResponse);
    }),
  );
  return {
    layer: Layer.succeed(HttpClient.HttpClient, client),
    requests,
  };
}

function fakeStorage() {
  const stored = new Map<string, string>();
  const storage: DeployProviderStorage = {
    get: (key) => Effect.sync(() => Option.fromUndefinedOr(stored.get(key))),
    set: (key, value) => Effect.sync(() => void stored.set(key, value)),
    remove: (key) => Effect.sync(() => void stored.delete(key)),
  };
  return { storage, stored };
}

function makeTestPlatform(httpLayer: Layer.Layer<HttpClient.HttpClient>) {
  return Layer.mergeAll(NodeServices.layer, httpLayer);
}

function extractFailureMessage(exit: Exit.Exit<unknown, { readonly message: string }>): string {
  if (Exit.isSuccess(exit)) return "";
  const fail = exit.cause.reasons.find(Cause.isFailReason);
  return fail?.error.message ?? "";
}

function makeStandardFixture() {
  let activeToken: string = TEST_TOKEN;
  let deployCounter = 0;
  let statusPolls = 0;
  const uploadedDigests: Array<string> = [];
  const upsertedEnvPayloads: Array<unknown> = [];
  let rollbackShouldFailWith400 = false;

  const handler: FakeHttpHandler = (req) => {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${activeToken}`) {
      return {
        status: 401,
        body: {
          error: {
            code: "forbidden",
            // Deliberately echo the supplied auth header to verify redaction strips it.
            message: `Not authorized for token ${auth ?? ""}`,
          },
        },
      };
    }

    const path = req.url.pathname;

    if (req.method === "GET" && path === "/v2/teams/team_acme")
      return { status: 200, body: { id: "team_acme", name: "ada-dev" } };

    if (req.method === "GET" && path === "/v2/user") {
      return {
        status: 200,
        body: {
          user: {
            id: "user_123",
            username: "ada-dev",
            email: "ada@example.com",
            name: "Ada Lovelace",
          },
        },
      };
    }

    if (req.method === "GET" && path === "/v9/projects") {
      return {
        status: 200,
        body: {
          projects: [
            {
              id: "prj_web_1",
              name: "my-web-app",
              framework: "nextjs",
              updatedAt: 1730000000000,
              link: {
                type: "github",
                org: "acme",
                repo: "my-web-app",
                repoId: 424242,
                productionBranch: "main",
              },
              latestDeployments: [{ url: "my-web-app-latest.vercel.app" }],
            },
            {
              id: "prj_static_2",
              name: "static-docs",
              framework: null,
              updatedAt: 1730000001000,
              link: null,
            },
          ],
        },
      };
    }

    if (req.method === "GET" && path === "/v9/projects/prj_web_1") {
      return {
        status: 200,
        body: {
          id: "prj_web_1",
          name: "my-web-app",
          framework: "nextjs",
          link: {
            type: "github",
            org: "acme",
            repo: "my-web-app",
            repoId: 424242,
            productionBranch: "main",
          },
        },
      };
    }

    if (req.method === "GET" && path === "/v9/projects/prj_static_2") {
      return {
        status: 200,
        body: {
          id: "prj_static_2",
          name: "static-docs",
          framework: null,
          link: null,
        },
      };
    }

    if (req.method === "POST" && path === "/v2/files") {
      const digest = req.headers["x-vercel-digest"];
      if (digest !== undefined) uploadedDigests.push(digest);
      return { status: 200, body: {} };
    }

    if (req.method === "POST" && path === "/v13/deployments") {
      deployCounter += 1;
      const body = JSON.parse(req.bodyText) as {
        readonly name: string;
        readonly target?: string;
      };
      return {
        status: 200,
        body: {
          id: `dpl_${deployCounter}`,
          projectId: "prj_web_1",
          name: body.name,
          url: `${body.name}-${deployCounter}.vercel.app`,
          readyState: "QUEUED",
          target: body.target ?? null,
        },
      };
    }

    if (req.method === "GET" && path.startsWith("/v13/deployments/")) {
      const id = decodeURIComponent(path.slice("/v13/deployments/".length));
      statusPolls += 1;
      const readyState =
        id === "dpl_building" && statusPolls < 2
          ? "BUILDING"
          : id === "dpl_failed"
            ? "ERROR"
            : "READY";
      return {
        status: 200,
        body: {
          id,
          projectId: "prj_web_1",
          name: "my-web-app",
          url: `my-web-app-${id}.vercel.app`,
          readyState,
          errorMessage: readyState === "ERROR" ? `Build failed using ${activeToken}` : null,
        },
      };
    }

    if (req.method === "GET" && path === "/v6/deployments") {
      return {
        status: 200,
        body: {
          deployments: [
            {
              uid: "dpl_current_prod",
              url: "my-web-app-curr.vercel.app",
              state: "READY",
            },
            {
              uid: "dpl_prev_prod",
              url: "my-web-app-prev.vercel.app",
              state: "READY",
            },
          ],
        },
      };
    }

    if (req.method === "GET" && path.endsWith("/events")) {
      const since = Number(req.url.searchParams.get("since") ?? "0");
      const all = [
        { id: "ev_1", type: "command", created: 1000, payload: { text: "Running build..." } },
        {
          id: "ev_2",
          type: "stdout",
          created: 2000,
          payload: { text: `Compiled successfully (no ${activeToken} leak)` },
        },
        { id: "ev_3", type: "stdout", created: 3000, payload: { text: "Build completed." } },
      ];
      return {
        status: 200,
        body: since === 0 ? all.slice(0, 2) : all.filter((event) => event.created >= since),
      };
    }

    if (req.method === "POST" && path.includes("/rollback/")) {
      if (rollbackShouldFailWith400) {
        return {
          status: 400,
          body: { error: { code: "not_a_production_deployment", message: "Use promote instead." } },
        };
      }
      return { status: 201, body: {} };
    }

    if (req.method === "POST" && path.includes("/promote/")) {
      return { status: 201, body: {} };
    }

    if (req.method === "GET" && path === "/v9/projects/prj_web_1/domains") {
      return {
        status: 200,
        body: {
          domains: [
            { name: "app.example.com", verified: true },
            { name: "staging.example.com", verified: false },
          ],
        },
      };
    }

    if (req.method === "POST" && path === "/v9/projects/prj_web_1/env") {
      const parsed: unknown = JSON.parse(req.bodyText);
      upsertedEnvPayloads.push(parsed);
      return { status: 200, body: { created: parsed } };
    }

    return {
      status: 404,
      body: { error: { code: "not_found", message: `Unhandled ${req.method} ${path}` } },
    };
  };

  return {
    handler,
    uploadedDigests,
    upsertedEnvPayloads,
    setToken: (next: string) => {
      activeToken = next;
    },
    setRollbackFails400: (fail: boolean) => {
      rollbackShouldFailWith400 = fail;
    },
  };
}

describe("built-in Vercel provider contract", () => {
  it.effect("exposes stable built-in metadata and descriptor", () =>
    Effect.gen(function* () {
      const fixture = makeStandardFixture();
      const http = makeFakeHttpLayer(fixture.handler);
      const { storage } = fakeStorage();

      const provider = yield* createVercelDeployProvider({ storage }).pipe(
        Effect.provide(makeTestPlatform(http.layer)),
      );

      assert.strictEqual(VERCEL_PROVIDER_INFO.id, "vercel");
      assert.strictEqual(VERCEL_PROVIDER_INFO.version, "0.2.0");
      assert.deepStrictEqual(provider.descriptor, {
        id: "vercel",
        label: "Vercel",
        icon: "triangle",
      });
    }),
  );
});

describe("auth: link, status, unlink, 401 expiry, and secret redaction", () => {
  it.effect(
    "links with a valid PAT via GET /v2/user, stores only in host credential storage, and never echoes token",
    () =>
      Effect.gen(function* () {
        const fixture = makeStandardFixture();
        const http = makeFakeHttpLayer(fixture.handler);
        const { storage, stored } = fakeStorage();

        const provider = yield* createVercelDeployProvider({ storage }).pipe(
          Effect.provide(makeTestPlatform(http.layer)),
        );

        const before = yield* provider.status(TEST_ACCOUNT);
        assert.deepStrictEqual(before, { state: "unlinked", accountLabel: null, message: null });

        const missingToken = yield* Effect.exit(provider.link({ account: TEST_ACCOUNT }));
        assert.isTrue(Exit.isFailure(missingToken));
        assert.include(extractFailureMessage(missingToken), "personal access token");

        const linked = yield* provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN });
        assert.deepStrictEqual(linked, { _tag: "linked", accountLabel: "ada-dev", warnings: [] });
        assert.isFalse(JSON.stringify(linked).includes(TEST_TOKEN));

        assert.strictEqual(stored.get("fixture-account:token"), TEST_TOKEN);
        assert.strictEqual(http.requests[0]?.url.pathname, "/v2/user");
        assert.strictEqual(http.requests[0]?.headers["authorization"], `Bearer ${TEST_TOKEN}`);

        const after = yield* provider.status(TEST_ACCOUNT);
        assert.deepStrictEqual(after, {
          state: "linked",
          accountLabel: "ada-dev",
          message: null,
          warnings: [],
        });
        assert.isFalse(JSON.stringify(after).includes(TEST_TOKEN));

        yield* provider.unlink(TEST_ACCOUNT);
        assert.isUndefined(stored.get("fixture-account:token"));
        const unlinked = yield* provider.status(TEST_ACCOUNT);
        assert.deepStrictEqual(unlinked, { state: "unlinked", accountLabel: null, message: null });
      }),
  );

  it.effect(
    "rejects 401 during link without storing token and keeps error safe for host redaction",
    () =>
      Effect.gen(function* () {
        const fixture = makeStandardFixture();
        const http = makeFakeHttpLayer(fixture.handler);
        const { storage, stored } = fakeStorage();

        const provider = yield* createVercelDeployProvider({ storage }).pipe(
          Effect.provide(makeTestPlatform(http.layer)),
        );

        const exit = yield* Effect.exit(
          provider.link({ account: TEST_ACCOUNT, token: EXPIRED_TOKEN }),
        );
        assert.isTrue(Exit.isFailure(exit));
        const message = extractFailureMessage(exit);
        assert.strictEqual(message, EXPIRED_TOKEN_MESSAGE);
        assert.isFalse(message.includes(EXPIRED_TOKEN));
        assert.strictEqual(hostRedact(message, EXPIRED_TOKEN), EXPIRED_TOKEN_MESSAGE);
        assert.isUndefined(stored.get("fixture-account:token"));

        const status = yield* provider.status(TEST_ACCOUNT);
        assert.strictEqual(status.state, "unlinked");
      }),
  );

  it.effect(
    "turns 401 on subsequent API calls into expired status, clears token, and allows relinking",
    () =>
      Effect.gen(function* () {
        const fixture = makeStandardFixture();
        const http = makeFakeHttpLayer(fixture.handler);
        const { storage, stored } = fakeStorage();

        const provider = yield* createVercelDeployProvider({ storage }).pipe(
          Effect.provide(makeTestPlatform(http.layer)),
        );

        yield* provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN });
        fixture.setToken("vcp_rotated_different_token_999999");

        const exit = yield* Effect.exit(provider.listProjects(TEST_ACCOUNT));
        assert.isTrue(Exit.isFailure(exit));
        const message = extractFailureMessage(exit);
        assert.strictEqual(message, EXPIRED_TOKEN_MESSAGE);
        assert.isFalse(message.includes(TEST_TOKEN));
        assert.isUndefined(stored.get("fixture-account:token"));

        const status = yield* provider.status(TEST_ACCOUNT);
        assert.deepStrictEqual(status, {
          state: "expired",
          accountLabel: "ada-dev",
          message: EXPIRED_TOKEN_MESSAGE,
        });

        const relinked = yield* provider.link({
          account: TEST_ACCOUNT,
          token: "vcp_rotated_different_token_999999",
        });
        assert.deepStrictEqual(relinked, { _tag: "linked", accountLabel: "ada-dev", warnings: [] });
        const recovered = yield* provider.status(TEST_ACCOUNT);
        assert.strictEqual(recovered.state, "linked");
      }),
  );

  it.effect(
    "redacts tokens echoed by upstream errors and composes cleanly with host redaction",
    () =>
      Effect.gen(function* () {
        const http = makeFakeHttpLayer((req) => {
          if (req.url.pathname === "/v2/user") {
            return { status: 200, body: { user: { id: "u1", username: "ada" } } };
          }
          return {
            status: 500,
            body: {
              error: { message: `Upstream error for ${TEST_TOKEN} with Bearer ${TEST_TOKEN}` },
            },
          };
        });
        const { storage } = fakeStorage();

        const provider = yield* createVercelDeployProvider({ storage }).pipe(
          Effect.provide(makeTestPlatform(http.layer)),
        );

        yield* provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN });
        const exit = yield* Effect.exit(provider.listProjects(TEST_ACCOUNT));
        assert.isTrue(Exit.isFailure(exit));
        const message = extractFailureMessage(exit);
        assert.isFalse(message.includes(TEST_TOKEN));
        assert.include(message, "[REDACTED]");
        assert.strictEqual(hostRedact(message, TEST_TOKEN), message);
      }),
  );
});

describe("projects, deployments, logs stream, rollback, domains, setEnv, and team scope", () => {
  it.effect(
    "lists projects, deploys via git, checks normalized status, and honors team scope",
    () =>
      Effect.gen(function* () {
        const fixture = makeStandardFixture();
        const http = makeFakeHttpLayer(fixture.handler);
        const { storage } = fakeStorage();

        const provider = yield* createVercelDeployProvider({ storage }).pipe(
          Effect.provide(makeTestPlatform(http.layer)),
        );

        yield* provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN });
        yield* provider.link({
          account: { ...TEST_ACCOUNT, teamId: "team_acme" },
          token: TEST_TOKEN,
        });

        const status = yield* provider.status(TEST_ACCOUNT);
        assert.deepStrictEqual(status, {
          state: "linked",
          accountLabel: "ada-dev",
          message: null,
          warnings: [
            {
              code: "team-scope",
              message:
                "Requests are limited to Vercel team team_acme; the token must grant access to that team.",
            },
          ],
        });

        const projects = yield* provider.listProjects(TEST_ACCOUNT);
        assert.strictEqual(projects.length, 2);
        assert.deepStrictEqual(projects[0], {
          kind: "vercel-project",
          id: "prj_web_1",
          name: "my-web-app",
          url: "https://my-web-app-latest.vercel.app",
        });
        assert.strictEqual(
          http.requests
            .find((r) => r.url.pathname === "/v9/projects")
            ?.url.searchParams.get("teamId"),
          "team_acme",
        );

        const deployed = yield* provider.deploy({
          account: TEST_ACCOUNT,
          target: { kind: "vercel-project", id: "prj_web_1" },
          source: { kind: "git", branch: "feat/deploy" },
          environment: "preview",
          envVars: { FEATURE_FLAG: "on" },
        });
        assert.deepStrictEqual(deployed, {
          deploymentId: "dpl_1",
          url: "https://my-web-app-1.vercel.app",
        });

        const createReq = http.requests.find(
          (req) => req.method === "POST" && req.url.pathname === "/v13/deployments",
        );
        assert.isDefined(createReq);
        const createPayload = JSON.parse(createReq?.bodyText ?? "{}") as {
          readonly project?: string;
          readonly target?: string;
          readonly gitSource?: {
            readonly type?: string;
            readonly ref?: string;
            readonly repoId?: number;
          };
        };
        assert.strictEqual(createPayload.project, "prj_web_1");
        assert.isUndefined(createPayload.target);
        assert.strictEqual(createPayload.gitSource?.type, "github");
        assert.strictEqual(createPayload.gitSource?.ref, "feat/deploy");
        assert.strictEqual(createPayload.gitSource?.repoId, 424242);
        assert.strictEqual(fixture.upsertedEnvPayloads.length, 1);

        const depStatus = yield* provider.deploymentStatus({
          account: TEST_ACCOUNT,
          deploymentId: "dpl_1",
        });
        assert.deepStrictEqual(depStatus, {
          deploymentId: "dpl_1",
          state: "ready",
          url: "https://my-web-app-dpl_1.vercel.app",
        });

        const failedStatus = yield* provider.deploymentStatus({
          account: TEST_ACCOUNT,
          deploymentId: "dpl_failed",
        });
        assert.strictEqual(failedStatus.state, "error");
        assert.isFalse((failedStatus.message ?? "").includes(TEST_TOKEN));
        assert.include(failedStatus.message ?? "", "[REDACTED]");
      }),
  );

  it.effect(
    "deploys local-build prebuilt (.vercel/output) directories via /v2/files + /v13/deployments",
    () =>
      Effect.gen(function* () {
        const fixture = makeStandardFixture();
        const http = makeFakeHttpLayer(fixture.handler);
        const { storage } = fakeStorage();

        const tmpDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p0-vercel-build-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(tmpDir, { recursive: true, force: true })),
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(tmpDir, ".vercel", "output", "static"), {
            recursive: true,
          });
          await NodeFSP.writeFile(
            NodePath.join(tmpDir, ".vercel", "output", "config.json"),
            JSON.stringify({ version: 3 }),
          );
          await NodeFSP.writeFile(
            NodePath.join(tmpDir, ".vercel", "output", "static", "index.html"),
            "<h1>Hello</h1>",
          );
        });

        const provider = yield* createVercelDeployProvider({ storage }).pipe(
          Effect.provide(makeTestPlatform(http.layer)),
        );
        yield* provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN });

        const deployed = yield* provider.deploy({
          account: TEST_ACCOUNT,
          target: { kind: "vercel-project", id: "prj_static_2" },
          source: { kind: "local-build", directory: tmpDir },
          environment: "production",
        });
        assert.strictEqual(deployed.deploymentId, "dpl_1");
        assert.strictEqual(fixture.uploadedDigests.length, 2);

        const createReq = http.requests.find(
          (req) => req.method === "POST" && req.url.pathname === "/v13/deployments",
        );
        const payload = JSON.parse(createReq?.bodyText ?? "{}") as {
          readonly target?: string;
          readonly prebuilt?: boolean;
          readonly files?: ReadonlyArray<{
            readonly file: string;
            readonly sha: string;
            readonly size: number;
          }>;
        };
        assert.strictEqual(payload.target, "production");
        assert.strictEqual(payload.prebuilt, true);
        assert.deepStrictEqual(
          payload.files?.map((f) => f.file),
          ["config.json", "static/index.html"],
        );
      }).pipe(Effect.scoped),
  );

  it.effect(
    "streams logs once when follow is false, and polls until terminal state when follow is true",
    () =>
      Effect.gen(function* () {
        const fixture = makeStandardFixture();
        const http = makeFakeHttpLayer(fixture.handler);
        const { storage } = fakeStorage();

        const provider = yield* createVercelDeployProvider({
          storage,
          logsPollIntervalMs: 0,
          logsMaxPolls: 5,
        }).pipe(Effect.provide(makeTestPlatform(http.layer)));
        yield* provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN });

        const single = Array.from(
          yield* provider
            .logs({ account: TEST_ACCOUNT, deploymentId: "dpl_building", follow: false })
            .pipe(Stream.runCollect),
        );
        assert.strictEqual(single.length, 2);
        assert.strictEqual(single[0], "[command] Running build...");
        assert.isFalse(single.join("\n").includes(TEST_TOKEN));
        assert.include(single[1] ?? "", "[REDACTED]");

        const followed = Array.from(
          yield* provider
            .logs({ account: TEST_ACCOUNT, deploymentId: "dpl_building", follow: true })
            .pipe(Stream.runCollect),
        );
        assert.strictEqual(followed.length, 3);
        assert.strictEqual(followed[2], "[stdout] Build completed.");
        assert.isFalse(followed.join("\n").includes(TEST_TOKEN));
      }),
  );

  it.effect(
    "rolls back explicit deployment, auto-selects previous production deployment, and falls back to promote",
    () =>
      Effect.gen(function* () {
        const fixture = makeStandardFixture();
        const http = makeFakeHttpLayer(fixture.handler);
        const { storage } = fakeStorage();

        const provider = yield* createVercelDeployProvider({ storage }).pipe(
          Effect.provide(makeTestPlatform(http.layer)),
        );
        yield* provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN });

        const autoRollback = yield* provider.rollback({
          account: TEST_ACCOUNT,
          target: { kind: "vercel-project", id: "prj_web_1" },
        });
        assert.deepStrictEqual(autoRollback, {
          deploymentId: "dpl_prev_prod",
          url: "https://my-web-app-prev.vercel.app",
        });

        fixture.setRollbackFails400(true);
        const promoted = yield* provider.rollback({
          account: TEST_ACCOUNT,
          target: { kind: "vercel-project", id: "prj_web_1" },
          deploymentId: "dpl_preview_9",
        });
        assert.deepStrictEqual(promoted, {
          deploymentId: "dpl_preview_9",
          url: "https://my-web-app-dpl_preview_9.vercel.app",
        });
        assert.isDefined(
          http.requests.find(
            (r) => r.method === "POST" && r.url.pathname.includes("/promote/dpl_preview_9"),
          ),
        );
      }),
  );

  it.effect("lists domains and upserts env vars without echoing values", () =>
    Effect.gen(function* () {
      const fixture = makeStandardFixture();
      const http = makeFakeHttpLayer(fixture.handler);
      const { storage } = fakeStorage();

      const provider = yield* createVercelDeployProvider({ storage }).pipe(
        Effect.provide(makeTestPlatform(http.layer)),
      );
      yield* provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN });

      const domains = yield* provider.listDomains({
        account: TEST_ACCOUNT,
        target: { kind: "vercel-project", id: "prj_web_1" },
      });
      assert.deepStrictEqual(domains, [
        { name: "app.example.com", verified: true },
        { name: "staging.example.com", verified: false },
      ]);

      const secretValue = "sk_live_never_echo_this_value";
      yield* provider.setEnv({
        account: TEST_ACCOUNT,
        target: { kind: "vercel-project", id: "prj_web_1" },
        environment: "production",
        secret: true,
        remove: [],
        vars: {
          STRIPE_KEY: secretValue,
          PUBLIC_URL: "https://app.example.com",
        },
      });

      const envReq = http.requests.find(
        (req) => req.method === "POST" && req.url.pathname === "/v9/projects/prj_web_1/env",
      );
      assert.strictEqual(envReq?.url.searchParams.get("upsert"), "true");
      assert.strictEqual(fixture.upsertedEnvPayloads.length, 1);

      const emptyExit = yield* Effect.exit(
        provider.setEnv({
          account: TEST_ACCOUNT,
          target: { kind: "vercel-project", id: "prj_web_1" },
          environment: "production",
          secret: true,
          remove: [],
          vars: {},
        }),
      );
      assert.isTrue(Exit.isFailure(emptyExit));
    }),
  );
});

describe("account isolation and env targets", () => {
  it.effect("keeps tokens, teams, expiry and unlink independent", () =>
    Effect.gen(function* () {
      const a = { accountId: "business-a", teamId: "team_a" };
      const b = { accountId: "business-b", teamId: "team_b" };
      let expireA = false;
      const http = makeFakeHttpLayer((req) => {
        const token = req.headers.authorization;
        const isA = token === "Bearer token-account-a";
        if (expireA && isA) return { status: 401, body: { error: { message: "expired" } } };
        if (req.url.pathname.startsWith("/v2/teams/"))
          return {
            status: 200,
            body: { id: isA ? a.teamId : b.teamId, name: isA ? "Business A" : "Business B" },
          };
        assert.strictEqual(req.url.searchParams.get("teamId"), isA ? a.teamId : b.teamId);
        return {
          status: 200,
          body: { projects: [{ id: isA ? "prj_a" : "prj_b", name: isA ? "A" : "B" }] },
        };
      });
      const { storage, stored } = fakeStorage();
      const provider = yield* createVercelDeployProvider({ storage }).pipe(
        Effect.provide(makeTestPlatform(http.layer)),
      );
      const linked = yield* provider.link({ account: a, token: "token-account-a" });
      assert.strictEqual(linked._tag, "linked");
      yield* provider.link({ account: b, token: "token-account-b" });
      assert.strictEqual(stored.get("business-a:token"), "token-account-a");
      assert.strictEqual(stored.get("business-b:token"), "token-account-b");
      assert.strictEqual((yield* provider.listProjects(a))[0]?.id, "prj_a");
      assert.strictEqual((yield* provider.listProjects(b))[0]?.id, "prj_b");
      expireA = true;
      yield* Effect.exit(provider.listProjects(a));
      assert.strictEqual((yield* provider.status(a)).state, "expired");
      assert.strictEqual((yield* provider.status(b)).state, "linked");
      yield* provider.unlink(a);
      assert.strictEqual((yield* provider.listProjects(b))[0]?.id, "prj_b");
      assert.isFalse(http.requests.some((req) => req.url.pathname === "/v2/user"));
    }),
  );

  it.effect("writes one environment and removes only that target from shared records", () =>
    Effect.gen(function* () {
      const http = makeFakeHttpLayer((req) => {
        if (req.url.pathname === "/v2/user")
          return { status: 200, body: { user: { id: "u", username: "Ada" } } };
        if (req.method === "GET")
          return {
            status: 200,
            body: {
              envs: [
                { id: "shared", key: "REMOVE", target: ["production", "preview"] },
                { id: "only", key: "ONLY", target: ["preview"] },
                { id: "keep", key: "KEEP", target: ["production"] },
              ],
            },
          };
        return { status: 200, body: {} };
      });
      const { storage } = fakeStorage();
      const provider = yield* createVercelDeployProvider({ storage }).pipe(
        Effect.provide(makeTestPlatform(http.layer)),
      );
      yield* provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN });
      const base = {
        account: TEST_ACCOUNT,
        target: { kind: "vercel-project" as const, id: "prj" },
        environment: "preview" as const,
      };
      yield* provider.setEnv({
        ...base,
        vars: { SECRET: "value" },
        secret: true,
        remove: ["REMOVE", "ONLY", "KEEP"],
      });
      assert.deepStrictEqual(
        JSON.parse(http.requests.find((req) => req.method === "PATCH")?.bodyText ?? "{}"),
        { target: ["production"] },
      );
      assert.isTrue(
        http.requests.some((req) => req.method === "DELETE" && req.url.pathname.endsWith("/only")),
      );
      assert.deepStrictEqual(
        JSON.parse(http.requests.find((req) => req.method === "POST")?.bodyText ?? "{}"),
        { key: "SECRET", value: "value", type: "sensitive", target: ["preview"] },
      );
      yield* provider.setEnv({ ...base, vars: { PUBLIC: "value" }, secret: false, remove: [] });
      assert.strictEqual(JSON.parse(http.requests.at(-1)?.bodyText ?? "{}").type, "plain");
      yield* provider.setEnv({ ...base, vars: {}, secret: false, remove: ["ONLY"] });
    }),
  );
});
