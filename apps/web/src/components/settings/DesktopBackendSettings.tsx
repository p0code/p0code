import {
  type DesktopBackendAction,
  type DesktopBackendMode,
  type DesktopBackendStatus,
} from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AdvancedSettings } from "./AdvancedSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

function isValidHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function DesktopBackendSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.backend;

  const [status, setStatus] = useState<DesktopBackendStatus | null>(null);
  const [draftMode, setDraftMode] = useState<DesktopBackendMode>("embedded");
  const [modeTouched, setModeTouched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [draftRemoteUrl, setDraftRemoteUrl] = useState("");
  const [draftBinaryPath, setDraftBinaryPath] = useState("");
  const [busyAction, setBusyAction] = useState<DesktopBackendAction | "save" | "refresh" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const syncFromStatus = (next: DesktopBackendStatus) => {
    setStatus(next);
    setDraftMode(next.mode);
    setModeTouched(false);
    setDraftRemoteUrl(next.remoteUrl ?? "");
    setDraftBinaryPath(next.binaryPath ?? "");
  };

  const refreshStatus = async () => {
    if (!bridge) return;
    setBusyAction("refresh");
    setError(null);
    try {
      const next = await bridge.getStatus();
      syncFromStatus(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not read backend status."));
    }
    setBusyAction(null);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads desktop backend IPC status once on mount
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.getStatus().then(
      (next) => {
        if (active) {
          setStatus(next);
          setDraftMode(next.mode);
          setDraftRemoteUrl(next.remoteUrl ?? "");
          setDraftBinaryPath(next.binaryPath ?? "");
        }
      },
      (cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : gt("Could not read backend status."));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [bridge, gt]);

  if (!bridge) return null;

  const modeLabel = (mode: DesktopBackendMode): string => {
    if (mode === "local-service") return gt("Local service (p0d)");
    if (mode === "remote") return gt("Remote URL");
    return gt("In-app backend");
  };

  const statusBadge = () => {
    const state = status?.status ?? "stopped";
    if (state === "running") {
      return <Badge variant="success">{gt("Running")}</Badge>;
    }
    if (state === "starting") {
      return <Badge variant="info">{gt("Starting")}</Badge>;
    }
    if (state === "unreachable") {
      return <Badge variant="error">{gt("Unreachable")}</Badge>;
    }
    return <Badge variant="secondary">{gt("Stopped")}</Badge>;
  };

  const normalizedDraftRemoteUrl = draftRemoteUrl.trim() || null;
  const normalizedDraftBinaryPath = draftBinaryPath.trim() || null;
  const hasUnsavedChanges =
    status !== null &&
    (modeTouched ||
      draftMode !== status.mode ||
      normalizedDraftRemoteUrl !== (status.remoteUrl ?? null) ||
      normalizedDraftBinaryPath !== (status.binaryPath ?? null));

  const remoteUrlInvalid = draftMode === "remote" && !isValidHttpUrl(draftRemoteUrl);

  const handleSave = async () => {
    if (busyAction !== null || remoteUrlInvalid) return;
    setBusyAction("save");
    setError(null);
    try {
      // Only send the mode when the user actually picked one, so editing the binary path
      // leaves the auto default (p0d when available) in place.
      const next = await bridge.updateConfig({
        ...(modeTouched || draftMode !== status?.mode ? { mode: draftMode } : {}),
        remoteUrl: normalizedDraftRemoteUrl,
        binaryPath: normalizedDraftBinaryPath,
      });
      syncFromStatus(next);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : gt("Could not save backend settings.");
      setError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not save backend settings"),
          description: message,
        }),
      );
    }
    setBusyAction(null);
  };

  const handleControl = async (action: DesktopBackendAction) => {
    if (busyAction !== null) return;
    setBusyAction(action);
    setError(null);
    try {
      const next = await bridge.control(action);
      syncFromStatus(next);
      if (next.error) {
        setError(next.error);
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : gt("Backend action failed.");
      setError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Backend action failed"),
          description: message,
        }),
      );
    }
    setBusyAction(null);
  };

  const modeDescription =
    draftMode === "local-service"
      ? gt(
          "Runs p0d as a background user service. Quitting the desktop window leaves the backend running.",
        )
      : draftMode === "remote"
        ? gt("Connects directly to a remote or self-hosted backend URL with no local process.")
        : gt(
            "Runs the backend inside the app. Quitting the window stops it, unlike Local service (p0d), which keeps running.",
          );

  const statusMetaParts: string[] = [];
  if (status?.url) statusMetaParts.push(status.url);
  if (status?.version) statusMetaParts.push(`v${status.version}`);
  if (status?.pid !== null && status?.pid !== undefined) {
    statusMetaParts.push(`PID ${status.pid}`);
  }

  return (
    <SettingsSection {...searchableSetting("desktop-backend")} title={gt("Backend")}>
      <p className="px-3 text-sm leading-relaxed text-muted-foreground sm:px-4">
        <T>
          Local service (p0d) is the default. Quitting the app window leaves the backend running in
          the background.
        </T>
      </p>
      {status !== null && !status.resolvedBinaryPath ? (
        <p className="px-3 text-sm leading-relaxed text-muted-foreground sm:px-4">
          <T>
            p0d was not found, so the app is running its in-app backend. Install p0d on PATH
            (/usr/local/bin or /opt/homebrew/bin), or choose Local service (p0d) to set its path.
          </T>
        </p>
      ) : null}
      <SettingsRow
        title={gt("Backend mode")}
        description={modeDescription}
        control={
          <Select
            value={draftMode}
            onValueChange={(value) => {
              if (value === "local-service" || value === "embedded") {
                setDraftMode(value);
                setShowAdvanced(false);
                setModeTouched(true);
              }
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-52"
              aria-label={gt("Backend mode")}
              disabled={busyAction !== null || status === null}
            >
              <SelectValue>{modeLabel(draftMode)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="local-service">
                <T>Local service (p0d)</T>
              </SelectItem>
              <SelectItem hideIndicator value="embedded">
                <T>In-app backend</T>
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      {draftMode === "local-service" ? (
        <SettingsRow
          title={gt("p0d binary path")}
          description={
            status?.resolvedBinaryPath ? (
              <T>
                Optional override. Currently resolved: <Var>{status.resolvedBinaryPath}</Var>
              </T>
            ) : (
              gt("Optional path to a local p0d binary. Leave blank to auto-detect.")
            )
          }
          control={
            <Input
              size="sm"
              font="mono"
              className="w-full sm:w-72"
              aria-label={gt("p0d binary path")}
              placeholder={gt("Auto-detect")}
              value={draftBinaryPath}
              disabled={busyAction !== null}
              onChange={(event) => setDraftBinaryPath(event.target.value)}
            />
          }
        />
      ) : null}

      <AdvancedSettings
        targetIds={["desktop-backend-remote"]}
        open={showAdvanced || draftMode === "remote"}
        onOpenChange={setShowAdvanced}
      >
        <SettingsRow
          title={gt("Connect to a p0code server on another machine…")}
          description={gt(
            "Points the app straight at a URL for a server you run elsewhere. This is not the relay: to reach another machine, use relay pairing or linked environments.",
          )}
          control={
            <Checkbox
              checked={draftMode === "remote"}
              disabled={busyAction !== null}
              aria-label={gt("Connect to a p0code server on another machine…")}
              onCheckedChange={(checked) => {
                if (checked) {
                  setShowAdvanced(true);
                  setDraftMode("remote");
                } else {
                  setShowAdvanced(false);
                  setDraftMode(status?.resolvedBinaryPath ? "local-service" : "embedded");
                }
                setModeTouched(true);
              }}
            />
          }
        />

        {draftMode === "remote" ? (
          <SettingsRow
            title={gt("Remote backend URL")}
            description={
              remoteUrlInvalid
                ? gt("Enter a valid http:// or https:// backend URL.")
                : gt("Address of the backend server this app connects to.")
            }
            control={
              <Input
                size="sm"
                type="url"
                font="mono"
                className="w-full sm:w-72"
                aria-label={gt("Remote backend URL")}
                placeholder="http://127.0.0.1:3773"
                value={draftRemoteUrl}
                disabled={busyAction !== null}
                onChange={(event) => setDraftRemoteUrl(event.target.value)}
              />
            }
          />
        ) : null}
      </AdvancedSettings>

      {hasUnsavedChanges ? (
        <SettingsRow
          title={gt("Apply backend changes")}
          description={gt("Saving changes will restart the desktop app to reconnect.")}
          control={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busyAction !== null}
                onClick={() => status && syncFromStatus(status)}
              >
                <T>Reset</T>
              </Button>
              <Button
                size="sm"
                disabled={busyAction !== null || remoteUrlInvalid}
                onClick={() => void handleSave()}
              >
                {busyAction === "save" ? (
                  <>
                    <Spinner size="sm" />
                    <T>Saving…</T>
                  </>
                ) : (
                  <T>Save and restart</T>
                )}
              </Button>
            </div>
          }
        />
      ) : null}

      <SettingsRow
        title={
          <span className="inline-flex items-center gap-2">
            <span>{gt("Backend status")}</span>
            {statusBadge()}
          </span>
        }
        description={
          <span className="flex flex-col gap-1">
            {statusMetaParts.length > 0 ? (
              <span className="font-mono text-xs">{statusMetaParts.join(" · ")}</span>
            ) : (
              <span>{gt("No active backend endpoint.")}</span>
            )}
            {(error ?? status?.error) ? (
              <span className="text-xs text-destructive">{error ?? status?.error}</span>
            ) : null}
          </span>
        }
        control={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              disabled={busyAction !== null || status === null || status.running}
              onClick={() => void handleControl("start")}
            >
              {busyAction === "start" ? <Spinner size="sm" /> : <T>Start</T>}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busyAction !== null || status === null || !status.running}
              onClick={() => void handleControl("stop")}
            >
              {busyAction === "stop" ? <Spinner size="sm" /> : <T>Stop</T>}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busyAction !== null || status === null}
              onClick={() => void handleControl("restart")}
            >
              {busyAction === "restart" ? <Spinner size="sm" /> : <T>Restart</T>}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={gt("Refresh backend status")}
              disabled={busyAction !== null}
              onClick={() => void refreshStatus()}
            >
              <RefreshCwIcon
                className={busyAction === "refresh" ? "size-3.5 animate-spin" : "size-3.5"}
              />
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}
