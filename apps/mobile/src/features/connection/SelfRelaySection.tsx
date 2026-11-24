import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  type EnvironmentId,
} from "@t3tools/contracts";
import { QrCode } from "@t3tools/shared/qrCode";
import { T, useGT } from "gt-react-native";
import { useState } from "react";
import { Linking, Share, TextInput, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentServerConfig } from "../../state/entities";
import { SettingsSection } from "../settings/components/SettingsSection";

function PairingQr({ value }: { value: string }) {
  const gt = useGT();
  const qr = QrCode.encodeText(value, QrCode.Ecc.LOW);
  const modules: string[] = [];
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++)
      if (qr.getModule(x, y)) modules.push(`M${x + 4},${y + 4}h1v1h-1z`);
  return (
    <Svg
      accessibilityLabel={gt("Pairing QR code")}
      width={200}
      height={200}
      viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
      style={{ backgroundColor: "white" }}
    >
      <Path d={modules.join("")} fill="black" />
    </Svg>
  );
}
export function SelfRelaySection({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const config = useEnvironmentServerConfig(environmentId);
  const supported = config?.environment.capabilities.selfRelay === true;
  const state = useEnvironmentQuery(
    supported ? serverEnvironment.relayStatus({ environmentId, input: {} }) : null,
  );
  const canLink = useAtomValue(serverEnvironment.relayLink.permissionAtom(environmentId));
  const canUnlink = useAtomValue(serverEnvironment.relayUnlink.permissionAtom(environmentId));
  const canShare = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const link = useAtomCommand(serverEnvironment.relayLink);
  const unlink = useAtomCommand(serverEnvironment.relayUnlink);
  const expose = useAtomCommand(serverEnvironment.relayExposePort);
  const unexpose = useAtomCommand(serverEnvironment.relayUnexposePort);
  const portLink = useAtomCommand(serverEnvironment.relayPortLink);
  const canExpose = useAtomValue(serverEnvironment.relayExposePort.permissionAtom(environmentId));
  const [port, setPort] = useState("");
  const pair = useAtomCommand(authEnvironment.createPairingCredential);
  const [relayUrl, setRelayUrl] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<"read-only" | "operate" | "full">("read-only");
  const [expiry, setExpiry] = useState(3600);
  const [url, setUrl] = useState<string | null>(null);
  if (!supported) return null;
  const share = async () => {
    const origin = state.data?.publicOrigin;
    if (!origin) return;
    const scopes = AuthStandardClientScopes.filter(
      (scope) =>
        access === "full" ||
        (access === "read-only"
          ? scope.endsWith(":read")
          : !["access:write", "relay:write"].includes(scope)),
    );
    const result = await pair({
      environmentId,
      input: { scopes, expiresInSeconds: expiry, ...(label.trim() ? { label: label.trim() } : {}) },
    });
    if (result._tag === "Success")
      setUrl(`${origin}/pair#token=${encodeURIComponent(result.value.credential)}`);
  };
  return (
    <SettingsSection title={gt("Self-hosted relay")}>
      <View className="gap-3 p-4">
        <Text>
          <T>
            Pin the ACME account with CAA to protect traffic from a relay without DNS control. A DNS
            operator can remove the pin; Certificate Transparency reveals issuance. Run your own
            relay to avoid a third party.
          </T>
        </Text>
        {state.data?.caaRecords.map((record) => (
          <Text key={record} selectable>
            {record}
          </Text>
        ))}
        {state.error ? <Text>{state.error}</Text> : null}
        <Text>{state.data?.publicOrigin ?? gt("Not linked")}</Text>
        {state.data?.linked ? (
          <>
            <Text>
              {state.data.connected ? gt("Connected") : gt("Reconnecting")} ·{" "}
              {state.data.certificate}
            </Text>
            <Button
              label={gt("Unlink relay")}
              disabled={!canUnlink}
              onPress={() => {
                void unlink({ environmentId, input: {} }).then(() => {
                  state.refresh();
                  setUrl(null);
                });
              }}
            />
          </>
        ) : (
          <>
            <TextInput
              accessibilityLabel={gt("Relay HTTPS origin")}
              placeholder="https://relay.example.com"
              value={relayUrl}
              onChangeText={setRelayUrl}
              autoCapitalize="none"
              autoCorrect={false}
              className="rounded-xl border border-border p-3 text-foreground"
            />
            <TextInput
              accessibilityLabel={gt("Enrollment token")}
              placeholder={gt("Enrollment token")}
              secureTextEntry
              value={token}
              onChangeText={setToken}
              className="rounded-xl border border-border p-3 text-foreground"
            />
            <Button
              label={gt("Link relay")}
              disabled={!canLink || !relayUrl || !token}
              onPress={() => {
                void link({ environmentId, input: { relayUrl, token } }).then((result) => {
                  if (result._tag === "Success") {
                    setToken("");
                    state.refresh();
                  }
                });
              }}
            />
          </>
        )}
        {state.data?.publicOrigin ? (
          <>
            <Text>
              <T>Share agent access</T>
            </Text>
            <TextInput
              accessibilityLabel={gt("Link label")}
              placeholder={gt("Link label")}
              value={label}
              onChangeText={setLabel}
              className="rounded-xl border border-border p-3 text-foreground"
            />
            <View className="flex-row flex-wrap gap-2">
              {(["read-only", "operate", "full"] as const).map((level) => (
                <Button
                  key={level}
                  size="compact"
                  label={level}
                  tone={level === access ? "primary" : "secondary"}
                  onPress={() => setAccess(level)}
                />
              ))}
            </View>
            <View className="flex-row gap-2">
              <Button
                label={gt("1 hour")}
                onPress={() => setExpiry(3600)}
                tone={expiry === 3600 ? "primary" : "secondary"}
              />
              <Button
                label={gt("1 day")}
                onPress={() => setExpiry(86400)}
                tone={expiry === 86400 ? "primary" : "secondary"}
              />
            </View>
            <Button
              label={gt("Create pairing link")}
              disabled={!canShare}
              onPress={() => void share()}
            />
            {url ? (
              <>
                <Text selectable>{url}</Text>
                <PairingQr value={url} />
                <Button
                  label={gt("Share link")}
                  onPress={() => void Share.share({ message: url })}
                />
              </>
            ) : null}
            <Text>
              <T>Expose a local port</T>
            </Text>
            <TextInput
              keyboardType="number-pad"
              accessibilityLabel={gt("Local port")}
              placeholder="3000"
              value={port}
              onChangeText={setPort}
              className="rounded-xl border border-border p-3 text-foreground"
            />
            <View className="flex-row flex-wrap gap-2">
              {(["private", "link"] as const).map((mode) => (
                <Button
                  key={mode}
                  label={mode === "private" ? gt("Private") : gt("Anyone with link")}
                  disabled={!canExpose || !port}
                  onPress={() => {
                    void expose({
                      environmentId,
                      input: { port: Number(port), access: mode, expiresInSeconds: expiry },
                    }).then(async (result) => {
                      if (result._tag === "Success") {
                        if (mode === "private") {
                          const link = await portLink({
                            environmentId,
                            input: { port: Number(port) },
                          });
                          if (link._tag === "Success") setUrl(link.value.url);
                        } else setUrl(result.value.url);
                        state.refresh();
                      }
                    });
                  }}
                />
              ))}
            </View>
            {state.data.ports.map((entry) => (
              <View key={entry.port} className="gap-2">
                <Button
                  label={entry.origin}
                  onPress={() => {
                    void portLink({ environmentId, input: { port: entry.port } }).then((result) => {
                      if (result._tag === "Success") void Linking.openURL(result.value.url);
                    });
                  }}
                />
                <Button
                  label={gt("Unexpose")}
                  disabled={!canUnlink}
                  onPress={() => {
                    void unexpose({ environmentId, input: { port: entry.port } }).then(() => {
                      setUrl(null);
                      state.refresh();
                    });
                  }}
                />
              </View>
            ))}
          </>
        ) : null}
      </View>
    </SettingsSection>
  );
}
