# AUR packaging

This directory maintains the [`t3code-bin`](https://aur.archlinux.org/packages/t3code-bin) and
[`t3code-nightly-bin`](https://aur.archlinux.org/packages/t3code-nightly-bin) packages. Both
repackage the official x86_64 and ARM64 AppImages from GitHub Releases.

## Publishing

This fork does not publish to the AUR automatically. To publish, update the package version and
both architectures' asset names and checksums, build it, regenerate `.SRCINFO`, and push it to the AUR.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.1.7 \
  packaging/aur/scripts/release.sh
```
