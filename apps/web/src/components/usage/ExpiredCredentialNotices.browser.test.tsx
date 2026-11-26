import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ExpiredCredentialNotices } from "./ExpiredCredentialNotices";

const state = vi.hoisted(() => ({
  refreshProviders: vi.fn(),
  canManage: true,
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      refreshProviders: { label: "refresh-providers" } as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.refreshProviders) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => state.canManage) as never,
  readEnvironmentScope: (() => state.canManage) as never,
}));

const environmentId = EnvironmentId.make("remote-google");
const instanceId = ProviderInstanceId.make("antigravity_paid");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("antigravity"),
  displayName: "Antigravity Paid",
  enabled: true,
  installed: true,
  version: "test-version",
  status: "warning",
  auth: {
    status: "authenticated",
    type: "oauth-personal",
    label: "Google account",
    email: "paid@example.com",
    credentialStatus: "expired",
    canRenewCredential: true,
  },
  checkedAt: "2026-11-25T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
};

const presentations: LimitPresentations = new Map([
  [
    environmentId,
    {
      entry: { target: { label: "Remote Google device" } },
      serverConfig: { providers: [provider] },
    },
  ],
]);

describe("expired Antigravity account warning", () => {
  it("names the account, links to its settings row, and renews it in one click", async () => {
    state.refreshProviders.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
    await using screen = await render(<ExpiredCredentialNotices presentations={presentations} />);

    await expect.element(screen.getByText(/paid@example\.com/)).toBeVisible();
    const link = screen.getByRole("link", { name: "Open account" });
    await expect
      .element(link)
      .toHaveAttribute(
        "href",
        `/settings/providers?environmentId=${environmentId}&instanceId=${instanceId}`,
      );

    await userEvent.click(screen.getByRole("button", { name: "Re-authenticate" }));
    expect(state.refreshProviders).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, refreshModels: true },
    });
  });

  it("keeps the account visible but explains a full sign-in when a turn cannot renew it", async () => {
    const manual = {
      ...provider,
      auth: { ...provider.auth, canRenewCredential: false },
    };
    const onlyManual: LimitPresentations = new Map([
      [
        environmentId,
        {
          entry: { target: { label: "Remote Google device" } },
          serverConfig: { providers: [manual] },
        },
      ],
    ]);
    await using screen = await render(<ExpiredCredentialNotices presentations={onlyManual} />);
    await expect.element(screen.getByText(/Sign in again in provider settings/)).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Re-authenticate" }))
      .not.toBeInTheDocument();
  });
});
