#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DESTINATION="${1:?Usage: build-wechat-sqlcipher.sh <new-install-prefix>}"
if [ "$(uname -m)" != arm64 ]; then
  echo "This WeChat dependency build supports the validated macOS arm64 reader." >&2
  exit 1
fi
if [ -e "$DESTINATION" ]; then
  echo "Choose a new dependency install prefix; existing files will not be replaced: $DESTINATION" >&2
  exit 1
fi
mkdir -p "$DESTINATION"
DESTINATION="$(cd "$DESTINATION" && pwd)"
WORK_DIR="${MEMMY_SQLCIPHER_BUILD_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/memmy-sqlcipher-source.XXXXXX")}"
mkdir -p "$WORK_DIR/downloads"
OPENSSL_PREFIX="$DESTINATION/openssl"
SQLCIPHER_PREFIX="$DESTINATION/sqlcipher"
export MACOSX_DEPLOYMENT_TARGET=12.0
JOBS="${MEMMY_NATIVE_BUILD_JOBS:-8}"

download_verified() {
  local url="$1" checksum="$2" file="$3"
  if [ ! -f "$file" ]; then
    curl --fail --location --retry 2 --silent --show-error "$url" --output "$file"
  fi
  printf '%s  %s\n' "$checksum" "$file" | shasum -a 256 -c -
}

download_verified https://github.com/openssl/openssl/releases/download/openssl-4.0.2/openssl-4.0.2.tar.gz \
  736b467530f916737b7031310ccb21d8218c6229e61e8e160cd1d3458cd543a8 "$WORK_DIR/downloads/openssl-4.0.2.tar.gz"
download_verified https://github.com/sqlcipher/sqlcipher/archive/refs/tags/v4.19.0.tar.gz \
  7075f96cbabe45b4ecfc2e6b1745a625f856f695b0827a5506ce9ed85b906aa0 "$WORK_DIR/downloads/sqlcipher-4.19.0.tar.gz"
tar -xzf "$WORK_DIR/downloads/openssl-4.0.2.tar.gz" -C "$WORK_DIR"
tar -xzf "$WORK_DIR/downloads/sqlcipher-4.19.0.tar.gz" -C "$WORK_DIR"

(
  cd "$WORK_DIR/openssl-4.0.2"
  CC=clang CFLAGS="-O2 -arch arm64 -mmacosx-version-min=12.0" \
    LDFLAGS="-arch arm64 -mmacosx-version-min=12.0 -Wl,-headerpad_max_install_names" \
    perl ./Configure darwin64-arm64-cc shared no-tests --prefix="$OPENSSL_PREFIX" --libdir=lib
  make -j "$JOBS"
  make install_sw
  install -m 644 LICENSE.txt "$OPENSSL_PREFIX/LICENSE.txt"
)
(
  cd "$WORK_DIR/sqlcipher-4.19.0"
  CFLAGS="-O2 -arch arm64 -mmacosx-version-min=12.0 -DSQLITE_HAS_CODEC -DSQLITE_ENABLE_JSON1 -DSQLITE_ENABLE_FTS3 -DSQLITE_ENABLE_FTS3_PARENTHESIS -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_EXTRA_INIT=sqlcipher_extra_init -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown" \
    CPPFLAGS="-I$OPENSSL_PREFIX/include" \
    LDFLAGS="-arch arm64 -mmacosx-version-min=12.0 -Wl,-headerpad_max_install_names -L$OPENSSL_PREFIX/lib -lcrypto" \
    ./configure --disable-tcl --dll-basename=libsqlcipher --enable-load-extension \
      --with-tempstore=yes --prefix="$SQLCIPHER_PREFIX" --includedir="$SQLCIPHER_PREFIX/include/sqlcipher"
  make -j "$JOBS"
  make install
  install -m 644 LICENSE.md "$SQLCIPHER_PREFIX/LICENSE.md"
)

node "$ROOT_DIR/scripts/internal/mac/verify-library-deployment-target.mjs" "$OPENSSL_PREFIX/lib/libcrypto.4.dylib" arm64 12.0
node "$ROOT_DIR/scripts/internal/mac/verify-library-deployment-target.mjs" "$SQLCIPHER_PREFIX/lib/libsqlcipher.dylib" arm64 12.0
printf 'Compatible dependency prefixes:\nMEMMY_SQLCIPHER_PREFIX=%s\nMEMMY_OPENSSL_PREFIX=%s\n' "$SQLCIPHER_PREFIX" "$OPENSSL_PREFIX"
