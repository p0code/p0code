import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";

export type RelayLinkFormState = {
  readonly advanced: boolean;
  readonly pending: boolean;
  readonly error: string | null;
};
export const initialRelayLinkFormState: RelayLinkFormState = {
  advanced: false,
  pending: false,
  error: null,
};
export function relayLinkFormReducer(
  state: RelayLinkFormState,
  action: { type: "start" | "success" | "toggle" } | { type: "failure"; error: string },
): RelayLinkFormState {
  if (action.type === "start") return { ...state, pending: true, error: null };
  if (action.type === "success") return { ...state, pending: false, error: null };
  if (action.type === "failure") return { ...state, pending: false, error: action.error };
  return state.pending ? state : { ...state, advanced: !state.advanced, error: null };
}
export function relayLinkErrorMessage(error: unknown, resolve: MessageResolver = m): string {
  const message = error instanceof Error ? error.message : "";
  switch (message) {
    case "Wrong username or password":
      return resolve(msg("Wrong username or password"));
    case "The relay slug or public key is already linked to another environment.":
      return resolve(msg("The relay slug or public key is already linked to another environment."));
    case "Enter an HTTPS relay URL (HTTP is allowed only on loopback).":
      return resolve(msg("Enter an HTTPS relay URL (HTTP is allowed only on loopback)."));
    case "Could not reach the relay. Check the URL and your network connection.":
      return resolve(msg("Could not reach the relay. Check the URL and your network connection."));
    default:
      return resolve(msg("Could not link the relay. Check your relay settings and try again."));
  }
}
