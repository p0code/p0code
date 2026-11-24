import type { SupervisorConnectionState, ConnectionHop } from "./model.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
export type ConnectionHopResult = "ok" | "failed" | "unchecked";
export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}
export interface ConnectionDiagnosis {
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [string, string]>;
  readonly moreInfoUrl: string | null;
}
export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  readonly via: "relay" | "direct";
  readonly relayStatus?: null;
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
}
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
  resolve: MFunctionType = mFallback,
): ConnectionDiagnosis | null {
  const failure = input.state.lastFailure;
  if (failure === null && input.state.phase !== "offline") return null;
  const hop = failure?.hop ?? (input.state.network === "offline" ? "device" : "server");
  return {
    headline: failure?.detail ?? resolve(msg("This device is offline")),
    hops: [{ hop, label: input.hostLabel, result: "failed" }],
    steps: [
      resolve(
        msg(
          "Check the server is running and the saved address is reachable. Pair again if its access was revoked.",
        ),
      ),
    ],
    facts: [
      [resolve(msg("Route", { $context: "diagnostics field label" })), input.via],
      ...(input.serverVersion
        ? [[resolve(msg("Host version")), input.serverVersion] as const]
        : []),
    ],
    moreInfoUrl: null,
  };
}
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `T3 Code connection to ${hostLabel}: ${diagnosis.headline}`,
    ...diagnosis.steps,
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
  ].join("\n");
}
