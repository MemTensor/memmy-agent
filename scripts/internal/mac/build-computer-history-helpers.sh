#!/usr/bin/env bash
set -euo pipefail

# Build into the staged runtime, before electron-builder packs and signs it.
HELPER_DIR="${1:?Usage: build-computer-history-helpers.sh <staged helper directory> <arm64|x64>}"
TARGET_CPU="${2:?Missing target CPU}"
case "$TARGET_CPU" in
  arm64) SWIFT_CPU=arm64 ;;
  x64) SWIFT_CPU=x86_64 ;;
  *) echo "Unsupported Computer History architecture: $TARGET_CPU" >&2; exit 1 ;;
esac
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
OUTPUT_DIR="$HELPER_DIR/native/$TARGET_CPU"
mkdir -p "$OUTPUT_DIR"

for helper in human-recorder app-icon; do
  xcrun --sdk macosx swiftc -O \
    -sdk "$SDK_PATH" -target "$SWIFT_CPU-apple-macos11.0" \
    -module-cache-path "$BUILD_DIR/modules" \
    -o "$BUILD_DIR/$helper" "$HELPER_DIR/$helper.swift"
  lipo "$BUILD_DIR/$helper" -verify_arch "$SWIFT_CPU"
  install -m 755 "$BUILD_DIR/$helper" "$OUTPUT_DIR/$helper"
done
