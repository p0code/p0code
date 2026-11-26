# Working with threads

Use a new thread for a separate task. Choose **New worktree** when its code changes
need a separate branch and working directory. Threads in the same checkout share its
branch, so p0code refuses a branch switch there while one of them is working.

## Resize or hide the sidebar

On web and desktop, drag the sidebar's right edge to resize it. Continue left past its minimum
width to preview hiding it, then release to keep it hidden. Dragging back right before releasing
shows it again and continues resizing.

Move the mouse to the middle of the left window edge to find a handle. Drag it right or click
it to show the sidebar again. Dragging back to the edge before releasing hides the preview
and leaves it hidden. The sidebar toggle and shortcut still keep it open.

## Start a thread

On web and desktop, **New thread** opens the project picker when you have more than one
open project in the default or project-grouped sidebar. Archived projects don't count. **Shift-click** to start in
the current project, or use a project's own new-thread action. A new thread carries
your model and mode selections, unless the destination project has its own model default.
Its branch and workspace mode come from your configured defaults. To continue in
an existing worktree, use **New thread in this worktree** from the branch toolbar.
While the sidebar is filtered to one project, the sidebar's **New thread** button
starts the thread in that project instead of asking which project to use.

On mobile, **New thread** starts in the current thread's project, or else in the
project the thread list is filtered to, or else in the last project you opened
or chose on that device. If none is available, the project picker opens. Turn
off **Settings → General → Use last project** to choose a project every time.
When you pick a project that is on more than one machine, the thread starts on
a connected one if any is connected.

When you change a new thread's project, p0code stays in the current environment
if that project exists there. Otherwise it selects an environment that has it.

### Start without a project

Threads don't require a project. Pick **No project** (or press `mod+alt+n` on web/desktop) to start a scratch thread in `~/.t3/scratch/<date>-<slug>-<id>`.

Each thread without a project works in its own folder under `~/.p0code/scratch` (the
`scratch` folder of your T3 data directory), named after its date, the first words
of its first message, and a short id, like
`2026-09-25-convert-these-pngs-to-webp-a1b2c3d4`. Deleting a thread keeps its
folder, so the files the agent wrote stay until you delete them. Branch, worktree, and diff controls stay hidden because
these folders are not Git repositories. This is unavailable when the data
directory itself sits inside a Git checkout.

### Start in the background and multi-model runs

- **Background start** (web/desktop): Press `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux) in a new thread to submit it and immediately open another draft with the same workspace mode and base branch.
- **Same prompt, multiple models** (web/desktop, Git projects): `Shift`-click models in a new thread's model picker to select several. Sending starts a separate thread and worktree for each model.

## Sidebar layout and organization

- **Resize or hide** (web/desktop): Drag the sidebar's right edge past its minimum width to hide it; hover the left window edge and click or drag the handle to bring it back.
- **Drop files onto a thread** (web/desktop): Drag files from your computer onto any thread row to open it and attach them to its composer.
- **Pin and reorder**: Pin a thread from its menu or drag threads between **Pinned**, **Active**, and **Settled** (or drag out of **Snoozed** to wake). On mobile, use **Arrange threads** or **Move up / Move down** in the thread menu. Custom order syncs across devices (requires an up-to-date server).
- **Undo** (web/desktop): Unpinning, settling, snoozing, archiving, or discarding a draft shows a 5-second **Undo** toast (`mod+z`).
- **Titles**: Choose **Regenerate title** from a thread's menu, or customize title style in **Settings → Threads → Text generation → Thread title instructions** (global or per-project).

### Working section (beta)

Enabled by default (**Settings → General → Working section**, per device). Unpinned threads that are actively running—or waiting on subagents, watched PRs, or monitors—collapse into a **Working** section below Active, and return to the top of Active when they finish, fail, or need input.

On web and desktop, unpinning, settling, snoozing, and archiving a thread each show
a notification with **Undo** for five seconds. Undo restores the thread's previous
state, including its pinned position, and reopens an archived thread you were
viewing. Discarding an unsent draft from the sidebar works the same way: Undo brings
back its text and attachments. `mod+z` triggers the most recent Undo, even from the composer; see
[Keybindings](./keybindings.md#commands-with-special-behavior).

On web and desktop, you can also drag files from your computer onto any thread row:
the thread opens and the files are attached in its composer, ready for
your next message. The same per-message file limits apply as when attaching
files directly; see [Attach files](./composer.md#attach-files).

On web and desktop, pinning or unpinning a thread keeps the sidebar at your current
scroll position instead of following the thread to its new place in the list.

Pinning does not prevent automatic settlement. Settling a thread removes its pin.

On web and desktop, drag a thread between sections to change its state. Drag a thread up into
the pinned section to pin it at the spot you drop it; drag a pinned thread down into the active
list to unpin it. Dragging a thread onto the **Settled** header settles it, and dragging a settled
thread into the active list un-settles it. A snoozed thread can be dragged out of the snoozed
shelf, which wakes it, but threads cannot be dragged into the shelf because snoozing needs a wake
time. Dragging a pinned thread out of the pinned section does not ask for unpin confirmation.
Pinned and active boundary labels appear only while dragging, without moving the rows. The
other rows slide aside to show where the thread will land. When you cross into another section,
the dragged thread shows the action the drop performs, with its icon: **Pin**, **Unpin**,
**Settle**, **Un-settle**, or **Wake**. Its status and hover actions hide during the drag. A pinned
thread keeps its pin only while it stays in the pinned section; once it leaves, the badge takes
over. Reordering within the same section shows no badge. When there are no pins, drag to the top
edge to pin a thread. Section labels stay readable for the whole drag, and the section the
thread is over takes the accent color. Section labels also
identify empty sections and a collapsed settled shelf.

Drag within the pinned or active section to change its order. Other rows slide aside to show the
spot where the thread will land. Drops into either section keep the position you choose. On
mobile, open a thread's menu and choose **Arrange threads**. Drag a handle within or between
**Pinned** and **Active** to reorder, pin, or unpin. Drop onto the **Settled** divider to
settle a thread. The dragged card shows the action before you release it. Expand **Snoozed**
or **Settled** to drag a parked thread back into either live section. Each drop saves; close the sheet to return to the thread list.
**Move up** and **Move down** are also available in the thread menu. The server
saves the order, so it survives a refresh and appears on your other connected devices.

On web and desktop, the list also animates section changes made with thread actions such as
**Pin**, **Settle**, and **Snooze**. These transitions respect your system's reduced-motion
preference. While dragging, rows follow the insertion gap without replaying a second transition
after the drop.

New threads appear above the active threads you have arranged. Settling clears a thread's active
position, so using **Un-settle** returns it to the top. Pinning and snoozing preserve its active
position until you move it again. Thread activity does not change the order. The settled shelf
continues to use settlement time.

If dragging is unavailable for one environment, update the p0code server running in that
environment. Pinned and active reordering require server support. Threads from older servers keep
their default order until the server is updated.

To generate a fresh title from the conversation, open a thread's menu and choose
**Regenerate title**. The action is unavailable while title generation is in progress
or when the connected environment needs a server update.

To change how titles are written, add **Thread title instructions** in **Settings → Threads →
Text generation**, under Advanced, such as a length limit or an identifier to put first. They apply to new and
regenerated titles. Select a project to give it its own instructions.

Agents connected through p0code can use the same server-owned metadata workflow to
rename a thread, regenerate its title, or link and unlink a pull request. These changes
appear on web, desktop, and mobile without requiring the originating browser to remain
open.

### Fold working threads (beta)

Threads that are working or waiting on work they will resume from move into a collapsed
**Working** section below the active list.
That includes subagents, watched pull requests with checks still running, Claude monitors and
`sleep` timers, and background commands or other monitors the agent says it is waiting on. A dev server or other process an agent leaves running does not keep a thread
there. A thread returns to the top of the active list when it finishes, fails, or needs an approval or
answer. The Working section lists the thread you last sent work to first. Pinned threads stay in
the pinned section.

This is on by default. Turn it off with **Settings → General → Working section** on web and desktop,
or **Settings → General → Working section** on iOS and Android. Each device keeps its own
choice.

While this is on, the active list is ordered by when each thread last came back to you, so you
cannot drag or move threads within it. Your saved order returns when you turn it off.

### Group threads by project (beta)

Enable **Settings → Labs → Boring sidebar (group by project)** on web/desktop (per device) to group active threads into collapsible project folders. Pinned threads stay above; Snoozed and Settled stay below. In this mode, the Working section and sidebar drag-reordering are disabled (dragging a thread onto the composer still works).

## Settle, snooze, and archive

| Action      | When to use          | Effect                                                                                                                                         |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Settle**  | Task is done for now | Moves to **Settled**; stays searchable; any new message reactivates it. Closes idle terminals (and stops actions with `stopOnSettle: true`).   |
| **Snooze**  | Defer until later    | Hides until wake time (thread keeps working in the background). Wakes early on approvals, questions, errors, or new messages.                  |
| **Archive** | Out of the way       | Leaves sidebar and search; lives in **Settings → Archive**. Refuses new messages (including from agents and scheduled tasks) until unarchived. |

> Tip: If a scheduled task targets a thread, settle it instead of archiving—archiving causes scheduled runs to fail.

### Settlement rules and hooks

- **Automatic settlement**: By default, environments settle threads after 7 days of inactivity or when their linked PR merges/closes (even while your apps are closed). Active work, pending questions/approvals, and waited-on background work block auto-settlement. Configure rules in **Settings → Threads** (per environment or **All environments**), including **Keep threads with a PR**.
- **Per-thread override**: Open a thread's menu → **Auto-settle behavior → Never** to exempt a single thread.
- **Drag-to-settle** (web/desktop): Press and drag down/up from a thread's **Settle**, **Un-settle**, or **Wake** button to act on a contiguous range (`Esc` cancels).
- **Offline settle/snooze**: Queues locally (**Pending** / **Waiting to sync**) and syncs on reconnect; remote changes take precedence if the thread changed in the meantime.
- **Worktree cleanup on settle**: Enable **Run in the thread's worktree when the thread settles** on a project action (or `"runOnSettle": true` in `t3.json`), e.g. `cargo clean`, to reclaim disk space automatically in worktree threads.

By default, environments settle inactive threads after seven days and settle
threads whose pull request merged. A closed pull request can also settle an idle
thread. An empty thread's inactivity counts from when it was created.
Work in progress, pending questions or approvals, and background work the agent
is waiting on prevent automatic settlement. An open pull request does not prevent inactivity
settlement unless you turn on **Keep threads with a PR** in **Settings → Threads**,
but an old closed or merged pull request does not settle work you
resumed after it closed. Your own messages count as resuming, and so does a
message an agent sends with `t3_thread_send` or `p0 thread send`. A turn that finished
background work or a pull request watch starts on its own does not.

Customize presets in **Settings → Threads → Snooze options** (durations like `3 hours` or times like `9:00 PM tomorrow`), or pick **Snooze → Custom…** for an exact date/time or duration. Choose **Wake thread** to bring a thread back early.

## Link a pull request

The server automatically links open PRs matching an unsettled thread's branch. On web/desktop, right-click any PR link in a thread and choose **Link to thread** or **Unlink from thread** to override it. Linked PRs participate in auto-settlement.

## Find and reference work

- **Command palette** (`Cmd/Ctrl+K`): Searches threads across connected environments by title, branch, PR, project, and message contents (use `"exact phrase"` for exact matches). On mobile, use the thread list search (or `Cmd+K` on iPad with a keyboard).
- **Copy reference**: Copies the linked PR URL if one exists, otherwise a thread link that pastes into any composer as a thread chip. Use **Copy → Thread** (or **Copy thread** on mobile) to force a thread link, or **Thread ID** for scripts and the `t3` CLI.

Use **Settings → Keybindings** to find or customize shortcuts for searching files
and copying a thread reference. A copied reference uses the thread's pull request
link when available, otherwise a link to the thread, which opens it from anywhere
you paste it and pastes into a composer as a thread chip (see
[sharing a thread](./prompt-links.md#share-a-thread)). To copy the thread even
when it has a PR, choose **Copy → Thread** from its context menu, or **Copy
thread** from its long-press menu on mobile.
**Thread ID** copies the bare ID for scripts and the `p0` CLI. See
[keybindings](./keybindings.md) for custom configuration.

## Inspect agent work

**Limited** means the provider stopped on a usage or rate limit. The conversation
keeps the provider's explanation. Retry after the limit resets, or switch to
another provider instance.
Press **Resume** in an empty composer to continue a limited or interrupted turn
manually when the provider supports native continuation, or send a message to continue.
Do this when the provider reports no reset time, because nothing continues the turn on its own.
Queued messages stay saved while the limit blocks the thread. They run after
the continuation finishes. If the queue was held by a restart, resume it then.

When the provider reports a reset time, choose **Resume at reset** to schedule a
continuation. You can cancel it from the thread. Enable **Resume after
usage limits** in **Settings → Threads** to schedule limit stops by default.
To decide for one thread before it hits a limit, turn on **Resume when limit resets**
in the model picker (on mobile, **Resume automatically when limit resets** in the
model sheet). The thread's choice overrides the setting, and turning it off cancels a
scheduled continuation. Antigravity reports a reset time only when its quota error
includes one; otherwise resume manually.
The environment must be running when the reset arrives; it resumes overdue
continuations after a restart. Stopping the thread, sending a new message,
archiving, or settling it prevents a pending continuation from starting.

Choose **Snooze until reset** to hide the thread until its allowance returns.
Snooze and auto-resume are independent: snooze alone wakes the thread without
sending a message; enabling both wakes and continues it. **Wake now** cancels
the snooze. Enable **Snooze until limits reset** in thread behavior settings to
snooze limit stops by default. Providers without a reset time offer manual
retry and the normal snooze choices.

On web and desktop, use **Agents** to follow work delegated to subagents. Click
a subagent there or on its conversation card to open it in the right panel,
beside the thread you are in. See
[Open a thread beside the one you are in](#open-a-thread-beside-the-one-you-are-in).
On mobile, open a subagent from its conversation card or **Agents**. On iOS
layouts with an inspector, its thread opens beside the parent. Maximize it to
fill the screen; close the full-screen view to return to the parent and inspector.
Stop on a thread also stops the subagents it delegated to.
Before archiving the parent, wait for its delegated tasks to finish or cancel them.

Subagent threads started by the agent can't take messages; message the parent
thread instead. When such a subagent needs an approval or an answer, the parent
thread asks for it.

Expand a tool call in the conversation to see its full command and output.
Summaries shorten shell wrappers and can still describe the latest call after it
finishes; the call's own result shows its status.

On web and desktop, the thread details card lists the local servers that the
thread's terminals or its Claude agent started, with their ports. Not every one
serves a web page. A server the agent started stays listed after the agent's
turn ends.
Select a server to open it in the browser panel. **Stop** ends the server's job
and keeps the agent, the terminal, and p0code running. Stop needs terminal
access to the environment and is not available on Windows.

To choose what the thread details card shows, right-click the card or open
**Settings → Appearance → Thread details**. Hidden rows keep their keyboard
shortcuts, such as Open in editor and project scripts. **Reset to default** brings
back the standard rows.

## Open a thread beside the one you are in

On web and desktop, subagents, side chats, and [threads on linked machines](./remote-access.md#read-a-linked-machines-threads) open as a tab in the right panel by default so your main thread stays visible.

- Hold `Cmd`/`Ctrl` while clicking (or middle-click) to open in the main view instead.
- Change the default in **Settings → Chat → Open subagents and side chats in**.
- From a right-panel tab, choose **Open in main view** to promote it.
- On mobile, they open in the inspector where available, or full screen otherwise.

## Side chats

Ask a quick side question about a thread without polluting its history. A side chat starts with the parent thread's context, folder, model, and permissions while the parent keeps working.

On web and desktop, start a message with `/side` or `/btw`, then your question.
You can also choose **Side chat** from the **+** menu in the right panel. The side
chat opens as a tab there, with its own composer. Side chats do not show in the
sidebar. Find one again under **Side chats** in thread details, where it opens
[like a subagent does](#open-a-thread-beside-the-one-you-are-in).

A side chat works in the same folder as the thread and starts with the permissions,
model, and reasoning level shown in the thread's composer, including for its first
reply. Change them for an individual side chat in its composer. Later changes to the
parent do not change existing side chats.

To use what you learned, choose **Add to chat** at the top of the side chat, or type
`@` and a word from its title in the thread's composer. The thread's message gets a
link to the side chat, and the agent reads as much of it as it needs. This works
while the thread is busy, once you have sent a message in the side chat. An agent on
an external OpenCode server cannot read the link, so put the details in your message
instead.

Closing a side chat you never sent a message in deletes it. To delete one you used,
choose **Delete** at the top of the side chat. Deleting a thread also deletes its
side chats. Archiving a thread also archives its side chats and stops their work, and
unarchiving the thread brings them back.

On mobile, a thread lists its side chats above the composer. Tap one to open it and
answer its questions.

## Snooze until later

To change the choices in the snooze menu, open **Settings → Threads → Snooze options**.
Each option is a duration, such as 3 hours, or a time on a day, such as 9:00 PM
tomorrow. A weekday means the next one after today. Menus list the options soonest
first and hide a today option after its time passes. Saved with **All environments**
selected, the options apply to every connected environment, and the mobile app uses them too.

Choose **Snooze → Custom…** from a thread's menu to pick a date and time in your
local time zone, or a duration in minutes, hours, or days. Durations start when
you confirm; one day means 24 hours. On web and desktop, you can also snooze
several selected threads together. Choose **Wake thread** to bring a thread back early.

Choose **Snooze → Until I bring it back** to hide a thread with no wake time. It moves
to its own **Hidden** section, below **Snoozed**, and never wakes on the clock; bring it
back from its menu, the command palette (**Bring thread back**), or the **Thread: Hide or
Bring Back** shortcut. A hidden thread with a scheduled limit continuation still resumes
at the reset.

A thread that stays hidden for 30 days moves to the archive, unless it has an open pull
request or is still working. Change the number of days, or turn this off, under
**Settings → Threads → Archive hidden threads**. Archived threads can be restored from
the archive.

A snoozed thread keeps working and stays hidden until its wake time, even while
its agent wakes itself for background work. It comes back early for an approval,
a new question, a failed run, or a message or answer you send. You can snooze an existing
question and answer when the thread wakes; the question stays unanswered.
