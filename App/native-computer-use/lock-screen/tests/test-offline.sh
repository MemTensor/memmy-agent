#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d /private/tmp/memmy-lock-cleanup-offline.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Every input and output is a temporary plist. No system authorization access.
swiftc -parse-as-library -D LEGACY_POLICY_TEST \
  "$SOURCE_DIR/policy-tool.swift" "$SOURCE_DIR/tests/cleanup-policy-smoke.swift" \
  -o "$WORK_DIR/cleanup-policy-test"
"$WORK_DIR/cleanup-policy-test"
swiftc -parse-as-library "$SOURCE_DIR/policy-tool.swift" -o "$WORK_DIR/policy-tool"
if "$WORK_DIR/policy-tool" install "$SOURCE_DIR/tests/screen-rule.plist" \
    "$WORK_DIR/installed.plist" "$WORK_DIR/remote.plist" >/dev/null 2>&1; then
  echo 'Retired policy tool unexpectedly allows installation' >&2
  exit 1
fi
test ! -e "$WORK_DIR/installed.plist"
test ! -e "$WORK_DIR/remote.plist"
test "$("$WORK_DIR/policy-tool" uninstall "$SOURCE_DIR/tests/screen-rule.plist" \
  "$WORK_DIR/clean.plist")" = 'unchanged'
plutil -lint "$WORK_DIR/clean.plist" >/dev/null
"$WORK_DIR/policy-tool" verify-snapshot "$SOURCE_DIR/tests/screen-rule.plist" "$WORK_DIR/clean.plist"
cp "$WORK_DIR/clean.plist" "$WORK_DIR/changed.plist"
plutil -insert timeout -integer 300 "$WORK_DIR/changed.plist"
if "$WORK_DIR/policy-tool" verify-snapshot "$WORK_DIR/clean.plist" "$WORK_DIR/changed.plist" >/dev/null 2>&1; then
  echo 'Cleanup accepted a concurrently changed policy snapshot' >&2
  exit 1
fi
# An install request must be rejected before privilege or system access.
if bash "$SOURCE_DIR/uninstall-legacy-plugin.sh" install > "$WORK_DIR/invalid-action.log" 2>&1; then
  echo 'Retired cleanup script unexpectedly allows installation' >&2
  exit 1
fi
echo 'legacy cleanup-only CLI passed; installation rejected'
