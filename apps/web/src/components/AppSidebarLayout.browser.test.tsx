import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  ]);
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
// The thread list needs live environments; the shortcut lives in the shell around it.
vi.mock(import("./Sidebar"), () => ({ default: (() => null) as never }));

import { useLocation } from "@tanstack/react-router";
import { AppRouteModal } from "./AppRouteModal";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { isAppModalPage } from "./sidebar/mainAppLocation";
import { AppSidebarLayout } from "./AppSidebarLayout";

describe("sidebar toggle shortcut", () => {
  it("leaves the key to a focused terminal when its rule excludes terminalFocus", async () => {
    await page.viewport(1280, 800);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    await using screen = await render(
      <AppSidebarLayout>
        <div data-terminal-owner="drawer">
          <textarea aria-label="Terminal input" />
        </div>
        <button type="button">Outside</button>
      </AppSidebarLayout>,
    );
    const wrapper = screen.container.querySelector('[data-slot="sidebar-wrapper"]')!;

    await userEvent.click(screen.getByRole("textbox", { name: "Terminal input" }));
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(wrapper.getAttribute("data-sidebar-state")).toBe("expanded");

    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await userEvent.keyboard("{Control>}b{/Control}");
    await vi.waitFor(() => expect(wrapper.getAttribute("data-sidebar-state")).toBe("collapsed"));
  });

  it("ignores Mod+B while a modal route or dialog is open", async () => {
    await page.viewport(1280, 800);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const storageKey = "chat_thread_sidebar_open";
    const previous = localStorage.getItem(storageKey);
    localStorage.removeItem(storageKey);
    using _storage = {
      [Symbol.dispose]: () => {
        if (previous === null) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, previous);
      },
    };
    function RouteFrame() {
      const path = useLocation({ select: (location) => location.pathname });
      return (
        <AppSidebarLayout>
          <SidebarInset>
            <button type="button">Outside</button>
            {path === "/" ? (
              <Dialog defaultOpen>
                <DialogPopup>
                  <DialogTitle>Confirm action</DialogTitle>
                </DialogPopup>
              </Dialog>
            ) : null}
          </SidebarInset>
          {isAppModalPage(path) ? (
            <AppRouteModal label={path === "/usage" ? "Usage" : "Settings"}>
              <button type="button">Inside modal</button>
            </AppRouteModal>
          ) : null}
        </AppSidebarLayout>
      );
    }
    await using screen = await render(<RouteFrame />, { router: "/pull-requests" });
    const wrapper = screen.container.querySelector('[data-slot="sidebar-wrapper"]')!;
    expect(wrapper.getAttribute("data-sidebar-state")).toBe("expanded");

    for (const modalPath of ["/settings/general", "/usage", "/"]) {
      await screen.router!.navigate({ href: modalPath });
      await expect.element(page.getByRole("dialog")).toBeVisible();
      await userEvent.keyboard("{Control>}b{/Control}");
      expect(wrapper.getAttribute("data-sidebar-state")).toBe("expanded");
    }

    await screen.router!.navigate({ href: "/pull-requests" });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    await userEvent.keyboard("{Control>}b{/Control}");
    await vi.waitFor(() => expect(wrapper.getAttribute("data-sidebar-state")).toBe("collapsed"));
  });
});

it("keeps the workspace sidebar action usable on Pull requests and renders Settings as a modal over the sidebar", async () => {
  await page.viewport(1280, 800);
  function RouteFrame() {
    const path = useLocation({ select: (location) => location.pathname });
    return (
      <AppSidebarLayout>
        <SidebarInset>
          <WorkspacePageHeader>Pull requests</WorkspacePageHeader>
        </SidebarInset>
        {path.startsWith("/settings") ? (
          <AppRouteModal label="Settings">
            <input aria-label="Setting" />
          </AppRouteModal>
        ) : null}
      </AppSidebarLayout>
    );
  }
  await using screen = await render(<RouteFrame />, { router: "/pull-requests" });
  const toggle = screen.getByRole("button", { name: "Toggle main sidebar" });
  const wrapper = screen.container.querySelector('[data-slot="sidebar-wrapper"]')!;
  const initial = wrapper.getAttribute("data-sidebar-state");
  expect(isAppModalPage("/pull-requests")).toBe(false);
  await userEvent.click(toggle);
  await vi.waitFor(() => expect(wrapper.getAttribute("data-sidebar-state")).not.toBe(initial));
  expect(document.querySelector("[data-app-modal]")).toBeNull();

  for (const path of ["/settings/general", "/settings/appearance"]) {
    expect(isAppModalPage(path)).toBe(true);
    await screen.router!.navigate({ to: path });
    await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect(document.querySelector("[data-app-modal]")).not.toBeNull();
    expect(screen.container.querySelector("[data-app-sidebar]")).not.toBeNull();
  }
});
