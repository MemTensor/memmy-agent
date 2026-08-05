#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

export MEMMY_SKIP_CODESIGN=1
export MEMMY_PACKAGE_SIGNING=unsigned
bash "$ROOT_DIR/scripts/internal/win/build-nsis.sh" "$@"
