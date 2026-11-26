import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useLocation } from "@tanstack/react-router";

import { render } from "../../../test/render";
import { useCommitOnBlur } from "../../hooks/useCommitOnBlur";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingsWorkspace } from "./SettingsWorkspace";

it("commits Settings edits on navigation and lets nested menus handle Escape first", async () => {
  const commit = vi.fn();
  function Settings() {
    const path = useLocation({ select: (location) => location.pathname });
    const field = useCommitOnBlur("", commit);
    return path.startsWith("/settings") ? (
      <SettingsWorkspace breadcrumb="Settings">
        <input aria-label="Instructions" {...field} />
        <Menu>
          <MenuTrigger>Choose</MenuTrigger>
          <MenuPopup>
            <MenuItem>Local</MenuItem>
          </MenuPopup>
        </Menu>
      </SettingsWorkspace>
    ) : null;
  }
  await using screen = await render(<Settings />, { router: "/settings/general" });
  await screen.getByRole("textbox", { name: "Instructions" }).fill("Keep edits");
  await screen.router!.navigate({ href: "/pull-requests" });
  expect(commit).toHaveBeenCalledWith("Keep edits");
  await screen.router!.navigate({ to: "/settings/general" });
  const trigger = screen.getByRole("button", { name: "Choose" });
  await userEvent.click(trigger);
  await expect.element(page.getByRole("menu")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  expect(screen.router!.state.location.pathname).toBe("/settings/general");
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(screen.router!.state.location.pathname).not.toMatch(/^\/settings/));
});
