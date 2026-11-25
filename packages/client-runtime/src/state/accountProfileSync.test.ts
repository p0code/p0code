import {
  AccountProfileId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { createAccountProfileSync } from "./accountProfileSync.ts";

const personal = AccountProfileId.make("profile-1");
const work = AccountProfileId.make("profile-2");
const remote = EnvironmentId.make("remote");
const cloud = EnvironmentId.make("cloud");

function settings(activeAccountProfileId: AccountProfileId | null): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    accountProfiles: [personal, work].map((id) => ({
      id,
      name: id,
      instanceOrder: [],
      excludedInstanceIds: [],
      autoSwitchOnLimit: false,
    })),
    activeAccountProfileId,
  };
}

function harness(saved = true) {
  const writes: Array<[EnvironmentId, ServerSettingsPatch]> = [];
  const failed: EnvironmentId[] = [];
  const sync = createAccountProfileSync({
    write: (environmentId, patch) => {
      writes.push([environmentId, patch]);
      return Promise.resolve(saved);
    },
    onFailed: (environmentId) => failed.push(environmentId),
  });
  return { sync, writes, failed };
}

describe("createAccountProfileSync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces quick switches into one write per target", async () => {
    const { sync, writes } = harness();
    const targets = [
      { environmentId: remote, settings: settings(personal) },
      { environmentId: cloud, settings: settings(work) },
    ];
    sync.update({ source: settings(work), targets });
    sync.update({ source: settings(personal), targets });
    sync.update({ source: settings(work), targets });
    await vi.runAllTimersAsync();
    expect(writes).toEqual([[remote, { activeAccountProfileId: work }]]);
  });

  it("writes once per source change, not on every target update", async () => {
    const { sync, writes } = harness();
    const source = settings(work);
    sync.update({ source, targets: [{ environmentId: remote, settings: settings(personal) }] });
    await vi.runAllTimersAsync();
    // The target changing on its own (or the write not landing yet) does not re-trigger.
    sync.update({ source, targets: [{ environmentId: remote, settings: settings(personal) }] });
    await vi.runAllTimersAsync();
    expect(writes).toHaveLength(1);
  });

  it("syncs again after the target reconnects", async () => {
    const { sync, writes } = harness();
    const source = settings(work);
    const target = { environmentId: remote, settings: settings(personal) };
    sync.update({ source, targets: [target] });
    await vi.runAllTimersAsync();
    sync.update({ source, targets: [] });
    await vi.runAllTimersAsync();
    sync.update({ source, targets: [target] });
    await vi.runAllTimersAsync();
    expect(writes).toHaveLength(2);
  });

  it("waits for the primary to connect", async () => {
    const { sync, writes } = harness();
    sync.update({ source: null, targets: [{ environmentId: remote, settings: settings(work) }] });
    await vi.runAllTimersAsync();
    expect(writes).toEqual([]);
  });

  it("reports a failing environment once", async () => {
    const { sync, failed } = harness(false);
    const targets = [{ environmentId: remote, settings: settings(personal) }];
    sync.update({ source: settings(work), targets });
    await vi.runAllTimersAsync();
    sync.update({ source: { ...settings(work), activeAccountProfileId: null }, targets });
    await vi.runAllTimersAsync();
    expect(failed).toEqual([remote]);
  });
});
