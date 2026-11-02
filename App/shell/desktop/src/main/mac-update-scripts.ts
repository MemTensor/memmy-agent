export interface MacUpdateValidationOptions {
  architecture: "arm64" | "x64";
  /** A signed release must retain the current app's signing team. */
  teamIdentifier: string | null;
  allowUnsigned?: boolean;
  expectedVersion?: string;
  currentVersion?: string;
}

function quotedShellValue(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function macBundleValidationScript(options: MacUpdateValidationOptions): string {
  if (!options.teamIdentifier && !options.allowUnsigned) throw new Error("Signed macOS update requires a signing team");
  return `EXPECTED_BUNDLE_ID='cn.memtensor.memmy'
EXPECTED_ARCH=${quotedShellValue(options.architecture === "x64" ? "x86_64" : "arm64")}
EXPECTED_TEAM=${quotedShellValue(options.teamIdentifier ?? "")}
EXPECTED_VERSION=${quotedShellValue(options.expectedVersion ?? "")}
CURRENT_VERSION=${quotedShellValue(options.currentVersion ?? "")}

version_is_newer() {
  LC_ALL=C /usr/bin/awk -v candidate="$1" -v installed="$2" 'BEGIN {
    exit !("x" candidate > "x" installed)
  }'
}

validate_app_bundle() {
  local app_path="$1"
  local plist="$app_path/Contents/Info.plist"
  if [[ ! -d "$app_path" || ! -f "$plist" || -L "$app_path" || -L "$app_path/Contents" || -L "$app_path/Contents/MacOS" || -L "$plist" ]]; then
    echo "Memmy update app bundle incomplete: $app_path"
    exit 1
  fi
  local bundle_id bundle_executable bundle_version minimum_os current_os signing_team
  bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null || true)"
  bundle_executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist" 2>/dev/null || true)"
  if [[ "$bundle_id" != "$EXPECTED_BUNDLE_ID" || -z "$bundle_executable" || "$bundle_executable" == */* || ! -x "$app_path/Contents/MacOS/$bundle_executable" || -L "$app_path/Contents/MacOS/$bundle_executable" ]]; then
    echo "Memmy update identity or executable invalid: $app_path"
    exit 1
  fi
  bundle_version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist" 2>/dev/null || true)"
  if [[ ! "$bundle_version" =~ '^[0-9]+(\\.[0-9]+)*(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$' || ( -n "$EXPECTED_VERSION" && "$bundle_version" != "$EXPECTED_VERSION" ) ]]; then
    echo "Memmy update version does not match the requested version: $bundle_version"
    exit 1
  fi
  if [[ -n "$CURRENT_VERSION" ]] && ! version_is_newer "$bundle_version" "$CURRENT_VERSION"; then
    echo "Memmy update version $bundle_version does not follow installed $CURRENT_VERSION"
    exit 1
  fi
  if ! /usr/bin/lipo "$app_path/Contents/MacOS/$bundle_executable" -verify_arch "$EXPECTED_ARCH"; then
    echo "Memmy update does not support $EXPECTED_ARCH"
    exit 1
  fi
  minimum_os="$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$plist" 2>/dev/null || true)"
  current_os="$(/usr/bin/sw_vers -productVersion)"
  if [[ ! "$minimum_os" =~ '^[0-9]+(\\.[0-9]+)*$' || ! "$current_os" =~ '^[0-9]+(\\.[0-9]+)*$' ]] || ! /usr/bin/awk -v installed="$current_os" -v required="$minimum_os" 'BEGIN {
    n=split(installed, a, "."); m=split(required, b, ".");
    for (i=1; i<=n || i<=m; i++) { if (a[i]+0 > b[i]+0) exit 0; if (a[i]+0 < b[i]+0) exit 1 }
    exit 0
  }'; then
    echo "Memmy update requires macOS $minimum_os; installed macOS is $current_os"
    exit 1
  fi
  if ! /usr/bin/codesign --verify --deep --strict "$app_path"; then
    echo "Memmy update code signature invalid: $app_path"
    exit 1
  fi
  if [[ -n "$EXPECTED_TEAM" ]]; then
    local signing_requirement=${quotedShellValue(`=anchor apple generic and identifier "cn.memtensor.memmy" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${options.teamIdentifier ?? ""}"`)}
    if ! /usr/bin/codesign --verify --deep --strict -R "$signing_requirement" "$app_path"; then
      echo "Memmy update does not have the installed Apple Developer ID identity"
      exit 1
    fi
    signing_team="$(/usr/bin/codesign -dv --verbose=4 "$app_path" 2>&1 | /usr/bin/awk -F= '/^TeamIdentifier=/{print $2}')"
    if [[ "$signing_team" != "$EXPECTED_TEAM" ]]; then
      echo "Memmy update signing team does not match the installed app"
      exit 1
    fi
  fi
}
`;
}

export function createMacDmgUpdateInstallScript(options: MacUpdateValidationOptions): string {
  return `#!/bin/zsh
set -eu
set -o pipefail

DMG_PATH="$1"
DEST_APP_PATH="$2"
LOG_PATH="$3"
CURRENT_APP_PID="\${4:-}"
OPEN_AFTER_INSTALL="\${5:-1}"
MARKER_PATH="\${6:-}"
STAGED_APP_PATH="\${7:-}"
STAGED_READY_PATH="\${8:-}"
REOPEN_AFTER_INSTALL="$OPEN_AFTER_INSTALL"
SCRIPT_PATH="$0"
MOUNT_POINT=""
LOCK_DIR=""
LOCK_ACQUIRED=0
TMP_APP_PATH=""
TMP_OWNED=0
BACKUP_APP_PATH=""
INSTALL_SUCCEEDED=0
BACKUP_CREATED=0

exec >> "$LOG_PATH" 2>&1
echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] starting Memmy background update"

cleanup() {
  if [[ "$INSTALL_SUCCEEDED" != "1" && "$BACKUP_CREATED" == "1" && -d "$BACKUP_APP_PATH" ]]; then
    # A failed replacement may already exist. Remove it before restoring the
    # exact original bundle, and keep the backup if restoration itself fails.
    if /bin/rm -rf "$DEST_APP_PATH" && [[ ! -e "$DEST_APP_PATH" && ! -L "$DEST_APP_PATH" ]] && /bin/mv "$BACKUP_APP_PATH" "$DEST_APP_PATH"; then
      echo "Memmy background update failed; previous app restored"
      if [[ "$REOPEN_AFTER_INSTALL" == "1" ]]; then
        /usr/bin/open -n "$DEST_APP_PATH" >/dev/null 2>&1 || true
      fi
    else
      echo "Memmy background update rollback failed; original is at $BACKUP_APP_PATH"
    fi
  fi
  if [[ "$TMP_OWNED" == "1" && -n "$TMP_APP_PATH" ]]; then
    /bin/rm -rf "$TMP_APP_PATH" >/dev/null 2>&1 || true
  fi
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet || true
    /bin/rmdir "$MOUNT_POINT" 2>/dev/null || true
  fi
  if [[ "$LOCK_ACQUIRED" == "1" && -n "$LOCK_DIR" && -d "$LOCK_DIR" ]]; then
    /bin/rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  /bin/rm -f "$SCRIPT_PATH" || true
}
trap cleanup EXIT

TMP_APP_PATH="$DEST_APP_PATH.update-tmp"
BACKUP_APP_PATH="$DEST_APP_PATH.update-backup"
if [[ -L "$DEST_APP_PATH" || -L "$TMP_APP_PATH" || -L "$BACKUP_APP_PATH" || ( -n "$STAGED_APP_PATH" && -L "$STAGED_APP_PATH" ) ]]; then
  echo "Memmy update app paths cannot be symbolic links"
  exit 1
fi

${macBundleValidationScript(options)}

if [[ -n "$MARKER_PATH" ]]; then
  LOCK_DIR="$MARKER_PATH.lock"
  if ! /bin/mkdir "$LOCK_DIR" >/dev/null 2>&1; then
    echo "Memmy background update already running"
    exit 0
  fi
  LOCK_ACQUIRED=1
fi
if [[ -e "$BACKUP_APP_PATH" || -L "$BACKUP_APP_PATH" ]]; then
  echo "Memmy update recovery is required; previous app preserved at $BACKUP_APP_PATH"
  exit 1
fi
TMP_OWNED=1

if [[ "$CURRENT_APP_PID" =~ '^[0-9]+$' ]]; then
  echo "waiting for Memmy PID $CURRENT_APP_PID to exit"
  while /bin/kill -0 "$CURRENT_APP_PID" >/dev/null 2>&1; do
    /bin/sleep 0.2
  done
else
  echo "missing Memmy PID, falling back to app path wait"
  while /usr/bin/pgrep -f "$DEST_APP_PATH/Contents/MacOS/" >/dev/null 2>&1; do
    /bin/sleep 0.2
  done
fi

LEFTOVER_PIDS="$(/usr/bin/pgrep -f "$DEST_APP_PATH/Contents/MacOS/" || true)"
if [[ -n "$LEFTOVER_PIDS" ]]; then
  echo "terminating leftover Memmy runtime processes: $LEFTOVER_PIDS"
  if [[ "$OPEN_AFTER_INSTALL" != "1" ]]; then
    REOPEN_AFTER_INSTALL="1"
    echo "detected reopen while background update is installing; will reopen after replacement"
  fi
  /bin/kill $LEFTOVER_PIDS >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    LEFTOVER_PIDS="$(/usr/bin/pgrep -f "$DEST_APP_PATH/Contents/MacOS/" || true)"
    if [[ -z "$LEFTOVER_PIDS" ]]; then
      break
    fi
    /bin/sleep 0.2
  done
  LEFTOVER_PIDS="$(/usr/bin/pgrep -f "$DEST_APP_PATH/Contents/MacOS/" || true)"
  if [[ -n "$LEFTOVER_PIDS" ]]; then
    /bin/kill -9 $LEFTOVER_PIDS >/dev/null 2>&1 || true
  fi
fi

if [[ -n "$STAGED_APP_PATH" && -n "$STAGED_READY_PATH" && -d "$STAGED_APP_PATH" && -f "$STAGED_READY_PATH" ]]; then
  echo "using staged Memmy app: $STAGED_APP_PATH"
  /bin/rm -rf "$TMP_APP_PATH"
  /bin/mv "$STAGED_APP_PATH" "$TMP_APP_PATH"
  /bin/rm -f "$STAGED_READY_PATH" >/dev/null 2>&1 || true
else
  MOUNT_POINT="$(/usr/bin/mktemp -d /tmp/memmy-update.XXXXXX)"
  /usr/bin/hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_POINT"
  SOURCE_APP_PATH="$(/usr/bin/find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -type d -print -quit)"
  if [[ -z "$SOURCE_APP_PATH" ]]; then
    echo "update DMG does not contain an app bundle"
    exit 1
  fi

  /bin/rm -rf "$TMP_APP_PATH"
  /usr/bin/ditto "$SOURCE_APP_PATH" "$TMP_APP_PATH"
fi
validate_app_bundle "$TMP_APP_PATH"
if [[ -d "$DEST_APP_PATH" ]]; then
  /bin/mv "$DEST_APP_PATH" "$BACKUP_APP_PATH"
  BACKUP_CREATED=1
fi
/bin/mv "$TMP_APP_PATH" "$DEST_APP_PATH"
validate_app_bundle "$DEST_APP_PATH"
/usr/bin/xattr -dr com.apple.quarantine "$DEST_APP_PATH" >/dev/null 2>&1 || true
if [[ -n "$MARKER_PATH" ]]; then
  /bin/rm -f "$MARKER_PATH" >/dev/null 2>&1 || true
fi
/bin/rm -rf "$BACKUP_APP_PATH" >/dev/null 2>&1 || true
INSTALL_SUCCEEDED=1
if [[ "$REOPEN_AFTER_INSTALL" == "1" ]]; then
  /bin/sleep 0.1
  /usr/bin/open -n "$DEST_APP_PATH" >/dev/null 2>&1 || true
fi
echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] Memmy background update finished"
`;
}

export function createMacDmgUpdateStageScript(options: MacUpdateValidationOptions): string {
  return `#!/bin/zsh
set -eu
set -o pipefail

DMG_PATH="$1"
STAGED_APP_PATH="$2"
STAGED_READY_PATH="$3"
LOG_PATH="$4"
SCRIPT_PATH="$0"
MOUNT_POINT=""
STAGED_TMP_PATH="$STAGED_APP_PATH.tmp"

exec >> "$LOG_PATH" 2>&1
echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] staging Memmy update package"

cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    /usr/bin/hdiutil detach "$MOUNT_POINT" -quiet || true
    /bin/rmdir "$MOUNT_POINT" 2>/dev/null || true
  fi
  /bin/rm -rf "$STAGED_TMP_PATH" 2>/dev/null || true
  /bin/rm -f "$SCRIPT_PATH" || true
}
trap cleanup EXIT

${macBundleValidationScript(options)}

/bin/rm -rf "$STAGED_TMP_PATH"
/bin/rm -f "$STAGED_READY_PATH"
MOUNT_POINT="$(/usr/bin/mktemp -d /tmp/memmy-stage.XXXXXX)"
/usr/bin/hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$MOUNT_POINT"
SOURCE_APP_PATH="$(/usr/bin/find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -type d -print -quit)"
if [[ -z "$SOURCE_APP_PATH" ]]; then
  echo "update DMG does not contain an app bundle"
  exit 1
fi

/usr/bin/ditto "$SOURCE_APP_PATH" "$STAGED_TMP_PATH"
validate_app_bundle "$STAGED_TMP_PATH"
/bin/rm -rf "$STAGED_APP_PATH"
/bin/mv "$STAGED_TMP_PATH" "$STAGED_APP_PATH"
/usr/bin/xattr -dr com.apple.quarantine "$STAGED_APP_PATH" >/dev/null 2>&1 || true
/usr/bin/touch "$STAGED_READY_PATH"
echo "[$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)] staged Memmy update package"
`;
}
