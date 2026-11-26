# Prompt links

A prompt link opens p0code with a prompt ready to send. Use one to share a prompt on social
media, or to put a one-click fix in a pull request comment.

Links **never** auto-send or change your permission mode, branch, or worktree. They only open a draft for you to review and send.

## Create a link

- **From the composer**: Open the command palette and choose **Copy prompt link** (or **Copy prompt link with repo and model** on GitHub projects).
- **From a sent message**: Click **Copy prompt link**.
- **By hand** (URL-encode the prompt, e.g. with `encodeURIComponent`):

```text
https://app.t3.codes/new?prompt=Rate%20my%20swearing
https://app.t3.codes/new?prompt=Fix%20the%20build&repo=owner/name&provider=codex&model=gpt-5.5
https://app.t3.codes/new?pr=owner/name/123&prompt=Fix%20the%20failing%20check
```

| Parameter  | Description                                                       |
| ---------- | ----------------------------------------------------------------- |
| `prompt`   | Draft text (up to 8,000 characters). Required unless `pr` is set. |
| `repo`     | GitHub repository (`owner/name` or URL).                          |
| `provider` | Provider ID (e.g. `codex`, `claude`).                             |
| `model`    | Model ID or name for that provider.                               |
| `pr`       | GitHub pull request (`owner/name/123` or URL).                    |

## How links open

Opening a link on `app.t3.codes` asks whether to use the desktop/mobile app, the current browser, or the download page (**Remember my choice** skips this next time).

- **No `repo`**: Opens a no-project draft on your last-used machine.
- **`repo`**: Opens in your most recent project for that repo (or offers **Clone** / **Use without project**).
- **`provider` / `model`**: Applied if configured; otherwise falls back to your default with a notice.
- **`pr`**: Opens the thread linked to that PR, or prepares a new worktree draft on the PR branch after you confirm checkout.
- **Thread prompt link** (`https://app.t3.codes/<environment>/<thread>?prompt=…`): Prefills that thread's composer (asks before overwriting an existing draft).

- **No `repo`**: the draft opens without a project, on the machine you used last.
- **`repo`**: the draft opens in your most recently used project for that repository. A fork
  counts only for its own owner. When you do not have the repository, choose **Clone** or **Use
  without project**.
- **`provider` and `model`**: used when you have that provider set up. Otherwise your default
  model is used, and p0code tells you.
- **`pr`**: opens the thread linked to that pull request on any connected machine, with the prompt
  in its composer. When no thread is linked, the draft goes on the pull request branch in a new
  worktree. p0code checks the code out only after you confirm, because the checkout runs your
  setup script on it.

A thread link with a prompt, such as `https://app.t3.codes/<environment>/<thread>?prompt=…`,
puts the prompt in that thread's composer. If you already typed a draft there, p0code asks
before it replaces it.

p0code removes characters you cannot see, such as zero-width and hidden tag characters, because
they can hide instructions for the agent. When a prompt had them, p0code warns you that it may be
malicious.

## Share a thread

**Copy thread** copies a link such as `https://app.t3.codes/threads/<environment>/<thread>`. Paste
it anywhere, such as Slack, a GitHub comment, or your notes. On a phone with p0code installed, it
opens the thread in the app. Elsewhere, opening it asks where to open it, like a prompt link, then
opens the thread. Only someone connected to the machine that runs the thread can see it. In p0code,
a thread link in a message opens the thread in the app.
