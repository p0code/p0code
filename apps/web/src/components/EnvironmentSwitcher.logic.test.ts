import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentPresentation } from "../state/environments";
import {
  buildEnvironmentSwitcherItems,
  buildEnvironmentSwitchActions,
} from "./EnvironmentSwitcher.logic";
import { environmentShortLabel } from "./environmentLabel";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
function environment(
  id: EnvironmentId,
  phase: EnvironmentPresentation["connection"]["phase"],
): EnvironmentPresentation {
  const target =
    id === local
      ? new PrimaryConnectionTarget({
          environmentId: id,
          label: "Laptop",
          httpBaseUrl: "http://localhost",
          wsBaseUrl: "ws://localhost/ws",
        })
      : new BearerConnectionTarget({ environmentId: id, label: "Remote", connectionId: "remote" });
  return {
    environmentId: id,
    label: target.label,
    displayUrl: null,
    relayManaged: false,
    entry: { target, profile: Option.none(), enabled: true },
    connection: { phase, error: phase === "error" ? "Credential expired" : null, traceId: null },
    serverConfig: null,
    refusedRouteIds: [],
  };
}
const availableEnvironments = [local, remote].map((environmentId) => ({
  environmentId,
  label: environmentId,
  machine: "server" as const,
  projectId: null,
  isPrimary: environmentId === local,
}));
const link: PeerLinkSummary = {
  environmentId: EnvironmentId.make("linked"),
  label: "Linked server",
  urls: ["https://remote.example"],
  access: "full-access",
  linkedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(0),
  lastReachedAt: null,
  lastError: null,
  status: "expired",
};

describe("environment switching", () => {
  it("lists saved and linked machines, marks current and explains unavailable choices", () => {
    const items = buildEnvironmentSwitcherItems({
      environments: [environment(local, "connected"), environment(remote, "error")],
      links: [link],
      currentEnvironmentId: local,
      availableEnvironments,
      canChange: true,
    });
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ environmentId: local, current: true, status: "online" });
    expect(items.find((item) => item.environmentId === remote)).toMatchObject({
      disabled: true,
      status: "offline",
      remote: true,
      detail: "Connection failed. Reason: Credential expired",
    });
    expect(items.find((item) => item.environmentId === link.environmentId)).toMatchObject({
      disabled: true,
      detail: "Link credential expired",
    });
  });

  it("commands switch only eligible drafts and leave locked threads on their machine", async () => {
    const onChange = vi.fn();
    const input = {
      environments: [environment(local, "connected"), environment(remote, "connected")],
      links: [link],
      currentEnvironmentId: local,
      availableEnvironments,
      canChange: true,
    };
    const actions = buildEnvironmentSwitchActions(buildEnvironmentSwitcherItems(input), onChange);
    expect(actions.find((item) => item.checked)?.title).toBe("Switch environment: Laptop");
    const action = actions.find((item) => item.value.endsWith(":remote"))!;
    expect(action.shortcutCommand).toBe("environment.switch");
    await action.run();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(remote);
    onChange.mockClear();
    for (const action of buildEnvironmentSwitchActions(
      buildEnvironmentSwitcherItems({ ...input, canChange: false }),
      onChange,
    ))
      await action.run();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the distinguishing suffix while shortening long labels", () => {
    expect(environmentShortLabel("  Mini PC  ")).toBe("Mini PC");
    const label = "Howard's Macbook Pro M4 (production server)";
    const short = environmentShortLabel(label);
    expect(short.length).toBeLessThanOrEqual(32);
    expect(short).toContain("…");
    expect(short.endsWith("duction server)")).toBe(true);
  });
});
