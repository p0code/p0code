import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  RouterProvider,
  useLocation,
  useNavigate,
  type AnyRouter,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { useShownThreadRouteTarget } from "../../hooks/useShownThreadRouteTarget";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { SharedTooltipProvider } from "../ui/shared-tooltip";
import { SidebarProvider } from "../ui/sidebar";
import { startMainAppLocationTracking } from "../sidebar/mainAppLocation";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { useRenderedSettingsPathname } from "./useRenderedSettingsPathname";

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [
    { id: "theme", title: "Theme", to: "/settings/appearance" },
  ],
  useHasSecretProvidersEnvironment: () => false,
  useHasPluginsEnvironment: () => false,
  useSettingsCatalogUnavailable: () => false,
}));
vi.mock("../chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

const THREAD_PATH = "/env-1/thread-a";

async function settled(router: AnyRouter, navigation: Promise<void>) {
  await navigation;
  await vi.waitFor(() =>
    expect(router.state.resolvedLocation?.href).toBe(router.state.location.href),
  );
}

function createSettingsModalRouter(initialPath: string) {
  const rootRoute = createRootRoute({
    component: function Shell() {
      const { shownTarget, modalOpen } = useShownThreadRouteTarget();
      const navigate = useNavigate();
      return (
        <SharedTooltipProvider>
          <SidebarProvider defaultOpen>
            <aside data-testid="thread-sidebar" aria-label="Threads">
              <button type="button" onClick={() => void navigate({ to: "/settings" })}>
                Open settings
              </button>
            </aside>
            <main
              data-testid="background-thread"
              data-thread-id={
                shownTarget?.kind === "server" ? shownTarget.threadRef.threadId : "none"
              }
              inert={modalOpen}
            >
              <button type="button">Background action</button>
              {shownTarget ? null : modalOpen ? null : <Outlet />}
            </main>
            {modalOpen ? <Outlet /> : null}
          </SidebarProvider>
        </SharedTooltipProvider>
      );
    },
  });

  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <p>Home route</p>,
  });

  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$environmentId/$threadId",
  });

  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings",
    beforeLoad: ({ location }) => {
      if (location.pathname === "/settings") {
        throw redirect({ to: "/settings/general", replace: true });
      }
    },
    component: function SettingsModalLayout() {
      const navPathname = useLocation({ select: (location) => location.pathname });
      const pathname = useRenderedSettingsPathname();
      return (
        <AppRouteModal
          label="Settings"
          popupClassName="sm:max-h-[min(80dvh,60rem)] sm:max-w-[68rem]"
        >
          <div className="relative flex min-h-0 flex-1">
            <SettingsSidebarNav pathname={navPathname} />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <header className="flex h-12 shrink-0 items-center gap-3 border-b ps-5 pe-2">
                <SettingsBreadcrumb pathname={pathname} />
                <div className="ms-auto flex shrink-0 items-center gap-1">
                  <AppRouteModalClose />
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-6">
                <Outlet />
              </div>
            </div>
          </div>
        </AppRouteModal>
      );
    },
  });

  const sections = [
    ["general", "General settings panel"],
    ["appearance", "Appearance settings panel"],
    ["chat", "Chat settings panel"],
    ["maintenance", "Maintenance settings panel"],
    ["diagnostics", "Diagnostics settings panel"],
  ] as const;

  const sectionRoutes = sections.map(([path, heading]) =>
    createRoute({
      getParentRoute: () => settingsRoute,
      path,
      component: () => <h2>{heading}</h2>,
    }),
  );

  return createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      threadRoute,
      settingsRoute.addChildren(sectionRoutes),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("Settings centered dialog", () => {
  it("opens as a centered dialog over the thread and sidebar on desktop and full-screen on small screens", async () => {
    await page.viewport(1440, 900);
    const router = createSettingsModalRouter(THREAD_PATH);
    await router.load();
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "General settings panel" }))
      .toBeVisible();
    expect(router.state.location.pathname).toBe("/settings/general");
    expect(screen.getByTestId("thread-sidebar").element()).toBeInTheDocument();
    expect(screen.getByTestId("background-thread").element().getAttribute("data-thread-id")).toBe(
      "thread-a",
    );

    const desktopRect = dialog.element().getBoundingClientRect();
    expect(desktopRect.width).toBeGreaterThanOrEqual(1000);
    expect(desktopRect.width).toBeLessThanOrEqual(1100);
    expect(desktopRect.height).toBeGreaterThanOrEqual(700);
    expect(desktopRect.height).toBeLessThanOrEqual(740);
    expect(Math.abs(desktopRect.left + desktopRect.width / 2 - 720)).toBeLessThan(2);
    expect(Math.abs(desktopRect.top + desktopRect.height / 2 - 450)).toBeLessThan(2);

    await page.viewport(390, 844);
    await vi.waitFor(() => {
      const mobileRect = dialog.element().getBoundingClientRect();
      expect(mobileRect.width).toBeCloseTo(390, 0);
      expect(mobileRect.height).toBeCloseTo(844, 0);
    });
  });

  it("closes via X button, Esc, and backdrop click while restoring the previous thread", async () => {
    await page.viewport(1440, 900);
    const router = createSettingsModalRouter(THREAD_PATH);
    await router.load();
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await using screen = await render(<RouterProvider router={router} />, { router: false });
    const openButton = screen.getByRole("button", { name: "Open settings" });

    // Close via X button.
    await userEvent.click(openButton);
    await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Close" }));
    await expect.element(page.getByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));

    // Close via Escape and restore focus to opener.
    (openButton.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("dialog", { name: "Settings" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));
    await expect.element(openButton).toHaveFocus();

    // Close via backdrop click.
    await userEvent.click(openButton);
    await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    const viewport = document.querySelector<HTMLElement>("[data-app-modal]")!.parentElement!;
    await act(() => {
      viewport.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      viewport.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expect.element(page.getByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));
  });

  it("traps focus inside the dialog", async () => {
    await page.viewport(1440, 900);
    const router = createSettingsModalRouter(THREAD_PATH);
    await router.load();
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect.element(dialog).toHaveFocus();

    for (let step = 0; step < 4; step += 1) {
      await userEvent.tab();
      expect(dialog.element().contains(document.activeElement)).toBe(true);
    }
    await userEvent.tab({ shift: true });
    expect(dialog.element().contains(document.activeElement)).toBe(true);
  });

  it("opens deep links directly and falls back to the home route when closed without a prior route", async () => {
    await page.viewport(1440, 900);
    const router = createSettingsModalRouter("/settings/appearance");
    await router.load();
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect.element(dialog).toBeVisible();
    await expect
      .element(page.getByRole("heading", { name: "Appearance settings panel" }))
      .toBeVisible();
    expect(router.state.location.pathname).toBe("/settings/appearance");

    await userEvent.click(page.getByRole("button", { name: "Close" }));
    await expect.element(dialog).not.toBeInTheDocument();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    await expect.element(screen.getByText("Home route")).toBeVisible();
  });

  it("keeps deep links, section switching, and browser back working over the last non-settings route", async () => {
    await page.viewport(1440, 900);
    const router = createSettingsModalRouter(THREAD_PATH);
    await router.load();
    using _tracking = { [Symbol.dispose]: startMainAppLocationTracking(router) };
    await using _screen = await render(<RouterProvider router={router} />, { router: false });

    // Deep link to a specific section from a thread.
    await settled(router, router.navigate({ to: "/settings/appearance" }));
    await expect
      .element(page.getByRole("heading", { name: "Appearance settings panel" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("navigation", { name: "Settings breadcrumb" }))
      .toHaveTextContent("Settings/Appearance");

    // Switching sections in the left nav updates the URL with replace semantics.
    await userEvent.click(page.getByRole("button", { name: "Chat" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/chat"));
    await expect.element(page.getByRole("heading", { name: "Chat settings panel" })).toBeVisible();

    // Browser Back returns directly to the thread.
    router.history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));
    await expect.element(page.getByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();

    // Pushed nested route inside Settings lets Back step to the previous section, while X closes to the thread.
    await settled(router, router.navigate({ to: "/settings/maintenance" }));
    await settled(router, router.navigate({ to: "/settings/diagnostics" }));
    await expect
      .element(page.getByRole("heading", { name: "Diagnostics settings panel" }))
      .toBeVisible();
    router.history.back();
    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/settings/maintenance"));
    await expect
      .element(page.getByRole("heading", { name: "Maintenance settings panel" }))
      .toBeVisible();
    await settled(router, router.navigate({ to: "/settings/diagnostics" }));
    await userEvent.click(page.getByRole("button", { name: "Close" }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe(THREAD_PATH));
  });
});
