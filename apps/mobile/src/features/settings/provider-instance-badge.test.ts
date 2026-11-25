import { ProviderDriverKind, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { planProviderInstanceBadgeSave } from "./provider-instance-badge";

const claude = ProviderDriverKind.make("claudeAgent");
const work = ProviderInstanceId.make("claudeAgent_work");
const providerInstances: ServerSettings["providerInstances"] = {
  [work]: { driver: claude, displayName: "Work", instanceBadge: "W", config: { homePath: "~/w" } },
};
const plan = (badge: string, instanceId = work) =>
  planProviderInstanceBadgeSave({
    providerInstances,
    policy: undefined,
    instanceId,
    driver: claude,
    badge,
  });

describe("planProviderInstanceBadgeSave", () => {
  it("sets the badge and keeps the rest of the instance", () => {
    expect(plan(" 👩‍💻W2 ")).toEqual({
      mutation: {
        operation: "upsert",
        instanceId: work,
        instance: {
          driver: claude,
          displayName: "Work",
          instanceBadge: "👩‍💻W2",
          config: { homePath: "~/w" },
        },
      },
    });
  });

  it("clears the badge when left empty", () => {
    expect(plan("")).toEqual({
      mutation: {
        operation: "upsert",
        instanceId: work,
        instance: { driver: claude, displayName: "Work", config: { homePath: "~/w" } },
      },
    });
  });

  it("rejects more than three characters", () => {
    expect(plan("ABCD")).toEqual({ error: "Use up to 3 characters." });
  });

  it("writes a default instance that has no saved config yet", () => {
    const instanceId = ProviderInstanceId.make("claudeAgent");
    expect(plan("C", instanceId)).toEqual({
      mutation: {
        operation: "upsert",
        instanceId,
        instance: { driver: claude, instanceBadge: "C" },
      },
    });
  });
});
