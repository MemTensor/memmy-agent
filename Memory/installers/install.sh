#!/bin/sh
set -eu

VERSION="${MEMMY_MEMORY_VERSION:-2.1.0}"
RELEASES_URL="${MEMMY_MEMORY_RELEASES_URL:-https://github.com/MemTensor/memmy-agent/releases}"
case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  Linux) PLATFORM=linux ;;
  *) echo "Unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

TARGET="$PLATFORM-$ARCH"
ASSET="memmy-memory-$VERSION-$TARGET.tar.gz"
BASE="$RELEASES_URL/download/memory-v$VERSION"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/memmy-memory-install.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT INT TERM

curl -fL --retry 3 "$BASE/$ASSET" -o "$TMP_DIR/$ASSET"
curl -fL --retry 3 "$BASE/SHA256SUMS" -o "$TMP_DIR/SHA256SUMS"
EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TMP_DIR/SHA256SUMS")"
if [ -z "$EXPECTED" ]; then echo "Checksum for $ASSET is missing" >&2; exit 1; fi
if command -v shasum >/dev/null 2>&1; then ACTUAL="$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')"; else ACTUAL="$(sha256sum "$TMP_DIR/$ASSET" | awk '{print $1}')"; fi
if [ "$ACTUAL" != "$EXPECTED" ]; then echo "Checksum verification failed for $ASSET" >&2; exit 1; fi

CLI_DIR="${MEMMY_MEMORY_HOME:-$HOME/.memmy}/cli/versions/$VERSION/$TARGET"
BIN_DIR="${MEMMY_MEMORY_HOME:-$HOME/.memmy}/bin"
mkdir -p "$CLI_DIR" "$BIN_DIR"
tar -xzf "$TMP_DIR/$ASSET" -C "$CLI_DIR"
ln -sfn "$CLI_DIR/memmy-memory" "$BIN_DIR/memmy-memory"
exec "$BIN_DIR/memmy-memory" install "$@"
