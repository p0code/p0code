import type { ReactNode } from "react";
import { EnvironmentId, type PluginManifest, type PluginsInstalledList } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({
  data: {
    snapshot: { plugins: [] },
    installations: [],
    stagedManifests: [],
  } as typeof PluginsInstalledList.Type,
  commands: {} as Record<string, ReturnType<typeof vi.fn>>,
  pickFolder: vi.fn(async () => "/fixture/dist"),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: state.data, refresh: vi.fn() }),
}));
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    serverEnvironment: Object.fromEntries(
      [
        "pluginsInstalledList",
        "pluginsInstall",
        "pluginsConsent",
        "pluginsUpdate",
        "pluginsRollback",
        "pluginsRemove",
        "pluginsSetEnabled",
      ].map((name) => [
        name,
        name === "pluginsInstalledList" ? () => undefined : { name, permissionAtom: () => allowed },
      ]),
    ),
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { name: string }) => state.commands[command.name],
}));
vi.mock("../../localApi", () => ({
  readLocalApi: () => ({ dialogs: { pickFolder: state.pickFolder } }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    title,
    children,
    headerAction,
  }: {
    title: string;
    children: ReactNode;
    headerAction: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
}));
import { PluginInstaller } from "./PluginInstaller";

const manifest: PluginManifest = {
  id: "fixture",
  version: "2.0.0",
  name: "Fixture",
  description: "Test plugin",
  capabilities: ["network:outbound"],
  externalServices: ["example.com"],
  unofficial: true,
  httpRoutes: [],
};
function stage() {
  const record = {
    id: "fixture",
    activeVersion: "1.0.0",
    previousVersion: "0.9.0",
    stagedVersion: "2.0.0",
    removedDataAt: null,
    versions: [
      {
        version: "2.0.0",
        source: { kind: "github" as const, url: "owner/repo" },
        consented: false,
        consentedCapabilities: [],
        installedAt: "2026-01-01T00:00:00Z",
        bundleSha256: "0".repeat(64),
      },
    ],
  };
  state.data = { ...state.data, installations: [record], stagedManifests: [manifest] };
  return { _tag: "Success", value: { record, manifest, restartRequired: false } };
}
function reset() {
  state.data = { snapshot: { plugins: [] }, installations: [], stagedManifests: [] };
  state.commands = {
    pluginsInstall: vi.fn(async () => stage()),
    pluginsUpdate: vi.fn(async () => stage()),
    pluginsConsent: vi.fn(async () => {
      const result = stage();
      const record = { ...result.value.record, activeVersion: "2.0.0", stagedVersion: null };
      state.data = { ...state.data, installations: [record], stagedManifests: [] };
      return { ...result, value: { ...result.value, record } };
    }),
    pluginsRollback: vi.fn(async () => ({
      ...stage(),
      value: { ...stage().value, record: { ...stage().value.record, stagedVersion: null } },
    })),
    pluginsRemove: vi.fn(async () => ({
      ...stage(),
      value: { ...stage().value, record: { ...stage().value.record, stagedVersion: null } },
    })),
  };
}
it("stages a URL install, preserves pending consent and activates only after explicit confirmation", async () => {
  reset();
  await using screen = await render(
    <PluginInstaller environmentId={EnvironmentId.make("local")} />,
  );
  await screen.getByRole("button", { name: "Add plugin", exact: true }).click();
  await screen.getByRole("textbox", { name: "GitHub URL" }).fill("owner/repo@v2");
  await screen.getByRole("button", { name: "Install", exact: true }).click();
  await expect
    .element(screen.getByRole("heading", { name: "Review plugin capabilities" }))
    .toBeVisible();
  expect(state.commands.pluginsConsent).not.toHaveBeenCalled();
  await expect
    .element(screen.getByText("Can connect to external services and send data from the server."))
    .toBeVisible();
  await screen.getByRole("button", { name: "Keep staged" }).click();
  await expect.element(screen.getByText(/is staged and waiting for consent/)).toBeVisible();
  await screen.getByRole("button", { name: "Review and activate" }).click();
  await screen.getByRole("button", { name: "Confirm and activate" }).click();
  expect(state.commands.pluginsConsent).toHaveBeenCalledWith({
    environmentId: "local",
    input: { id: "fixture", version: "2.0.0", capabilities: ["network:outbound"] },
  });
});
it("keeps invalid URLs and checksum failures out of the consent flow", async () => {
  reset();
  await using screen = await render(
    <PluginInstaller environmentId={EnvironmentId.make("local")} />,
  );
  await screen.getByRole("button", { name: "Add plugin", exact: true }).click();
  await screen.getByRole("textbox", { name: "GitHub URL" }).fill("bad URL");
  await screen.getByRole("button", { name: "Install", exact: true }).click();
  expect(state.commands.pluginsInstall).not.toHaveBeenCalled();
  state.commands.pluginsInstall!.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("Checksum mismatch")),
  });
  await screen.getByRole("textbox", { name: "GitHub URL" }).fill("owner/repo");
  await screen.getByRole("button", { name: "Install", exact: true }).click();
  await expect.element(screen.getByRole("dialog").getByText(/Checksum mismatch/)).toBeVisible();
  expect(state.commands.pluginsConsent).not.toHaveBeenCalled();
});
it("uploads a local pair to the selected environment without activating it", async () => {
  reset();
  await using screen = await render(
    <PluginInstaller environmentId={EnvironmentId.make("remote")} />,
  );
  await screen.getByRole("button", { name: "Add plugin", exact: true }).click();
  await screen.getByRole("button", { name: "Local folder or file" }).click();
  const input = screen.getByLabelText("Plugin files").element() as HTMLInputElement;
  const transfer = new DataTransfer();
  transfer.items.add(new File([JSON.stringify(manifest)], "manifest.json"));
  transfer.items.add(new File(["export default {}"], "plugin.mjs"));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect
    .element(screen.getByRole("heading", { name: "Review plugin capabilities" }))
    .toBeVisible();
  expect(state.commands.pluginsInstall).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId: "remote",
      input: expect.objectContaining({ upload: expect.objectContaining({ name: "plugin.zip" }) }),
    }),
  );
  expect(state.commands.pluginsConsent).not.toHaveBeenCalled();
});
it("updates and rolls back installed versions and requires a separate purge choice for removal", async () => {
  reset();
  stage();
  await using screen = await render(
    <PluginInstaller environmentId={EnvironmentId.make("local")} />,
  );
  await screen.getByRole("button", { name: "Update", exact: true }).click();
  await screen.getByRole("textbox", { name: "GitHub URL" }).fill("owner/repo@v2");
  await screen.getByRole("button", { name: "Update", exact: true }).click();
  expect(state.commands.pluginsUpdate).toHaveBeenCalledWith({
    environmentId: "local",
    input: { id: "fixture", source: "owner/repo@v2" },
  });
  await screen.getByRole("button", { name: "Keep staged" }).click();
  await screen.getByRole("button", { name: "Roll back" }).click();
  expect(state.commands.pluginsRollback).toHaveBeenCalledWith({
    environmentId: "local",
    input: { id: "fixture" },
  });
  await screen.getByRole("button", { name: "Remove", exact: true }).click();
  expect(state.commands.pluginsRemove).not.toHaveBeenCalled();
  await screen.getByRole("checkbox").click();
  await screen.getByRole("dialog").getByRole("button", { name: "Remove", exact: true }).click();
  expect(state.commands.pluginsRemove).toHaveBeenCalledWith({
    environmentId: "local",
    input: { id: "fixture", purgeData: true },
  });
});

it("routes the native folder picker to the selected desktop backend", async () => {
  reset();
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  using _bridge = {
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
  await using screen = await render(
    <PluginInstaller environmentId={EnvironmentId.make("local")} nativeTarget="wsl:Ubuntu" />,
  );
  await screen.getByRole("button", { name: "Add plugin", exact: true }).click();
  await screen.getByRole("button", { name: "Local folder or file" }).click();
  await screen.getByRole("button", { name: "Choose folder" }).click();
  expect(state.pickFolder).toHaveBeenCalledWith({ targetEnvironmentId: "wsl:Ubuntu" });
  expect(state.commands.pluginsInstall).toHaveBeenCalledWith({
    environmentId: "local",
    input: { source: "/fixture/dist" },
  });
  expect(state.commands.pluginsConsent).not.toHaveBeenCalled();
});
