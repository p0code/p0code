import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
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

describe("UsageLimitsPooled Antigravity attribution", () => {
  function antigravity(
    instanceId: string,
    displayName: string,
    windows: ServerProviderUsageLimits["windows"],
  ): ServerProvider {
    return {
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("antigravity"),
      displayName,
      enabled: true,
      installed: true,
      version: "0.1.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt,
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: { checkedAt, windows },
    };
  }
  const rolling = {
    id: "gemini-5h",
    label: "Gemini · 5-hour",
    kind: "session" as const,
    usedPercent: 0,
    windowDurationMins: 300,
  };
  const weekly = {
    id: "gemini-weekly",
    label: "Gemini · Weekly",
    kind: "weekly" as const,
    usedPercent: 20,
    windowDurationMins: 7 * 24 * 60,
  };
  const modelRows = [
    "Gemini 3.8 Flash (High)",
    "Gemini 3.8 Flash (Low)",
    "Gemini 3.8 Flash (Medium)",
    "Claude Opus 4.6 (Thinking)",
    "GPT-OSS 120B (Medium)",
  ].map((name) => ({
    id: name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
    label: `All Models · ${name}`,
    kind: "other" as const,
    usedPercent: 0,
    resetsAt: "2026-10-25T21:00:00.000Z",
  }));

  it("renders one row per reported window and no per-model rows", async () => {
    const paid = antigravity("antigravity_paid", "Antigravity Paid", [
      {
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "3p-weekly",
        label: "Claude & GPT (shared) · Weekly",
        kind: "weekly",
        usedPercent: 0,
        windowDurationMins: 7 * 24 * 60,
      },
      rolling,
      weekly,
      ...modelRows,
    ]);
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        { entry: { target: { label: "Desk" } }, serverConfig: { providers: [paid] } },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );
    await expect.element(screen.getByText("Claude & GPT (shared) · 5-hour")).toBeVisible();
    await expect.element(screen.getByText("Gemini · Weekly")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Gemini 3.8 Flash");
    expect(
      screen.container.querySelectorAll('button[aria-label^="Antigravity Paid: "]'),
    ).toHaveLength(4);
  });

  it("shows an account only in the shared window it reported", async () => {
    const paid = antigravity("antigravity_paid", "Antigravity Paid", [
      {
        id: "3p-5h",
        label: "Claude & GPT (shared) · 5-hour",
        kind: "session",
        usedPercent: 60,
        windowDurationMins: 300,
      },
      rolling,
      weekly,
    ]);
    const trial = antigravity("antigravity_trial", "Antigravity Trial", [rolling, weekly]);
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: { providers: [paid, trial] },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );
    await expect.element(screen.getByText("Claude & GPT (shared) · 5-hour")).toBeVisible();
    expect(
      screen.container.querySelectorAll('button[aria-label^="Antigravity Trial: "]'),
    ).toHaveLength(2);
    expect(
      screen.container.querySelectorAll('button[aria-label^="Antigravity Paid: "]'),
    ).toHaveLength(3);
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
