#!/usr/bin/env bash
set -euo pipefail

# Stage a private, relocatable CPython for the personal WeChat reader so an
# ordinary Mac needs no Xcode or Command Line Tools. Mirrors the Windows embed
# Python; electron-builder re-signs the interpreter with the package identity.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

DESTINATION="${1:?Usage: stage-wechat-python.sh <destination> <arm64|x64>}"
TARGET_CPU="${2:?Missing target architecture}"

# The personal WeChat reader is validated on Apple Silicon only, like the
# bundled SQLCipher and the native dylibs. Keep Intel packages free of it.
if [ "$TARGET_CPU" = x64 ]; then
  exit 0
fi
if [ "$TARGET_CPU" != arm64 ]; then
  echo "Unsupported WeChat Python target architecture: $TARGET_CPU" >&2
  exit 1
fi

# python-build-standalone, pinned and checksummed (verified 2026-10-15):
# https://github.com/astral-sh/python-build-standalone/releases/tag/20261013
PYTHON_VERSION="3.13.16"
PYTHON_BUILD="20261013"
PYTHON_SHA256="16a5332fb0dcb77f163fc8f8cbccd95be1644cc53e68e5d2a79f50afd6680a0e"
ARCHIVE_NAME="cpython-${PYTHON_VERSION}+${PYTHON_BUILD}-aarch64-apple-darwin-install_only_stripped.tar.gz"
PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD}/cpython-${PYTHON_VERSION}%2B${PYTHON_BUILD}-aarch64-apple-darwin-install_only_stripped.tar.gz"

CACHE_DIR="$ROOT_DIR/.tmp/package-downloads"
CACHED_ARCHIVE="$CACHE_DIR/${ARCHIVE_NAME}"
PINNED_ARCHIVE="${MEMMY_MAC_WECHAT_PYTHON_ARCHIVE:-}"

verify_sha256() {
  local file="$1"
  local actual
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  if [ "$actual" != "$PYTHON_SHA256" ]; then
    echo "WeChat Python archive does not match the pinned official SHA-256 ($actual)" >&2
    exit 1
  fi
}

if [ -n "$PINNED_ARCHIVE" ]; then
  ARCHIVE="$PINNED_ARCHIVE"
else
  mkdir -p "$CACHE_DIR"
  if [ ! -f "$CACHED_ARCHIVE" ]; then
    TEMP_ARCHIVE="$CACHED_ARCHIVE.$$.download"
    curl -fsSL "$PYTHON_URL" -o "$TEMP_ARCHIVE"
    mv "$TEMP_ARCHIVE" "$CACHED_ARCHIVE"
  fi
  ARCHIVE="$CACHED_ARCHIVE"
fi
verify_sha256 "$ARCHIVE"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
tar -xzf "$ARCHIVE" -C "$STAGING"
if [ ! -x "$STAGING/python/bin/python3.13" ]; then
  echo "Extracted WeChat Python is missing its interpreter" >&2
  exit 1
fi

rm -rf "$DESTINATION"
mkdir -p "$(dirname "$DESTINATION")"
mv "$STAGING/python" "$DESTINATION"

# Remove parts the reader never loads to keep the package lean. The reader only
# uses standard-library modules (ctypes, hashlib, plistlib, fcntl, ...).
PYTHON_LIB="$DESTINATION/lib/python${PYTHON_VERSION%.*}"
for unused in test idlelib tkinter turtledemo turtle.py ensurepip pydoc_data lib2to3 \
  "config-${PYTHON_VERSION%.*}-darwin"; do
  rm -rf "${PYTHON_LIB:?}/$unused"
done
rm -rf "$DESTINATION/include" "$DESTINATION/share"
find "$DESTINATION/bin" -mindepth 1 ! -name 'python3' ! -name 'python3.13' -delete
find "$DESTINATION" -name '__pycache__' -type d -prune -exec rm -rf {} +
find "$DESTINATION" -name '*.pyc' -delete

cat > "$DESTINATION/runtime.json" <<JSON
{"version":"$PYTHON_VERSION","arch":"arm64","build":"$PYTHON_BUILD","archiveSha256":"$PYTHON_SHA256"}
JSON

# Ad-hoc signatures make local dynamic-load tests meaningful on unsigned builds.
# electron-builder replaces them with the package identity when it signs the app.
while IFS= read -r macho; do
  codesign --force --sign - --timestamp=none "$macho" >/dev/null 2>&1 || true
done < <(find "$DESTINATION" \( -name '*.dylib' -o -name '*.so' \) -o -type f -name 'python3.13')

lipo "$DESTINATION/bin/python3.13" -verify_arch arm64

# Prove the private interpreter runs the reader's standard-library dependencies.
"$DESTINATION/bin/python3" -I -c "import ctypes, ctypes.util, hashlib, hmac, json, plistlib, fcntl, pwd, struct, subprocess, sqlite3" \
  || { echo "Bundled WeChat Python cannot load the reader's dependencies" >&2; exit 1; }
