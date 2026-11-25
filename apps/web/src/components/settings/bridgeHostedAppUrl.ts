import type { BridgeStatus } from "@t3tools/plugin-t3-connect-bridge/actions";

/**
 * The hosted app a running bridge opens, or null when it cannot back a pairing QR. A failed
 * tunnel or a bridge error means the hosted app cannot reach this environment, so the QR would
 * be broken even if one is configured.
 */
export function hostedAppUrlFromBridgeStatus(status: BridgeStatus | null): string | null {
  if (status === null || status.error !== null || status.tunnel === "failed") return null;
  return status.config.hostedAppUrl.trim() || null;
}
