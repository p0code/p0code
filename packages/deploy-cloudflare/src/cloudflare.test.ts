/*
 * MIT License
 * Copyright (c) 2026 p0code
 * Ported from https://github.com/p0code/deploy-cloudflare (v0.3.0)
 */
// @effect-diagnostics nodeBuiltinImport:off -- Fixture builds write real temp directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import type { PluginError, StartedDeployProvider } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  FIXTURE_ACCOUNTS,
  FIXTURE_PAGES_DEPLOYMENT_PREVIOUS,
  FIXTURE_PAGES_DEPLOYMENT_READY,
  FIXTURE_PAGES_DOMAINS,
  FIXTURE_PAGES_LOGS,
  FIXTURE_PAGES_PROJECTS,
  FIXTURE_TOKEN_ACTIVE,
  FIXTURE_WORKER_DEPLOYMENTS,
  FIXTURE_WORKER_DOMAINS,
  FIXTURE_WORKER_SCRIPTS,
  FIXTURE_WORKER_SETTINGS,
  FIXTURE_WORKER_VERSIONS,
  TEST_ACCOUNT_ID,
  TEST_ACCOUNT_NAME,
  TEST_TOKEN,
  cfError,
  cfSuccess,
  fakeStorage,
  makeMockHttpClient,
  makeTestPlatform,
  type MockRouteHandler,
} from "./fixtures.ts";
import {
  CLOUDFLARE_PROVIDER_INFO,
  createCloudflareDeployProvider,
  type CreateCloudflareDeployProviderOptions,
} from "./index.ts";
import { parseWranglerJsonc, parseWranglerToml } from "./wranglerConfig.ts";

const TEST_ACCOUNT = { accountId: "fixture-account" };

/** Creates the built-in Cloudflare provider against an in-memory HTTP client and storage. */
function startWithHandler(
  handler: MockRouteHandler,
  initialStorage?: Record<string, string>,
  extraOptions?: Omit<CreateCloudflareDeployProviderOptions, "storage">,
) {
  const mock = makeMockHttpClient(handler);
  const store = fakeStorage(initialStorage);
  const start = createCloudflareDeployProvider({ storage: store.storage, ...extraOptions }).pipe(
    Effect.provide(makeTestPlatform(mock.layer)),
  );
  return { mock, store, start };
}

function linkedStorage(overrides: Record<string, unknown> = {}) {
  return {
    "fixture-account:api_token": TEST_TOKEN,
    "fixture-account:account_meta": JSON.stringify({
      accountId: TEST_ACCOUNT_ID,
      accountLabel: TEST_ACCOUNT_NAME,
      tokenId: "tok_abc123",
      expiresAt: "2027-01-01T00:00:00Z",
      accounts: FIXTURE_ACCOUNTS,
      ...overrides,
    }),
  };
}

function assertNoTokenLeak(value: unknown) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert.isFalse(serialized.includes(TEST_TOKEN), `token leaked into: ${serialized}`);
}

/** Runs an effect expected to fail and returns its rendered cause. */
const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect);
    assert.isTrue(Exit.isFailure(exit), "expected a failure");
    const rendered = Exit.isFailure(exit) ? String(exit.cause) : "";
    assertNoTokenLeak(rendered);
    return rendered;
  });

const collect = (stream: Stream.Stream<string, PluginError>) => Stream.runCollect(stream);

describe("built-in Cloudflare provider wiring", () => {
  it.effect("exposes stable built-in metadata and checked provider descriptor", () =>
    Effect.gen(function* () {
      assert.strictEqual(CLOUDFLARE_PROVIDER_INFO.id, "cloudflare");
      assert.strictEqual(CLOUDFLARE_PROVIDER_INFO.label, "Cloudflare");
      assert.strictEqual(CLOUDFLARE_PROVIDER_INFO.version, "0.3.0");
      const env = startWithHandler(() => cfError([{ code: 9999, message: "unexpected" }], 500));
      const provider = yield* env.start;
      assert.deepStrictEqual(provider.descriptor, {
        id: "cloudflare",
        label: "Cloudflare",
        icon: "cloud",
      });
      assert.deepStrictEqual(yield* provider.status(TEST_ACCOUNT), {
        state: "unlinked",
        accountLabel: null,
        message: null,
      });
    }),
  );
});

describe("link, status, unlink", () => {
  it.effect(
    "verifies the token, stores it only in host credential storage, and reports the account",
    () =>
      Effect.gen(function* () {
        const env = startWithHandler((req) => {
          if (req.url.endsWith("/user/tokens/verify")) {
            assert.strictEqual(req.authorization, `Bearer ${TEST_TOKEN}`);
            return cfSuccess(FIXTURE_TOKEN_ACTIVE);
          }
          if (req.url.endsWith("/accounts")) return cfSuccess(FIXTURE_ACCOUNTS);
          return cfError([{ code: 404, message: "not found" }], 404);
        });
        const provider = yield* env.start;

        const linked = yield* provider.link({ account: TEST_ACCOUNT, token: `  ${TEST_TOKEN}  ` });
        assert.deepStrictEqual(linked, {
          _tag: "linked",
          accountLabel: TEST_ACCOUNT_NAME,
          teamId: TEST_ACCOUNT_ID,
          warnings: [],
        });
        assert.strictEqual(env.store.stored.get("fixture-account:api_token"), TEST_TOKEN);
        assertNoTokenLeak(env.store.stored.get("fixture-account:account_meta"));

        const status = yield* provider.status(TEST_ACCOUNT);
        assert.strictEqual(status.state, "linked");
        assert.strictEqual(status.accountLabel, TEST_ACCOUNT_NAME);
        assertNoTokenLeak(status);

        yield* provider.unlink(TEST_ACCOUNT);
        assert.isUndefined(env.store.stored.get("fixture-account:api_token"));
        assert.isUndefined(env.store.stored.get("fixture-account:account_meta"));
        assert.strictEqual((yield* provider.status(TEST_ACCOUNT)).state, "unlinked");
      }),
  );

  it.effect("explains that Cloudflare needs a token when link is called without one", () =>
    Effect.gen(function* () {
      const provider = yield* startWithHandler(() => cfSuccess(null)).start;
      const message = yield* failureOf(provider.link({ account: TEST_ACCOUNT }));
      assert.include(message, "API token");
      assert.include(message, "Pages:Edit");
    }),
  );

  it.effect("fails a 401 link without storing or echoing the token", () =>
    Effect.gen(function* () {
      const env = startWithHandler(() =>
        cfError(
          [{ code: 1000, message: `Invalid API Token Bearer ${TEST_TOKEN} ${TEST_TOKEN}` }],
          401,
        ),
      );
      const provider = yield* env.start;
      const message = yield* failureOf(provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN }));
      assert.include(message.toLowerCase(), "invalid");
      assert.isUndefined(env.store.stored.get("fixture-account:api_token"));
    }),
  );

  it.effect("names Account Settings:Read when /accounts is forbidden", () =>
    Effect.gen(function* () {
      const env = startWithHandler((req) =>
        req.url.endsWith("/user/tokens/verify")
          ? cfSuccess(FIXTURE_TOKEN_ACTIVE)
          : cfError([{ code: 10000, message: "Authentication error" }], 403),
      );
      const provider = yield* env.start;
      assert.include(
        yield* failureOf(provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN })),
        "Account Settings:Read",
      );
      assert.isUndefined(env.store.stored.get("fixture-account:api_token"));
    }),
  );

  it.effect("reports expired with a link-again hint when Cloudflare rejects the stored token", () =>
    Effect.gen(function* () {
      for (const status of [401, 403]) {
        const provider = yield* startWithHandler(
          () => cfError([{ code: 1000, message: "Invalid API Token" }], status),
          linkedStorage(),
        ).start;
        const result = yield* provider.status(TEST_ACCOUNT);
        assert.strictEqual(result.state, "expired");
        assert.strictEqual(result.accountLabel, TEST_ACCOUNT_NAME);
        assert.include(result.message ?? "", "Link Cloudflare again");
        assertNoTokenLeak(result);
      }
    }),
  );

  it.effect("reports expired without a request once the stored expiry has passed", () =>
    Effect.gen(function* () {
      // The test clock starts at the epoch, so an expiry before it has already passed.
      const env = startWithHandler(
        () => cfSuccess(FIXTURE_TOKEN_ACTIVE),
        linkedStorage({ expiresAt: "1969-12-31T00:00:00Z" }),
      );
      const provider = yield* env.start;
      const result = yield* provider.status(TEST_ACCOUNT);
      assert.strictEqual(result.state, "expired");
      assert.include(result.message ?? "", "1969-12-31");
      assert.strictEqual(env.mock.recorded.length, 0);
    }),
  );

  it.effect("reports error, not expired, when Cloudflare cannot be reached", () =>
    Effect.gen(function* () {
      const provider = yield* startWithHandler(
        () => ({ networkError: `ECONNREFUSED Authorization: Bearer ${TEST_TOKEN}` }),
        linkedStorage(),
      ).start;
      const result = yield* provider.status(TEST_ACCOUNT);
      assert.strictEqual(result.state, "error");
      assertNoTokenLeak(result);
    }),
  );
});

describe("listProjects", () => {
  it.effect("lists Pages projects and Workers with URLs", () =>
    Effect.gen(function* () {
      const provider = yield* startWithHandler((req) => {
        if (req.url.endsWith(`/accounts/${TEST_ACCOUNT_ID}/pages/projects`))
          return cfSuccess(FIXTURE_PAGES_PROJECTS);
        if (req.url.endsWith(`/accounts/${TEST_ACCOUNT_ID}/workers/scripts`))
          return cfSuccess(FIXTURE_WORKER_SCRIPTS);
        if (req.url.endsWith("/workers/subdomain")) return cfSuccess({ subdomain: "acme-eng" });
        return cfError([{ code: 404, message: `unmatched ${req.url}` }], 404);
      }, linkedStorage()).start;
      assert.deepStrictEqual(yield* provider.listProjects(TEST_ACCOUNT), [
        {
          kind: "pages",
          id: "pages:marketing-site",
          name: "marketing-site (Pages)",
          url: "https://marketing-site.pages.dev",
        },
        {
          kind: "worker",
          id: "worker:edge-api",
          name: "edge-api (Worker)",
          url: "https://edge-api.acme-eng.workers.dev",
        },
      ]);
    }),
  );

  it.effect("keeps the products a half-scoped token can see", () =>
    Effect.gen(function* () {
      const env = startWithHandler((req) => {
        if (req.url.endsWith("/pages/projects")) return cfSuccess(FIXTURE_PAGES_PROJECTS);
        return cfError([{ code: 10000, message: "Authentication error" }], 403);
      }, linkedStorage());
      const provider = yield* env.start;
      const projects = yield* provider.listProjects(TEST_ACCOUNT);
      assert.deepStrictEqual(
        projects.map((p) => p.id),
        ["pages:marketing-site"],
      );
    }),
  );

  it.effect("names both scopes when neither product is visible, and never echoes the token", () =>
    Effect.gen(function* () {
      const provider = yield* startWithHandler(
        () => cfError([{ code: 9109, message: `Unauthorized for ${TEST_TOKEN}` }], 403),
        linkedStorage(),
      ).start;
      const message = yield* failureOf(provider.listProjects(TEST_ACCOUNT));
      assert.include(message, "Pages:Edit");
      assert.include(message, "Workers Scripts:Edit");
    }),
  );

  it.effect("scrubs the token from transport failures", () =>
    Effect.gen(function* () {
      const provider = yield* startWithHandler(
        () => ({ networkError: `ECONNREFUSED while sending ${TEST_TOKEN}` }),
        linkedStorage(),
      ).start;
      yield* failureOf(provider.listProjects(TEST_ACCOUNT));
    }),
  );

  it.effect("adds a link-again hint when a stored token stops working mid-session", () =>
    Effect.gen(function* () {
      const provider = yield* startWithHandler(
        () => cfError([{ code: 1000, message: "Invalid API Token" }], 401),
        linkedStorage(),
      ).start;
      assert.include(
        yield* failureOf(provider.listProjects(TEST_ACCOUNT)),
        "Link Cloudflare again",
      );
    }),
  );
});

describe("Pages", () => {
  it.effect(
    "deploys from Git, reads status and logs, rolls back, lists domains, and sets env",
    () =>
      Effect.gen(function* () {
        const patches: Array<unknown> = [];
        let rollbackUrl = "";
        const provider = yield* startWithHandler((req) => {
          const base = "/pages/projects/marketing-site";
          if (req.method === "PATCH" && req.url.endsWith(base)) {
            if (req.body._tag === "Uint8Array")
              patches.push(JSON.parse(new TextDecoder().decode(req.body.body)));
            return cfSuccess(FIXTURE_PAGES_PROJECTS[0]);
          }
          if (req.method === "POST" && req.url.endsWith(`${base}/deployments`)) {
            if (req.body._tag === "FormData")
              assert.strictEqual(req.body.formData.get("branch"), "feature/hero");
            return cfSuccess({
              ...FIXTURE_PAGES_DEPLOYMENT_READY,
              id: "dep-pages-003",
              url: "https://dep003.marketing-site.pages.dev",
              latest_stage: { name: "build", status: "active" },
            });
          }
          if (req.url.endsWith(`${base}/deployments/dep-pages-002/history/logs`))
            return cfSuccess(FIXTURE_PAGES_LOGS);
          if (req.url.endsWith(`${base}/deployments/dep-pages-002`))
            return cfSuccess(FIXTURE_PAGES_DEPLOYMENT_READY);
          if (req.url.endsWith(`${base}/deployments/dep-pages-003`)) {
            return cfSuccess({
              ...FIXTURE_PAGES_DEPLOYMENT_READY,
              id: "dep-pages-003",
              latest_stage: { name: "build", status: "failure" },
            });
          }
          if (req.method === "GET" && req.url.endsWith(`${base}/deployments`)) {
            return cfSuccess([FIXTURE_PAGES_DEPLOYMENT_READY, FIXTURE_PAGES_DEPLOYMENT_PREVIOUS]);
          }
          if (req.url.endsWith(`${base}/deployments/dep-pages-001/rollback`)) {
            rollbackUrl = req.url;
            return cfSuccess({
              ...FIXTURE_PAGES_DEPLOYMENT_PREVIOUS,
              id: "dep-pages-004",
              url: "https://dep004.marketing-site.pages.dev",
            });
          }
          if (req.url.endsWith(`${base}/domains`)) {
            return cfSuccess([
              ...FIXTURE_PAGES_DOMAINS,
              { name: "pending.example", status: "pending" },
            ]);
          }
          if (req.url.endsWith(base)) return cfSuccess(FIXTURE_PAGES_PROJECTS[0]);
          return cfError([{ code: 404, message: `unmatched ${req.method} ${req.url}` }], 404);
        }, linkedStorage()).start;

        const deployed = yield* provider.deploy({
          account: TEST_ACCOUNT,
          target: { kind: "pages", id: "pages:marketing-site" },
          environment: "preview",
          source: { kind: "git", branch: "feature/hero" },
          envVars: { FEATURE_FLAG: "on" },
        });
        assert.deepStrictEqual(deployed, {
          deploymentId: "pages:marketing-site:dep-pages-003",
          url: "https://dep003.marketing-site.pages.dev",
        });
        assert.deepStrictEqual(patches[0], {
          deployment_configs: {
            preview: { env_vars: { FEATURE_FLAG: { type: "plain_text", value: "on" } } },
          },
        });

        assert.deepStrictEqual(
          yield* provider.deploymentStatus({
            account: TEST_ACCOUNT,
            deploymentId: "pages:marketing-site:dep-pages-002",
          }),
          {
            deploymentId: "pages:marketing-site:dep-pages-002",
            state: "ready",
            url: "https://dep002.marketing-site.pages.dev",
          },
        );
        const failed = yield* provider.deploymentStatus({
          account: TEST_ACCOUNT,
          deploymentId: "pages:marketing-site:dep-pages-003",
        });
        assert.strictEqual(failed.state, "error");
        assert.include(failed.message ?? "", "build");

        const lines = yield* collect(
          provider.logs({
            account: TEST_ACCOUNT,
            deploymentId: "pages:marketing-site:dep-pages-002",
          }),
        );
        assert.deepStrictEqual(lines, [
          "2026-06-01T08:00:03Z Cloning repository...",
          "2026-06-01T08:00:06Z Running pnpm build",
          "2026-06-01T08:00:09Z Success: Assets published!",
        ]);
        // The deployment is already ready, so following ends after the lines it has.
        assert.strictEqual(
          (yield* collect(
            provider.logs({
              account: TEST_ACCOUNT,
              deploymentId: "pages:marketing-site:dep-pages-002",
              follow: true,
            }),
          )).length,
          3,
        );

        const rolled = yield* provider.rollback({
          account: TEST_ACCOUNT,
          target: { kind: "pages", id: "pages:marketing-site" },
        });
        assert.include(rollbackUrl, "/dep-pages-001/rollback");
        assert.deepStrictEqual(rolled, {
          deploymentId: "pages:marketing-site:dep-pages-004",
          url: "https://dep004.marketing-site.pages.dev",
        });
        yield* provider.rollback({
          account: TEST_ACCOUNT,
          target: { kind: "pages", id: "pages:marketing-site" },
          deploymentId: "pages:marketing-site:dep-pages-001",
        });

        assert.deepStrictEqual(
          yield* provider.listDomains({
            account: TEST_ACCOUNT,
            target: { kind: "pages", id: "pages:marketing-site" },
          }),
          [
            { name: "acme.example", verified: true },
            { name: "pending.example", verified: false },
            { name: "marketing-site.pages.dev", verified: true },
          ],
        );

        patches.length = 0;
        yield* provider.setEnv({
          account: TEST_ACCOUNT,
          target: { kind: "pages", id: "pages:marketing-site" },
          environment: "production",
          secret: true,
          remove: [],
          vars: {
            PUBLIC_SITE_URL: "https://new.acme.example",
          },
        });
        const value = {
          PUBLIC_SITE_URL: { type: "secret_text", value: "https://new.acme.example" },
        };
        assert.deepStrictEqual(patches, [
          { deployment_configs: { production: { env_vars: value } } },
        ]);
      }),
  );

  it.effect("follows a building deployment's log until it settles", () =>
    Effect.gen(function* () {
      let polls = 0;
      const provider = yield* startWithHandler((req) => {
        if (req.url.endsWith("/history/logs")) {
          return cfSuccess({ data: FIXTURE_PAGES_LOGS.data.slice(0, polls === 1 ? 1 : 3) });
        }
        if (req.url.endsWith("/deployments/dep-live")) {
          polls += 1;
          return cfSuccess({
            ...FIXTURE_PAGES_DEPLOYMENT_READY,
            id: "dep-live",
            latest_stage:
              polls === 1
                ? { name: "build", status: "active" }
                : { name: "deploy", status: "success" },
          });
        }
        return cfError([{ code: 404, message: `unmatched ${req.url}` }], 404);
      }, linkedStorage()).start;
      const lines = yield* collect(
        provider.logs({
          account: TEST_ACCOUNT,
          deploymentId: "pages:marketing-site:dep-live",
          follow: true,
        }),
      );
      assert.strictEqual(lines.length, 3);
      assert.strictEqual(polls, 2);
    }),
  );

  it.effect("uploads a local build directly and says plainly when there is no build log", () =>
    Effect.gen(function* () {
      const tmpDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cf-pages-direct-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(tmpDir, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(tmpDir, "assets"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(tmpDir, "index.html"), "<h1>Hello Cloudflare</h1>");
        await NodeFSP.writeFile(NodePath.join(tmpDir, "assets", "app.js"), "console.log('hi');");
      });

      let uploaded = 0;
      let manifest: Record<string, string> = {};
      const provider = yield* startWithHandler((req) => {
        if (req.url.endsWith("/upload-token")) return cfSuccess({ jwt: "upload-jwt-short-lived" });
        if (req.url.endsWith("/pages/assets/check-missing")) {
          assert.strictEqual(req.authorization, "Bearer upload-jwt-short-lived");
          const body =
            req.body._tag === "Uint8Array"
              ? (JSON.parse(new TextDecoder().decode(req.body.body)) as { hashes: Array<string> })
              : { hashes: [] };
          return cfSuccess(body.hashes);
        }
        if (req.url.endsWith("/pages/assets/upload")) {
          uploaded =
            req.body._tag === "Uint8Array"
              ? (JSON.parse(new TextDecoder().decode(req.body.body)) as Array<unknown>).length
              : 0;
          return cfSuccess(null);
        }
        if (req.url.endsWith("/pages/assets/upsert-hashes")) return cfSuccess(null);
        if (
          req.method === "POST" &&
          req.url.endsWith("/pages/projects/marketing-site/deployments")
        ) {
          if (req.body._tag === "FormData") {
            const raw = req.body.formData.get("manifest");
            if (typeof raw === "string") manifest = JSON.parse(raw) as Record<string, string>;
          }
          return cfSuccess({
            ...FIXTURE_PAGES_DEPLOYMENT_READY,
            id: "dep-direct-1",
            url: "https://dep-direct-1.marketing-site.pages.dev",
          });
        }
        if (req.url.endsWith("/deployments/dep-direct-1/history/logs")) {
          return cfError([{ code: 8000009, message: "No build logs available" }], 404);
        }
        return cfError([{ code: 404, message: `unmatched ${req.method} ${req.url}` }], 404);
      }, linkedStorage()).start;

      const deployed = yield* provider.deploy({
        account: TEST_ACCOUNT,
        target: { kind: "pages", id: "pages:marketing-site" },
        environment: "production",
        source: { kind: "local-build", directory: tmpDir },
      });
      assert.strictEqual(uploaded, 2);
      assert.isDefined(manifest["/index.html"]);
      assert.isDefined(manifest["/assets/app.js"]);
      assert.strictEqual(deployed.url, "https://dep-direct-1.marketing-site.pages.dev");

      const lines = yield* collect(
        provider.logs({ account: TEST_ACCOUNT, deploymentId: deployed.deploymentId }),
      );
      assert.strictEqual(lines.length, 1);
      assert.include(lines[0] ?? "", "Direct Upload");
      assert.include(lines[0] ?? "", "dep-direct-1");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refuses a local build with no directory or a relative one, and per-deploy build vars",
    () =>
      Effect.gen(function* () {
        const provider = yield* startWithHandler(() => cfSuccess(null), linkedStorage()).start;
        const deploy = (source: Parameters<StartedDeployProvider["deploy"]>[0]["source"]) =>
          provider.deploy({
            account: TEST_ACCOUNT,
            target: { kind: "pages", id: "pages:marketing-site" },
            environment: "production",
            source,
          });
        assert.include(yield* failureOf(deploy({ kind: "local-build" })), "did not send one");
        assert.include(
          yield* failureOf(deploy({ kind: "local-build", directory: "dist" })),
          "relative directory",
        );
        assert.include(
          yield* failureOf(deploy({ kind: "git", env: { NODE_ENV: "production" } })),
          "no build variables",
        );
      }),
  );

  it.effect(
    "refuses a symlinked Pages build directory escaping projectRoot and skips symlinked files",
    () =>
      Effect.gen(function* () {
        const tmpBase = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cf-pages-symlink-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(tmpBase, { recursive: true, force: true })),
        );
        const projectDir = NodePath.join(tmpBase, "project");
        const outsideDir = NodePath.join(tmpBase, "outside");
        const distDir = NodePath.join(projectDir, "dist");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(distDir, { recursive: true });
          await NodeFSP.mkdir(outsideDir, { recursive: true });
          await NodeFSP.writeFile(NodePath.join(outsideDir, "secret.txt"), "top-secret");
          await NodeFSP.symlink(outsideDir, NodePath.join(projectDir, "escaped-dist"));
          await NodeFSP.writeFile(NodePath.join(distDir, "index.html"), "<h1>Safe</h1>");
          await NodeFSP.symlink(
            NodePath.join(outsideDir, "secret.txt"),
            NodePath.join(distDir, "leaked.txt"),
          );
        });

        let manifest: Record<string, string> = {};
        const provider = yield* startWithHandler((req) => {
          if (req.url.endsWith("/upload-token")) return cfSuccess({ jwt: "jwt-1" });
          if (req.url.endsWith("/pages/assets/check-missing")) return cfSuccess([]);
          if (req.url.endsWith("/pages/assets/upsert-hashes")) return cfSuccess(null);
          if (req.method === "POST" && req.url.endsWith("/deployments")) {
            if (req.body._tag === "FormData") {
              const raw = req.body.formData.get("manifest");
              if (typeof raw === "string") manifest = JSON.parse(raw) as Record<string, string>;
            }
            return cfSuccess({ ...FIXTURE_PAGES_DEPLOYMENT_READY, id: "dep-safe" });
          }
          return cfError([{ code: 404, message: `unmatched ${req.url}` }], 404);
        }, linkedStorage()).start;

        // Symlinked directory escaping projectRoot is refused.
        assert.include(
          yield* failureOf(
            provider.deploy({
              account: TEST_ACCOUNT,
              target: { kind: "pages", id: "pages:marketing-site" },
              environment: "production",
              source: {
                kind: "local-build",
                projectRoot: projectDir,
                directory: NodePath.join(projectDir, "escaped-dist"),
              },
            }),
          ),
          "outside project root",
        );

        // Symlinked files inside a valid build directory are skipped.
        yield* provider.deploy({
          account: TEST_ACCOUNT,
          target: { kind: "pages", id: "pages:marketing-site" },
          environment: "production",
          source: { kind: "local-build", projectRoot: projectDir, directory: distDir },
        });
        assert.deepStrictEqual(Object.keys(manifest), ["/index.html"]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "excludes secret dotfiles and key files from Cloudflare Pages uploads and logs a warning listing them",
    () =>
      Effect.gen(function* () {
        const tmpDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cf-pages-secrets-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(tmpDir, { recursive: true, force: true })),
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(NodePath.join(tmpDir, ".ssh"), { recursive: true });
          await NodeFSP.mkdir(NodePath.join(tmpDir, ".aws"), { recursive: true });
          await NodeFSP.writeFile(NodePath.join(tmpDir, "index.html"), "<h1>Safe</h1>");
          await NodeFSP.writeFile(NodePath.join(tmpDir, ".env"), "SECRET=1");
          await NodeFSP.writeFile(NodePath.join(tmpDir, ".env.local"), "SECRET=2");
          await NodeFSP.writeFile(NodePath.join(tmpDir, ".dev.vars"), "CF_SECRET=3");
          await NodeFSP.writeFile(NodePath.join(tmpDir, ".npmrc"), "//registry/:_authToken=x");
          await NodeFSP.writeFile(NodePath.join(tmpDir, ".netrc"), "password x");
          await NodeFSP.writeFile(NodePath.join(tmpDir, "cert.pem"), "PEM");
          await NodeFSP.writeFile(NodePath.join(tmpDir, "server.key"), "KEY");
          await NodeFSP.writeFile(NodePath.join(tmpDir, "id_rsa"), "RSA");
          await NodeFSP.writeFile(NodePath.join(tmpDir, ".ssh", "id_rsa"), "SSH");
          await NodeFSP.writeFile(NodePath.join(tmpDir, ".aws", "credentials"), "AWS");
        });

        let manifest: Record<string, string> = {};
        const warnings: Array<string> = [];
        const captureLogger = Logger.make(({ message }) => {
          warnings.push(String(message));
        });

        const provider = yield* startWithHandler((req) => {
          if (req.url.endsWith("/upload-token")) return cfSuccess({ jwt: "jwt-1" });
          if (req.url.endsWith("/pages/assets/check-missing")) return cfSuccess([]);
          if (req.url.endsWith("/pages/assets/upsert-hashes")) return cfSuccess(null);
          if (req.method === "POST" && req.url.endsWith("/deployments")) {
            if (req.body._tag === "FormData") {
              const raw = req.body.formData.get("manifest");
              if (typeof raw === "string") manifest = JSON.parse(raw) as Record<string, string>;
            }
            return cfSuccess({ ...FIXTURE_PAGES_DEPLOYMENT_READY, id: "dep-clean" });
          }
          return cfError([{ code: 404, message: `unmatched ${req.url}` }], 404);
        }, linkedStorage()).start;

        yield* provider
          .deploy({
            account: TEST_ACCOUNT,
            target: { kind: "pages", id: "pages:marketing-site" },
            environment: "production",
            source: { kind: "local-build", projectRoot: tmpDir, directory: tmpDir },
          })
          .pipe(Effect.provide(Logger.layer([captureLogger])));

        assert.deepStrictEqual(Object.keys(manifest), ["/index.html"]);
        const warningText = warnings.join("\n");
        assert.include(warningText, ".env");
        assert.include(warningText, ".dev.vars");
        assert.include(warningText, ".npmrc");
        assert.include(warningText, "cert.pem");
        assert.include(warningText, "id_rsa");
        assert.include(warningText, ".ssh");
        assert.include(warningText, ".aws");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "enforces file-count and total-byte limits on Pages uploads, times out hung requests, and caps log polling",
    () =>
      Effect.gen(function* () {
        const tmpDir = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cf-pages-limits-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(tmpDir, { recursive: true, force: true })),
        );
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(NodePath.join(tmpDir, "a.txt"), "a".repeat(60));
          await NodeFSP.writeFile(NodePath.join(tmpDir, "b.txt"), "b".repeat(60));
          await NodeFSP.writeFile(NodePath.join(tmpDir, "c.txt"), "c".repeat(60));
        });

        const fileCapped = yield* startWithHandler(() => cfSuccess(null), linkedStorage(), {
          maxPagesFiles: 2,
        }).start;
        assert.include(
          yield* failureOf(
            fileCapped.deploy({
              account: TEST_ACCOUNT,
              target: { kind: "pages", id: "pages:marketing-site" },
              environment: "production",
              source: { kind: "local-build", projectRoot: tmpDir, directory: tmpDir },
            }),
          ),
          "2-file upload limit",
        );

        const byteCapped = yield* startWithHandler(() => cfSuccess(null), linkedStorage(), {
          maxPagesBytes: 100,
        }).start;
        assert.include(
          yield* failureOf(
            byteCapped.deploy({
              account: TEST_ACCOUNT,
              target: { kind: "pages", id: "pages:marketing-site" },
              environment: "production",
              source: { kind: "local-build", projectRoot: tmpDir, directory: tmpDir },
            }),
          ),
          "100 bytes upload limit",
        );

        // Follow polling stops once logsMaxPolls or maxLogLines is reached.
        let polls = 0;
        const pollCapped = yield* startWithHandler(
          (req) => {
            if (req.url.endsWith("/history/logs")) return cfSuccess({ data: [] });
            if (req.url.endsWith("/deployments/dep-stuck")) {
              polls += 1;
              return cfSuccess({
                ...FIXTURE_PAGES_DEPLOYMENT_READY,
                id: "dep-stuck",
                latest_stage: { name: "build", status: "active" },
              });
            }
            return cfError([{ code: 404, message: `unmatched ${req.url}` }], 404);
          },
          linkedStorage(),
          { logsPollIntervalMs: 0, logsMaxPolls: 3 },
        ).start;
        yield* collect(
          pollCapped.logs({
            account: TEST_ACCOUNT,
            deploymentId: "pages:marketing-site:dep-stuck",
            follow: true,
          }),
        );
        assert.strictEqual(polls, 3);

        // Hung HTTP requests time out via Effect.timeout in cloudflareApi.
        const hungHttp = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        );
        const store = fakeStorage(linkedStorage());
        const hungProvider = yield* createCloudflareDeployProvider({
          storage: store.storage,
        }).pipe(Effect.provide(makeTestPlatform(hungHttp)));
        const fiber = yield* Effect.forkChild(hungProvider.listProjects(TEST_ACCOUNT));
        yield* TestClock.adjust("25 seconds");
        const exit = yield* Fiber.await(fiber);
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "Failed to reach Cloudflare API");
      }).pipe(Effect.scoped),
  );
});

describe("Workers", () => {
  it.effect("uploads with wrangler bindings, rolls back, and lists domains and routes", () =>
    Effect.gen(function* () {
      const tmpDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cf-worker-upload-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(tmpDir, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(
          NodePath.join(tmpDir, "wrangler.toml"),
          [
            'name = "edge-api"',
            'main = "index.js"',
            'compatibility_date = "2026-03-01"',
            'compatibility_flags = ["nodejs_compat"]',
            "",
            "[vars]",
            'APP_MODE = "edge"',
            "",
            "[[kv_namespaces]]",
            'binding = "CACHE_KV"',
            'id = "kv_123"',
          ].join("\n"),
        );
        await NodeFSP.writeFile(
          NodePath.join(tmpDir, "index.js"),
          "export default { fetch() { return new Response('ok'); } };\n",
        );
      });

      let metadata: Record<string, unknown> | undefined;
      let rollbackPayload: unknown;
      const provider = yield* startWithHandler(async (req) => {
        if (
          req.method === "PUT" &&
          req.url.endsWith(`/accounts/${TEST_ACCOUNT_ID}/workers/scripts/edge-api`)
        ) {
          if (req.body._tag === "FormData") {
            const part = req.body.formData.get("metadata");
            if (part instanceof Blob)
              metadata = JSON.parse(await part.text()) as Record<string, unknown>;
          }
          return cfSuccess({ id: "edge-api", etag: "etag-new" });
        }
        if (req.url.endsWith("/workers/scripts/edge-api/versions"))
          return cfSuccess(FIXTURE_WORKER_VERSIONS);
        if (req.url.endsWith("/workers/scripts/edge-api/versions/ver-002"))
          return cfSuccess(FIXTURE_WORKER_VERSIONS.items[0]);
        if (req.method === "GET" && req.url.endsWith("/workers/scripts/edge-api/deployments"))
          return cfSuccess(FIXTURE_WORKER_DEPLOYMENTS);
        if (req.method === "POST" && req.url.endsWith("/workers/scripts/edge-api/deployments")) {
          if (req.body._tag === "Uint8Array")
            rollbackPayload = JSON.parse(new TextDecoder().decode(req.body.body));
          return cfSuccess({
            id: "wdep-003",
            versions: [{ version_id: "ver-001", percentage: 100 }],
          });
        }
        if (req.url.includes("/workers/domains")) return cfSuccess(FIXTURE_WORKER_DOMAINS);
        if (req.url.endsWith("/workers/subdomain")) return cfSuccess({ subdomain: "acme-eng" });
        if (req.url.includes("/zones?"))
          return cfSuccess([{ id: "zone_acme", name: "acme.example" }]);
        if (req.url.endsWith("/zones/zone_acme/workers/routes")) {
          return cfSuccess([
            { id: "route_1", pattern: "acme.example/api/*", script: "edge-api" },
            { id: "route_2", pattern: "acme.example/other/*", script: "other-worker" },
          ]);
        }
        return cfError([{ code: 404, message: `unmatched ${req.method} ${req.url}` }], 404);
      }, linkedStorage()).start;

      const deployed = yield* provider.deploy({
        account: TEST_ACCOUNT,
        target: { kind: "worker", id: "worker:edge-api" },
        environment: "production",
        source: { kind: "local-build", directory: tmpDir },
        envVars: { RELEASE_SHA: "abc1234" },
      });
      assert.deepStrictEqual(deployed, {
        deploymentId: "worker:edge-api:ver-002",
        url: "https://api.acme.example",
      });
      assert.strictEqual(metadata?.main_module, "index.js");
      assert.deepStrictEqual(metadata?.keep_bindings, ["secret_text"]);
      assert.deepStrictEqual(metadata?.bindings, [
        { name: "APP_MODE", type: "plain_text", text: "edge" },
        { name: "CACHE_KV", type: "kv_namespace", namespace_id: "kv_123" },
        { name: "RELEASE_SHA", type: "plain_text", text: "abc1234" },
      ]);

      assert.deepStrictEqual(
        yield* provider.deploymentStatus({
          account: TEST_ACCOUNT,
          deploymentId: deployed.deploymentId,
        }),
        {
          deploymentId: "worker:edge-api:ver-002",
          state: "ready",
          url: "https://edge-api.acme-eng.workers.dev",
        },
      );

      const rolled = yield* provider.rollback({
        account: TEST_ACCOUNT,
        target: { kind: "worker", id: "worker:edge-api" },
      });
      assert.strictEqual(rolled.deploymentId, "worker:edge-api:ver-001");
      assert.deepStrictEqual((rollbackPayload as { versions: unknown }).versions, [
        { version_id: "ver-001", percentage: 100 },
      ]);

      assert.deepStrictEqual(
        yield* provider.listDomains({
          account: TEST_ACCOUNT,
          target: { kind: "worker", id: "worker:edge-api" },
        }),
        [
          { name: "api.acme.example", verified: true },
          { name: "edge-api.acme-eng.workers.dev", verified: true },
          { name: "acme.example/api/*" },
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps its documented gaps as plain errors and log lines", () =>
    Effect.gen(function* () {
      const provider = yield* startWithHandler((req) => {
        if (req.url.endsWith("/workers/scripts/edge-api/settings"))
          return cfSuccess(FIXTURE_WORKER_SETTINGS);
        if (req.url.includes("/workers/domains")) return cfSuccess([]);
        if (req.url.endsWith("/workers/subdomain")) return cfSuccess({ subdomain: "acme-eng" });
        if (req.url.includes("/zones?"))
          return cfError([{ code: 10000, message: "Authentication error" }], 403);
        return cfError([{ code: 404, message: `unmatched ${req.url}` }], 404);
      }, linkedStorage()).start;

      // No Git builds for Workers over the API.
      const git = yield* failureOf(
        provider.deploy({
          account: TEST_ACCOUNT,
          target: { kind: "worker", id: "worker:edge-api" },
          environment: "production",
          source: { kind: "git", branch: "main" },
        }),
      );
      assert.include(git, "Local build");

      // No stored Worker logs over REST, followed or not.
      for (const follow of [false, true]) {
        const lines = yield* collect(
          provider.logs({
            account: TEST_ACCOUNT,
            deploymentId: "worker:edge-api:ver-002",
            follow,
          }),
        );
        assert.strictEqual(lines.length, 1);
        assert.include(lines[0] ?? "", "no stored logs");
        assert.include(lines[0] ?? "", "dash.cloudflare.com");
      }

      // Worker vars are read-only, and the error names the current bindings.
      const env = yield* failureOf(
        provider.setEnv({
          account: TEST_ACCOUNT,
          target: { kind: "worker", id: "worker:edge-api" },
          environment: "production",
          secret: true,
          remove: [],
          vars: { FOO: "bar" },
        }),
      );
      assert.include(env, "read-only");
      assert.include(env, "CACHE_KV (kv_namespace)");

      // Without Zone:Read the zone routes are skipped, not fatal.
      assert.deepStrictEqual(
        yield* provider.listDomains({
          account: TEST_ACCOUNT,
          target: { kind: "worker", id: "worker:edge-api" },
        }),
        [{ name: "edge-api.acme-eng.workers.dev", verified: true }],
      );

      assert.include(
        yield* failureOf(
          provider.deploymentStatus({ account: TEST_ACCOUNT, deploymentId: "not-a-cloudflare-id" }),
        ),
        "not a Cloudflare deployment id",
      );
    }),
  );

  it.effect(
    "enforces realPath containment on Worker entrypoints, wrangler configs, and parent-dir lookup",
    () =>
      Effect.gen(function* () {
        const tmpBase = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cf-worker-escape-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(tmpBase, { recursive: true, force: true })),
        );
        const outsideDir = NodePath.join(tmpBase, "outside");
        const secretFile = NodePath.join(outsideDir, "secret.js");
        const projA = NodePath.join(tmpBase, "proj-a");
        const projB = NodePath.join(tmpBase, "proj-b");
        const projC = NodePath.join(tmpBase, "proj-c");
        const projD = NodePath.join(tmpBase, "proj-d");
        const projDDist = NodePath.join(projD, "dist");

        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(outsideDir, { recursive: true });
          await NodeFSP.writeFile(secretFile, "export default { secret: true };");

          // projA: wrangler.toml points main at a symlink escaping outside.
          await NodeFSP.mkdir(projA, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(projA, "wrangler.toml"),
            'name = "a"\nmain = "entry.js"\n',
          );
          await NodeFSP.symlink(secretFile, NodePath.join(projA, "entry.js"));

          // projB: no wrangler.toml, default entry index.js is a symlink escaping outside.
          await NodeFSP.mkdir(projB, { recursive: true });
          await NodeFSP.symlink(secretFile, NodePath.join(projB, "index.js"));

          // projC: no wrangler.toml inside projC, hostile wrangler.toml in parent (tmpBase).
          await NodeFSP.mkdir(projC, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(tmpBase, "wrangler.toml"),
            'name = "parent"\nmain = "outside/secret.js"\n',
          );
          await NodeFSP.writeFile(
            NodePath.join(projC, "index.js"),
            "export default { ok: 'projC' };",
          );

          // projD: wrangler.toml in projectRoot, deploying from projectRoot/dist (allowed climb).
          await NodeFSP.mkdir(projDDist, { recursive: true });
          await NodeFSP.writeFile(
            NodePath.join(projD, "wrangler.toml"),
            'name = "d"\nmain = "dist/worker.js"\n',
          );
          await NodeFSP.writeFile(
            NodePath.join(projDDist, "worker.js"),
            "export default { ok: 'projD' };",
          );
        });

        const uploadedModules: Array<string> = [];
        const provider = yield* startWithHandler((req) => {
          if (req.method === "PUT" && req.url.includes("/workers/scripts/edge-api")) {
            if (req.body._tag === "FormData") {
              for (const key of req.body.formData.keys()) {
                if (key !== "metadata") uploadedModules.push(key);
              }
            }
            return cfSuccess({ id: "edge-api", etag: "etag-1" });
          }
          if (req.url.endsWith("/versions")) return cfSuccess(FIXTURE_WORKER_VERSIONS);
          if (req.url.includes("/workers/domains")) return cfSuccess([]);
          if (req.url.endsWith("/workers/subdomain")) return cfSuccess({ subdomain: "acme-eng" });
          return cfError([{ code: 404, message: `unmatched ${req.url}` }], 404);
        }, linkedStorage()).start;

        const deployWorkerAt = (projectRoot: string, directory: string) =>
          provider.deploy({
            account: TEST_ACCOUNT,
            target: { kind: "worker", id: "worker:edge-api" },
            environment: "production",
            source: { kind: "local-build", projectRoot, directory },
          });

        assert.include(yield* failureOf(deployWorkerAt(projA, projA)), "outside project directory");
        assert.include(yield* failureOf(deployWorkerAt(projB, projB)), "outside project directory");

        // projC must NOT climb to tmpBase/wrangler.toml outside projectRoot; it uses projC/index.js.
        yield* deployWorkerAt(projC, projC);
        assert.deepStrictEqual(uploadedModules, ["index.js"]);

        // projD/dist MAY read projD/wrangler.toml because projD is inside projectRoot.
        yield* deployWorkerAt(projD, projDDist);
        assert.deepStrictEqual(uploadedModules, ["index.js", "worker.js"]);
      }).pipe(Effect.scoped),
  );
});

describe("wrangler config parser", () => {
  it.effect("parses wrangler.jsonc with comments, trailing commas, and env overrides", () =>
    Effect.gen(function* () {
      const parsed = yield* parseWranglerJsonc(
        `{
          // Worker config
          "name": "my-worker",
          "main": "dist/worker.js",
          "compatibility_date": "2026-04-01",
          "vars": { "API_MODE": "prod", },
          "env": {
            "preview": {
              "vars": { "API_MODE": "preview" },
              "r2_buckets": [{ "binding": "ASSETS", "bucket_name": "preview-assets" }],
            },
          },
        }`,
        "preview",
      );
      assert.strictEqual(parsed.name, "my-worker");
      assert.strictEqual(parsed.main, "dist/worker.js");
      assert.deepStrictEqual(parsed.bindings, [
        { name: "API_MODE", type: "plain_text", text: "preview" },
        { name: "ASSETS", type: "r2_bucket", bucket_name: "preview-assets" },
      ]);
    }),
  );

  it("parses wrangler.toml d1_databases and routes", () => {
    const parsed = parseWranglerToml(`
      name = "billing"
      main = "src/index.js"
      [[d1_databases]]
      binding = "BILLING_DB"
      database_id = "d1-abc"
      [[routes]]
      pattern = "billing.acme.example/*"
    `);
    assert.deepStrictEqual(parsed.bindings, [{ name: "BILLING_DB", type: "d1", id: "d1-abc" }]);
    assert.deepStrictEqual(parsed.routes, ["billing.acme.example/*"]);
  });

  it("ignores hostile __proto__, constructor, and prototype keys in wrangler.toml without polluting Object.prototype", () => {
    const parsed = parseWranglerToml(`
      name = "safe-worker"
      __proto__ = "bad"
      constructor = "bad"
      prototype = "bad"

      [__proto__]
      allowOutsideProject = true
      pollutedFromProto = "pwned"

      [[__proto__.pollutedList]]
      binding = "EVIL"
      id = "evil-id"

      [constructor.prototype]
      pollutedFromCtor = true

      [prototype]
      pollutedFromPrototype = true

      [vars]
      __proto__ = "ignored"
      constructor = "ignored"
      prototype = "ignored"
      SAFE_VAR = "ok"

      [__proto__.vars]
      LEAKED_VAR = "should-not-appear"
    `);

    const probe = {} as Record<string, unknown>;
    assert.isFalse("allowOutsideProject" in probe);
    assert.isFalse("pollutedFromProto" in probe);
    assert.isFalse("pollutedList" in probe);
    assert.isFalse("pollutedFromCtor" in probe);
    assert.isFalse("pollutedFromPrototype" in probe);
    assert.strictEqual(parsed.name, "safe-worker");
    assert.deepStrictEqual(parsed.bindings, [{ name: "SAFE_VAR", type: "plain_text", text: "ok" }]);
  });

  it.effect("ignores hostile __proto__ keys in wrangler.jsonc", () =>
    Effect.gen(function* () {
      const parsed = yield* parseWranglerJsonc(
        `{
          "name": "safe-jsonc",
          "__proto__": { "pollutedJsonc": true },
          "vars": { "__proto__": "bad", "constructor": "bad", "OK": "yes" }
        }`,
        "__proto__",
      );
      assert.isFalse("pollutedJsonc" in ({} as Record<string, unknown>));
      assert.strictEqual(parsed.name, "safe-jsonc");
      assert.deepStrictEqual(parsed.bindings, [{ name: "OK", type: "plain_text", text: "yes" }]);
    }),
  );
});

describe("account isolation and env targets", () => {
  it.effect(
    "scopes two tokens to selected provider accounts and keeps expiry/unlink independent",
    () =>
      Effect.gen(function* () {
        const a = { accountId: "local-a", teamId: "cf_a" };
        const b = { accountId: "local-b", teamId: "cf_b" };
        let expireA = false;
        const env = startWithHandler((req) => {
          const isA = req.authorization === "Bearer token-a";
          const id = isA ? "cf_a" : "cf_b";
          if (req.url.endsWith("/user/tokens/verify"))
            return expireA && isA
              ? cfError([{ code: 9109, message: "expired" }], 401)
              : cfSuccess(FIXTURE_TOKEN_ACTIVE);
          if (req.url.endsWith("/accounts"))
            return cfSuccess([
              { id: "cf_a", name: "A" },
              { id: "cf_b", name: "B" },
            ]);
          assert.include(
            req.url,
            req.url.includes("/zones") ? `account.id=${id}` : `/accounts/${id}/`,
          );
          return cfSuccess([]);
        });
        const provider = yield* env.start;
        yield* provider.link({ account: a, token: "token-a" });
        const linked = yield* provider.link({ account: b, token: "token-b" });
        assert.deepStrictEqual(linked, {
          _tag: "linked",
          accountLabel: "B",
          teamId: "cf_b",
          warnings: [],
        });
        assert.strictEqual(env.store.stored.get("local-a:api_token"), "token-a");
        assert.strictEqual(env.store.stored.get("local-b:api_token"), "token-b");
        yield* provider.listProjects(a);
        yield* provider.listProjects(b);
        expireA = true;
        assert.strictEqual((yield* provider.status(a)).state, "expired");
        assert.strictEqual((yield* provider.status(b)).state, "linked");
        yield* provider.unlink(a);
        assert.strictEqual((yield* provider.status(a)).state, "unlinked");
        assert.strictEqual((yield* provider.status(b)).state, "linked");
      }),
  );

  it.effect("returns missing scope warnings on link and status", () =>
    Effect.gen(function* () {
      const env = startWithHandler((req) => {
        if (req.url.endsWith("/user/tokens/verify")) return cfSuccess(FIXTURE_TOKEN_ACTIVE);
        if (req.url.endsWith("/accounts")) return cfSuccess(FIXTURE_ACCOUNTS);
        if (req.url.includes("/workers/scripts") || req.url.includes("/zones"))
          return cfError([{ code: 10000, message: "scope denied" }], 403);
        return cfSuccess([]);
      });
      const provider = yield* env.start;
      const linked = yield* provider.link({ account: TEST_ACCOUNT, token: TEST_TOKEN });
      assert.strictEqual(linked._tag, "linked");
      if (linked._tag === "linked")
        assert.isTrue(
          linked.warnings?.some((warning) => warning.message.includes("Workers Scripts:Edit")),
        );
      const status = yield* provider.status(TEST_ACCOUNT);
      assert.strictEqual(status.message, null);
      assert.isTrue(status.warnings?.some((warning) => warning.code === "missing-scope"));
    }),
  );

  it.effect("sets secrets and removes keys in only the selected Pages environment", () =>
    Effect.gen(function* () {
      const patches: Array<unknown> = [];
      const env = startWithHandler((req) => {
        if (req.method === "PATCH" && req.body._tag === "Uint8Array")
          patches.push(JSON.parse(new TextDecoder().decode(req.body.body)));
        return cfSuccess({ name: "marketing-site" });
      }, linkedStorage());
      const provider = yield* env.start;
      const base = {
        account: TEST_ACCOUNT,
        target: { kind: "pages" as const, id: "pages:marketing-site" },
        environment: "preview" as const,
      };
      yield* provider.setEnv({ ...base, vars: { SECRET: "value" }, secret: true, remove: ["OLD"] });
      yield* provider.setEnv({ ...base, vars: {}, secret: false, remove: ["OLD"] });
      assert.deepStrictEqual(patches, [
        {
          deployment_configs: {
            preview: { env_vars: { SECRET: { type: "secret_text", value: "value" }, OLD: null } },
          },
        },
        { deployment_configs: { preview: { env_vars: { OLD: null } } } },
      ]);
      const before = patches.length;
      yield* failureOf(
        provider.setEnv({
          ...base,
          environment: "development",
          vars: { FOO: "bar" },
          secret: false,
          remove: [],
        }),
      );
      yield* failureOf(
        provider.setEnv({
          ...base,
          target: { kind: "worker", id: "pages:marketing-site" },
          vars: {},
          secret: false,
          remove: [],
        }),
      );
      assert.strictEqual(patches.length, before);
    }),
  );
});
