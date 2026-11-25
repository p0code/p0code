import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { CustomModelProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  openCodeCustomProvidersEnvironment,
  readOpenCodeUserModelProviders,
} from "./customProviders.ts";

const providers: ReadonlyArray<CustomModelProvider> = [
  {
    id: "acme-ai",
    name: "Acme AI",
    kind: "openaiCompatible",
    baseUrl: "https://api.acme.test/v1",
    models: [
      { id: "acme-chat", contextWindow: 200_000, inputCost: 3, outputCost: 15 },
      { id: "acme-mini" },
    ],
  },
  {
    id: "proxy",
    name: "Claude proxy",
    kind: "anthropic",
    baseUrl: "https://proxy.test/v1",
    models: [{ id: "claude-x", name: "Claude X" }],
  },
];

describe("OpenCode custom providers", () => {
  it.effect(
    "writes an overlay OpenCode merges over the user's config, with keys by reference",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const stateDir = yield* fileSystem.makeTempDirectoryScoped();
        const input = { providers, stateDir, instanceId: "opencode", baseEnvironment: {} };
        const [variable] = yield* openCodeCustomProvidersEnvironment(input);
        assert.equal(variable?.name, "OPENCODE_CONFIG");
        assert.isTrue(variable!.value.startsWith(stateDir));
        const overlay = JSON.parse(yield* fileSystem.readFileString(variable!.value));
        assert.deepEqual(overlay.provider["acme-ai"], {
          name: "Acme AI",
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: "https://api.acme.test/v1",
            apiKey: "{env:P0CODE_PROVIDER_ACME_AI_API_KEY}",
          },
          models: {
            "acme-chat": {
              name: "acme-chat",
              limit: { context: 200_000, output: 16_384 },
              cost: { input: 3, output: 15 },
            },
            "acme-mini": { name: "acme-mini" },
          },
        });
        assert.deepInclude(overlay.provider.proxy, { npm: "@ai-sdk/anthropic" });

        // A user-owned OPENCODE_CONFIG stays theirs; the overlay goes inline instead.
        const inline = yield* openCodeCustomProvidersEnvironment({
          ...input,
          baseEnvironment: { OPENCODE_CONFIG: "/home/me/team.json" },
        });
        assert.equal(inline[0]?.name, "OPENCODE_CONFIG_CONTENT");
        assert.deepEqual(JSON.parse(inline[0]!.value), overlay);
        assert.deepEqual(
          yield* openCodeCustomProvidersEnvironment({
            ...input,
            baseEnvironment: { OPENCODE_CONFIG: "/a.json", OPENCODE_CONFIG_CONTENT: "{}" },
          }),
          [],
        );
        assert.deepEqual(
          yield* openCodeCustomProvidersEnvironment({ ...input, providers: [] }),
          [],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lists providers from the user's global config files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const configDir = path.join(home, ".config", "opencode");
      yield* fileSystem.makeDirectory(configDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(configDir, "opencode.jsonc"),
        `{
          // a comment
          "provider": {
            "ollama": {
              "name": "Ollama",
              "options": { "baseURL": "http://localhost:11434/v1", },
              "models": { "llama3": {}, "qwen": {} },
            },
          },
        }`,
      );
      assert.deepEqual(yield* readOpenCodeUserModelProviders({}, home), [
        {
          id: "ollama",
          name: "Ollama",
          baseUrl: "http://localhost:11434/v1",
          models: ["llama3", "qwen"],
          source: path.join(configDir, "opencode.jsonc"),
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
