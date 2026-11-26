import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

vi.mock("~/state/server", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    serverEnvironment: {
      projectCost: () =>
        Atom.make(
          AsyncResult.success({
            project: { costUsd: 580.72, partial: true, unpricedModels: [] },
            thread: { costUsd: 1.25, partial: false, unpricedModels: [] },
          }),
        ),
    },
  };
});

import { ThreadDetailsCost } from "./ThreadDetailsUsage";

const target = {
  environmentId: EnvironmentId.make("environment"),
  projectId: ProjectId.make("project-scratch"),
  threadId: ThreadId.make("thread-hello"),
};

describe("ThreadDetailsCost", () => {
  it("shows only the thread's own spend for a No project thread", async () => {
    await using screen = await render(
      <ThreadDetailsCost target={{ ...target, isScratch: true }} />,
    );

    await expect.element(screen.getByText("This thread")).toBeVisible();
    await expect.element(screen.getByText("$1.25")).toBeVisible();
    await expect.element(page.getByText("This project")).not.toBeInTheDocument();
    await expect.element(page.getByText("~$580.72")).not.toBeInTheDocument();
  });

  it("keeps the project and thread rows for a real project", async () => {
    await using screen = await render(
      <ThreadDetailsCost target={{ ...target, isScratch: false }} />,
    );

    await expect.element(screen.getByText("This project")).toBeVisible();
    await expect.element(screen.getByText("~$580.72")).toBeVisible();
    await expect.element(screen.getByText("This thread")).toBeVisible();
    await expect.element(screen.getByText("$1.25")).toBeVisible();
  });
});
