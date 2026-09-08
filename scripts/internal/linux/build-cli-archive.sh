#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
OUTPUT_DIR="$REPO_ROOT/release-assets"
ARCHIVE_NAME="memmy-agent-linux-cli.tar.gz"

usage() {
  printf '%s\n' \
    "Usage: build-cli-archive.sh [--version X.Y.Z] [--output DIR]" \
    "" \
    "Builds the architecture-neutral Memmy Agent Linux CLI archive."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "--version requires a value" >&2; exit 1; }
      VERSION="$2"
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || { echo "--output requires a directory" >&2; exit 1; }
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ROOT_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
if [ "$VERSION" != "$ROOT_VERSION" ]; then
  echo "Requested version $VERSION does not match repository version $ROOT_VERSION" >&2
  exit 1
fi

if [ "${MEMMY_LINUX_CLI_SKIP_BUILD:-0}" != "1" ]; then
  rm -rf \
    "$REPO_ROOT/App/memmy-agent/dist" \
    "$REPO_ROOT/App/backend/dist" \
    "$REPO_ROOT/AgentSourceCore/dist" \
    "$REPO_ROOT/Memory/dist" \
    "$REPO_ROOT/Migrations/dist" \
    "$REPO_ROOT/App/backend/local-api-contracts/dist"
  npm --prefix "$REPO_ROOT/Migrations" run build
  npm --prefix "$REPO_ROOT/App/backend/local-api-contracts" run build
  npm --prefix "$REPO_ROOT/App/backend" run build
  npm --prefix "$REPO_ROOT/AgentSourceCore" run build
  npm --prefix "$REPO_ROOT/Memory" run build
  npm --prefix "$REPO_ROOT/App/memmy-agent" run build
fi

for required in \
  "$REPO_ROOT/App/memmy-agent/dist/main.js" \
  "$REPO_ROOT/AgentSourceCore/dist/src/index.js" \
  "$REPO_ROOT/Memory/dist/src/server/index.js" \
  "$REPO_ROOT/Memory/dist/src/cli/index.js" \
  "$REPO_ROOT/App/backend/dist/src/analytics/analytics-transport.js" \
  "$REPO_ROOT/App/backend/dist/src/services/builtin-skill-target-registry.js" \
  "$REPO_ROOT/Migrations/dist/index.js" \
  "$REPO_ROOT/App/backend/local-api-contracts/dist/index.js"; do
  if [ ! -f "$required" ]; then
    echo "Required build output is missing: $required" >&2
    exit 1
  fi
done

BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/memmy-linux-cli.XXXXXX")"
cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

PAYLOAD_DIR="$BUILD_DIR/payload"
mkdir -p \
  "$PAYLOAD_DIR/App/memmy-agent" \
  "$PAYLOAD_DIR/AgentSourceCore" \
  "$PAYLOAD_DIR/App/backend/dist/src/analytics" \
  "$PAYLOAD_DIR/App/backend/dist/src/adapters/outbound" \
  "$PAYLOAD_DIR/App/backend/dist/src/services" \
  "$PAYLOAD_DIR/App/backend/local-api-contracts" \
  "$PAYLOAD_DIR/Memory" \
  "$PAYLOAD_DIR/Migrations" \
  "$OUTPUT_DIR"

cp "$REPO_ROOT/package.json" "$PAYLOAD_DIR/package.json"
cp "$REPO_ROOT/package-lock.json" "$PAYLOAD_DIR/package-lock.json"
cp "$REPO_ROOT/App/memmy-agent/package.json" "$PAYLOAD_DIR/App/memmy-agent/package.json"
cp "$REPO_ROOT/App/memmy-agent/package-lock.json" "$PAYLOAD_DIR/App/memmy-agent/package-lock.json"
cp -R "$REPO_ROOT/App/memmy-agent/dist" "$PAYLOAD_DIR/App/memmy-agent/dist"
cp "$REPO_ROOT/AgentSourceCore/package.json" "$PAYLOAD_DIR/AgentSourceCore/package.json"
cp -R "$REPO_ROOT/AgentSourceCore/dist" "$PAYLOAD_DIR/AgentSourceCore/dist"
cp "$REPO_ROOT/App/backend/package.json" "$PAYLOAD_DIR/App/backend/package.json"
cp -R "$REPO_ROOT/App/backend/dist/src/adapters/outbound/skill-writer" \
  "$PAYLOAD_DIR/App/backend/dist/src/adapters/outbound/skill-writer"
cp "$REPO_ROOT/App/backend/dist/src/adapters/outbound/agent-paths.js" \
  "$PAYLOAD_DIR/App/backend/dist/src/adapters/outbound/agent-paths.js"
cp "$REPO_ROOT/App/backend/dist/src/project-version.js" \
  "$PAYLOAD_DIR/App/backend/dist/src/project-version.js"
cp "$REPO_ROOT/App/backend/dist/src/analytics/analytics-transport.js" \
  "$PAYLOAD_DIR/App/backend/dist/src/analytics/analytics-transport.js"
cp "$REPO_ROOT/App/backend/dist/src/services/builtin-skill-target-registry.js" \
  "$PAYLOAD_DIR/App/backend/dist/src/services/builtin-skill-target-registry.js"
cp "$REPO_ROOT/Memory/package.json" "$PAYLOAD_DIR/Memory/package.json"
cp -R "$REPO_ROOT/Memory/dist" "$PAYLOAD_DIR/Memory/dist"
cp "$REPO_ROOT/Migrations/package.json" "$PAYLOAD_DIR/Migrations/package.json"
cp -R "$REPO_ROOT/Migrations/dist" "$PAYLOAD_DIR/Migrations/dist"
cp "$REPO_ROOT/App/backend/local-api-contracts/package.json" \
  "$PAYLOAD_DIR/App/backend/local-api-contracts/package.json"
cp -R "$REPO_ROOT/App/backend/local-api-contracts/dist" \
  "$PAYLOAD_DIR/App/backend/local-api-contracts/dist"

node --input-type=module - "$PAYLOAD_DIR/package.json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const manifestPath = process.argv[2];
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.workspaces = [
  "AgentSourceCore",
  "Memory",
  "Migrations",
  "App/backend/local-api-contracts"
];
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
NODE

node "$REPO_ROOT/scripts/internal/shared/prepare-embedding-model.mjs" \
  "$PAYLOAD_DIR/resources/embedding-models"

find "$PAYLOAD_DIR" -type f \( \
  -name '*.d.ts' -o \
  -name '*.d.ts.map' -o \
  -name '*.js.map' \
\) -delete

ARCHIVE_PATH="$OUTPUT_DIR/$ARCHIVE_NAME"
# macOS tar otherwise records Apple extended attributes as LIBARCHIVE pax
# headers, which produce thousands of warnings when GNU tar extracts on Linux.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$ARCHIVE_PATH" -C "$PAYLOAD_DIR" .

if command -v sha256sum >/dev/null 2>&1; then
  ARCHIVE_SHA256="$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ARCHIVE_SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
else
  echo "Neither sha256sum nor shasum is available" >&2
  exit 1
fi
printf '%s  %s\n' "$ARCHIVE_SHA256" "$ARCHIVE_NAME" > "$ARCHIVE_PATH.sha256"
cp "$REPO_ROOT/scripts/install.sh" "$OUTPUT_DIR/install.sh"

printf 'Linux CLI archive: %s\n' "$ARCHIVE_PATH"
printf 'SHA-256: %s\n' "$ARCHIVE_PATH.sha256"
