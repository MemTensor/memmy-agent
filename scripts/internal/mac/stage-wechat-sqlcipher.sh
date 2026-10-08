#!/usr/bin/env bash
set -euo pipefail

DESTINATION="${1:?Usage: stage-wechat-sqlcipher.sh <destination> <arm64|x64>}"
TARGET_CPU="${2:?Missing target architecture}"
mkdir -p "$DESTINATION"

# The personal WeChat database reader has only been validated on Apple Silicon.
# Keep Intel and Windows packages free of an unusable native dependency.
if [ "$TARGET_CPU" = x64 ]; then
  exit 0
fi
if [ "$TARGET_CPU" != arm64 ]; then
  echo "Unsupported SQLCipher target architecture: $TARGET_CPU" >&2
  exit 1
fi

SQLCIPHER_PREFIX="${MEMMY_SQLCIPHER_PREFIX:-/opt/homebrew/opt/sqlcipher}"
OPENSSL_PREFIX="${MEMMY_OPENSSL_PREFIX:-/opt/homebrew/opt/openssl@4}"
SQLCIPHER_SOURCE="$SQLCIPHER_PREFIX/lib/libsqlcipher.dylib"
CRYPTO_SOURCE="$OPENSSL_PREFIX/lib/libcrypto.4.dylib"
for source_file in "$SQLCIPHER_SOURCE" "$CRYPTO_SOURCE" \
  "$SQLCIPHER_PREFIX/LICENSE.md" "$OPENSSL_PREFIX/LICENSE.txt"; do
  if [ ! -f "$source_file" ]; then
    echo "Missing SQLCipher packaging dependency: $source_file" >&2
    exit 1
  fi
done

SQLCIPHER_TARGET="$DESTINATION/libsqlcipher.dylib"
CRYPTO_TARGET="$DESTINATION/libcrypto.4.dylib"
install -m 644 "$SQLCIPHER_SOURCE" "$SQLCIPHER_TARGET"
install -m 644 "$CRYPTO_SOURCE" "$CRYPTO_TARGET"
install -m 644 "$SQLCIPHER_PREFIX/LICENSE.md" "$DESTINATION/SQLCipher-LICENSE.md"
install -m 644 "$OPENSSL_PREFIX/LICENSE.txt" "$DESTINATION/OpenSSL-LICENSE.txt"

lipo "$SQLCIPHER_TARGET" -verify_arch arm64
lipo "$CRYPTO_TARGET" -verify_arch arm64
CRYPTO_INSTALL_NAME="$(otool -L "$SQLCIPHER_TARGET" | awk '$1 ~ /\/libcrypto[.]4[.]dylib$/ { print $1 }')"
if [ -z "$CRYPTO_INSTALL_NAME" ]; then
  echo "SQLCipher is not linked against the expected OpenSSL 4 library" >&2
  exit 1
fi
install_name_tool -id @loader_path/libcrypto.4.dylib "$CRYPTO_TARGET"
install_name_tool -id @loader_path/libsqlcipher.dylib "$SQLCIPHER_TARGET"
install_name_tool -change "$CRYPTO_INSTALL_NAME" @loader_path/libcrypto.4.dylib "$SQLCIPHER_TARGET"

# Staging signatures make local dynamic-load tests meaningful. electron-builder
# replaces them with the package identity when it signs the finished app.
codesign --force --sign - --timestamp=none "$CRYPTO_TARGET"
codesign --force --sign - --timestamp=none "$SQLCIPHER_TARGET"
codesign --verify --strict "$CRYPTO_TARGET"
codesign --verify --strict "$SQLCIPHER_TARGET"
if otool -L "$SQLCIPHER_TARGET" | grep -E '/opt/homebrew|/usr/local/opt' >/dev/null; then
  echo "SQLCipher retains a Homebrew runtime dependency" >&2
  exit 1
fi

/usr/bin/python3 - "$SQLCIPHER_TARGET" <<'PY'
import ctypes
import sys

library = ctypes.CDLL(sys.argv[1])
library.sqlite3_libversion.restype = ctypes.c_char_p
version = library.sqlite3_libversion()
if not version:
    raise SystemExit("Bundled SQLCipher failed to load")
if not hasattr(library, "sqlite3_key"):
    raise SystemExit("Bundled SQLCipher has no key function")
PY
