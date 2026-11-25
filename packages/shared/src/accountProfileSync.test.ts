import {
  type AccountProfile,
  AccountProfileId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { syncedAccountProfilesPatch } from "./accountProfiles.ts";

const personalId = AccountProfileId.make("profile-1");
const workId = AccountProfileId.make("profile-2");
const macAccount = ProviderInstanceId.make("claudeMac");
const remoteAccount = ProviderInstanceId.make("claudeRemote");

function profile(id: AccountProfileId, name: string, extra: Partial<AccountProfile> = {}) {
  return {
    id,
    name,
    instanceOrder: [],
    excludedInstanceIds: [],
    autoSwitchOnLimit: false,
    ...extra,
  } satisfies AccountProfile;
}

function settings(patch: Partial<ServerSettings>): ServerSettings {
  return { ...DEFAULT_SERVER_SETTINGS, ...patch };
}

const personal = profile(personalId, "Personal");
const work = profile(workId, "Work");
const source = settings({ accountProfiles: [personal, work], activeAccountProfileId: personalId });

describe("syncedAccountProfilesPatch", () => {
  it("is a no-op when the target already matches", () => {
    expect(syncedAccountProfilesPatch(source, source)).toBeUndefined();
  });

  it("ignores key order when comparing", () => {
    const reversed = (entry: AccountProfile): AccountProfile => ({
      autoSwitchOnLimit: entry.autoSwitchOnLimit,
      excludedInstanceIds: entry.excludedInstanceIds,
      instanceOrder: entry.instanceOrder,
      name: entry.name,
      id: entry.id,
    });
    const reordered = settings({
      accountProfiles: source.accountProfiles.map(reversed),
      activeAccountProfileId: personalId,
    });
    expect(syncedAccountProfilesPatch(source, reordered)).toBeUndefined();
  });

  it("adds profiles with empty per-environment account lists", () => {
    const withOrder = settings({
      accountProfiles: [
        personal,
        profile(workId, "Work", {
          instanceOrder: [macAccount],
          excludedInstanceIds: [macAccount],
        }),
      ],
      activeAccountProfileId: personalId,
    });
    expect(syncedAccountProfilesPatch(withOrder, settings({}))).toEqual({
      accountProfiles: [personal, work],
      activeAccountProfileId: personalId,
    });
  });

  it("renames while keeping the target's account order and exclusions", () => {
    const target = settings({
      accountProfiles: [
        personal,
        profile(workId, "Office", {
          instanceOrder: [remoteAccount],
          excludedInstanceIds: [remoteAccount],
          autoSwitchOnLimit: true,
        }),
      ],
      activeAccountProfileId: personalId,
    });
    expect(syncedAccountProfilesPatch(source, target)).toEqual({
      accountProfiles: [
        personal,
        profile(workId, "Work", {
          instanceOrder: [remoteAccount],
          excludedInstanceIds: [remoteAccount],
        }),
      ],
    });
  });

  it("follows the active profile switch", () => {
    const switched = settings({ ...source, activeAccountProfileId: workId });
    expect(syncedAccountProfilesPatch(switched, source)).toEqual({
      activeAccountProfileId: workId,
    });
  });

  it("removes a deleted profile and moves the target off it", () => {
    const target = settings({ accountProfiles: [personal, work], activeAccountProfileId: workId });
    const afterDelete = settings({
      accountProfiles: [personal],
      activeAccountProfileId: personalId,
    });
    expect(syncedAccountProfilesPatch(afterDelete, target)).toEqual({
      accountProfiles: [personal],
      activeAccountProfileId: personalId,
    });
  });

  it("never touches project or thread filing", () => {
    const target = settings({
      ...source,
      activeAccountProfileId: workId,
      projectAccountProfileIds: { [ProjectId.make("project")]: workId },
      threadAccountProfileIds: { [ThreadId.make("thread")]: workId },
    });
    expect(syncedAccountProfilesPatch(source, target)).toEqual({
      activeAccountProfileId: personalId,
    });
  });

  it("keeps the target's default model when it can't run the source's", () => {
    const remoteModel = { instanceId: remoteAccount, model: "claude-opus" };
    const target = settings({
      accountProfiles: [profile(personalId, "Personal", { defaultModelSelection: remoteModel })],
      activeAccountProfileId: personalId,
    });
    const withMacModel = settings({
      accountProfiles: [
        profile(personalId, "Personal", {
          defaultModelSelection: { instanceId: macAccount, model: "claude-opus" },
        }),
      ],
      activeAccountProfileId: personalId,
    });
    expect(syncedAccountProfilesPatch(withMacModel, target)).toBeUndefined();
  });

  it("spreads a default model the target can run", () => {
    const defaultModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    };
    const withModel = settings({
      accountProfiles: [profile(personalId, "Personal", { defaultModelSelection })],
      activeAccountProfileId: personalId,
    });
    expect(
      syncedAccountProfilesPatch(withModel, settings({ ...source, accountProfiles: [personal] })),
    ).toEqual({ accountProfiles: [profile(personalId, "Personal", { defaultModelSelection })] });
  });

  it("never wipes a target from a source without profiles", () => {
    expect(syncedAccountProfilesPatch(settings({}), source)).toBeUndefined();
  });
});
