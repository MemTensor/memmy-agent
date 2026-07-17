#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MEMORY_ROOT="$(cd "$CLI_DIR/../.." && pwd)"
MONOREPO_ROOT="$(cd "$CLI_DIR/../../.." && pwd)"
if [[ -f "$MONOREPO_ROOT/package.json" && -f "$MONOREPO_ROOT/Memory/src/cli/tsconfig.json" ]]; then
  PROJECT_ROOT="$MONOREPO_ROOT"
else
  PROJECT_ROOT="$CLI_DIR"
fi
cd "$PROJECT_ROOT"

if [[ -f "$CLI_DIR/npm/package.json" ]]; then
  VERSION_PACKAGE_JSON="$CLI_DIR/npm/package.json"
else
  VERSION_PACKAGE_JSON="$PROJECT_ROOT/package.json"
fi
export VERSION_PACKAGE_JSON
VERSION="${MEMMY_MEMORY_VERSION:-$(node -p "require(process.env.VERSION_PACKAGE_JSON).version")}"
TARGET="${MEMMY_MEMORY_TARGET:-}"

if [[ -z "$TARGET" ]]; then
  case "$(uname -s)" in
    Darwin) PLATFORM="darwin" ;;
    Linux) PLATFORM="linux" ;;
    MINGW*|MSYS*|CYGWIN*) PLATFORM="windows" ;;
    *)
      echo "Unsupported platform: $(uname -s)" >&2
      exit 1
      ;;
  esac

  case "$(uname -m)" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64) ARCH="x64" ;;
    *)
      echo "Unsupported arch: $(uname -m)" >&2
      exit 1
      ;;
  esac

  TARGET="${PLATFORM}-${ARCH}"
fi

case "$TARGET" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64|windows-arm64|windows-x64) ;;
  *)
    echo "Unsupported target: $TARGET" >&2
    exit 1
    ;;
esac

OUT_DIR="$CLI_DIR/dist/binaries"
WORK_DIR="$CLI_DIR/dist/memmy-memory-binary/$TARGET"
STAGE_DIR="$WORK_DIR/package"
ASSET_NAME="memmy-memory-${VERSION}-${TARGET}.tar.gz"

rm -rf "$WORK_DIR"
mkdir -p "$STAGE_DIR" "$OUT_DIR"

rm -rf "$CLI_DIR/dist/build"
npx tsc -p "$CLI_DIR/tsconfig.json"

mkdir -p "$STAGE_DIR/dist/cli"
cp -R "$CLI_DIR/dist/build/." "$STAGE_DIR/dist/cli/"
cp -R "$CLI_DIR/agent_inject.md" "$STAGE_DIR/dist/cli/agent_inject.md"
cp -R "$CLI_DIR/skills" "$STAGE_DIR/dist/cli/skills"

MEMMY_MEMORY_VERSION="$VERSION" MEMORY_PACKAGE_JSON="$MEMORY_ROOT/package.json" STAGE_PACKAGE_JSON="$STAGE_DIR/package.json" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const root = JSON.parse(readFileSync(process.env.MEMORY_PACKAGE_JSON, "utf8"));
const dependencies = {};
for (const name of ["yaml"]) {
  if (root.dependencies?.[name]) {
    dependencies[name] = root.dependencies[name];
  }
}
const runtime = {
  name: "memmy-memory-runtime",
  version: process.env.MEMMY_MEMORY_VERSION,
  private: true,
  type: "module",
  dependencies
};
writeFileSync(process.env.STAGE_PACKAGE_JSON, `${JSON.stringify(runtime, null, 2)}\n`);
NODE

(
  cd "$STAGE_DIR"
  npm install --omit=dev --no-audit --no-fund
)

if [[ "$TARGET" == windows-* ]]; then
  cat > "$STAGE_DIR/memmy-memory.cmd" <<'EOF'
@echo off
setlocal
set "DIR=%~dp0"
node "%DIR%dist\cli\index.js" %*
EOF
else
  cat > "$STAGE_DIR/memmy-memory" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/dist/cli/index.js" "$@"
EOF
  chmod +x "$STAGE_DIR/memmy-memory"
fi

(
  cd "$STAGE_DIR"
  archive_entries=(dist package.json package-lock.json)
  if [[ -d node_modules ]]; then
    archive_entries+=(node_modules)
  fi
  if [[ "$TARGET" == windows-* ]]; then
    tar -czf "$OUT_DIR/$ASSET_NAME" memmy-memory.cmd "${archive_entries[@]}"
  else
    tar -czf "$OUT_DIR/$ASSET_NAME" memmy-memory "${archive_entries[@]}"
  fi
)

echo "Built binary archive: $OUT_DIR/$ASSET_NAME"
