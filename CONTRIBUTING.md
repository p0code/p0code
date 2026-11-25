# Contributing

p0code is an independent fork of [T3 Code](https://github.com/pingdotgg/t3code). Most of what's
here comes from upstream; the p0-specific work — no telemetry, no Clerk sign-in, no T3 Connect
cloud, plus the plugin shop, Relay and the rest — lives in this repo. It is not affiliated with or
endorsed by T3 Tools, Inc.

Contributions are welcome: bug reports, ideas, and small focused PRs. I'm one busy person, so
reviews and replies can take a while — please be patient, and don't ping repeatedly. One polite bump
after a couple of weeks is fine; five comments in an hour is not.

## What we do not want

- Mobile app changes. This fork does not build or ship a mobile app — the app in the App Store and
  Play Store is upstream T3 Code's — so a PR touching `apps/mobile/` is closed automatically. Send
  those to [pingdotgg/t3code](https://github.com/pingdotgg/t3code) instead.

## Setup

Install [Vite+](https://viteplus.dev/guide/) first; `vp` provides the pinned Node version:

```sh
curl -fsSL https://vite.plus | bash
```

Clone with submodules so the bundled plugins under `plugins/` are checked out:

```sh
git clone --recurse-submodules https://github.com/p0code/p0code.git
cd p0code
pnpm install
vp run dev
```

Open the pairing URL the dev runner prints — the bare origin doesn't authenticate a new browser.
The full runbook is [docs/operations/00_development.md](docs/operations/00_development.md#first-checkout).

## Checks

Run these before you push; CI runs the same things:

```sh
pnpm typecheck   # vp run -r typecheck
pnpm test        # vp run -r test
pnpm lint
pnpm fmt:check
```

## What makes a PR easy to land

- One thing per PR. A fix plus a refactor is two PRs.
- Tests for behaviour changes. If a test is hard to write, say why in the description.
- Conventional-commit-ish messages (`fix: ...`, `feat: ...`, `docs: ...`). It's not enforced, it
  just makes the history readable.
- No drive-by refactors or reformatting of files you didn't need to touch.
- Say what you tested and on which platform (macOS, Windows, Linux, mobile).

## License

p0code is MIT licensed; see [LICENSE](LICENSE). The upstream T3 Tools Inc. copyright notice stays
there because MIT requires it. By contributing you agree that your work is released under the same
MIT license.
