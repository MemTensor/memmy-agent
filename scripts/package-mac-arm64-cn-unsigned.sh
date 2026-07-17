#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export MEMMY_ACCOUNT_CHANNEL=phone
export MEMMY_APP_EDITION=cn
bash "$ROOT_DIR/scripts/internal/package-mac-arm64-unsigned-base.sh" "$@"
