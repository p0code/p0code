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

export function DesktopBackendSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.backend;

  const [status, setStatus] = useState<DesktopBackendStatus | null>(null);
  const [draftMode, setDraftMode] = useState<DesktopBackendMode>("local-service");
  const [modeTouched, setModeTouched] = useState(false);
  const [draftBinaryPath, setDraftBinaryPath] = useState("");
  const [busyAction, setBusyAction] = useState<DesktopBackendAction | "save" | "refresh" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const syncFromStatus = (next: DesktopBackendStatus) => {
    setStatus(next);
    setDraftMode(next.mode);
    setModeTouched(false);
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
    if (mode === "local-service") return "p0d";
    if (mode === "remote") return gt("Remote URL (experimental)");
    return gt("Legacy Node backend (deprecated)");
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

  const normalizedDraftBinaryPath = draftBinaryPath.trim() || null;
  const hasUnsavedChanges =
    status !== null &&
    (modeTouched ||
      draftMode !== status.mode ||
      normalizedDraftBinaryPath !== (status.binaryPath ?? null));

  const handleSave = async () => {
    if (busyAction !== null) return;
    setBusyAction("save");
    setError(null);
    try {
      // Only send the mode when the user actually picked one, so editing the binary path
      // leaves the saved mode in place.
      const next = await bridge.updateConfig({
        ...(modeTouched || draftMode !== status?.mode ? { mode: draftMode } : {}),
        binaryPath: normalizedDraftBinaryPath,
      });
      syncFromStatus(next);
      if (next.error) {
        setError(next.error);
      }
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
      ? gt("The native backend. It starts the Node server only for features it hasn't taken over.")
      : draftMode === "remote"
        ? gt("Remote backend mode is experimental and not supported yet.")
        : gt(
            "Deprecated. Runs the old Node server directly and will be removed in a future release.",
          );

  const statusMetaParts: string[] = [];
  if (status?.url) statusMetaParts.push(status.url);
  if (status?.version) statusMetaParts.push(`v${status.version}`);
  if (status?.pid !== null && status?.pid !== undefined) {
    statusMetaParts.push(`PID ${status.pid}`);
  }

  return (
    <SettingsSection {...searchableSetting("desktop-backend")} title={gt("Backend")}>
      {status?.mode === "remote" ? (
        <SettingsRow
          title={gt("Remote backend mode is experimental and not supported yet")}
          description={gt(
            "This app cannot pair with or sign in to a remote server yet. Add another machine from Settings > Connections instead.",
          )}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busyAction !== null}
              onClick={() => {
                setDraftMode("local-service");
                setModeTouched(true);
              }}
            >
              <T>Use p0d</T>
            </Button>
          }
        />
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
                p0d
              </SelectItem>
              <SelectItem hideIndicator value="embedded">
                <T>Legacy Node backend (deprecated)</T>
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />

      {draftMode === "local-service" ? (
        <SettingsRow
          title={gt("Backend binary path")}
          description={
            status?.resolvedBinaryPath ? (
              <T>
                Optional override. Currently resolved: <Var>{status.resolvedBinaryPath}</Var>
              </T>
            ) : (
              gt("Used only when this app has no bundled p0d.")
            )
          }
          control={
            <Input
              size="sm"
              font="mono"
              className="w-full sm:w-72"
              aria-label={gt("Backend binary path")}
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
                disabled={busyAction !== null || !hasUnsavedChanges}
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

/** Names the backend this app runs, so a deprecated Node backend is never invisible. */
export function DesktopBackendAboutRow() {
  const gt = useGT();
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.backend;
  const [status, setStatus] = useState<DesktopBackendStatus | null>(null);
  const [switching, setSwitching] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads desktop backend IPC status once on mount
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.getStatus().then(
      (next) => {
        if (active) setStatus(next);
      },
      () => {},
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  if (!bridge || status === null || status.mode === "remote") return null;
  const legacy = status.mode === "embedded";

  const switchToP0d = async () => {
    setSwitching(true);
    try {
      const next = await bridge.updateConfig({ mode: "local-service" });
      setStatus(next);
      if (next.error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not switch to p0d"),
            description: next.error,
          }),
        );
      }
    } catch (cause) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not switch to p0d"),
          description: cause instanceof Error ? cause.message : String(cause),
        }),
      );
    }
    setSwitching(false);
  };

  return (
    <SettingsRow
      title={
        <span className="inline-flex items-center gap-2">
          <span>{gt("Backend")}</span>
          {legacy ? <Badge variant="warning">{gt("Deprecated")}</Badge> : null}
        </span>
      }
      description={legacy ? gt("Legacy Node backend") : "p0d"}
      control={
        legacy ? (
          <Button
            size="sm"
            variant="outline"
            disabled={switching}
            onClick={() => void switchToP0d()}
          >
            {switching ? <Spinner size="sm" /> : <T>Switch to p0d</T>}
          </Button>
        ) : null
      }
    />
  );
}
