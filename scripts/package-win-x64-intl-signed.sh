#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export MEMMY_ACCOUNT_CHANNEL=email
export MEMMY_APP_EDITION=intl
unset MEMMY_SKIP_CODESIGN
bash "$ROOT_DIR/scripts/internal/package-win-x64.sh" "$@"
