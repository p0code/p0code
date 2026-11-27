import { EnvironmentId } from "@t3tools/contracts";
import { type BridgeStatus, T3_CONNECT_BRIDGE_ID } from "@t3tools/plugin-t3-connect-bridge/actions";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { useT3ConnectBridgeHostedAppUrl } from "./useT3ConnectBridgeHostedAppUrl";

type PluginSnapshot = {
  readonly manifest: { readonly id: string };
  readonly enabled: boolean;
  readonly state: string;
  readonly message: string | null;
};

const harness = vi.hoisted(() => ({
  canManagePlugins: true,
  dataUpdatedAt: 1,
  plugins: [] as ReadonlyArray<PluginSnapshot>,
  status: null as BridgeStatus | null,
  fail: false,
  calls: 0,
  pluginSubscribes: 0,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => harness.canManagePlugins,
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data: atom === null ? null : { plugins: harness.plugins },
    dataUpdatedAt: harness.dataUpdatedAt,
  })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      plugins: (() => {
        harness.pluginSubscribes += 1;
        return "plugins-atom";
      }) as never,
      pluginsInvoke: null as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => {
  // Stable identity: the hook keeps the command in its effect dependencies.
  const invoke = async () => {
    harness.calls += 1;
    return harness.fail
      ? { _tag: "Failure" as const }
      : { _tag: "Success" as const, value: harness.status };
  };
  return {
    ...(await original()),
    useAtomCommand: (() => invoke) as never,
  };
});

const environmentId = EnvironmentId.make("environment-bridge");

const status = (hostedAppUrl: string): BridgeStatus => ({
  account: "howard",
  signedIn: true,
  pendingSignIn: null,
  linked: true,
  tunnel: "connected",
  hostname: "relay.example.com",
  error: null,
  config: {
    relayUrl: "https://relay.t3.codes",
    clerkPublishableKey: "pk_test",
    cliOAuthClientId: "client",
    hostedAppUrl,
    pushNotifications: true,
  },
});

const snapshot = (enabled: boolean): ReadonlyArray<PluginSnapshot> => [
  {
    manifest: { id: T3_CONNECT_BRIDGE_ID },
    enabled,
    state: enabled ? "running" : "disabled",
    message: enabled ? "Linked" : null,
  },
];

function Probe() {
  const hostedAppUrl = useT3ConnectBridgeHostedAppUrl(environmentId);
  return <output data-testid="hosted-app-url">{hostedAppUrl ?? "none"}</output>;
}

async function mount() {
  const screen = await render(<Probe />);
  const output = screen.getByTestId("hosted-app-url");
  return {
    screen,
    expectUrl: (value: string) => expect.element(output).toHaveTextContent(value),
    async push(next: { enabled?: boolean; updatedAt: number }) {
      harness.plugins = snapshot(next.enabled ?? false);
      harness.dataUpdatedAt = next.updatedAt;
      await screen.rerender(<Probe />);
    },
    async [Symbol.asyncDispose]() {
      await screen[Symbol.asyncDispose]();
    },
  };
}

it("follows the bridge from disabled to enabled and back", async () => {
  harness.plugins = snapshot(false);
  harness.status = status("https://app.example.com");
  harness.dataUpdatedAt = 1;
  await using probe = await mount();

  await probe.expectUrl("none");
  await probe.push({ enabled: true, updatedAt: 2 });
  await probe.expectUrl("https://app.example.com");
  await probe.push({ enabled: false, updatedAt: 3 });
  await probe.expectUrl("none");
});

it("refreshes when the running bridge's config changes", async () => {
  harness.plugins = snapshot(true);
  harness.status = status("https://old.example.com");
  harness.dataUpdatedAt = 1;
  await using probe = await mount();
  await probe.expectUrl("https://old.example.com");

  // A config edit republishes the plugin snapshot even though the plugin keeps running.
  harness.status = status("https://new.example.com");
  harness.dataUpdatedAt = 2;
  await probe.screen.rerender(<Probe />);
  await probe.expectUrl("https://new.example.com");
});

it("clears on a failed tunnel, a bridge error, and a failed status call", async () => {
  harness.plugins = snapshot(true);
  harness.status = status("https://app.example.com");
  harness.dataUpdatedAt = 1;
  await using probe = await mount();
  await probe.expectUrl("https://app.example.com");

  harness.status = { ...status("https://app.example.com"), tunnel: "failed" };
  harness.dataUpdatedAt = 2;
  await probe.screen.rerender(<Probe />);
  await probe.expectUrl("none");

  harness.status = { ...status("https://app.example.com"), error: "The relay rejected this link." };
  harness.dataUpdatedAt = 3;
  await probe.screen.rerender(<Probe />);
  await probe.expectUrl("none");

  harness.status = status("https://app.example.com");
  harness.fail = true;
  harness.dataUpdatedAt = 4;
  await probe.screen.rerender(<Probe />);
  await probe.expectUrl("none");
});

it("skips plugin subscriptions and status calls without plugins:manage", async () => {
  harness.canManagePlugins = false;
  harness.fail = false;
  harness.calls = 0;
  harness.pluginSubscribes = 0;
  harness.plugins = snapshot(true);
  harness.status = status("https://app.example.com");
  harness.dataUpdatedAt = 1;
  await using probe = await mount();

  await probe.expectUrl("none");
  expect(harness.pluginSubscribes).toBe(0);
  expect(harness.calls).toBe(0);
  harness.canManagePlugins = true;
});
