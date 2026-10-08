#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d /private/tmp/memmy-lock-offline.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

clang -Wall -Wextra -Werror -DMEMMY_AUTH_SOCKET='"/private/tmp/memmy-no-broker.sock"' \
  -framework CoreFoundation -framework Security \
  "$SOURCE_DIR/MemmyLockScreenAuthorizationPlugin.c" \
  "$SOURCE_DIR/tests/plugin-denies-without-broker.c" -o "$WORK_DIR/plugin-test"
"$WORK_DIR/plugin-test"

swiftc -parse-as-library "$SOURCE_DIR/policy-tool.swift" -o "$WORK_DIR/policy-tool"
"$WORK_DIR/policy-tool" install "$SOURCE_DIR/tests/screen-rule.plist" \
  "$WORK_DIR/installed.plist" "$WORK_DIR/remote.plist"
"$WORK_DIR/policy-tool" uninstall "$WORK_DIR/installed.plist" "$WORK_DIR/restored.plist" \
  "$SOURCE_DIR/tests/screen-rule.plist"
plutil -lint "$WORK_DIR/installed.plist" "$WORK_DIR/remote.plist" "$WORK_DIR/restored.plist" >/dev/null
test "$(plutil -extract rule json -o - "$WORK_DIR/installed.plist")" = \
  '["example.other.remote","cn.memtensor.memmy.computeruse.authorization-plugin.remote","use-login-window-ui"]'
test "$(plutil -extract rule json -o - "$WORK_DIR/restored.plist")" = \
  '["example.other.remote","use-login-window-ui"]'
cp "$WORK_DIR/installed.plist" "$WORK_DIR/changed.plist"
plutil -insert rule.0 -string example.new.remote "$WORK_DIR/changed.plist"
"$WORK_DIR/policy-tool" uninstall "$WORK_DIR/changed.plist" "$WORK_DIR/changed-restored.plist" \
  "$SOURCE_DIR/tests/screen-rule.plist"
test "$(plutil -extract rule json -o - "$WORK_DIR/changed-restored.plist")" = \
  '["example.new.remote","example.other.remote","use-login-window-ui"]'
echo 'authorization policy add/remove simulation passed'

swiftc -parse-as-library -D SYSTEM_INSTALLER \
  "$SOURCE_DIR/policy-tool.swift" "$SOURCE_DIR/system-installer.swift" \
  -o "$WORK_DIR/lock-installer"
codesign --force --identifier cn.memtensor.memmy.computeruse.lock-installer \
  --sign - "$WORK_DIR/lock-installer" >/dev/null 2>&1
if "$WORK_DIR/lock-installer" status >/dev/null 2>&1; then
  echo 'Ad-hoc lock installer unexpectedly accepted as a release binary' >&2
  exit 1
fi
echo 'unsigned lock installer denied before system access'

swiftc -parse-as-library \
  "$SOURCE_DIR/../packages/OpenComputerUseKit/Sources/OpenComputerUseKit/LockScreenLease.swift" \
  "$SOURCE_DIR/tests/lease-smoke.swift" -o "$WORK_DIR/lease-test"
"$WORK_DIR/lease-test"

swiftc -parse-as-library \
  "$SOURCE_DIR/GuardianRecoveryPolicy.swift" \
  "$SOURCE_DIR/tests/guardian-policy-smoke.swift" -o "$WORK_DIR/guardian-policy-test"
"$WORK_DIR/guardian-policy-test"

swiftc -parse-as-library -O \
  "$SOURCE_DIR/GuardianRecoveryPolicy.swift" \
  "$SOURCE_DIR/LockScreenGuardian.swift" \
  "$SOURCE_DIR/../apps/OpenComputerUse/Sources/OpenComputerUse/PhysicalInputMonitor.swift" \
  -o "$WORK_DIR/lock-guardian"
codesign --force --identifier cn.memtensor.memmy.computeruse.guardian \
  --sign - "$WORK_DIR/lock-guardian" >/dev/null 2>&1
if "$WORK_DIR/lock-guardian" "$$" >/dev/null 2>&1; then
  echo 'Ad-hoc guardian unexpectedly accepted as a release binary' >&2
  exit 1
fi
echo 'unsigned guardian denied before input monitoring or screen access'
