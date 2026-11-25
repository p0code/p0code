import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

describe("UsageLimitsPooled next refill", () => {
  it("skips elapsed resets while waiting for refreshed account data", async () => {
    function account(instanceId: string, usedPercent: number, resetsAt: string): ServerProvider {
      return {
        ...managedChatGpt(instanceId, instanceId),
        usageLimits: {
          checkedAt,
          windows: [{ id: "weekly", label: "Weekly", kind: "weekly", usedPercent, resetsAt }],
        },
      };
    }
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              account("Work", 20, "2026-10-25T17:00:00.000Z"),
              account("Personal", 60, "2026-10-25T18:00:00.000Z"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T17:30:00Z")} />,
    );
    await expect.element(screen.getByText("↻ +30%", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("↻ +30% in 30m")).toBeVisible();

    await screen.rerender(
      <UsageLimitsPooled presentations={presentations} now={Date.parse("2026-10-25T18:00:00Z")} />,
    );
    await expect.element(screen.getByText(/^↻ \+\d+%$/)).not.toBeInTheDocument();
  });
});

describe("UsageLimitsPooled usageDisplayMode", () => {
  it("renders left vs used wording, bar fills, and pace labels consistently", async () => {
    using _resetSettings = {
      [Symbol.dispose]() {
        __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
      },
    };
    const provider: ServerProvider = {
      ...managedChatGpt("codex", "Codex"),
      usageLimits: {
        checkedAt,
        windows: [
          {
            id: "session",
            label: "5 hours",
            kind: "session",
            usedPercent: 41,
            windowDurationMins: 300,
            resetsAt: "2026-10-25T19:00:00.000Z",
          },
        ],
      },
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        { entry: { target: { label: "Desk" } }, serverConfig: { providers: [provider] } },
      ],
    ]);
    const now = Date.parse(checkedAt);

    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, usageDisplayMode: "left" });
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={now} />,
    );
    await expect.element(screen.getByText("59%", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("left", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /59% left.*60% of the window left/ }))
      .toBeVisible();

    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, usageDisplayMode: "used" });
    await screen.rerender(<UsageLimitsPooled presentations={presentations} now={now} />);
    await expect.element(screen.getByText("41%", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("used", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /41% used.*40% of the window elapsed/ }))
      .toBeVisible();
  });
});
