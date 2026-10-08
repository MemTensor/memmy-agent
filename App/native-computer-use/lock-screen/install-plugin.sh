#!/usr/bin/env bash
set -euo pipefail

# Intentionally not called by Memmy at startup. The product must show the user
# the exact system-policy change and obtain fresh administrator authorization.
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-status}"
BUNDLE="${2:-$SOURCE_DIR/MemmyLockScreenAuthorizationPlugin.bundle}"
PLUGIN_PATH='/Library/Security/SecurityAgentPlugins/MemmyLockScreenAuthorizationPlugin.bundle'
STATE_DIR='/Library/Application Support/MemmyLockScreenAuthorizationPlugin'
RIGHT='cn.memtensor.memmy.computeruse.authorization-plugin.remote'
SCREEN_RIGHT='system.login.screensaver'
POLICY_TOOL="$SOURCE_DIR/policy-tool"

status() {
  if [[ -d "$PLUGIN_PATH" ]] && security authorizationdb read "$RIGHT" >/dev/null 2>&1 \
      && codesign --verify --strict "$PLUGIN_PATH" >/dev/null 2>&1 \
      && [[ "$(codesign -dv "$PLUGIN_PATH" 2>&1)" == \
        *'Identifier=cn.memtensor.memmy.computeruse.authorization-plugin'* ]] \
      && [[ "$(codesign -dv "$PLUGIN_PATH" 2>&1)" == *'TeamIdentifier=S7NLXHGBJ2'* ]] \
      && [[ "$(security authorizationdb read "$RIGHT" 2>/dev/null | \
        plutil -extract mechanisms.0 raw -o - - 2>/dev/null)" == \
        'MemmyLockScreenAuthorizationPlugin:allow' ]] \
      && security authorizationdb read "$SCREEN_RIGHT" 2>/dev/null | \
        plutil -extract rule json -o - - | grep -Fq "$RIGHT"; then
    echo 'installed'
  else
    echo 'not-installed'
  fi
}

if [[ "$ACTION" == 'status' ]]; then status; exit 0; fi
if [[ "$ACTION" != 'install' && "$ACTION" != 'uninstall' ]]; then
  echo 'Usage: install-plugin.sh status|install|uninstall [signed-plugin-bundle]' >&2
  exit 2
fi
if [[ "$EUID" -ne 0 ]]; then
  echo 'Administrator approval is required for the SecurityAgent plugin and authorization rule.' >&2
  exit 1
fi
if [[ ! -x "$POLICY_TOOL" ]]; then
  echo 'Signed package is missing its policy tool.' >&2
  exit 1
fi
codesign --verify --strict "$POLICY_TOOL"
TOOL_SIGNATURE="$(codesign -dv "$POLICY_TOOL" 2>&1)"
[[ "$TOOL_SIGNATURE" == *'TeamIdentifier=S7NLXHGBJ2'* ]] || {
  echo 'Policy tool signing identity does not match Memmy.' >&2
  exit 1
}
WORK_DIR="$(mktemp -d /private/tmp/memmy-lock-policy.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
security authorizationdb read "$SCREEN_RIGHT" > "$WORK_DIR/screen-before.plist" 2>/dev/null

if [[ "$ACTION" == 'install' ]]; then
  if [[ -d "$PLUGIN_PATH" ]] || security authorizationdb read "$RIGHT" >/dev/null 2>&1; then
    echo 'Existing Memmy lock authorization installation requires an explicit uninstall first.' >&2
    exit 1
  fi
  [[ -d "$BUNDLE" ]] || { echo 'Plugin bundle is missing' >&2; exit 1; }
  codesign --verify --strict "$BUNDLE"
  SIGNATURE="$(codesign -dv "$BUNDLE" 2>&1)"
  [[ "$SIGNATURE" == *'Identifier=cn.memtensor.memmy.computeruse.authorization-plugin'* \
     && "$SIGNATURE" == *'TeamIdentifier=S7NLXHGBJ2'* ]] || {
    echo 'Plugin signing identity does not match Memmy.' >&2; exit 1;
  }
  "$POLICY_TOOL" install "$WORK_DIR/screen-before.plist" \
    "$WORK_DIR/screen-next.plist" "$WORK_DIR/remote-next.plist"
  mkdir -p "$STATE_DIR" /Library/Security/SecurityAgentPlugins
  chmod 700 "$STATE_DIR"
  cp "$WORK_DIR/screen-before.plist" "$STATE_DIR/screen-before.plist"
  chmod 600 "$STATE_DIR/screen-before.plist"
  ditto "$BUNDLE" "$PLUGIN_PATH"
  chown -R root:wheel "$PLUGIN_PATH"
  chmod -R go-w "$PLUGIN_PATH"
  codesign --verify --strict "$PLUGIN_PATH"
  if ! security authorizationdb write "$RIGHT" < "$WORK_DIR/remote-next.plist"; then
    rm -rf "$PLUGIN_PATH"
    exit 1
  fi
  if ! security authorizationdb write "$SCREEN_RIGHT" < "$WORK_DIR/screen-next.plist"; then
    security authorizationdb remove "$RIGHT" >/dev/null 2>&1 || true
    rm -rf "$PLUGIN_PATH"
    exit 1
  fi
  [[ "$(status)" == 'installed' ]] || {
    security authorizationdb write "$SCREEN_RIGHT" < "$WORK_DIR/screen-before.plist" || true
    security authorizationdb remove "$RIGHT" >/dev/null 2>&1 || true
    rm -rf "$PLUGIN_PATH"
    echo 'Authorization install verification failed; original rule restored.' >&2
    exit 1
  }
  echo 'installed'
  exit 0
fi

# Uninstall removes only Memmy's right from the *current* rule. If another
# product changed the rule later, its entries remain intact.
if [[ -f "$STATE_DIR/screen-before.plist" ]]; then
  "$POLICY_TOOL" uninstall "$WORK_DIR/screen-before.plist" "$WORK_DIR/screen-next.plist" \
    "$STATE_DIR/screen-before.plist"
else
  "$POLICY_TOOL" uninstall "$WORK_DIR/screen-before.plist" "$WORK_DIR/screen-next.plist"
fi
security authorizationdb write "$SCREEN_RIGHT" < "$WORK_DIR/screen-next.plist"
if security authorizationdb read "$SCREEN_RIGHT" 2>/dev/null | \
    plutil -extract rule json -o - - | grep -Fq "$RIGHT"; then
  echo 'Memmy right remains in the screen-unlock policy; leaving plugin installed.' >&2
  exit 1
fi
if [[ "$(security authorizationdb read "$RIGHT" 2>/dev/null | \
    plutil -extract mechanisms.0 raw -o - - 2>/dev/null || true)" == \
    'MemmyLockScreenAuthorizationPlugin:allow' ]]; then
  security authorizationdb remove "$RIGHT" >/dev/null 2>&1 || true
fi
rm -rf "$PLUGIN_PATH"
echo 'uninstalled; the existing password-login fallback remains available'
