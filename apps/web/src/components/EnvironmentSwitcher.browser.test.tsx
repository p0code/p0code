import { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "../index.css";
import { render } from "../../test/render";
import { EnvironmentSwitcherMenu } from "./EnvironmentSwitcher";
import type { EnvironmentSwitcherItem } from "./EnvironmentSwitcher.logic";

vi.mock("../hooks/useEnvironmentSwitcher", () => ({
  useEnvironmentSwitcher: () => ({ items: [], environments: [], onEnvironmentChange: undefined }),
}));
vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  return { primaryServerKeybindingsAtom: Atom.make(DEFAULT_RESOLVED_KEYBINDINGS) };
});

it("opens with the keyboard, exposes full machine names and switches without selecting offline machines", async () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const onChange = vi.fn();
  const onManage = vi.fn();
  const onAdd = vi.fn();
  const items: EnvironmentSwitcherItem[] = [
    {
      environmentId: local,
      label: "Howard's Macbook Pro M4 (local machine)",
      machine: "laptop",
      status: "online",
      detail: "Connected",
      current: true,
      remote: false,
      disabled: false,
    },
    {
      environmentId: remote,
      label: "Production server",
      machine: "server",
      status: "online",
      detail: "Connected",
      current: false,
      remote: true,
      disabled: false,
    },
    {
      environmentId: EnvironmentId.make("offline"),
      label: "Expired server",
      machine: "server",
      status: "offline",
      detail: "Link credential expired",
      current: false,
      remote: true,
      disabled: true,
    },
  ];
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <div className="w-64">
        <EnvironmentSwitcherMenu
          items={items}
          open={open}
          onOpenChange={setOpen}
          onEnvironmentChange={onChange}
          onManage={onManage}
          onAdd={onAdd}
        />
      </div>
    );
  }
  await using screen = await render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Switch environment" });
  await trigger.click();
  await expect
    .element(page.getByRole("menuitem", { name: /Howard's Macbook Pro M4 \(local machine\)/ }))
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(page.getByRole("menuitem", { name: /Expired server/ }))
    .toHaveAttribute("aria-disabled", "true");
  await expect.element(page.getByText("Remote · Link credential expired")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await page.getByRole("menuitem", { name: /Production server/ }).click();
  expect(onChange).toHaveBeenCalledExactlyOnceWith(remote);
  await trigger.click();
  await page.getByRole("menuitem", { name: "Manage environments…" }).click();
  expect(onManage).toHaveBeenCalledOnce();
  await trigger.click();
  await page.getByRole("menuitem", { name: "Add environment…" }).click();
  expect(onAdd).toHaveBeenCalledOnce();
});

it("opens the global switcher through the configured environment command", async () => {
  const { EnvironmentSwitcher } = await import("./EnvironmentSwitcher");
  const { DEFAULT_RESOLVED_KEYBINDINGS } = await import("@t3tools/shared/keybindings");
  const { shortcutLabelForCommand } = await import("../keybindings");
  const { useEnvironmentSwitcherStore } = await import("../environmentSwitcherStore");
  expect(shortcutLabelForCommand(DEFAULT_RESOLVED_KEYBINDINGS, "environment.switch")).toBeTruthy();
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  useEnvironmentSwitcherStore.setState({ context: null, open: false });
  await using screen = await render(<EnvironmentSwitcher />);
  await userEvent.keyboard("{Control>}{Alt>}e{/Alt}{/Control}");
  await expect.element(page.getByRole("menuitem", { name: "Manage environments…" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("button", { name: "Switch environment" })).toHaveFocus();
});
