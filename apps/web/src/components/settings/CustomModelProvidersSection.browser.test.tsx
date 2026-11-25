import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../../test/render";
import { CustomModelProvidersSection } from "./CustomModelProvidersSection";

const listCustomProviderModels = vi.hoisted(() =>
  vi.fn<typeof import("../../customModelProviders").listCustomProviderModels>(
    async (_environmentId, input) =>
      input.test
        ? { models: [], testedModel: input.model ?? "acme-chat" }
        : {
            models: [
              { id: "acme-chat", name: "acme-chat", contextWindow: 32_000 },
              { id: "acme-mini", name: "acme-mini" },
            ],
          },
  ),
);

vi.mock("../../customModelProviders", () => ({
  listCustomProviderModels,
  useUserModelProviders: () =>
    AsyncResult.success([
      {
        id: "ollama",
        name: "Ollama",
        models: ["llama3"],
        source: "/home/me/.config/opencode/opencode.json",
      },
    ]),
}));

it("adds a provider with loaded and hand-typed models", async () => {
  const onConfigChange = vi.fn(async (_config: Readonly<Record<string, unknown>>) => true);
  await using _screen = await render(
    <CustomModelProvidersSection
      environmentId={EnvironmentId.make("local")}
      instanceId={ProviderInstanceId.make("opencode")}
      config={{ binaryPath: "opencode" }}
      readOnly={false}
      onConfigChange={onConfigChange}
    />,
  );
  await expect.element(page.getByText("In opencode.json · 1 model")).toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Add provider" }));
  await userEvent.fill(page.getByLabelText("Name"), "Acme AI");
  await expect.element(page.getByLabelText("Provider ID")).toHaveValue("acme-ai");
  await userEvent.fill(page.getByLabelText("Base URL"), "https://api.acme.test/v1");
  await userEvent.fill(page.getByLabelText("API key"), "sk-acme");
  await expect.element(page.getByRole("button", { name: "Save" })).toBeDisabled();

  await userEvent.click(page.getByRole("button", { name: "Load models" }));
  expect(listCustomProviderModels).toHaveBeenLastCalledWith(EnvironmentId.make("local"), {
    instanceId: ProviderInstanceId.make("opencode"),
    provider: { id: "acme-ai", kind: "openaiCompatible", baseUrl: "https://api.acme.test/v1" },
    apiKey: "sk-acme",
  });
  await userEvent.click(page.getByRole("checkbox", { name: "acme-chat" }));
  await userEvent.type(page.getByRole("textbox", { name: "Model ID" }), "acme-large{Enter}");
  await userEvent.fill(page.getByLabelText("Output price for acme-large"), "2.5");

  await userEvent.click(page.getByRole("button", { name: "Test" }));
  await expect.element(page.getByRole("status")).toHaveTextContent("acme-chat answered. It works.");

  await userEvent.click(page.getByRole("button", { name: "Save" }));
  expect(onConfigChange).toHaveBeenCalledWith({
    binaryPath: "opencode",
    customProviders: [
      {
        id: "acme-ai",
        name: "Acme AI",
        kind: "openaiCompatible",
        baseUrl: "https://api.acme.test/v1",
        models: [
          { id: "acme-chat", contextWindow: 32_000 },
          { id: "acme-large", outputCost: 2.5 },
        ],
      },
    ],
    customProviderApiKeys: { "acme-ai": "sk-acme" },
  });
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});
