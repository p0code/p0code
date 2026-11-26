# Projects with several repositories

A single T3 Code project can span multiple Git repositories so one thread can read and edit all of them. This supports:

- A plain folder containing multiple repositories (e.g. `shop/api` and `shop/web`)
- A repository paired with external sibling repositories anywhere on disk
- A repository with Git submodules

The project folder itself does not need to be a Git repository.

## Discovery and configuration

There is no list to keep. A project covers every repository inside its folder: p0code looks one
level down, and one level further inside folders that are not repositories themselves, such as
`src` or `packages`. It reads the disk each time, so a repository you clone there is part of the
project straight away, and one you delete is gone from it. Worktrees of another repository are left
out.

**Settings → Projects → Repositories** shows what the project covers on each machine.

### Folders outside the project

A repository somewhere else on the machine has to be added, because adding it lets agents work in a
place they could not reach before.

- On web and desktop, use **Add folder** under **Repositories**.
- If the project folder has a `.code-workspace` file, the folders it lists outside the project are
  offered there with an **Add** button, on mobile too.
- From a script, `p0 project add <path> --track <folder>` adds one.

**Remove** takes an added folder out of the project. It never deletes files. Added folders are
paths on one machine, so the same project on another machine has its own. A project can cover up to
128 folders.

### Leave a repository out

To keep a repository inside the project folder out of the project, name it in the `t3.json` in the
project folder, relative to that folder:

```json
{
  "ignoreRepositories": ["vendor/big"]
}
```

- **Submodules**: Checked out automatically when creating a worktree. If checkout fails, run `git submodule update --init` in the thread folder. Modified submodules appear as their own repository for diffs and Git actions, while the parent shows the updated pin.

## Review, commit, and open pull requests

- **Turn diffs**: Each turn groups changed files by repository. In the Diff pane (web/desktop), **Uncommitted**, **Changes**, and **Commits** read one repository at a time via the repository picker. See [Review turn changes](./source-control.md#review-turn-changes).
- **Git actions**: Commit, push, and PR actions run per repository—expand a repository in the thread details panel (web/desktop) or open **Git controls** (mobile). Use **Other repositories…** to include untouched repos. PRs link under their own repository.

## Worktree threads

**New worktree** creates a thread folder matching the project layout, giving each selected repository its own worktree on the thread's branch.

- Choose repositories from the repositories control next to the workspace picker before sending (all repos are selected by default when there are 8 or fewer; none when more; repos with no commits are excluded).
- Add more repositories to a running thread from **Other repositories…** (web/desktop) or the mobile Git sheet.
- Each repository branches from the thread's base branch if it has one, otherwise its own default branch.
- In a plain project folder, files outside repositories are linked (shared) rather than copied—editing them affects all threads.

### Custom worktree layout

For custom workspace generation (e.g., per-thread build dirs or submodule setup), declare `worktreeLayout` in the project folder's `t3.json`:

```json
{
  "worktreeLayout": {
    "create": "./scripts/new-workspace.sh",
    "remove": "./scripts/remove-workspace.sh"
  }
}
```

`create` runs in the project folder (10-minute timeout, serialized per project) with these environment variables:

| Variable                   | Value                                         |
| -------------------------- | --------------------------------------------- |
| `T3_PROJECT_ROOT`          | The project folder.                           |
| `T3_WORKTREE_ROOT`         | Empty folder to populate for this thread.     |
| `T3_WORKTREE_PROJECT_PATH` | Target path for the project folder inside it. |
| `T3_WORKTREE_BRANCH`       | The thread's branch name.                     |
| `T3_WORKTREE_BASE`         | Base branch, or empty if none.                |
| `T3_WORKTREE_REPOSITORIES` | Selected repositories, one path per line.     |

Every repository of the project that the command checks out at the same relative place becomes the
thread's checkout of it. `remove` is optional and runs before p0code removes whatever is left.

- Create linked worktrees on `T3_WORKTREE_BRANCH` via `git worktree add` (clones or other branches are rejected).
- `create` must be idempotent (if re-run when a folder is missing, check out the existing branch). Failed `create` runs roll back created checkouts.
- `remove` (optional) runs before T3 Code cleans up and should handle partially missing folders and delete generated files.

- **Checkouts are linked worktrees on the thread's branch.** Make each one with
  `git worktree add` from the repository it belongs to, on `T3_WORKTREE_BRANCH`. p0code later
  removes, restores, and renames these through Git, so it refuses a clone or a checkout on another
  branch and the thread does not start.
- **`create` can run more than once.** It runs again when a thread's folder has gone missing, by
  which time the branch already exists. Check the branch out when it is there and create it
  otherwise.
- **`remove` can run on a folder that is partly gone**, such as after a failed `create` or an
  earlier cleanup. Storage cleanup never deletes files that exist only in the thread's folder, so
  `remove` should delete what `create` generated.
- **A failed `create` is rolled back.** Checkouts it already made are removed.
- **One command runs at a time per project**, so a command can update a shared file in the project
  folder without its own locking.
- **Each command has ten minutes.**
- **The commands run only for requests that may run commands on the host.** A client paired
  without `orchestration:operate` and `terminal:operate`, and a thread started through a
  [linked environment](remote-access.md#link-another-environment) paired below full access, get no worktree in a project
  that declares a layout, and their cleanup leaves `remove` out.

#### Approve the commands

p0code runs `create` and `remove` only after you have approved them. The first time you start a
worktree thread in the project from the web or desktop app, it shows both commands in full and asks.
**Approve and continue** records the approval and starts the thread; **Cancel** leaves your draft as
it was. You can also review, approve, and revoke each command under **Worktree layout** in the
project's settings. Approving needs a client that can use the terminal (`terminal:operate`).

An approval is kept on the environment, not in the repository, and covers the exact text of one
command for one project. When the text in `t3.json` changes, for example after a pull, the command
stops running until you approve the new text. An approval covers the command text only: when the
command runs a script file, later changes to that file do not ask again.

While a command is not approved:

- **Nothing that needs `create` gets a worktree.** A worktree thread started from the mobile app,
  by a scheduled task, or by an agent fails with a message that says so. Approve the command in the
  web or desktop app, then start it again.
- **A thread folder that went missing comes back as plain checkouts**, without the project's
  `create`.
- **Removing a thread's worktree skips `remove`** and removes the checkouts.

Agents never approve a command, and an approval is not enough for one that works below Full access.
When an agent hands its thread off to a worktree or starts a worktree thread, the commands run
only if the thread that asked is in Full access when they are about to run. Below that, or where an
administrator's [policy](managed-policy.md) does not allow Full access, a project that declares a
layout gets no worktree from the agent. In any project, an action set to **Run automatically on worktree
creation** does not run for a worktree an agent asked for below Full access. Start the worktree
thread yourself, or switch the thread to Full access.

An administrator can turn these commands off for a machine with
[`worktreeLayoutCommands`](managed-policy.md#other-capabilities).

A project with no other repository can declare a layout too. This example gives each thread
a worktree with its submodules checked out. The command runs in `sh`, and in `cmd.exe` on Windows,
so write it for the shell of the machine the project is on; this one is for `sh`:

```json
{
  "worktreeLayout": {
    "create": "(git worktree add \"$T3_WORKTREE_PROJECT_PATH\" \"$T3_WORKTREE_BRANCH\" 2>/dev/null || git worktree add -b \"$T3_WORKTREE_BRANCH\" \"$T3_WORKTREE_PROJECT_PATH\" ${T3_WORKTREE_BASE:-HEAD}) && git -C \"$T3_WORKTREE_PROJECT_PATH\" submodule update --init"
  }
}
```

#### Command approval and security

T3 Code prompts you to approve the exact `create` and `remove` command strings on web/desktop before running them (manage approvals in **Settings → Projects → Worktree layout**; requires `terminal:operate`). Approvals are stored per environment and invalidated if the command string in `t3.json` changes.

- Unapproved commands block worktree creation from mobile, scheduled tasks, and agents.
- Agents can never approve commands and must be in **Full access** to trigger `worktreeLayout` or worktree-creation setup scripts.
- Administrators can disable layout commands with [`worktreeLayoutCommands`](./managed-policy.md#other-capabilities).

## Rewind and limits

- **Rewind**: Restores every repository with an earlier snapshot. Plain-folder files outside repositories and repositories with no earlier snapshot keep their current contents (the rewind reports any skipped repos).
- **Limits**: Git actions run one repository at a time; only the project folder's `t3.json` is read; the Diff pane repository picker and plain-folder base branch field are web/desktop only.
