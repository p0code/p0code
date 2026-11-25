// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { CustomModelProvider } from "@t3tools/contracts";
import { customModelProviderKeyEnvironment } from "@t3tools/provider-core/server/customModelProviders";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  parsePiUserModelProviders,
  PI_CUSTOM_PROVIDERS_EXTENSION_ENV,
  piCustomProvidersEnvironment,
} from "./customProviders.ts";

const providers: ReadonlyArray<CustomModelProvider> = [
  {
    id: "acme",
    name: "Acme AI",
    kind: "openaiCompatible",
    baseUrl: "https://api.acme.test/v1",
    models: [{ id: "acme-chat", contextWindow: 32_000, inputCost: 0.5, outputCost: 1.5 }],
  },
  {
    id: "proxy",
    name: "Claude proxy",
    kind: "anthropic",
    baseUrl: "https://proxy.test/v1",
    models: [{ id: "claude-x" }],
  },
];

describe("Pi custom providers", () => {
  it.effect("registers p0code's providers from its own extension, keys only by variable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = yield* fileSystem.makeTempDirectoryScoped();
      const keyEnvironment = customModelProviderKeyEnvironment({
        customProviders: providers,
        customProviderApiKeys: { acme: "sk-acme-secret", proxy: "" },
      });
      assert.deepEqual(keyEnvironment, [
        { name: "P0CODE_PROVIDER_ACME_API_KEY", value: "sk-acme-secret", sensitive: true },
      ]);
      const [variable] = yield* piCustomProvidersEnvironment({
        providers,
        keyEnvironment,
        stateDir,
        instanceId: "pi",
      });
      assert.equal(variable?.name, PI_CUSTOM_PROVIDERS_EXTENSION_ENV);
      const source = yield* fileSystem.readFileString(variable!.value);
      assert.notInclude(source, "sk-acme-secret");

      const registered = new Map<string, Record<string, unknown>>();
      const extension = (yield* Effect.promise(
        () => import(NodeURL.pathToFileURL(variable!.value).href),
      )) as { default: (pi: unknown) => void };
      extension.default({
        registerProvider: (id: string, config: Record<string, unknown>) =>
          registered.set(id, config),
      });
      assert.deepInclude(registered.get("acme"), {
        name: "Acme AI",
        baseUrl: "https://api.acme.test/v1",
        api: "openai-completions",
        apiKey: "$P0CODE_PROVIDER_ACME_API_KEY",
      });
      assert.deepInclude((registered.get("acme")!.models as Array<unknown>)[0], {
        id: "acme-chat",
        contextWindow: 32_000,
        cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
      });
      // The Anthropic SDK appends /v1, and a provider without a key still lists its models.
      assert.deepInclude(registered.get("proxy"), {
        baseUrl: "https://proxy.test",
        api: "anthropic-messages",
        apiKey: "p0code-no-key",
      });

      assert.deepEqual(
        yield* piCustomProvidersEnvironment({
          providers: [],
          keyEnvironment: [],
          stateDir,
          instanceId: "pi",
        }),
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("lists the user's models.json providers", () => {
    assert.deepEqual(
      parsePiUserModelProviders(
        JSON.stringify({
          providers: {
            ollama: {
              baseUrl: "http://localhost:11434/v1",
              api: "openai-completions",
              apiKey: "ollama",
              models: [{ id: "llama3" }, { name: "no id" }],
            },
            anthropic: { baseUrl: "https://gateway.test" },
            broken: "nope",
          },
        }),
        "/home/me/.pi/agent/models.json",
      ),
      [
        {
          id: "ollama",
          baseUrl: "http://localhost:11434/v1",
          models: ["llama3"],
          source: "/home/me/.pi/agent/models.json",
        },
        {
          id: "anthropic",
          baseUrl: "https://gateway.test",
          models: [],
          source: "/home/me/.pi/agent/models.json",
        },
      ],
    );
    assert.deepEqual(parsePiUserModelProviders("{ not json", "models.json"), []);
  });
});
