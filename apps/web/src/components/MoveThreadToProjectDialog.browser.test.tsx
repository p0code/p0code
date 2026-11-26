import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

// The popup sits above the dialog's backdrop only with the app's styles.
import "~/index.css";

import { render } from "../../test/render";
import {
  MoveThreadToProjectDialog,
  openMoveThreadToProjectDialog,
  moveThreadToProjectDialogIsOpenFor,
} from "./MoveThreadToProjectDialog";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

const projects = [
  {
    environmentId: "environment-1",
    id: ProjectId.make("project-repo"),
    title: "Repo",
    workspaceRoot: "/repo",
    isGitRepository: true,
  },
  {
    environmentId: "environment-1",
    id: ProjectId.make("project-docs"),
    title: "Docs",
    workspaceRoot: "/docs",
    isGitRepository: false,
  },
];

const thread = {
  projectId: ProjectId.make("project-scratch"),
  worktreePath: "/scratch/notes-a1b2",
};

function renderDialog(onConfirm = vi.fn(async () => true), onClose = vi.fn()) {
  return render(
    <MoveThreadToProjectDialog
      projects={projects}
      thread={thread}
      onClose={onClose}
      onConfirm={onConfirm}
    />,
  );
}

describe("MoveThreadToProjectDialog", () => {
  it("opens for the thread it was asked for", () => {
    const ref = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
    openMoveThreadToProjectDialog(ref);
    expect(moveThreadToProjectDialogIsOpenFor(ref)).toBe(true);
    expect(
      moveThreadToProjectDialogIsOpenFor(
        scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-2")),
      ),
    ).toBe(false);
  });

  it("shows each project's root and whether it is a git repository", async () => {
    await using screen = await renderDialog();
    await expect.element(screen.getByText("Repo")).toBeInTheDocument();
    await expect.element(screen.getByText("/repo")).toBeInTheDocument();
    await expect.element(screen.getByText("Git repository")).toBeInTheDocument();
    await expect.element(screen.getByText("Not a git repository")).toBeInTheDocument();
    // The thread's own project is not a destination.
    await expect.element(screen.getByText("No project")).not.toBeInTheDocument();
  });

  it("defaults to the project folder and confirms with a summary", async () => {
    const onConfirm = vi.fn(async () => true);
    await using screen = await renderDialog(onConfirm);
    await userEvent.click(screen.getByText("Repo"));

    await expect.element(screen.getByText("Where should it work?")).toBeInTheDocument();
    await expect
      .element(screen.getByText("The project becomes Repo, working in that project's folder."))
      .toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Use the project folder/ })).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Move thread" }));
    await vi.waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        projectId: ProjectId.make("project-repo"),
        workspace: "project-root",
        acceptOutOfTree: false,
      }),
    );
  });

  it("warns when keeping an out-of-tree folder and accepts it on confirm", async () => {
    const onConfirm = vi.fn(async () => true);
    await using screen = await renderDialog(onConfirm);
    await userEvent.click(screen.getByText("Repo"));
    await userEvent.click(screen.getByRole("radio", { name: /Keep its current folder/ }));

    await expect
      .element(
        screen.getByText("This folder is outside the project. The chat keeps working there."),
      )
      .toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Move thread" }));
    await vi.waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({
        projectId: ProjectId.make("project-repo"),
        workspace: "keep",
        acceptOutOfTree: true,
      }),
    );
  });

  it("keeps the dialog open and shows no success when the move fails", async () => {
    const onConfirm = vi.fn(async () => false);
    await using screen = await renderDialog(onConfirm);
    await userEvent.click(screen.getByText("Repo"));
    await userEvent.click(screen.getByRole("button", { name: "Move thread" }));

    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Move thread" })).toBeEnabled();
  });
});
