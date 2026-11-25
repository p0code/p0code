import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  OBSIDIAN_SHARED_MEMORY_ID,
  type SharedMemoryCommand,
  SharedMemoryStatus,
  SharedMemoryVaults,
} from "@t3tools/plugin-obsidian-shared-memory/actions";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { T, useGT, Var } from "gt-react";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

const decodeStatus = Schema.decodeUnknownOption(SharedMemoryStatus);
const decodeVaults = Schema.decodeUnknownOption(SharedMemoryVaults);

export function ObsidianSharedMemoryDisclosure() {
  return (
    <p className="text-muted-foreground">
      <T>
        Syncs a shared agent memory folder through Obsidian Sync and adds a short note to every
        agent turn naming that folder. Needs Obsidian Headless with Node 22 or later on this
        environment.
      </T>
    </p>
  );
}

export function ObsidianSharedMemoryPanel({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const canManage = useAtomValue(serverEnvironment.pluginsInvoke.permissionAtom(environmentId));
  const invoke = useAtomCommand(serverEnvironment.pluginsInvoke);
  const plugins = useEnvironmentQuery(serverEnvironment.plugins({ environmentId, input: {} }));
  const message =
    plugins.data?.plugins.find((plugin) => plugin.manifest.id === OBSIDIAN_SHARED_MEMORY_ID)
      ?.message ?? null;
  const [state, setState] = useState<SharedMemoryStatus | null>(null);
  const call = async (action: "status" | "vaults" | "command", input: unknown = {}) => {
    const result = await invoke({
      environmentId,
      input: { pluginId: OBSIDIAN_SHARED_MEMORY_ID, action, input },
    });
    return result._tag === "Success" ? Option.some(result.value) : Option.none();
  };
  const refresh = async () => {
    const value = await call("status");
    const decoded = Option.flatMap(value, decodeStatus);
    if (Option.isSome(decoded)) setState(decoded.value);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server pushes only the plugin's one-line status; the details come back from its status action.
  useEffect(() => {
    // Re-read full status whenever the server pushes a new status line (including clearing to null).
    if (message === undefined) return;
    void invoke({
      environmentId,
      input: { pluginId: OBSIDIAN_SHARED_MEMORY_ID, action: "status", input: {} },
    }).then((result) => {
      if (result._tag !== "Success") return;
      const decoded = decodeStatus(result.value);
      if (Option.isSome(decoded)) setState(decoded.value);
    });
  }, [environmentId, invoke, message]);
  const [vaults, setVaults] = useState<SharedMemoryVaults | null>(null);
  async function refreshVaults() {
    const decoded = Option.flatMap(await call("vaults"), decodeVaults);
    if (Option.isSome(decoded)) setVaults(decoded.value);
  }
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfa, setMfa] = useState("");
  const [vault, setVault] = useState("");
  const [folder, setFolder] = useState("");
  const [vaultPassword, setVaultPassword] = useState("");
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(input: SharedMemoryCommand) {
    setBusy(true);
    setError(null);
    const result = Option.flatMap(await call("command", input), decodeStatus);
    setPassword("");
    setMfa("");
    setVaultPassword("");
    setBusy(false);
    if (Option.isSome(result)) setState(result.value);
    else
      setError(
        gt(
          "Shared memory could not be updated. Check Obsidian Headless, credentials, and vault access.",
        ),
      );
    if (input.action === "login") await refreshVaults();
  }
  if (state === null) return null;
  const disabled = busy || !canManage;
  return (
    <div className="space-y-1">
      <div className="space-y-2 py-1 text-sm text-muted-foreground">
        <p>
          <T>Install Obsidian Headless:</T>{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
            bun install -g obsidian-headless
          </code>
        </p>
        <p>
          <T>Do not sync this folder with the Obsidian desktop app on the same machine.</T>
        </p>
        {(error || state.lastError) && (
          <p role="alert" className="text-sm text-destructive">
            {error || state.lastError}
          </p>
        )}
      </div>
      <SettingsRow
        title={gt("Sync status")}
        description={
          state.lastSyncedAt
            ? gt("Last synced: {time}", { time: new Date(state.lastSyncedAt).toLocaleString() })
            : gt("No completed sync yet")
        }
        control={
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-medium text-muted-foreground">
              {state.phase === "syncing"
                ? gt("Syncing")
                : state.phase === "error"
                  ? gt("Sync error")
                  : state.paused
                    ? gt("Paused")
                    : gt("Idle")}
            </span>
            <Button variant="outline" size="sm" onClick={() => void refresh()}>
              <T>Refresh</T>
            </Button>
          </div>
        }
      />
      {!state.connected ? (
        <div className="px-4 py-4">
          <div className="grid max-w-md gap-3">
            <Input
              aria-label={gt("Obsidian email")}
              placeholder={gt("Obsidian email")}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              aria-label={gt("Obsidian password")}
              placeholder={gt("Obsidian password")}
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Input
              aria-label={gt("MFA code (if enabled)")}
              placeholder={gt("MFA code (if enabled)")}
              autoComplete="off"
              value={mfa}
              onChange={(e) => setMfa(e.target.value)}
            />
            <div className="pt-1">
              <Button
                disabled={disabled || !email || !password}
                onClick={() => void act({ action: "login", email, password, mfa })}
              >
                <T>Connect Obsidian</T>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <SettingsRow
            title={gt("Remote vault")}
            control={
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => void refreshVaults()}
                >
                  <T>Load vaults</T>
                </Button>
                <Select
                  value={vault || state.vault}
                  onValueChange={(value) => setVault(value ?? "")}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={gt("Choose a vault")} />
                  </SelectTrigger>
                  <SelectPopup>
                    {[...(vaults?.vaults ?? []), ...(vaults?.shared ?? [])].map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            }
          />
          <div className="px-4 py-4">
            <div className="grid max-w-md gap-3">
              <Input
                aria-label={gt("Local memory folder")}
                placeholder={state.folder || gt("Default folder in the server state directory")}
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              />
              {state.folder && (
                <p className="text-xs text-muted-foreground break-all">
                  <T>
                    Current folder: <Var>{state.folder}</Var>
                  </T>
                </p>
              )}
              <Input
                aria-label={gt("Vault encryption password (if required)")}
                placeholder={gt("Vault encryption password (if required)")}
                type="password"
                autoComplete="off"
                value={vaultPassword}
                onChange={(e) => setVaultPassword(e.target.value)}
              />
              <div className="pt-1">
                <Button
                  disabled={disabled || !(vault || state.vault)}
                  onClick={() =>
                    void act({
                      action: "configure",
                      vault: vault || state.vault,
                      folder:
                        folder || ((vault || state.vault) === state.vault ? state.folder : ""),
                      password: vaultPassword,
                    })
                  }
                >
                  <T>Use vault</T>
                </Button>
              </div>
            </div>
          </div>
          <SettingsRow
            title={gt("Inject shared memory instructions")}
            control={
              <Switch
                disabled={disabled || !state.folder}
                checked={state.enabled}
                onCheckedChange={(enabled) => void act({ action: "preferences", enabled, agentId })}
              />
            }
          />
          <SettingsRow
            title={gt("Shared agent identity")}
            description={state.agentId}
            control={
              <Input
                aria-label={gt("Override agent identity")}
                placeholder={gt("Use vault identity")}
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              />
            }
          />
          <div className="flex flex-wrap gap-2 px-4 py-3.5">
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => void act({ action: "preferences", enabled: state.enabled, agentId })}
            >
              <T>Save identity</T>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !state.folder}
              onClick={() => void act({ action: state.paused ? "resume" : "pause" })}
            >
              {state.paused ? gt("Resume sync") : gt("Pause sync")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!state.snippet}
              onClick={() => void navigator.clipboard.writeText(state.snippet)}
            >
              <T>Copy instruction snippet</T>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => void act({ action: "logout" })}
            >
              <T>Log out of Obsidian</T>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
