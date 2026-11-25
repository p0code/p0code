import { it } from "@effect/vitest";
import {
  type ListCustomProviderModelsInput,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { expect, vi } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import { RpcCallerScopes } from "../auth/RpcCallerScopes.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import * as CustomModelProviders from "./CustomModelProviders.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";

const instanceId = ProviderInstanceId.make("opencode");
const saved = {
  id: "acme",
  kind: "openaiCompatible",
  baseUrl: "https://api.acme.test/v1",
} as const;

const layer = Layer.effect(
  CustomModelProviders.CustomModelProviders,
  CustomModelProviders.make,
).pipe(
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("opencode"),
          config: {
            customProviders: [{ ...saved, name: "Acme", models: [{ id: "acme-chat" }] }],
            customProviderApiKeys: { acme: "saved-key" },
          },
        },
      },
    }),
  ),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Layer.mock(SecretResolver.SecretResolver)({})),
  Layer.provide(
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: () => Effect.undefined,
    }),
  ),
);

it.effect("sends a custom provider's saved key only to the base URL it was saved for", () =>
  Effect.gen(function* () {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return String(url).endsWith("/chat/completions")
        ? Response.json({ choices: [{ finish_reason: "stop", message: { content: "OK" } }] })
        : Response.json({ data: [{ id: "acme-chat", context_window: 128_000 }] });
    });
    const service = yield* CustomModelProviders.CustomModelProviders;
    const list = (
      provider: ListCustomProviderModelsInput["provider"],
      apiKey: string,
      test?: { model: string },
    ) =>
      service
        .listModels({
          instanceId,
          provider,
          apiKey,
          ...(test ? { test: true, model: test.model } : {}),
        })
        .pipe(Effect.provideService(FetchHttpClient.Fetch, upstream));

    expect((yield* list(saved, SECRET_REDACTED)).models).toEqual([
      { id: "acme-chat", name: "acme-chat", contextWindow: 128_000 },
    ]);
    yield* list({ ...saved, baseUrl: "https://elsewhere.test/v1" }, "");
    yield* list({ ...saved, id: "new" }, "typed-key");
    expect((yield* list(saved, "", { model: "acme-chat" })).testedModel).toBe("acme-chat");
    expect(seen).toEqual([
      { url: "https://api.acme.test/v1/models", auth: "Bearer saved-key" },
      { url: "https://elsewhere.test/v1/models", auth: null },
      { url: "https://api.acme.test/v1/models", auth: "Bearer typed-key" },
      { url: "https://api.acme.test/v1/chat/completions", auth: "Bearer saved-key" },
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("needs providers:manage to probe an unsaved base URL, not a saved one", () =>
  Effect.gen(function* () {
    const upstream = vi.fn<typeof fetch>(async () =>
      Response.json({ data: [{ id: "acme-chat" }] }),
    );
    const service = yield* CustomModelProviders.CustomModelProviders;
    const listAs = (
      scopes: ReadonlyArray<typeof AuthSettingsWriteScope | typeof AuthProvidersManageScope>,
      provider: ListCustomProviderModelsInput["provider"],
    ) =>
      service
        .listModels({ instanceId, provider, apiKey: "" })
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, upstream),
          Effect.provideService(RpcCallerScopes, RpcCallerScopes.of({ scopes })),
        );

    const refused = yield* listAs([AuthSettingsWriteScope], {
      ...saved,
      baseUrl: "https://elsewhere.test/v1",
    }).pipe(Effect.flip);
    expect(refused.detail).toContain("providers:manage");
    expect(upstream).not.toHaveBeenCalled();

    const allowed = yield* listAs([AuthSettingsWriteScope, AuthProvidersManageScope], {
      ...saved,
      baseUrl: "https://elsewhere.test/v1",
    });
    expect(allowed.models).toEqual([{ id: "acme-chat", name: "acme-chat" }]);

    // The saved base URL stays usable with settings:write alone.
    upstream.mockClear();
    yield* listAs([AuthSettingsWriteScope], saved);
    expect(upstream).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer)),
);
