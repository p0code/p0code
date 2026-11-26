import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useEnvironmentSwitcherStore } from "../environmentSwitcherStore";
import { useEnvironmentSwitcher } from "../hooks/useEnvironmentSwitcher";
import { shortcutLabelForCommand } from "../keybindings";
import { registerCommands } from "../shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "../state/server";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import type { EnvironmentSwitcherItem } from "./EnvironmentSwitcher.logic";
import { environmentShortLabel } from "./environmentLabel";
import { AddEnvironmentDialog } from "./settings/AddEnvironmentDialog";
import { Button } from "./ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "./ui/menu";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

function StatusDot({ status }: { status: EnvironmentSwitcherItem["status"] }) {
  return (
    <span
      aria-hidden="true"
      className={`size-1.5 shrink-0 rounded-full ${status === "online" ? "bg-success" : status === "connecting" ? "bg-warning" : "bg-muted-foreground/50"}`}
    />
  );
}

export function EnvironmentSwitcherMenu({
  items,
  open,
  onOpenChange,
  onEnvironmentChange,
  onManage,
  onAdd,
  shortcut,
}: {
  readonly items: readonly EnvironmentSwitcherItem[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onEnvironmentChange: ((id: EnvironmentId) => void) | undefined;
  readonly onManage: () => void;
  readonly onAdd: () => void;
  readonly shortcut?: string | undefined;
}) {
  const gt = useGT();
  const current = items.find((item) => item.current);
  const label = current?.label ?? gt("Environments");
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-0 flex-1 justify-start [-webkit-app-region:no-drag]"
                />
              }
              aria-label={gt("Switch environment")}
            >
              <EnvironmentMachineIcon
                kind={current?.machine ?? "server"}
                className="size-3.5 shrink-0"
              />
              {current ? <StatusDot status={current.status} /> : null}
              <span className="min-w-0 flex-1 truncate text-left text-xs">
                {environmentShortLabel(label)}
              </span>
              <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground" />
            </MenuTrigger>
          }
        />
        <TooltipPopup>
          {label}
          {current ? ` · ${current.detail}` : ""}
          {shortcut ? ` · ${shortcut}` : ""}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" width="content">
        {items.map((item) => (
          <MenuItem
            key={item.environmentId}
            disabled={item.disabled}
            aria-current={item.current ? "true" : undefined}
            onClick={() => {
              if (!item.disabled && !item.current) onEnvironmentChange?.(item.environmentId);
            }}
          >
            <EnvironmentMachineIcon kind={item.machine} className="size-4 shrink-0" />
            <StatusDot status={item.status} />
            <span className="min-w-0 max-w-80 whitespace-normal break-words">
              <span className="block">{item.label}</span>
              <span className="block text-xs text-muted-foreground">
                {item.remote ? gt("Remote · {status}", { status: item.detail }) : item.detail}
              </span>
            </span>
            {item.current ? (
              <CheckIcon
                aria-label={gt("Current environment")}
                className="ml-auto size-4 shrink-0"
              />
            ) : null}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={onManage}>
          <T>Manage environments…</T>
        </MenuItem>
        <MenuItem onClick={onAdd}>
          <T>Add environment…</T>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function EnvironmentSwitcher() {
  const { items, environments, onEnvironmentChange } = useEnvironmentSwitcher();
  const open = useEnvironmentSwitcherStore((state) => state.open);
  const [addOpen, setAddOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const shortcut = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "environment.switch",
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- register the switcher keyboard command while the sidebar is mounted
  useEffect(
    () =>
      registerCommands({
        "environment.switch": (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!event.repeat) useEnvironmentSwitcherStore.setState({ open: true });
        },
      }),
    [],
  );
  return (
    <>
      <EnvironmentSwitcherMenu
        items={items}
        open={open}
        onOpenChange={(open) => useEnvironmentSwitcherStore.setState({ open })}
        onEnvironmentChange={onEnvironmentChange}
        shortcut={shortcut ?? undefined}
        onManage={() => {
          void navigate({ to: "/settings/connections" });
        }}
        onAdd={() => setAddOpen(true)}
      />
      {addOpen ? (
        <AddEnvironmentDialog
          open
          showTrigger={false}
          routeTarget={null}
          error={error}
          savedEnvironments={environments}
          onOpenChange={(open) => {
            setAddOpen(open);
            setError(null);
          }}
          onErrorChange={setError}
        />
      ) : null}
    </>
  );
}
