import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  type AccountProfile,
  AccountProfileId,
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  isListedProfileAccount,
  listedProfileDrivers,
  moveProfileInstance,
  newAccountProfile,
  orderInstancesForDriver,
  setProfileEnvironmentLinked,
} from "@t3tools/shared/accountProfiles";
import { exhaustedUsageWindow } from "@t3tools/shared/usageLimits";
import { T, useGT } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNowMinute } from "../../hooks/useNowMinute";
import { m } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

/** Named priority orders over this environment's accounts, and which one new threads follow. */
export function AccountProfilesSettings({
  environmentId,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const nowMinute = useNowMinute();
  const settings = useEnvironmentSettings(environmentId, (current) => ({
    accountProfiles: current.accountProfiles,
    activeAccountProfileId: current.activeAccountProfileId,
  }));
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const [editingId, setEditingId] = useState<AccountProfileId | null>(null);
  const profiles = settings.accountProfiles;
  const editing =
    profiles.find((profile) => profile.id === (editingId ?? settings.activeAccountProfileId)) ??
    profiles[0];
  const drivers = listedProfileDrivers(providers);
  const machines = useEnvironments().environments;
  const now = Date.parse(`${nowMinute}:00Z`);

  const saveProfiles = (next: ReadonlyArray<AccountProfile>) =>
    updateSettings({ accountProfiles: next });
  const saveProfile = (next: AccountProfile) =>
    saveProfiles(profiles.map((profile) => (profile.id === next.id ? next : profile)));
  const addProfile = () => {
    let index = profiles.length + 1;
    while (profiles.some((profile) => profile.id === `profile-${index}`)) index += 1;
    const id = AccountProfileId.make(`profile-${index}`);
    const nextProfiles = [
      ...profiles,
      newAccountProfile(
        id,
        gt("Profile {index}", { index }),
        machines.map((machine) => machine.environmentId),
      ),
    ];
    const hasActive = profiles.some((profile) => profile.id === settings.activeAccountProfileId);
    updateSettings({
      accountProfiles: nextProfiles,
      ...(!hasActive ? { activeAccountProfileId: id } : {}),
    });
    setEditingId(id);
  };
  const removeProfile = (id: AccountProfileId) => {
    const remaining = profiles.filter((profile) => profile.id !== id);
    updateSettings({
      accountProfiles: remaining,
      ...(settings.activeAccountProfileId === id
        ? { activeAccountProfileId: remaining[0]?.id ?? null }
        : {}),
    });
    setEditingId(null);
  };

  return (
    <SettingsSection
      {...setting("account-profiles")}
      headerAction={
        readOnly ? null : (
          <Button size="xs" variant="outline" onClick={addProfile}>
            <PlusIcon className="size-3" aria-hidden />
            <T>Add profile</T>
          </Button>
        )
      }
    >
      <SettingsRow
        title={gt("Active profile")}
        description={gt(
          "New threads start on the profile's first account that is not at its usage limit. Picking an account yourself always wins.",
        )}
        control={
          <Select
            items={profiles.map((profile) => ({ value: profile.id, label: profile.name }))}
            value={settings.activeAccountProfileId ?? null}
            disabled={readOnly || profiles.length === 0}
            onValueChange={(value) => {
              if (value !== null) updateSettings({ activeAccountProfileId: value });
            }}
          >
            <SelectTrigger size="sm" className="w-40" aria-label={gt("Active profile")}>
              <SelectValue placeholder={gt("No profile")} />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {editing ? (
        <>
          {profiles.length > 1 ? (
            <div className="px-3 py-2 sm:px-4">
              <ToggleGroup
                aria-label={gt("Profile to edit")}
                variant="segmented"
                value={[editing.id]}
                onValueChange={(next) => {
                  const id = next[0];
                  if (id !== undefined) setEditingId(AccountProfileId.make(id));
                }}
              >
                {profiles.map((profile) => (
                  <Toggle key={profile.id} value={profile.id}>
                    <span className="max-w-32 truncate">{profile.name}</span>
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
          ) : null}
          <SettingsRow
            title={gt("Name")}
            control={
              <div className="flex items-center gap-1.5">
                <div className="w-40">
                  <Input
                    key={editing.id}
                    size="sm"
                    aria-label={gt("Profile name")}
                    defaultValue={editing.name}
                    disabled={readOnly}
                    onBlur={(event) => {
                      const name = event.target.value.trim();
                      if (name && name !== editing.name) saveProfile({ ...editing, name });
                    }}
                  />
                </div>
                {readOnly ? null : (
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={gt("Remove {name}", { name: editing.name })}
                    onClick={() => removeProfile(editing.id)}
                  >
                    <Trash2Icon />
                  </Button>
                )}
              </div>
            }
          />
          <SettingsRow
            title={gt("Permissions")}
            control={
              <Select
                value={editing.defaultRuntimeMode ?? "__inherit__"}
                disabled={readOnly}
                onValueChange={(value) => {
                  if (value === "__inherit__" || value === null) {
                    const { defaultRuntimeMode: _removed, ...rest } = editing;
                    saveProfile(rest);
                  } else {
                    saveProfile({ ...editing, defaultRuntimeMode: value as RuntimeMode });
                  }
                }}
              >
                <SelectTrigger size="sm" className="w-44" aria-label={gt("Permissions")}>
                  <SelectValue>
                    {editing.defaultRuntimeMode
                      ? m(runtimeModeConfig[editing.defaultRuntimeMode].label)
                      : gt("Default")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="__inherit__">{gt("Default")}</SelectItem>
                  {runtimeModeOptions.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {m(runtimeModeConfig[mode].label)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            title={gt("Switch accounts at usage limits")}
            description={gt(
              "When a thread hits a usage limit, continue it on the next account in this profile instead of waiting for the reset. Without this, the thread offers the switch.",
            )}
            control={
              <Switch
                checked={editing.autoSwitchOnLimit}
                disabled={readOnly}
                aria-label={gt("Switch accounts at usage limits")}
                onCheckedChange={(autoSwitchOnLimit) =>
                  saveProfile({ ...editing, autoSwitchOnLimit })
                }
              />
            }
          />
          <ProfileMachines
            profile={editing}
            machines={machines}
            readOnly={readOnly}
            onChange={saveProfile}
          />
          {drivers.length === 0 ? (
            <SettingsRow
              title={gt("No accounts to order")}
              description={gt(
                "Add a second instance of a provider, such as another Claude account, to give this profile an order.",
              )}
            />
          ) : (
            drivers.map((driver) => (
              <DriverOrder
                key={driver}
                driver={driver}
                profile={editing}
                providers={providers}
                now={now}
                readOnly={readOnly}
                onChange={saveProfile}
                onRenew={(instanceId) =>
                  void refreshProviders({
                    environmentId,
                    input: { instanceId, refreshModels: true },
                  })
                }
              />
            ))
          )}
        </>
      ) : null}
    </SettingsSection>
  );
}

function ProfileMachines(props: {
  readonly profile: AccountProfile;
  readonly machines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly readOnly: boolean;
  readonly onChange: (profile: AccountProfile) => void;
}) {
  const gt = useGT();
  const known = props.machines.map((machine) => machine.environmentId);
  const linked = props.profile.linkedEnvironmentIds;
  return (
    <SettingsRow
      title={gt("Machines")}
      description={gt(
        "Only these machines' projects and threads show while this profile is active. None selected means all machines.",
      )}
    >
      <div className="mt-2 grid gap-1 rounded-lg border border-border/60 p-2">
        {props.machines.map((machine) => (
          <label key={machine.environmentId} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={linked.length === 0 || linked.includes(machine.environmentId)}
              disabled={props.readOnly}
              onCheckedChange={(checked) =>
                props.onChange(
                  setProfileEnvironmentLinked(
                    props.profile,
                    known,
                    machine.environmentId,
                    checked === true,
                  ),
                )
              }
            />
            <span className="truncate">{machine.label}</span>
          </label>
        ))}
      </div>
    </SettingsRow>
  );
}

function DriverOrder(props: {
  readonly driver: ProviderDriverKind;
  readonly profile: AccountProfile;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly now: number;
  readonly readOnly: boolean;
  readonly onChange: (profile: AccountProfile) => void;
  readonly onRenew: (instanceId: ProviderInstanceId) => void;
}) {
  const gt = useGT();
  const ordered = orderInstancesForDriver(props.profile, props.providers, props.driver).filter(
    isListedProfileAccount,
  );
  const ids = ordered.map((provider) => provider.instanceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const driverName = PROVIDER_DISPLAY_NAMES[props.driver] ?? props.driver;
  const move = (index: number, steps: number) => {
    const instanceId = ids[index];
    if (instanceId !== undefined)
      props.onChange(moveProfileInstance(props.profile, ids, instanceId, steps));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const from = ids.indexOf(String(event.active.id) as (typeof ids)[number]);
    const to = ids.indexOf(String(event.over.id) as (typeof ids)[number]);
    if (from !== -1 && to !== -1) move(from, to - from);
  };
  const toggleAllowed = (instanceId: (typeof ids)[number], allowed: boolean) => {
    const excluded = new Set(props.profile.excludedInstanceIds);
    if (allowed) excluded.delete(instanceId);
    else excluded.add(instanceId);
    props.onChange({ ...props.profile, excludedInstanceIds: [...excluded] });
  };
  return (
    <SettingsRow title={driverName} description={gt("First account first.")}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol
            aria-label={gt("{provider} accounts, first choice first", { provider: driverName })}
            className="mt-2 divide-y divide-border/60 rounded-lg border border-border/60"
          >
            {ordered.map((provider, index) => (
              <AccountRow
                key={provider.instanceId}
                provider={provider}
                position={index + 1}
                count={ordered.length}
                allowed={!props.profile.excludedInstanceIds.includes(provider.instanceId)}
                limited={exhaustedUsageWindow(provider, props.now) !== undefined}
                readOnly={props.readOnly}
                onToggleAllowed={(allowed) => toggleAllowed(provider.instanceId, allowed)}
                onMove={(steps) => move(index, steps)}
                onRenew={() => props.onRenew(provider.instanceId)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </SettingsRow>
  );
}

function AccountRow(props: {
  readonly provider: ServerProvider;
  readonly position: number;
  readonly count: number;
  readonly allowed: boolean;
  readonly limited: boolean;
  readonly readOnly: boolean;
  readonly onToggleAllowed: (allowed: boolean) => void;
  readonly onMove: (steps: number) => void;
  readonly onRenew: () => void;
}) {
  const gt = useGT();
  const name = props.provider.displayName ?? props.provider.instanceId;
  const email = props.provider.auth.email?.trim();
  const expired = props.provider.auth.credentialStatus === "expired";
  const canRenew = expired && props.provider.auth.canRenewCredential === true;
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.provider.instanceId, disabled: props.readOnly || props.count <= 1 });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 py-1.5 ps-3 pe-1.5",
        !props.allowed && "opacity-55",
        isDragging && "relative z-10 rounded-lg bg-background shadow-md",
      )}
    >
      {props.count > 1 ? (
        <span className="w-4 text-xs tabular-nums text-muted-foreground">{props.position}</span>
      ) : null}
      <ProviderInstanceIcon
        driverKind={props.provider.driver}
        displayName={name}
        accentColor={props.provider.accentColor}
        badgeContent="none"
        size="compact"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{name}</span>
        {email ? (
          <span className="block truncate text-2xs text-muted-foreground">{email}</span>
        ) : null}
      </span>
      {expired ? (
        <span className="rounded-sm bg-warning/12 px-1 text-2xs text-warning">
          <T>Sign-in expired</T>
        </span>
      ) : null}
      {canRenew && !props.readOnly ? (
        <Button size="xs" variant="outline" onClick={props.onRenew}>
          <T>Re-authenticate</T>
        </Button>
      ) : null}
      {props.limited ? (
        <span className="rounded-sm bg-warning/12 px-1 text-2xs text-warning">
          <T>At limit</T>
        </span>
      ) : null}
      {props.readOnly ? null : (
        <>
          <Switch
            checked={props.allowed}
            onCheckedChange={props.onToggleAllowed}
            aria-label={name}
          />
          {props.count > 1 ? (
            <>
              <span
                ref={setActivatorNodeRef}
                {...listeners}
                aria-hidden
                className="hidden size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 hover:text-foreground active:cursor-grabbing sm:flex"
              >
                <GripVerticalIcon className="size-3.5" />
              </span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                disabled={props.position === 1}
                aria-label={gt("Move {name} up", { name })}
                onClick={() => props.onMove(-1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                disabled={props.position === props.count}
                aria-label={gt("Move {name} down", { name })}
                onClick={() => props.onMove(1)}
              >
                <ArrowDownIcon />
              </Button>
            </>
          ) : null}
        </>
      )}
    </li>
  );
}
