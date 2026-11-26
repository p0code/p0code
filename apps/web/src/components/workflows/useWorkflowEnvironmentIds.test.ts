import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workflowEnvironmentIds } from "./useWorkflowEnvironmentIds";

const laptop = EnvironmentId.make("environment:laptop");
const school = EnvironmentId.make("environment:school");
const vps = EnvironmentId.make("environment:vps");

describe("workflowEnvironmentIds", () => {
  it("keeps workflows on allowed machines and drops excluded ones", () => {
    expect(
      workflowEnvironmentIds(
        [laptop, school, vps],
        new Set([laptop, school, vps]),
        new Set([school]),
      ),
    ).toEqual([laptop, vps]);
  });

  it("still requires workflows to be enabled", () => {
    expect(workflowEnvironmentIds([laptop, school], new Set([laptop]), new Set([school]))).toEqual([
      laptop,
    ]);
  });

  it("leaves every connected machine when the profile hides none", () => {
    expect(workflowEnvironmentIds([laptop, school], new Set([laptop, school]), new Set())).toEqual([
      laptop,
      school,
    ]);
  });
});
