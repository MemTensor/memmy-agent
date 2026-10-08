#!/usr/bin/env bash
set -euo pipefail

HELPER_DIR="${1:?Usage: build-computer-use-helpers.sh <staged helper directory> <arm64|x64>}"
TARGET_CPU="${2:?Missing target CPU}"
case "$TARGET_CPU" in
  arm64) CLANG_CPU=arm64 ;;
  x64) CLANG_CPU=x86_64 ;;
  *) echo "Unsupported Computer Use architecture: $TARGET_CPU" >&2; exit 1 ;;
esac
OUTPUT_DIR="$HELPER_DIR/native/$TARGET_CPU"
mkdir -p "$OUTPUT_DIR"
xcrun --sdk macosx clang -O2 -fobjc-arc -arch "$CLANG_CPU" \
  -mmacosx-version-min=11.0 -framework AppKit -framework CoreGraphics \
  -o "$OUTPUT_DIR/list-windows" "$HELPER_DIR/list-windows.m"
lipo "$OUTPUT_DIR/list-windows" -verify_arch "$CLANG_CPU"
xcrun --sdk macosx clang -O2 -fobjc-arc -arch "$CLANG_CPU" \
  -mmacosx-version-min=11.0 -framework AppKit -framework CoreGraphics -framework IOKit \
  -o "$OUTPUT_DIR/focus-guard" "$HELPER_DIR/focus-guard.m"
lipo "$OUTPUT_DIR/focus-guard" -verify_arch "$CLANG_CPU"
