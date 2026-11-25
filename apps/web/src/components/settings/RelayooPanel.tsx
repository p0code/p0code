import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  RELAYOO_ID,
  type RelayooAction,
  RelayStatus,
  type RelayTunnel,
  TunnelList,
  TunnelResult,
  type TunnelKind,
} from "@t3tools/plugin-relayoo/actions";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { useEffect, useState } from "react";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const decodeStatus = Schema.decodeUnknownOption(RelayStatus);
const decodeTunnels = Schema.decodeUnknownOption(TunnelList);
const decodeResult = Schema.decodeUnknownOption(TunnelResult);

export function RelayooDisclosure() {
  return (
    <p className="text-muted-foreground">
      <T>
        Tunnels make this machine reachable from the internet through your Relay server. Anyone with
        a tunnel's address can reach the service behind it, and the Relay server sees the traffic it
        forwards.
      </T>
    </p>
  );
}

export function RelayooPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const canManage = useAtomValue(serverEnvironment.pluginsInvoke.permissionAtom(environmentId));
  const invoke = useAtomCommand(serverEnvironment.pluginsInvoke);
  const plugins = useEnvironmentQuery(serverEnvironment.plugins({ environmentId, input: {} }));
  const message =
    plugins.data?.plugins.find((plugin) => plugin.manifest.id === RELAYOO_ID)?.message ?? null;
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [tunnels, setTunnels] = useState<ReadonlyArray<RelayTunnel>>([]);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const [kind, setKind] = useState<TunnelKind>("http");
  const [port, setPort] = useState("");

  const call = async <A,>(
    action: RelayooAction,
    input: unknown,
    decode: (value: unknown) => Option.Option<A>,
  ): Promise<A | null> => {
    setBusy(true);
    const result = await invoke({
      environmentId,
      input: { pluginId: RELAYOO_ID, action, input },
    });
    setBusy(false);
    // Failures are already shown as a toast by useAtomCommand.
    return result._tag === "Success" ? Option.getOrNull(decode(result.value)) : null;
  };
  const run = async (action: RelayooAction, input: unknown = {}) => {
    const next = await call(action, input, decodeStatus);
    if (next) setStatus(next);
  };
  const refreshTunnels = async () => {
    const list = await call("listTunnels", {}, decodeTunnels);
    if (list) setTunnels(list.tunnels);
  };
  const share = async (action: "reachThisMachine" | "shareLocalPort", input: unknown = {}) => {
    const created = await call(action, input, decodeResult);
    if (created) await refreshTunnels();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server pushes only a one-line status; details come from the plugin's own actions.
  useEffect(() => {
    if (message === null) return;
    void invoke({
      environmentId,
      input: { pluginId: RELAYOO_ID, action: "status", input: {} },
    }).then((result) => {
      if (result._tag !== "Success") return;
      const decoded = decodeStatus(result.value);
      if (Option.isSome(decoded)) setStatus(decoded.value);
    });
  }, [environmentId, invoke, message]);

  const signedIn = status?.signedIn ?? false;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tunnels live on the Relay server; reload them when the agent signs in.
  useEffect(() => {
    if (!signedIn) return;
    void invoke({
      environmentId,
      input: { pluginId: RELAYOO_ID, action: "listTunnels", input: {} },
    }).then((result) => {
      if (result._tag !== "Success") return;
      const decoded = decodeTunnels(result.value);
      if (Option.isSome(decoded)) setTunnels(decoded.value.tunnels);
    });
  }, [environmentId, invoke, signedIn]);

  if (status === null) return null;
  const disabled = busy || !canManage;
  const portNumber = Number(port);
  const validPort = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;

  return (
    <div className="space-y-3">
      {status.error ? (
        <p role="alert" className="text-destructive">
          {status.error}
        </p>
      ) : message ? (
        <p role="status" className="text-muted-foreground">
          {message}
        </p>
      ) : null}

      {status.pendingSignIn ? (
        <div className="flex flex-wrap items-center gap-3">
          <code className="text-lg tracking-widest">{status.pendingSignIn.userCode}</code>
          <Button
            render={
              <a href={status.pendingSignIn.verificationUrl} target="_blank" rel="noreferrer" />
            }
          >
            <T>Approve in Relay</T>
          </Button>
          <Button variant="ghost" disabled={disabled} onClick={() => void run("cancelSignIn")}>
            <T>Cancel</T>
          </Button>
        </div>
      ) : !signedIn ? (
        <Button disabled={disabled} onClick={() => void run("signIn")}>
          <T>Sign in to Relay</T>
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto truncate font-mono text-xs">{status.agentId}</span>
          {status.connection === "failed" ? (
            <>
              <Button variant="outline" disabled={disabled} onClick={() => void run("reconnect")}>
                <T>Reconnect</T>
              </Button>
              <Button variant="outline" disabled={disabled} onClick={() => void run("signIn")}>
                <T>Sign in again</T>
              </Button>
            </>
          ) : null}
          <Button variant="ghost" disabled={disabled} onClick={() => void run("signOut")}>
            <T>Sign out</T>
          </Button>
        </div>
      )}

      {signedIn ? (
        <>
          <Button disabled={disabled} onClick={() => void share("reachThisMachine")}>
            <T>Reach this machine via Relay</T>
          </Button>

          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (validPort) {
                void share("shareLocalPort", { kind, localPort: portNumber }).then(() =>
                  setPort(""),
                );
              }
            }}
          >
            <Button
              type="button"
              variant="outline"
              aria-label={gt("Tunnel type")}
              disabled={disabled}
              onClick={() => setKind(kind === "http" ? "tcp" : "http")}
            >
              {kind.toUpperCase()}
            </Button>
            <Input
              className="w-28"
              inputMode="numeric"
              aria-label={gt("Local port")}
              placeholder="3000"
              value={port}
              onChange={(event) => setPort(event.target.value.trim())}
            />
            <Button type="submit" variant="outline" disabled={disabled || !validPort}>
              <T>Share port</T>
            </Button>
          </form>

          {tunnels.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {tunnels.map((tunnel) => (
                <li key={tunnel.id} className="flex items-center gap-3 px-3 py-2">
                  <span
                    aria-label={tunnel.online ? gt("Online") : gt("Offline")}
                    className={`size-2 shrink-0 rounded-full ${tunnel.online ? "bg-success" : "bg-muted-foreground/40"}`}
                  />
                  <div className="min-w-0 flex-1">
                    {tunnel.kind === "http" && tunnel.publicAddress ? (
                      <a
                        href={tunnel.publicAddress}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate font-mono text-xs hover:underline"
                      >
                        {tunnel.publicAddress}
                      </a>
                    ) : (
                      <span className="block truncate font-mono text-xs">
                        {tunnel.publicAddress ?? tunnel.id}
                      </span>
                    )}
                    <span className="text-muted-foreground text-xs">
                      {tunnel.kind.toUpperCase()} → {tunnel.localPort}
                    </span>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      void call("stopTunnel", { tunnelId: tunnel.id }, decodeTunnels).then(
                        (list) => list && setTunnels(list.tunnels),
                      )
                    }
                  >
                    <T>Stop</T>
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      <details>
        <summary className="cursor-pointer text-muted-foreground">
          <T>Server</T>
        </summary>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (server !== null) void run("setServer", { server }).then(() => setServer(null));
          }}
        >
          <Input
            aria-label={gt("Relay server")}
            value={server ?? status.server}
            onChange={(event) => setServer(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={disabled || server === null}>
            <T>Save</T>
          </Button>
        </form>
      </details>
    </div>
  );
}
