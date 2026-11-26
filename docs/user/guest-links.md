# Guest links

Share a single thread with a teammate in their browser—no account required. Guests see messages and agent activity stream live, and any message they send waits for your approval before running.

## Prerequisites and sharing

Guest links are a beta. Turn on **Settings → Labs → Guest links** for the machine that runs the
thread. They also need the machine reachable at a [self-hosted relay](./remote-access.md#self-hosted-relay)
address, because the link points at the public origin it serves. The machine must stay online
while the guest uses it.
While the setting is off, every guest link on that machine stops working; links that have not
expired work again when you turn it back on.

1. Open the thread's menu (or command palette / mobile long-press) and choose **Share with guest**.
2. Send the copied link to one person (works in one browser and expires after 24 hours).
3. Guest messages appear at the end of the thread (**Request** in the sidebar). Choose **Send** to run as a normal turn (in the thread's current permission mode—review text and files first) or **Dismiss**.

Choose **Stop sharing** to end the link at once. Archiving the thread, creating a new link, or
unlinking the machine from the relay also ends it. The mobile app can send, dismiss, and stop
sharing too.

## What guests can see and attach

The guest sees recent user messages and assistant replies, the thread's working status, and which
files changed. File changes hide the diff and file contents. Their composer shows the thread's
model, but they cannot change it. Command output, tool details, reasoning, plans, subagents,
checkpoints, repository paths, branches, and linked pull requests stay private.

Messages and assistant replies can still contain sensitive text. Share only threads whose
conversation you are comfortable showing. A guest message waits for you and does not start a run
or change whether the thread is settled.

## Guest attachments

Guests can attach images and other files to a message: use the paperclip, paste, or drop them on
the message box. A message holds up to 4 files and 10 MB in total. Images must be PNG, JPEG, GIF, or
WebP. While messages wait for you, their files can total 20 MB; the guest can attach more once you
send or dismiss some.

Dismissing a message, ending the link, or archiving the thread deletes the files of messages that
still wait. A sent message keeps its files, like any message in the thread.

The guest's text and files run with the thread's current permission mode once you send them. Check
them before you choose **Send**, as you would anything pasted from a chat.
