import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { FirstRunGate } from "./FirstRunGate";

vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    catalogError: {
      detail: "Could not decode the local connection catalog.",
      preservedKey: "catalog:unreadable:1",
    },
    networkStatus: "online",
    environments: [],
    presentationById: new Map(),
  }),
}));

it("renders the saved-catalog recovery surface instead of the app shell", async () => {
  await using _screen = await render(
    <FirstRunGate enabled hostedStatic={false}>
      <div>App shell</div>
    </FirstRunGate>,
    { router: "/" },
  );

  await expect
    .element(page.getByRole("heading", { name: "Your saved environments could not be read" }))
    .toBeVisible();
  await expect.element(page.getByText("A copy was kept at catalog:unreadable:1.")).toBeVisible();
  expect(page.getByText("App shell").query()).toBeNull();
});
