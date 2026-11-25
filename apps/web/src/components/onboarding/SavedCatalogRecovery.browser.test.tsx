import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { SavedCatalogRecovery } from "./SavedCatalogRecovery";

const error = {
  detail: "Could not decode the local connection catalog.",
  preservedKey: "catalog:unreadable:1712",
};

it("shows the saved environments error, the kept copy, and the two ways out", async () => {
  await using screen = await render(<SavedCatalogRecovery error={error} />, { router: "/" });

  await expect
    .element(page.getByRole("heading", { name: "Your saved environments could not be read" }))
    .toBeVisible();
  await expect.element(page.getByText("A copy was kept at catalog:unreadable:1712.")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Retry" })).toBeVisible();
  const reconnect = page.getByRole("button", { name: "Reconnect this machine" });
  await expect.element(reconnect).toBeVisible();

  await userEvent.click(reconnect);
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/settings/connections"),
  );
});

it("says the saved list was left alone when no copy path is known", async () => {
  await using _screen = await render(
    <SavedCatalogRecovery error={{ ...error, preservedKey: null }} />,
    { router: "/" },
  );

  await expect.element(page.getByText("The saved list was left where it was.")).toBeVisible();
});
