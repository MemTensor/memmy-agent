#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export MEMMY_ACCOUNT_CHANNEL=email
export MEMMY_APP_EDITION=intl
bash "$ROOT_DIR/scripts/internal/package-mac-x64-unsigned-base.sh" "$@"
