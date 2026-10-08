#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUTPUT="${1:?Pass destination memmy-computer-use.exe path}"
ARCH="${2:-amd64}"
case "$ARCH" in amd64|arm64) ;; *) echo "Unsupported Windows Computer Use architecture: $ARCH" >&2; exit 1 ;; esac
if ! command -v go >/dev/null 2>&1; then
  echo 'Building Memmy Computer Use for Windows requires Go 1.22 or newer.' >&2; exit 1
fi
VERSION="$(node -p "require('$ROOT_DIR/App/shell/desktop/package.json').version")"
mkdir -p "$(dirname "$OUTPUT")"
(
  cd "$ROOT_DIR/App/native-computer-use/apps/OpenComputerUseWindows"
  GOOS=windows GOARCH="$ARCH" CGO_ENABLED=0 go build \
    -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$OUTPUT" .
)
