#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUTPUT_DIR="${1:?Pass destination native-computer-use/linux directory}"
if ! command -v go >/dev/null 2>&1; then
  echo 'Building Memmy Computer Use for Linux requires Go 1.22 or newer.' >&2
  exit 1
fi
VERSION="$(node -p "require('$ROOT_DIR/App/shell/desktop/package.json').version")"
for ARCH in amd64 arm64; do
  mkdir -p "$OUTPUT_DIR/$ARCH"
  (
    cd "$ROOT_DIR/App/native-computer-use/apps/OpenComputerUseLinux"
    GOOS=linux GOARCH="$ARCH" CGO_ENABLED=0 go build \
      -trimpath -ldflags "-s -w -X main.version=$VERSION" \
      -o "$OUTPUT_DIR/$ARCH/memmy-computer-use" .
  )
done
