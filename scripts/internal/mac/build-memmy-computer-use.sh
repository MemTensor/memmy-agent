#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SOURCE_DIR="$ROOT_DIR/App/native-computer-use"
APP_PATH="${1:?Pass destination Memmy Computer Use.app path}"
TARGET_CPU="${2:-$(uname -m)}"
SIGNING_IDENTITY="${3:--}"
# Signed packages use Memmy's bundle identifier so privacy grants are one program.
# Development builds keep a separate identifier and are not what users install.
BUNDLE_ID="${4:-cn.memtensor.memmy.computeruse}"
if [ "$BUNDLE_ID" = "cn.memtensor.memmy" ]; then
  BUNDLE_NAME="Memmy"
else
  BUNDLE_NAME="Memmy Computer Use"
fi

case "$TARGET_CPU" in arm64) SWIFT_CPU=arm64 ;; x64|x86_64) SWIFT_CPU=x86_64 ;; *) echo "Unsupported Computer Use CPU: $TARGET_CPU" >&2; exit 1 ;; esac
if [ "$(basename "$APP_PATH")" != 'Memmy Computer Use.app' ]; then
  echo 'Computer Use destination must be Memmy Computer Use.app' >&2; exit 1
fi
TRIPLE="$SWIFT_CPU-apple-macosx14.0"
SCRATCH="$SOURCE_DIR/.build/$SWIFT_CPU-release"
VERSION="$(node -p "require('$ROOT_DIR/App/shell/desktop/package.json').version")"

swift build --package-path "$SOURCE_DIR" -c release --triple "$TRIPLE" --scratch-path "$SCRATCH" --product MemmyComputerUse
BIN_DIR="$(swift build --package-path "$SOURCE_DIR" -c release --triple "$TRIPLE" --scratch-path "$SCRATCH" --show-bin-path)"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"
rm -f "$APP_PATH/Contents/MacOS/OpenComputerUse"
cp "$BIN_DIR/MemmyComputerUse" "$APP_PATH/Contents/MacOS/MemmyComputerUse"
chmod +x "$APP_PATH/Contents/MacOS/MemmyComputerUse"
cp "$ROOT_DIR/App/shell/desktop/build/icon.icns" "$APP_PATH/Contents/Resources/MemmyComputerUse.icns"
cp "$SOURCE_DIR/assets/official-software-cursor-window-252.png" "$APP_PATH/Contents/Resources/official-software-cursor-window-252.png"
LOCK_SUPPORT="$APP_PATH/Contents/SharedSupport"
mkdir -p "$LOCK_SUPPORT"
bash "$SOURCE_DIR/lock-screen/build-plugin.sh" \
  "$LOCK_SUPPORT/MemmyLockScreenAuthorizationPlugin.bundle" \
  "$SIGNING_IDENTITY" "$LOCK_SUPPORT/policy-tool" "$LOCK_SUPPORT/lock-installer" \
  "$LOCK_SUPPORT/lock-guardian" "$TRIPLE"
cp "$SOURCE_DIR/lock-screen/authorize-install.applescript" "$LOCK_SUPPORT/authorize-install.applescript"
cat > "$APP_PATH/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleExecutable</key><string>MemmyComputerUse</string>
<key>CFBundleIconFile</key><string>MemmyComputerUse.icns</string>
<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>$BUNDLE_NAME</string>
<key>CFBundleDisplayName</key><string>$BUNDLE_NAME</string>
<key>MemmyComputerUseAppVariant</key><string>release</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>$VERSION</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
plutil -lint "$APP_PATH/Contents/Info.plist" >/dev/null
SIGN_ARGS=(--force --options runtime --sign "$SIGNING_IDENTITY")
if [ "$SIGNING_IDENTITY" != '-' ]; then SIGN_ARGS+=(--timestamp); fi
/usr/bin/codesign "${SIGN_ARGS[@]}" "$APP_PATH"
/usr/bin/codesign --verify --deep --strict "$APP_PATH"
test -x "$LOCK_SUPPORT/policy-tool"
test -x "$LOCK_SUPPORT/lock-installer"
test -x "$LOCK_SUPPORT/lock-guardian"
"$APP_PATH/Contents/MacOS/MemmyComputerUse" --version
