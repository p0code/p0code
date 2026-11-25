import { describe, expect, it } from "vite-plus/test";

import {
  providerFromDraft,
  suggestCustomProviderId,
  withCustomModelProvider,
  withoutCustomModelProvider,
} from "./customModelProviders.ts";

const REDACTED = "••••••";
const acme = {
  id: "acme",
  name: "Acme",
  kind: "openaiCompatible",
  baseUrl: "https://api.acme.test/v1",
  models: [{ id: "acme-chat" }],
} as const;

describe("custom model providers", () => {
  it.each([
    ["Acme AI", [], "acme-ai"],
    ["  42 Labs!! ", [], "labs"],
    ["Acme AI", ["acme-ai", "acme-ai-2"], "acme-ai-3"],
    ["???", [], "provider"],
  ] as const)("suggests an id for %j", (name, taken, expected) => {
    expect(suggestCustomProviderId(name, new Set(taken))).toBe(expected);
  });

  it("turns the form into a provider only when every field is valid", () => {
    const draft = {
      id: "acme",
      name: " Acme ",
      kind: "openaiCompatible",
      baseUrl: "https://api.acme.test/v1/",
      models: [{ id: "acme-chat", contextWindow: "32000", inputCost: "0.5", outputCost: "" }],
    } as const;
    expect(providerFromDraft(draft)).toEqual({
      id: "acme",
      name: "Acme",
      kind: "openaiCompatible",
      baseUrl: "https://api.acme.test/v1",
      models: [{ id: "acme-chat", contextWindow: 32_000, inputCost: 0.5 }],
    });
    expect(providerFromDraft({ ...draft, id: "Acme" })).toBeUndefined();
    expect(providerFromDraft({ ...draft, baseUrl: "api.acme.test" })).toBeUndefined();
    expect(
      providerFromDraft({ ...draft, models: [{ ...draft.models[0], contextWindow: "-1" }] }),
    ).toBeUndefined();
  });

  it("keeps the rest of the config and a saved key unless a new one is typed", () => {
    const config = {
      binaryPath: "opencode",
      serverPassword: REDACTED,
      customProviders: [acme],
      customProviderApiKeys: { acme: REDACTED },
    };
    const renamed = withCustomModelProvider(config, { ...acme, name: "Acme 2" }, "");
    expect(renamed).toEqual({
      ...config,
      customProviders: [{ ...acme, name: "Acme 2" }],
    });
    const other = { ...acme, id: "other", name: "Other" };
    expect(withCustomModelProvider(config, other, " sk-new ")).toEqual({
      ...config,
      customProviders: [acme, other],
      customProviderApiKeys: { acme: REDACTED, other: "sk-new" },
    });
    expect(withoutCustomModelProvider(config, "acme")).toEqual({
      ...config,
      customProviders: [],
      customProviderApiKeys: {},
    });
  });
});
