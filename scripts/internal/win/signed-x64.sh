#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

unset MEMMY_SKIP_CODESIGN
export MEMMY_PACKAGE_SIGNING=signed
bash "$ROOT_DIR/scripts/internal/win/build-nsis.sh" "$@"
