#!/usr/bin/env bash
set -euo pipefail

# Developer recovery only; never shipped or called by Memmy at startup.
ACTION="${1:-status}"
PLUGIN_PATH='/Library/Security/SecurityAgentPlugins/MemmyLockScreenAuthorizationPlugin.bundle'
STATE_DIR='/Library/Application Support/MemmyLockScreenAuthorizationPlugin'
RIGHT='cn.memtensor.memmy.computeruse.authorization-plugin.remote'
SCREEN_RIGHT='system.login.screensaver'

if [[ "$ACTION" == 'status' ]]; then
  if [[ -e "$PLUGIN_PATH" ]] || /usr/bin/security authorizationdb read "$RIGHT" >/dev/null 2>&1; then
    echo 'legacy-component-present'
  else
    echo 'no-legacy-component'
  fi
  exit 0
fi
if [[ "$ACTION" != 'uninstall' || "$#" -ne 2 ]]; then
  echo 'Usage: uninstall-legacy-plugin.sh status | uninstall SIGNED_CLEANUP_POLICY_TOOL' >&2
  exit 2
fi
if [[ "$EUID" -ne 0 ]]; then
  echo 'Explicit administrator authorization is required to remove the legacy system component.' >&2
  exit 1
fi

require_safe_path() {
  local candidate="$1" mode
  [[ ! -L "$candidate" && "$(/usr/bin/stat -f '%u' "$candidate")" == '0' ]] || {
    echo "Unsafe legacy authorization path: $candidate" >&2; exit 1;
  }
  mode="$(/usr/bin/stat -f '%Lp' "$candidate")"
  (( (8#$mode & 8#022) == 0 )) || {
    echo "Writable legacy authorization path: $candidate" >&2; exit 1;
  }
}

WORK_DIR="$(/usr/bin/mktemp -d /private/tmp/memmy-lock-cleanup.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
# Copy first so the verified executable cannot be swapped at its source path.
cp "$2" "$WORK_DIR/policy-tool"
chmod 700 "$WORK_DIR/policy-tool"
POLICY_TOOL="$WORK_DIR/policy-tool"
/usr/bin/codesign --verify --strict \
  -R='anchor apple generic and certificate leaf[subject.OU] = "S7NLXHGBJ2"' "$POLICY_TOOL"

if [[ -e "$PLUGIN_PATH" || -L "$PLUGIN_PATH" ]]; then
  require_safe_path '/Library/Security/SecurityAgentPlugins'
  require_safe_path "$PLUGIN_PATH"
  [[ -d "$PLUGIN_PATH" ]] || { echo 'Legacy plugin is not a directory' >&2; exit 1; }
  /usr/bin/codesign --verify --strict \
    -R='identifier "cn.memtensor.memmy.computeruse.authorization-plugin" and anchor apple generic and certificate leaf[subject.OU] = "S7NLXHGBJ2"' "$PLUGIN_PATH"
fi

HAS_REMOTE=0
if /usr/bin/security authorizationdb read "$RIGHT" > "$WORK_DIR/remote.plist" 2>/dev/null; then
  "$POLICY_TOOL" verify-remote "$WORK_DIR/remote.plist"
  HAS_REMOTE=1
fi
/usr/bin/security authorizationdb read "$SCREEN_RIGHT" > "$WORK_DIR/screen-before.plist" 2>/dev/null
BACKUP_ARGS=()
if [[ -e "$STATE_DIR" || -L "$STATE_DIR" ]]; then
  require_safe_path "$STATE_DIR"
  [[ -d "$STATE_DIR" ]] || { echo 'Legacy state is not a directory' >&2; exit 1; }
fi
if [[ -e "$STATE_DIR/screen-before.plist" || -L "$STATE_DIR/screen-before.plist" ]]; then
  require_safe_path "$STATE_DIR/screen-before.plist"
  [[ -f "$STATE_DIR/screen-before.plist" ]] || { echo 'Legacy backup is not a file' >&2; exit 1; }
  BACKUP_ARGS=("$STATE_DIR/screen-before.plist")
fi
RESULT="$("$POLICY_TOOL" uninstall "$WORK_DIR/screen-before.plist" "$WORK_DIR/screen-next.plist" "${BACKUP_ARGS[@]}")"
if [[ "$RESULT" == 'removed' ]]; then
  /usr/bin/security authorizationdb read "$SCREEN_RIGHT" > "$WORK_DIR/screen-latest.plist" 2>/dev/null
  "$POLICY_TOOL" verify-snapshot "$WORK_DIR/screen-before.plist" "$WORK_DIR/screen-latest.plist"
  /usr/bin/security authorizationdb write "$SCREEN_RIGHT" < "$WORK_DIR/screen-next.plist"
fi
/usr/bin/security authorizationdb read "$SCREEN_RIGHT" > "$WORK_DIR/screen-verified.plist" 2>/dev/null
if [[ "$("$POLICY_TOOL" uninstall "$WORK_DIR/screen-verified.plist" "$WORK_DIR/verified-next.plist")" != 'unchanged' ]]; then
  echo 'Memmy branch remains in the screen policy; keeping the plugin for recovery.' >&2; exit 1
fi
if [[ "$HAS_REMOTE" == '1' ]]; then
  /usr/bin/security authorizationdb read "$RIGHT" > "$WORK_DIR/remote-latest.plist" 2>/dev/null
  "$POLICY_TOOL" verify-remote "$WORK_DIR/remote-latest.plist"
  "$POLICY_TOOL" verify-snapshot "$WORK_DIR/remote.plist" "$WORK_DIR/remote-latest.plist"
  /usr/bin/security authorizationdb remove "$RIGHT"
fi
if [[ -d "$PLUGIN_PATH" ]]; then rm -rf "$PLUGIN_PATH"; fi
# Preserve the original backup for recovery and audit.
echo 'Legacy component removed; password-login fallback and other authorization rules preserved.'
