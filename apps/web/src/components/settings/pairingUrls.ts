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

export function resolveHostedPairingUrl(
  endpointUrl: string,
  credential: string,
  hostedAppUrl?: string | null,
): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  try {
    return buildHostedPairingUrl({
      host: endpointUrl,
      token: credential,
      ...(hostedAppUrl === undefined ? {} : { hostedAppUrl }),
    });
  } catch {
    return null;
  }
}

export function publicOriginAdvertisedEndpoint(
  origin: string,
  resolve: MessageResolver = m,
  hostedAppUrl?: string | null,
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
    // The hosted app is upstream's, so only offer it when this environment opted into the
    // T3 Connect bridge and that bridge named the app to open. Otherwise the QR is direct.
    compatibility: {
      hostedHttpsApp: hostedAppUrl?.trim() ? "compatible" : "requires-configuration",
      desktopApp: "compatible",
    },
    source: "server",
    status: "available",
    isDefault: true,
  };
}
