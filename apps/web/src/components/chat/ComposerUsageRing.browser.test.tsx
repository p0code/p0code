import {
  DEFAULT_CLIENT_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { __setClientSettingsForTests, updateClientSettings } from "../../hooks/useSettings";
import { ComposerUsageRing } from "./ComposerUsageRing";

const checkedAt = "2026-10-25T16:00:00.000Z";

function makeProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [
        {
          id: "session",
          kind: "session",
          label: "Session",
          usedPercent: 0,
          windowDurationMins: 300,
          resetsAt: "2026-10-25T20:00:00.000Z",
        },
        {
          id: "weekly",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 41,
          windowDurationMins: 10080,
          resetsAt: "2026-10-30T16:00:00.000Z",
        },
      ],
    },
  };
}

describe("ComposerUsageRing usageDisplayMode", () => {
  it("shows explicit left/used labels for context and limit rows while keeping ring fill on context use", async () => {
    using _resetSettings = {
      [Symbol.dispose]() {
        __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
      },
    };
    const usage = {
      costTarget: null,
      providerInstanceId: ProviderInstanceId.make("claude"),
      model: "claude-opus-4-6",
      providers: [makeProvider()],
      sources: [],
      contextWindow: {
        usedTokens: 553_000,
        maxTokens: 1_000_000,
        remainingTokens: 447_000,
        usedPercentage: 55.3,
        remainingPercentage: 44.7,
        updatedAt: checkedAt,
      },
    };

    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, usageDisplayMode: "left" });
    await using screen = await render(<ComposerUsageRing usage={usage} size="sm" />);

    const ringButton = screen.getByRole("button", { name: "Context 45% left, show usage" });
    await expect.element(ringButton).toHaveAttribute("data-composer-usage-ring", "55");
    await ringButton.click();

    await expect.element(page.getByText("447k left of 1m")).toBeVisible();
    await expect.element(page.getByText("100% left")).toBeVisible();
    await expect.element(page.getByText("59% left")).toBeVisible();

    await updateClientSettings({ usageDisplayMode: "used" });

    const usedButton = screen.getByRole("button", { name: "Context 55% used, show usage" });
    await expect.element(usedButton).toHaveAttribute("data-composer-usage-ring", "55");
    await expect.element(page.getByText("553k / 1m used")).toBeVisible();
    await expect.element(page.getByText("0% used")).toBeVisible();
    await expect.element(page.getByText("41% used")).toBeVisible();
  });
});
