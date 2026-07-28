#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP_VERSION="${MEMMY_DESKTOP_VERSION:-$(node -p "require('$ROOT_DIR/App/shell/desktop/package.json').version")}"

case "${MEMMY_ACCOUNT_CHANNEL:-phone}" in
  email)
    PACKAGE_EDITION="intl"
    ;;
  phone|"")
    PACKAGE_EDITION="cn"
    ;;
  *)
    echo "Unsupported MEMMY_ACCOUNT_CHANNEL: ${MEMMY_ACCOUNT_CHANNEL:-}" >&2
    exit 1
    ;;
esac

ARTIFACT_NAME="Memmy-$DESKTOP_VERSION-darwin-x64-$PACKAGE_EDITION-unsigned.\${ext}"

export MEMMY_SKIP_CODESIGN=1
export MEMMY_PACKAGE_SIGNING=unsigned
bash "$ROOT_DIR/scripts/internal/package-mac-dmg.sh" \
  --x64 \
  "$@" \
  --config.extraMetadata.version="$DESKTOP_VERSION" \
  --config.artifactName="$ARTIFACT_NAME"
