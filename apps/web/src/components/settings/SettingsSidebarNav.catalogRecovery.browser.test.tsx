import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
  useHasSecretProvidersEnvironment: () => false,
  useHasPluginsEnvironment: () => false,
  useSettingsCatalogUnavailable: () => true,
}));

it("keeps Plugins, Deploy and Secrets in the nav, disabled, with the reason", async () => {
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );

  for (const name of ["Secrets", "Plugins", "Deploy"]) {
    const row = page.getByRole("button", { name: new RegExp(name) }).first();
    await expect.element(row).toBeVisible();
    await expect.element(row).toBeDisabled();
  }
  const reasons = page.getByText("unavailable: saved connections did not load");
  expect(reasons.elements()).toHaveLength(3);
  await expect.element(reasons.first()).toBeVisible();
});
