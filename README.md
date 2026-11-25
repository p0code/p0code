<p align="center">
  <img src="./assets/prod/logo.svg" width="80" height="80" alt="p0code logo" />
</p>

<h1 align="center">p0code</h1>

<p align="center">The open-source control plane for coding agents.</p>

> [!IMPORTANT]
> p0code is an independent, unofficial fork of T3 Code. It is not affiliated with, endorsed by, or sponsored by T3 Tools, Inc. "T3 Code" is a trademark of T3 Tools, Inc.

<p align="center">
  <a href="https://github.com/p0code/p0code/releases"><strong>Download</strong></a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://github.com/p0code/p0code/issues">Issues</a> ·
  <a href="https://github.com/p0code/p0code/discussions">Discussions</a>
</p>

p0code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, p0code can control it.

## What's different from T3 Code

p0code is a fork of [T3 Code](https://github.com/pingdotgg/t3code), so most of what's here comes from upstream. These are the things that changed.

**Privacy**

- All telemetry and analytics are gone. p0code also has no Clerk sign-in and no T3 Connect cloud.

**Remote access**

- A self-hosted relay ([`apps/relay`](./apps/relay)) replaces T3 Connect. TLS terminates on your own machine, and the relay only sees encrypted tunnel traffic. The stock T3 Code mobile app still pairs by QR code.
- Someone else can follow a single thread through a guest link. They don't need an account, and their messages wait for you to send or dismiss. See [Guest links](./docs/user/guest-links.md).

**Threads and accounts**

- Hidden threads get their own section in the sidebar. They auto-archive after 30 days hidden with no open PR; you can change that window in settings or turn it off.
- Work and personal account profiles keep provider accounts separate and fail over between them. Switching profiles carries over to the other machines you're connected to.
- The model picker shows how much usage each linked subscription has left, and a context ring next to the model chip opens context and limit details.

**Runtime and data**

- The CLI is `p0`. The native backend is `p0d`, written in Go, and the desktop app can run it as a separate local service.
- Data lives in `~/.p0code`. An old `~/.hhh` folder is migrated on first launch.
- Importing from T3 Code refuses a database from a newer p0code or an unknown migration instead of risking it. See [Moving over from T3 Code](./docs/user/migrating-from-t3-code.md).
- There's a plugin host, off by default. The T3 Connect bridge ships as an unofficial plugin for people who want those notifications back.

**Also here**

- Upstream T3 Code 0.1.12 is merged in, so multi-repo projects and the rest of that release are included.
- `p0deploy` builds a container image, ships it over `ssh`, and swaps it in behind Traefik with a rollback command — no registry needed. Cost is broken down per project.
- Simplified and Traditional Chinese are both available.
- macOS builds are signed with a stable self-signed certificate, so keychain approvals survive updates. [Install](#install) has the one-time Gatekeeper step.

## What you get

- **Your subscriptions.** p0code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or the self-hosted relay.
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** Source code is MIT licensed. If you don't like something, fork it under your own branding (see [Trademarks and forks](#trademarks-and-forks)).

## Install

### Desktop app

Download a build from [Releases](https://github.com/p0code/p0code/releases) for macOS, Windows, or Linux, or [build from source](./docs/operations/00_development.md#first-checkout).

**macOS:** p0code is signed with its own certificate rather than an Apple Developer ID, and isn't notarized, so macOS blocks it the first time ("damaged" or "unidentified developer"). After dragging it to Applications, run this once in Terminal, then open it normally:

```sh
xattr -dr com.apple.quarantine /Applications/p0code.app
```

Updates are signed with the same certificate, so macOS keeps your keychain approvals between versions.

### Command line

Clone with submodules (`plugins/*` live in their own repositories), install dependencies, and start the server (the `p0` command):

```bash
git clone --recurse-submodules=plugins https://github.com/p0code/p0code.git
cd p0code
pnpm install
node apps/server/src/bin.ts
```

### Sign in to an agent

p0code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. p0code is a fork of T3 Code, built because we wanted the best possible development experience with agents and wanted to keep it truly open. If we ever go the wrong direction, you have everything you need to fork the source code and build the tool that you want, under your own name and branding.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Migrating from T3 Code](./docs/user/migrating-from-t3-code.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/p0code/p0code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/00_development.md#first-checkout). The [architecture overview](./docs/internals/01_architecture.md) explains how it works.

## License

The source code in this repository is licensed under the [MIT License](./LICENSE).

## Trademarks and forks

The MIT license applies **only to the source code**. It does not grant any rights to T3 Tools, Inc.'s trademarks, branding, or trade dress, including the **T3 Code** name, wordmark, logos, and application icons.

If you fork, redistribute, or build on T3 Code's source code:

- **Use your own branding.** Replace the T3 Code name, wordmark, logos, and application icons in any public fork, redistributed build, website, package, or app store listing.
- **Be explicitly clear that your project is unofficial.** Do not use the T3 Code name, wordmark, logo, or branding in your own projects without making it unmistakably clear that your project is unofficial and not affiliated with or endorsed by T3 Tools, Inc.

Using our name, wordmark, logo, or branding in a way that suggests official status or affiliation is trademark infringement and unlawful. **Any project indicating or implying that it is an official version of T3 Code when it is not will be pursued to the full extent of the law.**
