import { useRouter } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { XIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { getCommandPaletteOpener } from "../../commandPaletteStore";
import { isElectron } from "../../env";
import { useCloseAppModal } from "../sidebar/mainAppLocation";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

/** Settings uses the workspace frame so the main sidebar and its actions stay available. */
export function SettingsWorkspace({
  breadcrumb,
  actions,
  children,
}: {
  breadcrumb: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const gt = useGT();
  const close = useCloseAppModal();
  const router = useRouter();
  const [opener] = useState(
    () =>
      getCommandPaletteOpener() ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );
  const surfaceRef = useRef<HTMLElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the new route without opening a text field or trapping focus away from the sidebar
  useEffect(() => {
    surfaceRef.current?.focus({ preventScroll: true });
  }, []);
  // Navigation must commit a focused field before React unmounts it without a blur.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- commits settings fields before route navigation removes their DOM
  useEffect(
    () =>
      router.subscribe("onBeforeLoad", () => {
        const focused = document.activeElement;
        if (
          focused instanceof HTMLElement &&
          surfaceRef.current?.contains(focused) &&
          focused.matches("input, textarea, [contenteditable]")
        )
          focused.blur();
      }),
    [router],
  );
  return (
    <SidebarInset
      ref={surfaceRef}
      tabIndex={-1}
      className="h-dvh min-h-0 overflow-hidden"
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.repeat ||
          event.nativeEvent.isComposing
        )
          return;
        event.preventDefault();
        void Promise.resolve(close()).then(() => {
          if (opener?.isConnected) opener.focus({ preventScroll: true });
        });
      }}
    >
      <WorkspacePageHeader electron={isElectron} className="border-b">
        {breadcrumb}
        <div className="ms-auto flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
          {actions}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={gt("Close")}
                  onClick={() => void close()}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              <T>Close (Esc)</T>
            </TooltipPopup>
          </Tooltip>
        </div>
      </WorkspacePageHeader>
      {children}
    </SidebarInset>
  );
}
