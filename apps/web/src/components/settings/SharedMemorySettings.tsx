import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";
import { type SharedMemoryVaults, type SharedMemoryCommand } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { sharedMemory } from "~/state/sharedMemory";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function SharedMemorySettings() {
  const gt = useGT();
  const m = useMessages();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const scope = useOptionalSettingsScope();
  const environmentId = scope?.target?.environmentId ?? primaryEnvironmentId;
  const canManage = useAtomValue(sharedMemory.command.permissionAtom(environmentId));
  const status = useEnvironmentQuery(
    environmentId ? sharedMemory.status({ environmentId, input: {} }) : null,
    m,
  );
  const listVaults = useAtomCommand(sharedMemory.vaults);
  const [vaults, setVaults] = useState<typeof SharedMemoryVaults.Type | null>(null);
  async function refreshVaults() {
    if (!environmentId) return;
    const result = await listVaults({ environmentId, input: {} });
    if (result._tag === "Success") setVaults(result.value);
  }
  const command = useAtomCommand(sharedMemory.command);
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
    if (!environmentId) return;
    setBusy(true);
    setError(null);
    const result = await command({ environmentId, input });
    setPassword("");
    setMfa("");
    setVaultPassword("");
    setBusy(false);
    if (result._tag === "Failure")
      setError(
        gt(
          "Shared memory could not be updated. Check Obsidian Headless, credentials, and vault access.",
        ),
      );
    status.refresh();
    if (input.action === "login") await refreshVaults();
  }
  const state = status.data;
  const disabled = busy || !canManage;
  return (
    <SettingsSection id="shared-memory" title={gt("Shared memory")}>
      <div className="space-y-2 px-4 py-3.5 text-sm text-muted-foreground">
        <p>
          <T>
            Share agent memory through Obsidian Sync. Install Obsidian Headless with Node 22 or
            later on this environment.
          </T>{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
            bun install -g obsidian-headless
          </code>
        </p>
        <p>
          <T>Do not sync this folder with the Obsidian desktop app on the same machine.</T>
        </p>
        {(error || status.error || state?.lastError) && (
          <p role="alert" className="text-sm text-destructive">
            {error || status.error || state?.lastError}
          </p>
        )}
      </div>
      <SettingsRow
        title={gt("Sync status")}
        description={
          state?.lastSyncedAt
            ? gt("Last synced: {time}", { time: new Date(state.lastSyncedAt).toLocaleString() })
            : gt("No completed sync yet")
        }
        control={
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-medium text-muted-foreground">
              {state?.phase === "syncing"
                ? gt("Syncing")
                : state?.phase === "error"
                  ? gt("Sync error")
                  : state?.paused
                    ? gt("Paused")
                    : gt("Idle")}
            </span>
            <Button variant="outline" size="sm" onClick={status.refresh}>
              <T>Refresh</T>
            </Button>
          </div>
        }
      />
      {!state?.connected ? (
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
    </SettingsSection>
  );
}
