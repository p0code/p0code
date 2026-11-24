import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}

export function publicOriginAdvertisedEndpoint(
  origin: string,
  resolve: MessageResolver = m,
): AdvertisedEndpoint {
  const url = new URL(origin);
  return {
    id: "server-public-origin",
    label: resolve(msg("Public HTTPS")),
    provider: {
      id: "self-relay",
      label: resolve(msg("Self-hosted relay")),
      kind: "tunnel",
      isAddon: false,
    },
    httpBaseUrl: url.origin,
    wsBaseUrl: url.origin.replace(/^https:/, "wss:"),
    reachability: "public",
    compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
    source: "server",
    status: "available",
    isDefault: true,
  };
}
