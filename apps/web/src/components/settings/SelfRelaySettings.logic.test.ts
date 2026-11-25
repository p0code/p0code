import { describe, expect, it } from "vite-plus/test";
import {
  initialRelayLinkFormState,
  relayLinkFormReducer,
  relayLinkErrorMessage,
} from "./SelfRelaySettings.logic";

describe("relay account form", () => {
  it("clears errors while pending and finishes successfully", () => {
    const failed = relayLinkFormReducer(initialRelayLinkFormState, {
      type: "failure",
      error: "Wrong username or password",
    });
    const pending = relayLinkFormReducer(failed, { type: "start" });
    expect(pending).toEqual({ advanced: false, pending: true, error: null });
    expect(relayLinkFormReducer(pending, { type: "toggle" })).toBe(pending);
    expect(relayLinkFormReducer(pending, { type: "success" })).toEqual(initialRelayLinkFormState);
  });
  it("shows a wrong-password error and clears it when switching to advanced enrollment", () => {
    const error = relayLinkErrorMessage(new Error("Wrong username or password"));
    const failed = relayLinkFormReducer(
      { ...initialRelayLinkFormState, pending: true },
      { type: "failure", error },
    );
    expect(failed).toEqual({
      advanced: false,
      pending: false,
      error: "Wrong username or password",
    });
    const advanced = relayLinkFormReducer(failed, { type: "toggle" });
    expect(advanced).toEqual({ advanced: true, pending: false, error: null });
    expect(relayLinkFormReducer(advanced, { type: "toggle" })).toEqual(initialRelayLinkFormState);
    expect(relayLinkErrorMessage(new Error("unexpected secret-password"))).toBe(
      "Could not link the relay. Check your relay settings and try again.",
    );
  });
});
