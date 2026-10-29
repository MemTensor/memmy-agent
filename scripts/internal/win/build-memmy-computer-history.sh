#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
node "$ROOT_DIR/scripts/internal/win/build-memmy-computer-history.mjs" \
  "${1:?Pass destination memmy-computer-history.exe path}" "${2:-amd64}"
