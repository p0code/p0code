import type { ProjectId, ScopedThreadRef, ThreadMoveWorkspace } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg, T, useGT, Var } from "gt-react";
import {
  CheckIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderInputIcon,
  GitBranchIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { create } from "zustand";

import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { cn } from "~/lib/utils";
import { m } from "../i18n/messages";
import { readThreadShell, useProjects } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Radio, RadioGroup } from "./ui/radio-group";
import { ScrollArea } from "./ui/scroll-area";
import { canMoveThreadIntoProject, useThreadActions } from "../hooks/useThreadActions";

export interface MoveProjectChoice {
  readonly environmentId: string;
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly isGitRepository: boolean;
}

export interface MoveThreadSummary {
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
}

interface MoveRequest {
  readonly threadRef: ScopedThreadRef;
}

const useRequest = create<{ request: MoveRequest | null }>(() => ({ request: null }));

/** Opens the picker from the thread menu or the No project empty state. */
export function openMoveThreadToProjectDialog(threadRef: ScopedThreadRef): void {
  useRequest.setState({ request: { threadRef } });
}

export function moveThreadToProjectDialogIsOpenFor(threadRef: ScopedThreadRef): boolean {
  const request = useRequest.getState().request;
  return (
    request !== null &&
    request.threadRef.environmentId === threadRef.environmentId &&
    request.threadRef.threadId === threadRef.threadId
  );
}

function close() {
  useRequest.setState({ request: null });
}

function isWithin(candidate: string, root: string): boolean {
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  return (
    candidate === normalizedRoot ||
    candidate.startsWith(`${normalizedRoot}/`) ||
    candidate.startsWith(`${normalizedRoot}\\`)
  );
}

export function MoveThreadToProjectDialogHost() {
  const request = useRequest((state) => state.request);
  const projects = useProjects();
  const router = useRouter();
  const { moveThreadToProject } = useThreadActions();
  const threadRef = request?.threadRef ?? null;
  const thread = threadRef === null ? null : readThreadShell(threadRef);
  if (threadRef === null || thread === null || !canMoveThreadIntoProject(threadRef)) return null;

  const choices: ReadonlyArray<MoveProjectChoice> = projects
    .filter(
      (project) =>
        project.environmentId === threadRef.environmentId &&
        project.id !== thread.projectId &&
        project.archivedAt == null,
    )
    .map((project) => ({
      environmentId: project.environmentId,
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
      isGitRepository: project.repositoryIdentity != null,
    }));

  return (
    <MoveThreadToProjectDialog
      projects={choices}
      thread={{ projectId: thread.projectId, worktreePath: thread.worktreePath }}
      onClose={close}
      onConfirm={async (selection) => {
        const result = await moveThreadToProject(threadRef, selection);
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            const error = squashAtomCommandFailure(result);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: m(msg("Could not move the thread")),
                description: thrownErrorMessage(error, m) ?? m(msg("An error occurred.")),
              }),
            );
          }
          return false;
        }
        close();
        toastManager.add({ type: "success", title: m(msg("Thread moved")) });
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
        return true;
      }}
    />
  );
}

export function MoveThreadToProjectDialog({
  projects,
  thread,
  onClose,
  onConfirm,
}: {
  readonly projects: ReadonlyArray<MoveProjectChoice>;
  readonly thread: MoveThreadSummary;
  readonly onClose: () => void;
  readonly onConfirm: (selection: {
    readonly projectId: ProjectId;
    readonly workspace: ThreadMoveWorkspace;
    readonly acceptOutOfTree: boolean;
  }) => Promise<boolean>;
}) {
  const gt = useGT();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<ThreadMoveWorkspace | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = projects.find((project) => project.id === projectId) ?? null;
  const currentProject = projects.find((project) => project.id === thread.projectId) ?? null;
  const threadCwd = thread.worktreePath ?? currentProject?.workspaceRoot ?? null;
  const insideProject =
    selected !== null && threadCwd !== null && isWithin(threadCwd, selected.workspaceRoot);
  const defaultWorkspace: ThreadMoveWorkspace =
    insideProject && thread.worktreePath !== null ? "keep" : "project-root";
  const resolvedWorkspace = workspace ?? defaultWorkspace;
  const outOfTree = resolvedWorkspace === "keep" && thread.worktreePath !== null && !insideProject;

  const chooseProject = (project: MoveProjectChoice) => {
    setProjectId(project.id);
    setWorkspace(null);
  };
  const confirm = async () => {
    if (selected === null || busy) return;
    setBusy(true);
    const moved = await onConfirm({
      projectId: selected.id,
      workspace: resolvedWorkspace,
      acceptOutOfTree: outOfTree,
    });
    if (!moved) setBusy(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>Move to project</T>
          </DialogTitle>
          <DialogDescription>
            <T>Pick the project this chat should belong to.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col">
          <div className="flex min-h-0 flex-col gap-4">
            {projects.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                <T>Add another project first.</T>
              </p>
            ) : (
              <ScrollArea className="max-h-64 shrink-0">
                <div className="flex flex-col gap-1.5 pr-2">
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      aria-pressed={project.id === projectId}
                      disabled={busy}
                      onClick={() => chooseProject(project)}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                        project.id === projectId
                          ? "border-primary/50 bg-primary/5"
                          : "border-border hover:bg-muted/60",
                      )}
                    >
                      <span className="mt-0.5 text-muted-foreground">
                        {project.isGitRepository ? (
                          <FolderGit2Icon className="size-4" />
                        ) : (
                          <FolderIcon className="size-4" />
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium">{project.title}</span>
                        <span className="truncate font-mono text-2xs text-muted-foreground">
                          {project.workspaceRoot}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground">
                        {project.isGitRepository
                          ? gt("Git repository")
                          : gt("Not a git repository")}
                      </span>
                      {project.id === projectId ? (
                        <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
                      ) : null}
                    </button>
                  ))}
                </div>
              </ScrollArea>
            )}

            {selected === null ? null : (
              <>
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">
                    <T>Where should it work?</T>
                  </p>
                  <RadioGroup
                    value={resolvedWorkspace}
                    onValueChange={(next) => {
                      if (next === "keep" || next === "project-root" || next === "new-worktree") {
                        setWorkspace(next);
                      }
                    }}
                  >
                    {thread.worktreePath === null ? null : (
                      <WorkspaceOption
                        value="keep"
                        checked={resolvedWorkspace === "keep"}
                        icon={<FolderIcon className="size-4" />}
                        title={gt("Keep its current folder")}
                        detail={thread.worktreePath}
                        warning={
                          insideProject
                            ? null
                            : gt(
                                "This folder is outside the project. The chat keeps working there.",
                              )
                        }
                      />
                    )}
                    <WorkspaceOption
                      value="project-root"
                      checked={resolvedWorkspace === "project-root"}
                      icon={<FolderIcon className="size-4" />}
                      title={gt("Use the project folder")}
                      detail={selected.workspaceRoot}
                    />
                    <WorkspaceOption
                      value="new-worktree"
                      checked={resolvedWorkspace === "new-worktree"}
                      icon={<GitBranchIcon className="size-4" />}
                      title={gt("Create a new worktree")}
                      detail={
                        selected.isGitRepository
                          ? gt("A fresh checkout on a new branch, from this project.")
                          : gt("Needs a project with a Git repository.")
                      }
                      disabled={!selected.isGitRepository}
                    />
                  </RadioGroup>
                </div>

                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
                  <p className="font-medium">
                    <T>Keeps</T>
                  </p>
                  <p className="text-muted-foreground">
                    <T>
                      Its messages, attachments, drafts, model choice, links, schedule and
                      parent-child threads.
                    </T>
                  </p>
                  <p className="mt-2 font-medium">
                    <T>Changes</T>
                  </p>
                  <p className="text-muted-foreground">
                    {resolvedWorkspace === "keep" ? (
                      <T>
                        The project becomes <Var>{selected.title}</Var>. It keeps working in its
                        current folder.
                      </T>
                    ) : resolvedWorkspace === "new-worktree" ? (
                      <T>
                        The project becomes <Var>{selected.title}</Var>, and it moves onto a new
                        worktree.
                      </T>
                    ) : (
                      <T>
                        The project becomes <Var>{selected.title}</Var>, working in that project's
                        folder.
                      </T>
                    )}
                  </p>
                </div>
              </>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            <T>Cancel</T>
          </Button>
          <Button onClick={() => void confirm()} disabled={selected === null || busy}>
            <FolderInputIcon className="size-4" />
            {busy ? <T>Moving…</T> : <T>Move thread</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function WorkspaceOption({
  value,
  checked,
  icon,
  title,
  detail,
  warning,
  disabled,
}: {
  readonly value: ThreadMoveWorkspace;
  readonly checked: boolean;
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly warning?: string | null;
  readonly disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2",
        checked ? "border-primary/50 bg-primary/5" : "border-border",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <Radio value={value} disabled={disabled} className="mt-0.5" />
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="truncate font-mono text-2xs text-muted-foreground">{detail}</span>
        {warning === null || warning === undefined ? null : (
          <span className="text-2xs text-warning">{warning}</span>
        )}
      </span>
    </label>
  );
}
