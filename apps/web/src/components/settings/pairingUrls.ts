import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import type { AdvertisedEndpoint } from "@t3tools/contracts";
import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string | null {
  let url: URL;
  try {
    url = new URL(endpointUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  url.pathname = "/pair";
  url.search = "";
  url.hash = "";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(
  endpointUrl: string,
  credential: string,
  hostedAppUrl?: string | null,
): string | null {
  try {
    const url = new URL(endpointUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      return null;
    }

    return buildHostedPairingUrl({
      host: url.origin,
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
): AdvertisedEndpoint | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
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
