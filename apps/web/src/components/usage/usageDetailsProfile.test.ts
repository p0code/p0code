import {
  AccountProfileId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  UsageDay,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { newAccountProfile } from "@t3tools/shared/accountProfiles";
import { usageDetailsInActiveProfile } from "./usageDetailsProfile";

const project = ProjectId.make("project-shared");
const personal = AccountProfileId.make("personal");
const work = AccountProfileId.make("work");
const personalProject = ProjectId.make("project-personal");
const personalThread = ThreadId.make("thread-personal");
const workThread = ThreadId.make("thread-work");

const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  accountProfiles: [
    newAccountProfile(personal, "Personal", []),
    newAccountProfile(work, "Work", []),
  ],
  activeAccountProfileId: work,
  projectAccountProfileIds: { [project]: work, [personalProject]: personal },
  threadAccountProfileIds: { [personalThread]: personal },
};

const row = (
  threadId: typeof personalThread,
  projectId: typeof project,
  records: number,
  costUsd: number,
) => ({
  day: UsageDay.make("2026-11-20"),
  threadId,
  title: "Thread",
  projectId,
  project: "Shared",
  provider: "Claude",
  account: "Personal",
  model: "Opus",
  uncachedInputTokens: 10,
  cachedInputTokens: 20,
  cacheCreationTokens: 30,
  outputTokens: 40,
  reasoningTokens: 50,
  records,
  costUsd,
  unpricedRecords: 0,
});

describe("usageDetailsInActiveProfile", () => {
  it("drops rows the active profile hides and recomputes the page totals", () => {
    const data = {
      rows: [row(personalThread, personalProject, 2, 1.5), row(workThread, project, 3, 2.25)],
      totalRows: 9,
      totals: {
        uncachedInputTokens: 20,
        cachedInputTokens: 40,
        cacheCreationTokens: 60,
        outputTokens: 80,
        reasoningTokens: 100,
        records: 5,
        costUsd: 3.75,
        unpricedRecords: 0,
      },
    };

    const filtered = usageDetailsInActiveProfile(data, settings);

    expect(filtered.rows.map((entry) => entry.threadId)).toEqual([workThread]);
    expect(filtered.totals).toEqual({
      uncachedInputTokens: 10,
      cachedInputTokens: 20,
      cacheCreationTokens: 30,
      outputTokens: 40,
      reasoningTokens: 50,
      records: 3,
      costUsd: 2.25,
      unpricedRecords: 0,
    });
    // Paging still sees the server's whole result, not just this page's visible rows.
    expect(filtered.totalRows).toBe(9);
  });

  it("leaves usage from environments without profile separation untouched", () => {
    const data = {
      rows: [row(personalThread, personalProject, 1, 1)],
      totalRows: 1,
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 30,
        outputTokens: 40,
        reasoningTokens: 50,
        records: 1,
        costUsd: 1,
        unpricedRecords: 0,
      },
    };

    expect(usageDetailsInActiveProfile(data, null)).toBe(data);
  });
});
