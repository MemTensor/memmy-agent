#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export MEMMY_ACCOUNT_CHANNEL=phone
export MEMMY_APP_EDITION=cn
export MEMMY_SKIP_CODESIGN=1
bash "$ROOT_DIR/scripts/internal/package-win-x64.sh" "$@"
