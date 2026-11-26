# Release Runbook

Unified release workflow: `.github/workflows/release.yml`. Beta is a product label, not a release channel—channels remain `stable` and `nightly` (plus `preview` for maintainer test builds).

## Channels and triggers

- **Stable (`channel=stable` on `main`, or pushing a `vX.Y.Z` tag):** Manual dispatch promotes the **latest published nightly commit** (not `main` HEAD) using its base version unless overridden. Pushing a `vX.Y.Z` tag ships that exact commit. Finalization commits version bumps to `main` using `RELEASE_APP_ID` / `RELEASE_APP_PRIVATE_KEY`.
- **Nightly (manual `channel=nightly` on `main`):** There is no automatic schedule. A nightly publishes a GitHub prerelease, the `nightly` desktop updater channel and the `nightly` npm dist-tag. It does not bump versions on `main`.
- **Preview (`channel=preview`, any branch—default dispatch channel):** Exercises build, signing, notarization, and smoke tests into a **draft** GitHub release and skips npm. **Never publish a preview draft or push a test tag**—there is no dry-run tag path (any non-nightly `v*` tag publishes stable), and published preview tags hide nightlies from the update feed. Rebase onto `main` before dispatching `preview`.
- **PR macOS previews:** Applying the `preview:mac` label triggers a two-workflow split (`desktop-macos-preview.yml` builds the untrusted JS bundle; `desktop-macos-preview-publish.yml` checks author trust, packages/signs using `main`, and publishes to rolling `desktop-preview`). One-shot per commit; label is removed automatically.

## Critical release invariants

- **Server self-update ordering:** Connected servers update to the exact client version by downloading the GitHub Release CLI archive (or `npx p0@<version>`). Keep the release graph order strictly: `release` (CLI archives + `SHA256SUMS` + desktop installers) → `publish_cli` (`p0` npm launcher). Never publish the npm launcher before the archives exist.
- **Standalone CLI archives & Node pin:** `engines.node` in root `package.json` must stay exact (Node SEA builds reject mismatches). There is no macOS x64 CLI archive (SEA is unsupported there; x64 desktop uses Electron).
- **Smoke fixture:** `scripts/fixtures/desktop-launch` is intentionally an old SQLite snapshot to verify forward migrations on packaged builds—never regenerate it on schema changes.

## Update feed

Nightly installs check `releases.atom` (the 10 newest git tags), then the `update-feed` release's `nightly.json` pointer, then the GitHub API as fallback. **Never delete the `update-feed` release.**

- If `Check the update feed` fails because stray/preview tags pushed the newest nightly out of `releases.atom`, delete the unneeded tags (`git push origin :refs/tags/<tag>`—converting a release to draft keeps its tag).
- **To pull a bad nightly:** delete its release and tag, run `gh release delete-asset update-feed nightly.json` (so installs fall back until the next tick rewrites it), and move npm's `nightly` dist-tag back with `npm dist-tag add p0@<last-good> nightly`.

## Relay

There is no managed relay in this fork: operators stand up their own
[self-hosted relay](./02_relay-setup.md) (`apps/relay`) and hand environments an
enrollment token. Nothing in the release pipeline deploys or configures a
relay.

## Mobile releases

The app here is not the one that ships from the store, so nothing mobile runs on a
push or a pull request: every mobile workflow is `workflow_dispatch` only, and the
macOS mobile native lint in CI runs only when CI is dispatched.

- **Store binaries:** this fork keeps the development and preview mobile tooling (preview builds, OTA updates and native client installs) but does not publish builds to the App Store, TestFlight or Google Play.

## Windows payload topology and update validation

Windows packages the bundled server and its unpacked native modules in `resources/server.asar` (+ `server.asar.unpacked`) and embeds the matching-architecture Linux CLI archive as `resources/wsl-runtime.tar.gz` + SHA-256 sidecar (passed via `--wsl-runtime`). Avoid whole-package smart unpacking (keeps unpacked file counts and NSIS differential blockmaps bounded). `scripts/build-desktop-artifact.ts` enforces all structural, native-load, and WSL archive checks at build time.

## One-time credentials setup

### npm OIDC trusted publishing

Configure `p0` on npm with GitHub Actions Trusted Publishing for `.github/workflows/release.yml` (the workflow publishes only the `p0` launcher tarball via `npm publish --provenance`). Set the publisher's environment to `production`, which `publish_cli` declares.

### Apple signing and notarization (macOS)

- **Secrets:** `CSC_LINK` (base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (raw `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `MACOS_PROVISIONING_PROFILE` (base64 profile for `com.t3tools.t3code` with Associated Domains).
- **Variables:** `APPLE_TEAM_ID`, optional `T3CODE_PASSKEY_RP_DOMAINS`.
- The packager only enables passkey entitlements (`keychain-access-groups`, `com.apple.developer.web-browser.public-key-credential`) present in the provisioning profile; regenerate and re-upload `MACOS_PROVISIONING_PROFILE` after Apple approves managed capabilities. Complete Apple's Associated Domains / AASA setup per [Relay setup](./02_relay-setup.md#desktop-passkeys).

### Azure Trusted Signing (Windows)

Set secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` with an Entra service principal granted Trusted Signing permissions.

## Ongoing stable release checklist

1. Verify the latest nightly (desktop launch, `npm view p0@<version> version`, remote server update + DB migration smoke test).
2. Dispatch **Release** on `main` with `channel=stable` (leave `version` blank unless overriding the nightly's base version).
3. Confirm `Resolve release commit` matches the verified nightly, then verify `release` and `publish_cli` both succeed.
4. Smoke-test the published artifacts.
