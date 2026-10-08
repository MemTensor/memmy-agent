#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESTINATION="${1:?Pass destination MemmyLockScreenAuthorizationPlugin.bundle}"
IDENTITY="${2:?Pass the Developer ID signing identity, or - for offline compilation only}"
POLICY_DESTINATION="${3:-$(dirname "$DESTINATION")/policy-tool}"
INSTALLER_DESTINATION="${4:-$(dirname "$DESTINATION")/lock-installer}"
GUARDIAN_DESTINATION="${5:-$(dirname "$DESTINATION")/lock-guardian}"
TARGET_TRIPLE="${6:-$(uname -m)-apple-macosx14.0}"
if [[ "$(basename "$DESTINATION")" != 'MemmyLockScreenAuthorizationPlugin.bundle' ]]; then
  echo 'Unexpected authorization plugin bundle name' >&2
  exit 1
fi
mkdir -p "$DESTINATION/Contents/MacOS"
clang -O2 -Wall -Wextra -Werror -bundle -framework CoreFoundation -framework Security \
  "$SOURCE_DIR/MemmyLockScreenAuthorizationPlugin.c" \
  -o "$DESTINATION/Contents/MacOS/MemmyLockScreenAuthorizationPlugin"
cp "$SOURCE_DIR/Info.plist" "$DESTINATION/Contents/Info.plist"
plutil -lint "$DESTINATION/Contents/Info.plist" >/dev/null
if [[ "$IDENTITY" == '-' ]]; then
  codesign --force --sign - "$DESTINATION"
else
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$DESTINATION"
fi
codesign --verify --strict "$DESTINATION"
swiftc -parse-as-library -O "$SOURCE_DIR/policy-tool.swift" -o "$POLICY_DESTINATION"
if [[ "$IDENTITY" == '-' ]]; then
  codesign --force --sign - "$POLICY_DESTINATION"
else
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$POLICY_DESTINATION"
fi
codesign --verify --strict "$POLICY_DESTINATION"
swiftc -parse-as-library -O -D SYSTEM_INSTALLER \
  "$SOURCE_DIR/policy-tool.swift" "$SOURCE_DIR/system-installer.swift" -o "$INSTALLER_DESTINATION"
if [[ "$IDENTITY" == '-' ]]; then
  codesign --force --identifier cn.memtensor.memmy.computeruse.lock-installer \
    --sign - "$INSTALLER_DESTINATION"
else
  codesign --force --options runtime --timestamp \
    --identifier cn.memtensor.memmy.computeruse.lock-installer \
    --sign "$IDENTITY" "$INSTALLER_DESTINATION"
fi
codesign --verify --strict "$INSTALLER_DESTINATION"
swiftc -parse-as-library -O -target "$TARGET_TRIPLE" \
  "$SOURCE_DIR/GuardianRecoveryPolicy.swift" \
  "$SOURCE_DIR/LockScreenGuardian.swift" \
  "$SOURCE_DIR/../apps/OpenComputerUse/Sources/OpenComputerUse/PhysicalInputMonitor.swift" \
  -o "$GUARDIAN_DESTINATION"
if [[ "$IDENTITY" == '-' ]]; then
  codesign --force --identifier cn.memtensor.memmy.computeruse.guardian \
    --sign - "$GUARDIAN_DESTINATION"
else
  codesign --force --options runtime --timestamp \
    --identifier cn.memtensor.memmy.computeruse.guardian \
    --sign "$IDENTITY" "$GUARDIAN_DESTINATION"
fi
codesign --verify --strict "$GUARDIAN_DESTINATION"
