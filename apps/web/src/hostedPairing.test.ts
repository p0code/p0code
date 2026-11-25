import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedPairingUrl,
  hasHostedPairingRequest,
  hostedAppOrigin,
  readHostedPairingRequest,
} from "./hostedPairing";
import { resolveHostedPairingUrl } from "./components/settings/pairingUrls";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://app.t3.codes/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    const url = new URL(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773",
        token: "pairing-token",
        label: "Workstation",
      }),
    );

    expect(url.origin).toBe("https://preview.t3.codes");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("encodes only the validated backend origin into the host query", () => {
    expect(
      buildHostedPairingUrl({
        host: "https://backend.example.com:3773/some/path?token=leak#fragment",
        token: "pairing-token",
        hostedAppUrl: "https://app.example.com",
      }),
    ).toBe(
      "https://app.example.com/pair?host=https%3A%2F%2Fbackend.example.com%3A3773#token=pairing-token",
    );
  });

  it.each([
    ["plain HTTP", "http://app.example.com"],
    ["credentials", "https://user:secret@app.example.com"],
    ["a non-URL", "app.example.com/pair"],
    ["a nested scheme", "javascript:alert(1)"],
  ])("rejects a hosted app origin with %s", (_label, hostedAppUrl) => {
    expect(hostedAppOrigin(hostedAppUrl)).toBeNull();
    expect(() =>
      buildHostedPairingUrl({ host: "https://backend.example.com", token: "t", hostedAppUrl }),
    ).toThrow();
    expect(resolveHostedPairingUrl("https://backend.example.com", "t", hostedAppUrl)).toBeNull();
  });

  it("keeps loopback HTTP for local previews and accepts HTTPS", () => {
    expect(hostedAppOrigin("http://localhost:5733")).toBe("http://localhost:5733");
    expect(hostedAppOrigin("http://127.0.0.1:5733")).toBe("http://127.0.0.1:5733");
    expect(hostedAppOrigin("  https://app.example.com/pair?x=1 ")).toBe("https://app.example.com");
  });

  it("rejects a missing or malformed backend host", () => {
    expect(() =>
      buildHostedPairingUrl({ host: "", token: "t", hostedAppUrl: "https://app.example.com" }),
    ).toThrow();
    expect(() =>
      buildHostedPairingUrl({
        host: "javascript:alert(1)",
        token: "t",
        hostedAppUrl: "https://app.example.com",
      }),
    ).toThrow();
  });
});
