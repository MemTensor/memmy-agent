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
# History observation now lives inside Memmy Computer Use.app. Never ship the
# former independent recorder binary with a second permission identity.
rm -f "$OUTPUT_DIR/human-recorder"

build_helper() {
  local helper="$1"
  shift
  xcrun --sdk macosx swiftc -O \
    -sdk "$SDK_PATH" -target "$SWIFT_CPU-apple-macos11.0" \
    -module-cache-path "$BUILD_DIR/modules" \
    -o "$BUILD_DIR/$helper" "$HELPER_DIR/$helper.swift" "$@"
  lipo "$BUILD_DIR/$helper" -verify_arch "$SWIFT_CPU"
  install -m 755 "$BUILD_DIR/$helper" "$OUTPUT_DIR/$helper"
}
for helper in app-icon task-recorder; do
  if [ "$helper" = task-recorder ]; then
    build_helper "$helper" -Xlinker -weak_framework -Xlinker ScreenCaptureKit
  else
    build_helper "$helper"
  fi
done

# The optional Apple silicon WeChat connection copies these libraries into its
# private helper. Build before packaging/signing so users never invoke clang.
if [ "$TARGET_CPU" = arm64 ]; then
  WECHAT_NATIVE_DIR="$HELPER_DIR/wechat/native/arm64"
  mkdir -p "$WECHAT_NATIVE_DIR"
  xcrun --sdk macosx clang -arch arm64 -isysroot "$SDK_PATH" -mmacosx-version-min=11.0 \
    -dynamiclib -fobjc-arc -framework AppKit -framework Security \
    "$HELPER_DIR/wechat/permission_probe.m" -o "$WECHAT_NATIVE_DIR/MemmyWeChatPermissionProbe.dylib"
  xcrun --sdk macosx clang -arch arm64 -isysroot "$SDK_PATH" -mmacosx-version-min=11.0 \
    -dynamiclib -Wall -Wextra -Werror "$HELPER_DIR/wechat/private_storage_bridge.c" \
    -o "$WECHAT_NATIVE_DIR/MemmyWeChatPrivateStorage.dylib"
  # Capture and scan inside the temporary reader; ordinary Macs need no Xcode/CLT.
  xcrun --sdk macosx clang -arch arm64 -isysroot "$SDK_PATH" -mmacosx-version-min=11.0 \
    -dynamiclib -O2 -Wall -Wextra -Werror "$HELPER_DIR/wechat/key_capture_bridge.c" \
    -o "$WECHAT_NATIVE_DIR/MemmyWeChatKeyCapture.dylib"
  for library in "$WECHAT_NATIVE_DIR"/*.dylib; do lipo "$library" -verify_arch arm64; done
fi
