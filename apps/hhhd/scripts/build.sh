#!/usr/bin/env bash
# Cross-builds hhhd into dist/<os>-<arch>/hhhd[.exe]. Usage: scripts/build.sh [os/arch ...]
set -euo pipefail
cd "$(dirname "$0")/.."

version="${HHHD_VERSION:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}"
targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  targets=(darwin/arm64 darwin/amd64 linux/arm64 linux/amd64 windows/arm64 windows/amd64)
fi

for target in "${targets[@]}"; do
  os="${target%/*}"
  arch="${target#*/}"
  ext=""
  [ "$os" = windows ] && ext=".exe"
  out="dist/$os-$arch/hhhd$ext"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
    go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$out" .
  echo "$out $(wc -c <"$out" | tr -d ' ') bytes"
done
