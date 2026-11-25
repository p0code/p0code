import { useEnvironmentScope } from "~/state/session";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useReducer, useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  initialRelayLinkFormState,
  relayLinkFormReducer,
  relayLinkErrorMessage,
} from "./SelfRelaySettings.logic";
import { T, useGT, msg, useMessages } from "gt-react";
import { serverEnvironment } from "~/state/server";
import { authEnvironment } from "~/state/auth";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { QRCodeSvg } from "../ui/qr-code";

const RELAY_URL_PLACEHOLDER = "https://relay.yourdomain.com";

export function SelfRelaySettings({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const [relayUrl, setRelayUrl] = useState("");
  const [configRelayUrl, setConfigRelayUrl] = useState("");
  const status = useEnvironmentQuery(
    serverEnvironment.relayStatus({ environmentId, input: { relayUrl: configRelayUrl } }),
  );
  const canLink = useAtomValue(serverEnvironment.relayLink.permissionAtom(environmentId));
  const canUnlink = useAtomValue(serverEnvironment.relayUnlink.permissionAtom(environmentId));
  const canExpose = useAtomValue(serverEnvironment.relayExposePort.permissionAtom(environmentId));
  const canShare = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const link = useAtomCommand(serverEnvironment.relayLink, { reportFailure: false });
  const unlink = useAtomCommand(serverEnvironment.relayUnlink);
  const expose = useAtomCommand(serverEnvironment.relayExposePort);
  const unexpose = useAtomCommand(serverEnvironment.relayUnexposePort);
  const portLink = useAtomCommand(serverEnvironment.relayPortLink);
  const pair = useAtomCommand(authEnvironment.createPairingCredential);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [form, dispatch] = useReducer(relayLinkFormReducer, initialRelayLinkFormState);
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState("3600");
  const [access, setAccess] = useState("read-only");
  const [port, setPort] = useState("");
  const [portAccess, setPortAccess] = useState<"private" | "link">("private");
  const [sharedUrl, setSharedUrl] = useState<string | null>(null);
  const busy = form.pending;
  const origin = status.data?.publicOrigin;
  const scopes = AuthStandardClientScopes.filter(
    (scope) =>
      access === "full" ||
      (access === "operate"
        ? !["access:write", "relay:write", "relay:configure"].includes(scope)
        : scope.endsWith(":read")),
  );
  const share = async () => {
    if (!origin) return;
    const result = await pair({
      environmentId,
      input: {
        scopes,
        expiresInSeconds: Number(expiry),
        ...(label.trim() ? { label: label.trim() } : {}),
      },
    });
    if (result._tag === "Success") {
      const url = new URL("/pair", origin);
      url.hash = `token=${encodeURIComponent(result.value.credential)}`;
      setSharedUrl(url.toString());
    }
  };
  const linkRelay = async () => {
    if (busy) return;
    dispatch({ type: "start" });
    const input = form.advanced ? { relayUrl, token } : { relayUrl, username, password };
    setPassword("");
    setToken("");
    const result = await link({ environmentId, input });
    if (result._tag === "Success") {
      dispatch({ type: "success" });
      status.refresh();
    } else {
      dispatch({
        type: "failure",
        error: relayLinkErrorMessage(squashAtomCommandFailure(result), m),
      });
    }
  };
  return (
    <SettingsSection id="self-relay" title={gt("Self-hosted relay")}>
      <div className="space-y-4 px-3 py-3 sm:px-4">
        <p className="text-sm text-muted-foreground">
          <T>
            Pin the ACME account with CAA to protect traffic from a relay without DNS control. A DNS
            operator can remove the pin; Certificate Transparency reveals issuance. Run your own
            relay to avoid a third party.
          </T>
        </p>
        {status.data?.caaRecords.map((record) => (
          <pre key={record} className="overflow-x-auto whitespace-pre-wrap text-xs">
            {record}
          </pre>
        ))}
        {status.error ? <p role="alert">{status.error}</p> : null}
        {status.data?.linked ? (
          <div className="space-y-2 text-sm">
            <p>
              {status.data.slug} · {status.data.relayUrl}
            </p>
            <p>{origin}</p>
            <p>
              {status.data.connected ? gt("Connected") : gt("Reconnecting")} · {gt("Certificate")}:{" "}
              {status.data.certificate}
            </p>
            <Button
              disabled={!canUnlink || busy}
              onClick={async () => {
                await unlink({ environmentId, input: {} });
                status.refresh();
                setSharedUrl(null);
              }}
            >
              <T>Unlink relay</T>
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {m(
                msg(
                  "The relay only forwards encrypted traffic. Your password is sent to your relay once to link this environment and is never saved.",
                ),
              )}
            </p>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                void linkRelay();
              }}
            >
              <label className="block space-y-1 text-sm">
                <span>{m(msg("Relay URL"))}</span>
                <Input
                  type="url"
                  placeholder={RELAY_URL_PLACEHOLDER}
                  value={relayUrl}
                  disabled={busy}
                  onChange={(event) => setRelayUrl(event.target.value)}
                  onBlur={() => setConfigRelayUrl(relayUrl.trim())}
                />
              </label>
              {!form.advanced ? (
                <>
                  <label className="block space-y-1 text-sm">
                    <span>{m(msg("Username"))}</span>
                    <Input
                      autoComplete="username"
                      value={username}
                      disabled={busy}
                      onChange={(event) => setUsername(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1 text-sm">
                    <span>{m(msg("Password"))}</span>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      disabled={busy}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    {m(msg("Use an enrollment token for agents, CI, or automated setup."))}
                  </p>
                  <label className="block space-y-1 text-sm">
                    <span>{m(msg("Enrollment token"))}</span>
                    <Input
                      type="password"
                      autoComplete="off"
                      value={token}
                      disabled={busy}
                      onChange={(event) => setToken(event.target.value)}
                    />
                  </label>
                </>
              )}
              {form.error ? (
                <p role="alert" className="text-sm text-destructive">
                  {form.error}
                </p>
              ) : null}
              <Button
                type="submit"
                disabled={
                  !canLink ||
                  busy ||
                  !relayUrl.trim() ||
                  (form.advanced ? !token : !username.trim() || !password)
                }
              >
                {busy
                  ? m(msg("Linking…"))
                  : form.advanced
                    ? m(msg("Link relay"))
                    : m(msg("Sign in and link"))}
              </Button>
            </form>
            {status.data?.signupUrl && !form.advanced ? (
              <p className="text-sm">
                <a href={status.data.signupUrl} target="_blank" rel="noreferrer">
                  {m(msg("Create account"))}
                </a>
              </p>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={form.advanced}
              disabled={busy}
              onClick={() => {
                setPassword("");
                setToken("");
                dispatch({ type: "toggle" });
              }}
            >
              {m(msg("Advanced"))}
            </Button>
          </div>
        )}
        {origin ? (
          <div className="space-y-3 border-t pt-3">
            <h3 className="text-sm font-medium">
              <T>Share agent access</T>
            </h3>
            <Input
              aria-label={gt("Link label")}
              placeholder={gt("Link label")}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Select value={access} onValueChange={(value) => value && setAccess(value)}>
                <SelectTrigger aria-label={gt("Access level")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="read-only">
                    <T>Read-only</T>
                  </SelectItem>
                  <SelectItem value="operate">
                    <T>Operate</T>
                  </SelectItem>
                  <SelectItem value="full">
                    <T>Full access</T>
                  </SelectItem>
                </SelectPopup>
              </Select>
              <Select value={expiry} onValueChange={(value) => value && setExpiry(value)}>
                <SelectTrigger aria-label={gt("Link expiry")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="3600">
                    <T>1 hour</T>
                  </SelectItem>
                  <SelectItem value="86400">
                    <T>1 day</T>
                  </SelectItem>
                  <SelectItem value="604800">
                    <T>7 days</T>
                  </SelectItem>
                </SelectPopup>
              </Select>
              <Button disabled={!canShare} onClick={() => void share()}>
                <T>Create pairing link</T>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              <T>Scan with p0code mobile. Revoke the link or paired client in Sharing & access.</T>
            </p>
            <h3 className="text-sm font-medium">
              <T>Expose a local port</T>
            </h3>
            <div className="flex flex-wrap gap-2">
              <Input
                type="number"
                min={1}
                max={65535}
                aria-label={gt("Local port")}
                placeholder="3000"
                value={port}
                onChange={(event) => setPort(event.target.value)}
              />
              <Select
                value={portAccess}
                onValueChange={(value) => {
                  if (value === "private" || value === "link") setPortAccess(value);
                }}
              >
                <SelectTrigger aria-label={gt("Port access")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="private">
                    <T>Private</T>
                  </SelectItem>
                  <SelectItem value="link">
                    <T>Anyone with link</T>
                  </SelectItem>
                </SelectPopup>
              </Select>
              <Button
                disabled={!canExpose || !port}
                onClick={async () => {
                  const result = await expose({
                    environmentId,
                    input: {
                      port: Number(port),
                      access: portAccess,
                      expiresInSeconds: Number(expiry),
                    },
                  });
                  if (result._tag === "Success") {
                    if (portAccess === "private") {
                      const link = await portLink({ environmentId, input: { port: Number(port) } });
                      if (link._tag === "Success") setSharedUrl(link.value.url);
                    } else setSharedUrl(result.value.url);
                    status.refresh();
                  }
                }}
              >
                <T>Expose port</T>
              </Button>
            </div>
            {status.data?.ports.map((entry) => (
              <div key={entry.port} className="flex flex-wrap items-center gap-2 text-sm">
                <span>
                  {entry.origin} · {entry.access}
                </span>
                <Button
                  onClick={async () => {
                    const result = await portLink({ environmentId, input: { port: entry.port } });
                    if (result._tag === "Success")
                      window.open(result.value.url, "_blank", "noopener,noreferrer");
                  }}
                >
                  <T>Open</T>
                </Button>
                <Button
                  disabled={!canUnlink}
                  onClick={async () => {
                    await unexpose({ environmentId, input: { port: entry.port } });
                    setSharedUrl(null);
                    status.refresh();
                  }}
                >
                  <T>Unexpose</T>
                </Button>
              </div>
            ))}
          </div>
        ) : null}
        {sharedUrl ? (
          <div className="space-y-3">
            <Input readOnly value={sharedUrl} aria-label={gt("Share link")} />
            <QRCodeSvg value={sharedUrl} size={180} title={gt("Share link QR code")} />
            <Button onClick={() => void navigator.clipboard.writeText(sharedUrl)}>
              <T>Copy link</T>
            </Button>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
