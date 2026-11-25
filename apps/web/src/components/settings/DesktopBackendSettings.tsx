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
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
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
  const [draftMode, setDraftMode] = useState<DesktopBackendMode>("legacy-embedded");
  const [draftRemoteUrl, setDraftRemoteUrl] = useState("");
  const [draftBinaryPath, setDraftBinaryPath] = useState("");
  const [busyAction, setBusyAction] = useState<DesktopBackendAction | "save" | "refresh" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const syncFromStatus = (next: DesktopBackendStatus) => {
    setStatus(next);
    setDraftMode(next.mode);
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
    } finally {
      setBusyAction(null);
    }
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
    return gt("Legacy embedded");
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
    (draftMode !== status.mode ||
      normalizedDraftRemoteUrl !== (status.remoteUrl ?? null) ||
      normalizedDraftBinaryPath !== (status.binaryPath ?? null));

  const remoteUrlInvalid = draftMode === "remote" && !isValidHttpUrl(draftRemoteUrl);

  const handleSave = async () => {
    if (busyAction !== null || remoteUrlInvalid) return;
    setBusyAction("save");
    setError(null);
    try {
      const next = await bridge.updateConfig({
        mode: draftMode,
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
    } finally {
      setBusyAction(null);
    }
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
    } finally {
      setBusyAction(null);
    }
  };

  const modeDescription =
    draftMode === "local-service"
      ? gt(
          "Runs p0d as a background user service. Quitting the desktop window leaves the backend running.",
        )
      : draftMode === "remote"
        ? gt("Connects directly to a remote or self-hosted backend URL with no local process.")
        : gt("Spawns the legacy Node server inside the desktop app.");

  const statusMetaParts: string[] = [];
  if (status?.url) statusMetaParts.push(status.url);
  if (status?.version) statusMetaParts.push(`v${status.version}`);
  if (status?.pid !== null && status?.pid !== undefined) {
    statusMetaParts.push(`PID ${status.pid}`);
  }

  return (
    <SettingsSection {...searchableSetting("desktop-backend")} title={gt("Backend")}>
      <SettingsRow
        title={gt("Backend mode")}
        description={modeDescription}
        control={
          <Select
            value={draftMode}
            onValueChange={(value) => {
              if (value === "local-service" || value === "remote" || value === "legacy-embedded") {
                setDraftMode(value);
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
              <SelectItem hideIndicator value="remote">
                <T>Remote URL</T>
              </SelectItem>
              <SelectItem hideIndicator value="legacy-embedded">
                <T>Legacy embedded</T>
              </SelectItem>
            </SelectPopup>
          </Select>
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
