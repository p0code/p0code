import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveAdvertisedEndpointPairingUrl } from "./ConnectionsSettings.logic";
import {
  publicOriginAdvertisedEndpoint,
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
} from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints when a hosted app is configured", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });

  it("prefers the environment's own URL for the public origin by default", () => {
    const endpoint = publicOriginAdvertisedEndpoint("https://abcdef.relay.example.com");
    expect(endpoint.compatibility.hostedHttpsApp).toBe("requires-configuration");
    expect(resolveAdvertisedEndpointPairingUrl(endpoint, "pairing-code")).toBe(
      "https://abcdef.relay.example.com/pair#token=pairing-code",
    );
  });

  it("uses the bridge's hosted app only when the bridge names one", () => {
    const endpoint = publicOriginAdvertisedEndpoint(
      "https://abcdef.relay.example.com",
      undefined,
      "https://app.example.com",
    );
    expect(endpoint.compatibility.hostedHttpsApp).toBe("compatible");
    expect(
      resolveAdvertisedEndpointPairingUrl(endpoint, "pairing-code", "https://app.example.com"),
    ).toBe(
      "https://app.example.com/pair?host=https%3A%2F%2Fabcdef.relay.example.com#token=pairing-code",
    );
    expect(resolveAdvertisedEndpointPairingUrl(endpoint, "pairing-code")).toBe(
      "https://abcdef.relay.example.com/pair#token=pairing-code",
    );
  });

  it("advertises the server public origin for stock mobile pairing without a hosted hop", () => {
    const endpoint = publicOriginAdvertisedEndpoint("https://abcdef.relay.example.com");
    expect(endpoint.reachability).toBe("public");
    expect(endpoint.wsBaseUrl).toBe("wss://abcdef.relay.example.com");
    expect(resolveDesktopPairingUrl(endpoint.httpBaseUrl, "pairing-code")).toBe(
      "https://abcdef.relay.example.com/pair#token=pairing-code",
    );
  });
});
