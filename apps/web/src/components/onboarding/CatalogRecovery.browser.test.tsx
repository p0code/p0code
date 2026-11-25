import { expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import { CatalogRecovery } from "./CatalogRecovery";

it("shows the preserved catalog and lets a returning user open the workspace", async () => {
  const onContinue = vi.fn();
  await using screen = await render(
    <CatalogRecovery
      error={{
        reason: "unreadable",
        message: "Cannot decrypt",
        keptPath: "/home/catalog.unreadable-123",
      }}
      onContinue={onContinue}
    />,
  );
  await expect
    .element(screen.getByRole("heading"))
    .toHaveTextContent("Your saved environments could not be decrypted");
  await expect
    .element(screen.getByText("Preserved copy: /home/catalog.unreadable-123", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Open workspace" }).click();
  expect(onContinue).toHaveBeenCalledOnce();
});

it("offers reconnecting this machine and shows a failed reconnect", async () => {
  const reconnect = vi.fn().mockRejectedValue(new Error("Reconnect failed"));
  using _bridge = stubGlobal("desktopBridge", { setLocalEnvironmentEnabled: reconnect });
  await using screen = await render(
    <CatalogRecovery
      error={{ reason: "unreadable", message: "Cannot decrypt" }}
      onContinue={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Reconnect this machine" }).click();
  expect(reconnect).toHaveBeenCalledWith(true);
  await expect.element(screen.getByText("Reconnect failed", { exact: true })).toBeVisible();
});

it("explains unavailable encryption and offers retry without hiding the workspace", async () => {
  const onContinue = vi.fn();
  await using screen = await render(
    <CatalogRecovery
      error={{ reason: "encryption-unavailable", message: "Unlock keychain" }}
      onContinue={onContinue}
    />,
  );
  await expect
    .element(screen.getByRole("heading"))
    .toHaveTextContent("Secure storage is unavailable");
  await expect.element(screen.getByRole("button", { name: "Retry secure storage" })).toBeVisible();
  await screen.getByRole("button", { name: "Open workspace" }).click();
  expect(onContinue).toHaveBeenCalledOnce();
});
