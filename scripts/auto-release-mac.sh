#!/usr/bin/env bash
#
# auto-release-mac.sh —— daily schedule: pull latest dev → bump version +1 → build signed Mac packages (cn+intl)
#                        → upload & release (website download button takes effect automatically) → DingTalk notification
#
# Design notes:
#   * Version = latest version from the online latest/list +1 (does not touch package.json in git, reset-safe)
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
BRANCH="dev"

# Backend for upload + querying the download list (cn/intl share the same one)
API_BASE="https://memmy-api.memtensor.cn"

# Cloud service address each version of the App connects to (written into .env as MEMMY_CLOUD_SERVICE at build time)
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

# ============================================================
# 2. Pull the latest dev
# ============================================================
CURRENT_STEP="Pull latest $BRANCH"
log "$CURRENT_STEP"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
log "dev current commit: $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"

# Dependencies may change with dev, make sure they are in place
CURRENT_STEP="Install dependencies"
log "$CURRENT_STEP"
npm install

# ============================================================
# 3. Compute the new version = latest online version +1
# ============================================================
CURRENT_STEP="Compute new version"
log "$CURRENT_STEP"
# Query the largest version in the cn online list, patch +1; fall back to package.json if none found
ONLINE_JSON="$(curl -sS -m 20 "$API_BASE/api/memmy/desktop/latest/list?edition=cn" || echo '')"
NEW_VERSION="$(node - "$ONLINE_JSON" <<'NODE'
const raw = process.argv[2] || "";
let online = [];
try { const p = JSON.parse(raw); online = Array.isArray(p.data) ? p.data : []; } catch {}
const pkg = require("./App/shell/desktop/package.json");
// Collect all known versions (online + local package.json) and take the largest
const vers = online.map(x => x.version).filter(Boolean);
vers.push(pkg.version);
const cmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i]||0) !== (pb[i]||0)) return (pa[i]||0) - (pb[i]||0); }
  return 0;
};
const latest = vers.sort(cmp).at(-1);
const parts = latest.split(".").map(Number);
parts[2] = (parts[2] || 0) + 1;                     // patch +1
process.stdout.write(parts.join("."));
NODE
)"
[ -n "$NEW_VERSION" ] || die "Cannot compute new version"
log "Latest online → new version: $NEW_VERSION"

# ============================================================
# 4. Domestic network: local binaries, avoid GitHub downloads
# ============================================================
export MEMMY_ELECTRON_DIST="$REPO_DIR/App/shell/desktop/node_modules/electron/dist"
export CUSTOM_DMGBUILD_PATH="$(find "$HOME/Library/Caches/electron-builder" -name dmgbuild -type f 2>/dev/null | head -1)"
export MEMMY_DESKTOP_VERSION="$NEW_VERSION"          # the packaging script names artifacts from this, does not touch git

RELEASE_DIR="$REPO_DIR/App/shell/desktop/release"

# ---- Common: switch .env → build → upload ----
set_cloud_service() {
  sed -i '' "s#^MEMMY_CLOUD_SERVICE=.*#MEMMY_CLOUD_SERVICE=$1#" "$REPO_DIR/.env"
  grep MEMMY_CLOUD_SERVICE "$REPO_DIR/.env"
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
bash scripts/package-mac-arm64-cn-signed.sh
upload_pkg "$RELEASE_DIR/Memmy-$NEW_VERSION-darwin-arm64-cn-signed.dmg" "darwin-arm64-cn-signed"

# ============================================================
# 6. Build + upload: international signed package (intl)
# ============================================================
CURRENT_STEP="Build and upload Mac international signed package"
log "$CURRENT_STEP"
set_cloud_service "$INTL_CLOUD_SERVICE"
bash scripts/package-mac-arm64-intl-signed.sh
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
