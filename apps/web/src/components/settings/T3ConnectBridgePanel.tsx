import type { EnvironmentId } from "@t3tools/contracts";
import {
  type BridgeAction,
  type BridgeConfigPatch,
  BridgeStatus,
  T3_CONNECT_BRIDGE_ID,
} from "@t3tools/plugin-t3-connect-bridge/actions";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { T, useGT } from "gt-react";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

const decodeStatus = Schema.decodeUnknownOption(BridgeStatus);

export function T3ConnectBridgeDisclosure() {
  return (
    <p className="text-muted-foreground">
      <T>
        Unofficial. Lets T3 Code apps signed in to your T3 account reach this environment and sends
        push notifications to the store mobile app. Not end-to-end encrypted: Cloudflare ends TLS
        for the tunnel, and T3's relay sees your devices, connection metadata, and thread titles in
        notifications.
      </T>
    </p>
  );
}

export function T3ConnectBridgePanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const invoke = useAtomCommand(serverEnvironment.pluginsInvoke);
  const plugins = useEnvironmentQuery(serverEnvironment.plugins({ environmentId, input: {} }));
  const message =
    plugins.data?.plugins.find((plugin) => plugin.manifest.id === T3_CONNECT_BRIDGE_ID)?.message ??
    null;
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<BridgeConfigPatch>({});

  const call = async (action: BridgeAction, input: unknown = {}) => {
    const result = await invoke({
      environmentId,
      input: { pluginId: T3_CONNECT_BRIDGE_ID, action, input },
    });
    if (result._tag !== "Success") return;
    const decoded = decodeStatus(result.value);
    if (Option.isSome(decoded)) setStatus(decoded.value);
  };
  const run = async (action: BridgeAction, input: unknown = {}) => {
    setBusy(true);
    await call(action, input);
    setBusy(false);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server pushes only a one-line status; the details come back from the bridge's status action.
  useEffect(() => {
    // The bridge reports a line as soon as it starts; until then there is nothing to read.
    if (message === null) return;
    void invoke({
      environmentId,
      input: { pluginId: T3_CONNECT_BRIDGE_ID, action: "status", input: {} },
    }).then((result) => {
      if (result._tag !== "Success") return;
      const decoded = decodeStatus(result.value);
      if (Option.isSome(decoded)) setStatus(decoded.value);
    });
  }, [environmentId, invoke, message]);

  if (status === null) return null;
  const config = { ...status.config, ...draft };
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
            <T>Approve in browser</T>
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => void run("signOut")}>
            <T>Cancel</T>
          </Button>
        </div>
      ) : !status.signedIn ? (
        <Button disabled={busy} onClick={() => void run("signIn")}>
          <T>Sign in to T3 Connect</T>
        </Button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto truncate">{status.account ?? gt("Signed in")}</span>
          {status.linked ? (
            <Button variant="outline" disabled={busy} onClick={() => void run("unlink")}>
              <T>Unlink</T>
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void run("link")}>
              <T>Link</T>
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={() => void run("signOut")}>
            <T>Sign out</T>
          </Button>
        </div>
      )}
      <label className="flex items-center justify-between gap-3">
        <T>Push notifications</T>
        <Switch
          checked={status.config.pushNotifications}
          disabled={busy}
          onCheckedChange={(pushNotifications) => void run("setConfig", { pushNotifications })}
        />
      </label>
      <details>
        <summary className="cursor-pointer text-muted-foreground">
          <T>Service</T>
        </summary>
        <form
          className="mt-2 grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run("setConfig", draft).then(() => setDraft({}));
          }}
        >
          <Input
            aria-label={gt("Relay URL")}
            value={config.relayUrl}
            onChange={(event) => setDraft({ ...draft, relayUrl: event.target.value })}
          />
          <Input
            aria-label={gt("Clerk publishable key")}
            value={config.clerkPublishableKey}
            onChange={(event) => setDraft({ ...draft, clerkPublishableKey: event.target.value })}
          />
          <Input
            aria-label={gt("Sign-in client ID")}
            value={config.cliOAuthClientId}
            onChange={(event) => setDraft({ ...draft, cliOAuthClientId: event.target.value })}
          />
          <Input
            aria-label={gt("Hosted app URL")}
            value={config.hostedAppUrl}
            onChange={(event) => setDraft({ ...draft, hostedAppUrl: event.target.value })}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={busy || Object.keys(draft).length === 0}
          >
            <T>Save</T>
          </Button>
        </form>
      </details>
      {status.linked ? (
        <Button
          variant="link"
          render={<a href={config.hostedAppUrl} target="_blank" rel="noreferrer" />}
        >
          <T>Open T3 Code web</T>
        </Button>
      ) : null}
    </div>
  );
}
