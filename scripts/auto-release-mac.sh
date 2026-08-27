#!/usr/bin/env bash
#
# auto-release-mac.sh —— daily schedule: pull latest branch → verify its declared version → build signed Mac packages (cn+intl)
#                        → upload & release (website download button takes effect automatically) → DingTalk notification
#
# Design notes:
#   * Version = the checked-out source version; packaging never invents or rewrites release metadata
#   * cn / intl share the same upload backend, distinguished by cn/intl in platformType
#   * Upload takes effect immediately: the website reads /api/memmy/desktop/latest/list live, no redeploy needed
#   * Any failed step → DingTalk alert and exit (set -e + trap)
#
# Usage: bash scripts/auto-release-mac.sh
# Scheduling: see the launchd install notes at the end of this file
#
set -euo pipefail

# ============================================================
# 1. Configuration (★ the two placeholder items must be filled first, or the script refuses to run)
# ============================================================
REPO_DIR="/Users/zongy/Documents/MemTensor/Memmy-agent"
BRANCH="${MEMMY_RELEASE_BRANCH:-}"

# Backend for upload + querying the download list (cn/intl share the same one)
API_BASE="https://memmy-api.memtensor.cn"

# Public cloud-service origin embedded through the allowlisted runtime manifest.
CN_CLOUD_SERVICE="https://memmy-api.memtensor.cn"
INTL_CLOUD_SERVICE="https://memmy-api.memtensor.cn"

# Release notes (customizable)
RELEASE_NOTES="Daily automated build (dev)"

# Log directory
LOG_DIR="$HOME/.memmy-release/logs"
# ============================================================

mkdir -p "$LOG_DIR"
TS="$(date '+%Y%m%d-%H%M%S')"
LOG_FILE="$LOG_DIR/release-$TS.log"

# Write all output to both the terminal and the log file
exec > >(tee -a "$LOG_FILE") 2>&1

log()  { printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die()  { echo "❌ $*" >&2; return 1; }

# ---- Notification: macOS system notification (top-right popup + sound), zero config ----
# Pass args via argv to avoid quote injection; failure uses the Basso sound, success uses Glass.
notify() {
  local text="$1" sound="${2:-Glass}"
  osascript -e 'on run argv' \
            -e 'display notification (item 1 of argv) with title "Memmy Auto Release" sound name (item 2 of argv)' \
            -e 'end run' \
            "$text" "$sound" >/dev/null 2>&1 || true
}

# ---- Failure fallback: alert on any uncaught error ----
CURRENT_STEP="Startup"
on_error() {
  local code=$?
  log "FAILED at: $CURRENT_STEP (exit $code)"
  notify "❌ Failed at [$CURRENT_STEP] (exit $code), see log at $LOG_FILE" "Basso"
  exit "$code"
}
trap on_error ERR

cd "$REPO_DIR"
if [ -z "$BRANCH" ]; then
  BRANCH="$(git branch --show-current)"
fi
case "$BRANCH" in
  release/v*.*.*)
    ;;
  *)
    die "Packaging requires a release/vX.Y.Z branch; set MEMMY_RELEASE_BRANCH explicitly"
    ;;
esac

# ============================================================
# 2. Pull the latest dev
# ============================================================
CURRENT_STEP="Pull latest $BRANCH"
log "$CURRENT_STEP"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
log "$BRANCH current commit: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

# Dependencies may change with the release branch, make sure they are in place
CURRENT_STEP="Install dependencies"
log "$CURRENT_STEP"
npm install

# ============================================================
# 3. Verify the source-declared release version is newer than the online version
# ============================================================
CURRENT_STEP="Verify source release version"
log "$CURRENT_STEP"
ONLINE_JSON="$(curl -sS -m 20 "$API_BASE/api/memmy/desktop/latest/list?edition=cn" || echo '')"
NEW_VERSION="$(node - "$ONLINE_JSON" <<'NODE'
const raw = process.argv[2] || "";
let online = [];
try { const p = JSON.parse(raw); online = Array.isArray(p.data) ? p.data : []; } catch {}
const pkg = require("./App/shell/desktop/package.json");
const vers = online.map(x => x.version).filter(Boolean);
const cmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pa[i]||0) - (pb[i]||0); }
  return 0;
};
const latestOnline = vers.sort(cmp).at(-1);
if (latestOnline && cmp(pkg.version, latestOnline) <= 0) {
  throw new Error("Source package version must be newer than the latest online version");
}
process.stdout.write(pkg.version);
NODE
)"
[ -n "$NEW_VERSION" ] || die "Cannot read the source release version"
log "Verified source release version: $NEW_VERSION"

# ============================================================
# 4. Domestic network: local binaries, avoid GitHub downloads
# ============================================================
export MEMMY_ELECTRON_DIST="$REPO_DIR/App/shell/desktop/node_modules/electron/dist"
export CUSTOM_DMGBUILD_PATH="$(find "$HOME/Library/Caches/electron-builder" -name dmgbuild -type f 2>/dev/null | head -1)"
export MEMMY_DESKTOP_VERSION="$NEW_VERSION"

RELEASE_DIR="$REPO_DIR/App/shell/desktop/release"

# ---- Common: configure public runtime origin → build → upload ----
set_cloud_service() {
  export MEMMY_CLOUD_SERVICE="$1"
  echo "Cloud service configured for packaging."
}

upload_pkg() {
  local file="$1" platform_type="$2"
  [ -f "$file" ] || die "Artifact not found: $file"
  log "Uploading: $(basename "$file")  (platformType=$platform_type)"
  local resp
  resp="$(curl -sS -m 600 --location --request POST "$API_BASE/api/memmy/desktop/upload" \
    --header 'User-Agent: PostmanRuntime-ApipostRuntime/1.1.0' \
    --form "file=@$file" \
    --form "version=$NEW_VERSION" \
    --form "releaseNotes=$RELEASE_NOTES" \
    --form "platformType=$platform_type")"
  echo "Upload response: $resp"
  # Simple check: a response containing success/code 0/200 is treated as success, otherwise error out
  echo "$resp" | grep -qiE '"code" *: *(0|200)|success|true' || die "Upload appears to have failed: $resp"
}

# ============================================================
# 5. Build + upload: domestic signed package (cn)
# ============================================================
CURRENT_STEP="Build and upload Mac domestic signed package"
log "$CURRENT_STEP"
set_cloud_service "$CN_CLOUD_SERVICE"
bash scripts/package-mac.sh --version "$NEW_VERSION" --arch arm64 --edition cn --sign signed
upload_pkg "$RELEASE_DIR/Memmy-$NEW_VERSION-darwin-arm64-cn-signed.dmg" "darwin-arm64-cn-signed"

# ============================================================
# 6. Build + upload: international signed package (intl)
# ============================================================
CURRENT_STEP="Build and upload Mac international signed package"
log "$CURRENT_STEP"
set_cloud_service "$INTL_CLOUD_SERVICE"
bash scripts/package-mac.sh --version "$NEW_VERSION" --arch arm64 --edition intl --sign signed
upload_pkg "$RELEASE_DIR/Memmy-$NEW_VERSION-darwin-arm64-intl-signed.dmg" "darwin-arm64-intl-signed"

# ============================================================
# 7. Done
# ============================================================
CURRENT_STEP="Done"
log "All done: v$NEW_VERSION (cn + intl) released"
notify "✅ Release succeeded v$NEW_VERSION (Mac domestic + international signed packages are live)" "Glass"

# ============================================================
# Appendix: install as a daily 20:30 scheduled job (launchd)
# ------------------------------------------------------------
# 1) Create ~/Library/LaunchAgents/cn.memmy.autorelease.plist with:
#
# <?xml version="1.0" encoding="UTF-8"?>
# <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
# <plist version="1.0"><dict>
#   <key>Label</key><string>cn.memmy.autorelease</string>
#   <key>ProgramArguments</key>
#     <array>
#       <string>/bin/bash</string>
#       <string>/Users/zongy/Documents/MemTensor/Memmy-agent/scripts/auto-release-mac.sh</string>
#     </array>
#   <key>StartCalendarInterval</key><dict>
#     <key>Hour</key><integer>20</integer>
#     <key>Minute</key><integer>30</integer>
#   </dict>
#   <key>StandardOutPath</key><string>/Users/zongy/.memmy-release/launchd.out.log</string>
#   <key>StandardErrorPath</key><string>/Users/zongy/.memmy-release/launchd.err.log</string>
#   <key>RunAtLoad</key><false/>
# </dict></plist>
#
# 2) Load:      launchctl load ~/Library/LaunchAgents/cn.memmy.autorelease.plist
#    Unload:    launchctl unload ~/Library/LaunchAgents/cn.memmy.autorelease.plist
#    Run now:   launchctl start cn.memmy.autorelease
#
# Note: signing/notarization must happen on this Mac; the machine must stay powered on and not sleep
#       (System Settings → Battery/Energy Saver → Prevent automatic sleeping; or caffeinate).
# ============================================================
