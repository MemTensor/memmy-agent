#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CERT_DIR="${MEMMY_MAC_CERT_DIR:-$ROOT_DIR/Mac软件打包}"
SIGNING_DIR="$ROOT_DIR/.signing-local"
KEYCHAIN="${CSC_KEYCHAIN:-/private/tmp/memmy-build-x64.keychain-db}"
KEYCHAIN_PASSWORD_FILE="${MEMMY_KEYCHAIN_PASSWORD_FILE:-$SIGNING_DIR/keychain-password-x64.txt}"
FALLBACK_KEYCHAIN_PASSWORD_FILE="$SIGNING_DIR/keychain-password.txt"
P12_FILE="${MEMMY_P12_FILE:-$CERT_DIR/证书.p12}"
P12_PASSWORD_FILE="${MEMMY_P12_PASSWORD_FILE:-$SIGNING_DIR/p12-password.txt}"
FALLBACK_P12_PASSWORD_FILE="$CERT_DIR/证书密码.txt"
APPLE_API_KEY="${APPLE_API_KEY:-$CERT_DIR/AuthKey_CUARD5SC47.p8}"
APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-CUARD5SC47}"
APPLE_API_ISSUER="${APPLE_API_ISSUER:-5ed1f28c-0bb2-4369-89fe-d04023d48d45}"
CSC_NAME="${CSC_NAME:-XINYUE REN (S7NLXHGBJ2)}"
CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-Developer ID Application: XINYUE REN (S7NLXHGBJ2)}"
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

DMG="$ROOT_DIR/App/shell/desktop/release/Memmy-$DESKTOP_VERSION-darwin-x64-$PACKAGE_EDITION-signed.dmg"
ARTIFACT_NAME="Memmy-$DESKTOP_VERSION-darwin-x64-$PACKAGE_EDITION-signed.\${ext}"

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

require_file() {
  local file_path="$1"
  local label="$2"

  if [ ! -f "$file_path" ]; then
    echo "Missing $label: $file_path" >&2
    exit 1
  fi
}

resolve_existing_password_file() {
  local preferred="$1"
  local fallback="$2"
  local label="$3"

  if [ -f "$preferred" ]; then
    printf '%s\n' "$preferred"
    return
  fi
  if [ -f "$fallback" ]; then
    printf '%s\n' "$fallback"
    return
  fi

  echo "Missing $label. Tried:" >&2
  echo "  $preferred" >&2
  echo "  $fallback" >&2
  exit 1
}

ensure_keychain_password() {
  mkdir -p "$SIGNING_DIR"
  chmod 700 "$SIGNING_DIR"

  if [ -f "$KEYCHAIN_PASSWORD_FILE" ]; then
    return
  fi
  if [ -f "$FALLBACK_KEYCHAIN_PASSWORD_FILE" ]; then
    cp "$FALLBACK_KEYCHAIN_PASSWORD_FILE" "$KEYCHAIN_PASSWORD_FILE"
    chmod 600 "$KEYCHAIN_PASSWORD_FILE"
    return
  fi

  openssl rand -base64 32 > "$KEYCHAIN_PASSWORD_FILE"
  chmod 600 "$KEYCHAIN_PASSWORD_FILE"
}

prepare_keychain() {
  local keychain_password
  local p12_password_file
  local p12_password

  ensure_keychain_password
  p12_password_file="$(resolve_existing_password_file "$P12_PASSWORD_FILE" "$FALLBACK_P12_PASSWORD_FILE" "p12 password file")"
  keychain_password="$(cat "$KEYCHAIN_PASSWORD_FILE")"
  p12_password="$(cat "$p12_password_file")"

  log "Preparing temporary signing keychain"
  rm -f "$KEYCHAIN"
  security create-keychain -p "$keychain_password" "$KEYCHAIN"
  security set-keychain-settings -lut 21600 "$KEYCHAIN"
  security unlock-keychain -p "$keychain_password" "$KEYCHAIN"
  security list-keychains -d user -s "$KEYCHAIN" "$HOME/Library/Keychains/login.keychain-db" /Library/Keychains/System.keychain
  security import "$P12_FILE" \
    -k "$KEYCHAIN" \
    -P "$p12_password" \
    -A \
    -T /usr/bin/codesign \
    -T /usr/bin/productsign \
    -T /usr/bin/security
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$KEYCHAIN"
  security find-identity -v -p codesigning "$KEYCHAIN"
}

sign_and_notarize_dmg() {
  require_file "$DMG" "x64 DMG"

  log "Signing outer DMG"
  codesign --force --sign "$CODESIGN_IDENTITY" --keychain "$KEYCHAIN" "$DMG"

  log "Submitting outer DMG for Apple notarization"
  xcrun notarytool submit "$DMG" \
    --key "$APPLE_API_KEY" \
    --key-id "$APPLE_API_KEY_ID" \
    --issuer "$APPLE_API_ISSUER" \
    --wait

  log "Stapling notarization ticket"
  xcrun stapler staple "$DMG"
}

verify_dmg() {
  log "Verifying DMG checksum"
  hdiutil verify "$DMG"

  log "Validating stapled ticket"
  xcrun stapler validate "$DMG"

  log "Checking Gatekeeper acceptance"
  spctl -a -vvv -t open --context context:primary-signature "$DMG"
}

main() {
  cd "$ROOT_DIR"

  require_file "$P12_FILE" "Developer ID p12 certificate"
  require_file "$APPLE_API_KEY" "Apple API key"

  prepare_keychain

  log "Building signed x64 app and DMG"
  export CSC_NAME
  export CSC_KEYCHAIN="$KEYCHAIN"
  export APPLE_API_KEY
  export APPLE_API_KEY_ID
  export APPLE_API_ISSUER
  bash "$ROOT_DIR/scripts/internal/package-mac-dmg.sh" \
    --x64 \
    "$@" \
    --config.extraMetadata.version="$DESKTOP_VERSION" \
    --config.artifactName="$ARTIFACT_NAME"

  sign_and_notarize_dmg
  verify_dmg

  log "Done"
  echo "Signed x64 DMG is ready:"
  echo "  $DMG"
}

main "$@"
