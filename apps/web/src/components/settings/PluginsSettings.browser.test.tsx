import type { ReactNode } from "react";
import { EnvironmentId, type PluginInfo } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({ plugins: [] as PluginInfo[], setEnabled: vi.fn() }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { plugins: state.plugins } }),
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    serverEnvironment: {
      plugins: () => undefined,
      pluginsSetEnabled: { permissionAtom: () => allowed },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.setEnabled,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    environment: {
      environmentId: "local",
      connection: { phase: "connected" },
      serverConfig: { environment: { capabilities: { plugins: true } } },
    },
  }),
}));
vi.mock("./BackupPanel", () => ({ BackupDisclosure: () => null, BackupPanel: () => null }));
vi.mock("./ObsidianSharedMemoryPanel", () => ({
  ObsidianSharedMemoryDisclosure: () => null,
  ObsidianSharedMemoryPanel: () => null,
}));
vi.mock("./T3ConnectBridgePanel", () => ({
  T3ConnectBridgeDisclosure: () => null,
  T3ConnectBridgePanel: () => null,
}));

vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
}));

import { PluginsSettingsPanel } from "./PluginsSettings";

it("shows host disclosures for disabled plugins before allowing enable", async () => {
  state.setEnabled = vi.fn();
  state.plugins = [
    {
      manifest: {
        id: "test-reader",
        name: "Test reader",
        description: "This plugin claims it cannot read anything.",
        version: "1.0.0",
        unofficial: false,
        externalServices: [],
        httpRoutes: [],
        capabilities: [
          "usage:read",
          "data:backup",
          "orchestration:read-activity",
          "auth:issue-device-credentials",
          "process:spawn",
          "network:outbound",
          "http:routes",
          "agent:instructions",
        ],
      },
      origin: "bundled",
      enabled: false,
      state: "disabled",
      message: null,
    },
  ];
  await using screen = await render(<PluginsSettingsPanel />);
  await expect
    .element(
      screen.getByText(
        "Can read your token and cost totals for every agent, one row per day, provider and model. Never prompts, paths or titles.",
      ),
    )
    .toBeVisible();
  await expect
    .element(
      screen.getByText(
        "Can read a copy of all your chats, attachments and settings, and propose replacing them with a backup.",
      ),
    )
    .toBeVisible();
  await expect
    .element(screen.getByText("Can pair devices that stay signed in until you disable the plugin."))
    .toBeVisible();
  expect(screen.getByRole("listitem").elements()).toHaveLength(8);
  const toggle = screen.getByRole("switch", { name: "Test reader" });
  await expect.element(toggle).not.toBeChecked();
  expect(state.setEnabled).not.toHaveBeenCalled();
  await toggle.click();
  expect(state.setEnabled).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("local"),
    input: { pluginId: "test-reader", enabled: true },
  });
});
