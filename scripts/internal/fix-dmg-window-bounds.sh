#!/usr/bin/env bash
# Swap in an oversized background TIFF after electron-builder creates the DMG.
# The compressed (UDZO) DMG is converted to read-write, modified, then
# re-compressed so the final artifact keeps its original format.
set -euo pipefail

DMG_PATH="${1:?DMG path required}"
VOLUME_TITLE="${2:-Memmy Installer}"
DESKTOP_DIR="${3:-}"

if [ ! -f "$DMG_PATH" ]; then
  echo "DMG not found: $DMG_PATH" >&2
  exit 1
fi

if [ -z "$DESKTOP_DIR" ]; then
  DESKTOP_DIR="$(cd "$(dirname "$DMG_PATH")/.." && pwd)"
fi

LARGE_BG="$DESKTOP_DIR/build/dmg-background-large.png"
LARGE_BG_2X="$DESKTOP_DIR/build/dmg-background-large@2x.png"

if [ ! -f "$LARGE_BG" ] || [ ! -f "$LARGE_BG_2X" ]; then
  echo "Large DMG backgrounds not found under $DESKTOP_DIR/build — skipping." >&2
  exit 0
fi

VOLUME_PATH="/Volumes/$VOLUME_TITLE"
TMP_DIR="$(mktemp -d /tmp/memmy-dmg.XXXXXX)"
RW_DMG="$TMP_DIR/rw.dmg"
TMP_TIFF="$TMP_DIR/background.tiff"
MOUNTED_VOLUME_PATH=""

cleanup() {
  if [ -n "$MOUNTED_VOLUME_PATH" ] && mount | grep -qF "$MOUNTED_VOLUME_PATH" 2>/dev/null; then
    hdiutil detach "$MOUNTED_VOLUME_PATH" -quiet 2>/dev/null || hdiutil detach -force "$MOUNTED_VOLUME_PATH" -quiet 2>/dev/null || true
  elif mount | grep -qF "$VOLUME_PATH" 2>/dev/null; then
    hdiutil detach "$VOLUME_PATH" -quiet 2>/dev/null || hdiutil detach -force "$VOLUME_PATH" -quiet 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

hdiutil convert "$DMG_PATH" -format UDRW -o "$RW_DMG" -quiet -ov
hdiutil attach "$RW_DMG" -noverify -noautoopen -quiet

MOUNTED_VOLUME_PATH="$(hdiutil info | awk -v image_path="$RW_DMG" '
  $1 == "image-path" {
    in_image = ($3 == image_path)
    next
  }
  in_image && $0 ~ /\/Volumes\// {
    print substr($0, index($0, "/Volumes/"))
    exit
  }
')"

if [ -z "$MOUNTED_VOLUME_PATH" ] || [ ! -d "$MOUNTED_VOLUME_PATH" ]; then
  echo "Failed to mount read-write DMG for $DMG_PATH" >&2
  exit 1
fi

tiffutil -cathidpicheck "$LARGE_BG" "$LARGE_BG_2X" -out "$TMP_TIFF"
cp "$TMP_TIFF" "$MOUNTED_VOLUME_PATH/.background.tiff"

osascript <<APPLESCRIPT || true
tell application "Finder"
  tell disk "$VOLUME_TITLE"
    open
    delay 1
    set installerWindow to container window
    set current view of installerWindow to icon view
    set toolbar visible of installerWindow to false
    set statusbar visible of installerWindow to false
    set bounds of installerWindow to {200, 120, 740, 500}
    close
  end tell
end tell
APPLESCRIPT

sync
hdiutil detach "$MOUNTED_VOLUME_PATH" -quiet
MOUNTED_VOLUME_PATH=""

mv "$DMG_PATH" "$DMG_PATH.bak"
hdiutil convert "$RW_DMG" -format UDZO -o "$DMG_PATH" -quiet
rm -f "$DMG_PATH.bak"

echo "Installed oversized DMG background on $(basename "$DMG_PATH")"
