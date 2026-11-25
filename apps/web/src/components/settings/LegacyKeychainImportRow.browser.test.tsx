import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({
  run: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../../state/server", async (original) => ({
  ...(await original()),
  serverEnvironment: { importLegacyKeychain: {} },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.run,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: (...args: Array<unknown>) => state.toast(...args),
    },
  };
});

import { LegacyKeychainImportRow } from "./LegacyKeychainImportRow";

const environmentId = EnvironmentId.make("env-a");

it("waits for confirmation and then reports the import counts", async () => {
  state.run = vi.fn().mockResolvedValue({
    _tag: "Success",
    value: { moved: 2, alreadyPresent: 1, leftBehind: 1, failed: 0 },
  });
  state.toast = vi.fn();
  await using screen = await render(<LegacyKeychainImportRow environmentId={environmentId} />);

  await screen.getByRole("button", { name: "Import…" }).click();

  expect(state.run).not.toHaveBeenCalled();
  await expect
    .element(page.getByText("macOS will ask for permission for each old keychain item."))
    .toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "Import", exact: true }));

  expect(state.run).toHaveBeenCalledWith({ environmentId, input: {} });
  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Old keychain items imported",
        description: "2 moved, 1 already present, 1 left behind.",
      }),
    ),
  );
});

it("says nothing to import when the old service is empty", async () => {
  state.run = vi.fn().mockResolvedValue({
    _tag: "Success",
    value: { moved: 0, alreadyPresent: 0, leftBehind: 0, failed: 0 },
  });
  state.toast = vi.fn();
  await using screen = await render(<LegacyKeychainImportRow environmentId={environmentId} />);

  await screen.getByRole("button", { name: "Import…" }).click();
  await userEvent.click(page.getByRole("button", { name: "Import", exact: true }));

  await vi.waitFor(() =>
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Nothing to import",
        description: "No old keychain items were found.",
      }),
    ),
  );
});
