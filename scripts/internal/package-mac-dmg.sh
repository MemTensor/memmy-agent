#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/App/shell/desktop"
AGENT_DIR="$ROOT_DIR/App/memmy-agent"
MEMORY_DIR="$ROOT_DIR/Memory"
RUNTIME_DIR="$DESKTOP_DIR/dist/runtime"
CLI_BIN_DIR="$RUNTIME_DIR/bin"
DMG_HELPER_DIR="$DESKTOP_DIR/dist/dmg"

resolve_target_cpu() {
  local target_cpu=""

  for arg in "$@"; do
    case "$arg" in
      --arm64|arm64)
        target_cpu="arm64"
        ;;
      --x64|x64)
        target_cpu="x64"
        ;;
      --universal|universal)
        echo "Universal macOS packaging is not supported by this script yet; build --arm64 and --x64 separately." >&2
        exit 1
        ;;
    esac
  done

  if [ -z "$target_cpu" ]; then
    case "$(uname -m)" in
      arm64)
        target_cpu="arm64"
        ;;
      x86_64)
        target_cpu="x64"
        ;;
      *)
        echo "Cannot infer macOS packaging CPU from uname -m. Pass --arm64 or --x64." >&2
        exit 1
        ;;
    esac
  fi

  echo "$target_cpu"
}

write_desktop_edition_manifest() {
  local account_channel="${MEMMY_ACCOUNT_CHANNEL:-phone}"
  local package_signing="${MEMMY_PACKAGE_SIGNING:-}"
  local edition="cn"

  case "$account_channel" in
    email)
      edition="intl"
      ;;
    phone|"")
      account_channel="phone"
      ;;
    *)
      echo "Unsupported MEMMY_ACCOUNT_CHANNEL: $account_channel" >&2
      exit 1
      ;;
  esac

  if [ -z "$package_signing" ]; then
    if [ "${MEMMY_SKIP_CODESIGN:-}" = "1" ]; then
      package_signing="unsigned"
    else
      package_signing="signed"
    fi
  fi

  case "$package_signing" in
    signed|unsigned)
      ;;
    *)
      echo "Unsupported MEMMY_PACKAGE_SIGNING: $package_signing" >&2
      exit 1
      ;;
  esac

  cat > "$DESKTOP_DIR/dist/main/desktop-edition.json" <<EOF
{
  "edition": "$edition",
  "accountChannel": "$account_channel",
  "signing": "$package_signing"
}
EOF
}

create_cli_launcher() {
  local output_path="$1"
  local asar_entry="$2"

  cat > "$output_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail

SOURCE="\${BASH_SOURCE[0]}"
while [ -L "\$SOURCE" ]; do
  SOURCE_DIR="\$(cd -P "\$(dirname "\$SOURCE")" && pwd)"
  TARGET="\$(readlink "\$SOURCE")"
  if [[ "\$TARGET" == /* ]]; then
    SOURCE="\$TARGET"
  else
    SOURCE="\$SOURCE_DIR/\$TARGET"
  fi
done
SCRIPT_DIR="\$(cd -P "\$(dirname "\$SOURCE")" && pwd)"
RESOURCES_DIR="\$(cd "\$SCRIPT_DIR/.." && pwd)"
MACOS_DIR="\$RESOURCES_DIR/../MacOS"
APP_EXEC="\$MACOS_DIR/Memmy"

if [ ! -x "\$APP_EXEC" ]; then
  for candidate in "\$MACOS_DIR"/*; do
    if [ -f "\$candidate" ] && [ -x "\$candidate" ]; then
      APP_EXEC="\$candidate"
      break
    fi
  done
fi

if [ ! -x "\$APP_EXEC" ]; then
  echo "Cannot find Memmy app executable under \$MACOS_DIR" >&2
  exit 1
fi

DEFAULT_CONFIG="\$HOME/.memmy/config.yaml"
if [ -z "\${MEMMY_CONFIG:-}" ] && [ -f "\$DEFAULT_CONFIG" ]; then
  export MEMMY_CONFIG="\$DEFAULT_CONFIG"
fi

export ELECTRON_RUN_AS_NODE=1
export NODE_ENV="\${NODE_ENV:-production}"
exec "\$APP_EXEC" "\$RESOURCES_DIR/app.asar/$asar_entry" "\$@"
EOF

  chmod 755 "$output_path"
}

create_cli_installer() {
  local output_path="$1"

  cat > "$output_path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  SOURCE_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  TARGET="$(readlink "$SOURCE")"
  if [[ "$TARGET" == /* ]]; then
    SOURCE="$TARGET"
  else
    SOURCE="$SOURCE_DIR/$TARGET"
  fi
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
PREFIX="${MEMMY_CLI_PREFIX:-}"

usage() {
  cat <<'USAGE'
Usage: install-cli [--prefix <dir>]

Installs symlinks for:
  memmy-memory
  memmy

Default prefix:
  ~/.local/bin
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      if [ "$#" -lt 2 ]; then
        echo "--prefix requires a directory" >&2
        exit 1
      fi
      PREFIX="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$PREFIX" ]; then
  PREFIX="$HOME/.local/bin"
fi

mkdir -p "$PREFIX"
ln -sf "$SCRIPT_DIR/memmy-memory" "$PREFIX/memmy-memory"
ln -sf "$SCRIPT_DIR/memmy" "$PREFIX/memmy"

add_local_bin_to_profile() {
  local profile_path="$1"
  local marker="# Memmy CLI PATH"

  if [ ! -f "$profile_path" ] || ! grep -Fq "$marker" "$profile_path"; then
    {
      echo ""
      echo "$marker"
      echo 'export PATH="$HOME/.local/bin:$PATH"'
    } >> "$profile_path"
  fi
}

cat <<MESSAGE
Memmy CLI installed:
  $PREFIX/memmy-memory -> $SCRIPT_DIR/memmy-memory
  $PREFIX/memmy        -> $SCRIPT_DIR/memmy
MESSAGE

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *)
    if [ "$PREFIX" = "$HOME/.local/bin" ]; then
      add_local_bin_to_profile "$HOME/.zshrc"
      add_local_bin_to_profile "$HOME/.bash_profile"
      cat <<MESSAGE

Added ~/.local/bin to ~/.zshrc and ~/.bash_profile when needed.
Run the command for your shell now, or open a new terminal:

  source ~/.zshrc
  source ~/.bash_profile
MESSAGE
    else
      cat <<MESSAGE

Warning: $PREFIX is not in PATH for this shell.
Add this line to ~/.zshrc, then open a new terminal:

  export PATH="$PREFIX:\$PATH"
MESSAGE
    fi
    ;;
esac
EOF

  chmod 755 "$output_path"
}

create_dmg_cli_installer_command() {
  local output_path="$1"

  cat > "$output_path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

APP_PATH="/Applications/Memmy.app"
INSTALLER="$APP_PATH/Contents/Resources/cli/install-cli"

if [ ! -x "$INSTALLER" ]; then
  MESSAGE="Please drag Memmy to Applications first, then run Install CLI again."
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display dialog \"$MESSAGE\" buttons {\"OK\"} default button \"OK\" with icon caution" >/dev/null
  else
    echo "$MESSAGE" >&2
  fi
  exit 1
fi

"$INSTALLER"

echo
echo "Done. You can close this window."
EOF

  chmod 755 "$output_path"
}

create_memory_runtime_manifest() {
  local output_dir="$1"

  ROOT_DIR="$ROOT_DIR" MEMORY_DIR="$MEMORY_DIR" MEMORY_RUNTIME_DIR="$output_dir" node --input-type=module <<'NODE'
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const rootDir = requiredEnv("ROOT_DIR");
const memoryDir = requiredEnv("MEMORY_DIR");
const runtimeDir = requiredEnv("MEMORY_RUNTIME_DIR");
const runtimeName = "memmy-memory-runtime";
const projectPackage = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const runtimeVersion = projectPackage.version;

const memoryPackage = JSON.parse(await readFile(join(memoryDir, "package.json"), "utf8"));
const rootLock = JSON.parse(await readFile(join(rootDir, "package-lock.json"), "utf8"));
const dependencies = memoryPackage.dependencies ?? {};
const runtimePackage = {
  name: runtimeName,
  version: runtimeVersion,
  private: true,
  type: "module",
  dependencies
};
const sourcePackages = rootLock.packages ?? {};
const runtimeLock = {
  name: runtimeName,
  version: runtimeVersion,
  lockfileVersion: rootLock.lockfileVersion,
  requires: rootLock.requires,
  packages: {
    "": {
      name: runtimeName,
      version: runtimeVersion,
      private: true,
      type: "module",
      dependencies
    }
  }
};
const selectedPackageKeys = new Set([""]);

for (const dependencyName of Object.keys(dependencies)) {
  addDependency("", dependencyName, false);
}

for (const packageKey of selectedPackageKeys) {
  if (packageKey === "") {
    continue;
  }
  runtimeLock.packages[packageKey] = sourcePackages[packageKey];
}

await mkdir(runtimeDir, { recursive: true });
await writeFile(join(runtimeDir, "package.json"), `${JSON.stringify(runtimePackage, null, 2)}\n`);
await writeFile(join(runtimeDir, "package-lock.json"), `${JSON.stringify(runtimeLock, null, 2)}\n`);

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function addPackage(packageKey) {
  if (selectedPackageKeys.has(packageKey)) {
    return;
  }

  const packageInfo = sourcePackages[packageKey];
  if (!packageInfo) {
    throw new Error(`Missing package-lock entry for ${packageKey}`);
  }

  selectedPackageKeys.add(packageKey);
  for (const dependencyName of Object.keys(packageInfo.dependencies ?? {})) {
    addDependency(packageKey, dependencyName, false);
  }
  for (const dependencyName of Object.keys(packageInfo.optionalDependencies ?? {})) {
    addDependency(packageKey, dependencyName, true);
  }
}

function addDependency(fromPackageKey, dependencyName, optional) {
  const packageKey = resolvePackageKey(fromPackageKey, dependencyName);
  if (!packageKey) {
    if (optional) {
      return;
    }
    throw new Error(`Cannot resolve ${dependencyName} from ${fromPackageKey || "runtime root"}`);
  }
  addPackage(packageKey);
}

function resolvePackageKey(fromPackageKey, dependencyName) {
  const candidates = [];
  if (fromPackageKey) {
    candidates.push(`${fromPackageKey}/node_modules/${dependencyName}`);

    let currentKey = fromPackageKey;
    while (currentKey.includes("/node_modules/")) {
      currentKey = currentKey.slice(0, currentKey.lastIndexOf("/node_modules/"));
      candidates.push(`${currentKey}/node_modules/${dependencyName}`);
    }
  }
  candidates.push(`node_modules/${dependencyName}`);
  return candidates.find((candidate) => sourcePackages[candidate]);
}
NODE
}

prune_better_sqlite3_build_artifacts() {
  local module_dir="$1"
  local native_file="$module_dir/build/Release/better_sqlite3.node"

  if [ ! -f "$native_file" ]; then
    return
  fi

  local tmp_dir
  tmp_dir="$(mktemp -d)"
  mkdir -p "$tmp_dir/build/Release"
  cp "$native_file" "$tmp_dir/build/Release/better_sqlite3.node"
  rm -rf "$module_dir/build" "$module_dir/deps"
  mkdir -p "$module_dir/build/Release"
  cp "$tmp_dir/build/Release/better_sqlite3.node" "$native_file"
  rm -rf "$tmp_dir"
}

prune_onnxruntime_native_artifacts() {
  local target_cpu="$1"
  local napi_dir="$2"

  if [ ! -d "$napi_dir" ]; then
    return
  fi

  find "$napi_dir" -mindepth 1 -maxdepth 1 -type d ! -name darwin -exec rm -rf {} +
  case "$target_cpu" in
    arm64)
      rm -rf "$napi_dir/darwin/x64"
      ;;
    x64)
      rm -rf "$napi_dir/darwin/arm64"
      ;;
  esac
}

prune_mac_runtime_artifacts() {
  local target_cpu="$1"

  echo "Pruning macOS runtime artifacts for darwin-$target_cpu."
  find "$RUNTIME_DIR" -type f -name "*.map" -delete

  while IFS= read -r module_dir; do
    prune_better_sqlite3_build_artifacts "$module_dir"
  done < <(find "$RUNTIME_DIR" -path "*/node_modules/better-sqlite3" -type d)

  while IFS= read -r napi_dir; do
    prune_onnxruntime_native_artifacts "$target_cpu" "$napi_dir"
  done < <(find "$RUNTIME_DIR" -path "*/node_modules/onnxruntime-node/bin/napi-v3" -type d)
}

cd "$ROOT_DIR"
node scripts/sync-project-version.mjs

BUILDER_CONFIG="electron-builder.yml"
TARGET_CPU="$(resolve_target_cpu "$@")"
if [ "${MEMMY_SKIP_CODESIGN:-}" = "1" ]; then
  BUILDER_CONFIG="electron-builder.unsigned.yml"
  echo "Building unsigned DMG for local testing. This build is not notarized."
fi

echo "Preparing macOS $TARGET_CPU package."

if [ ! -x "$ROOT_DIR/node_modules/.bin/tsc" ] || [ ! -x "$ROOT_DIR/node_modules/.bin/electron-builder" ]; then
  npm install
fi
npm install --workspace @memmy/frontend-desktop --no-package-lock

echo "Installing memmy-agent dependencies."
npm ci --prefix "$AGENT_DIR"

npm run build -w @memmy/memory
npm --prefix "$AGENT_DIR" run build
npm run build -w @memmy/desktop
write_desktop_edition_manifest

rm -rf "$RUNTIME_DIR"
rm -rf "$DMG_HELPER_DIR"
mkdir -p "$RUNTIME_DIR/memory" "$RUNTIME_DIR/memmy-agent" "$CLI_BIN_DIR" "$DMG_HELPER_DIR"
cp -R "$MEMORY_DIR/dist/src" "$RUNTIME_DIR/memory/src"
cp -R "$AGENT_DIR/dist" "$RUNTIME_DIR/memmy-agent/dist"
create_memory_runtime_manifest "$RUNTIME_DIR/memory"
npm ci --prefix "$RUNTIME_DIR/memory" --omit=dev --os=darwin --cpu="$TARGET_CPU"
ELECTRON_VERSION="$(node -p "require('./App/shell/desktop/node_modules/electron/package.json').version")"
node_modules/.bin/electron-rebuild \
  -f \
  -v "$ELECTRON_VERSION" \
  -a "$TARGET_CPU" \
  -w better-sqlite3 \
  -m "$RUNTIME_DIR/memory"
cp "$AGENT_DIR/package.json" "$RUNTIME_DIR/memmy-agent/package.json"
cp "$AGENT_DIR/package-lock.json" "$RUNTIME_DIR/memmy-agent/package-lock.json"
npm ci --prefix "$RUNTIME_DIR/memmy-agent" --omit=dev --os=darwin --cpu="$TARGET_CPU"
node_modules/.bin/electron-rebuild \
  -f \
  -v "$ELECTRON_VERSION" \
  -a "$TARGET_CPU" \
  -w better-sqlite3 \
  -m "$RUNTIME_DIR/memmy-agent"
create_cli_launcher "$CLI_BIN_DIR/memmy-memory" "dist/runtime/memory/src/cli/index.js"
create_cli_launcher "$CLI_BIN_DIR/memmy" "dist/runtime/memmy-agent/dist/main.js"
create_cli_installer "$CLI_BIN_DIR/install-cli"
create_dmg_cli_installer_command "$DMG_HELPER_DIR/Install CLI.command"
prune_mac_runtime_artifacts "$TARGET_CPU"

if [ "${MEMMY_PACKAGE_PREPARE_ONLY:-}" = "1" ]; then
  echo "Prepared desktop runtime resources at $RUNTIME_DIR"
  exit 0
fi

cd "$DESKTOP_DIR"
# DMG background images are committed static assets and are no longer generated during packaging.
# For style changes, see the historical generator in git history.
BUILDER_ARGS=(--config "$BUILDER_CONFIG")
if [ -n "${MEMMY_ELECTRON_DIST:-}" ]; then
  BUILDER_ARGS+=(--config.electronDist="$MEMMY_ELECTRON_DIST")
fi

npx electron-builder "${BUILDER_ARGS[@]}" --mac dmg "$@"

LATEST_DMG="$(ls -t release/*.dmg 2>/dev/null | head -1 || true)"
if [ -n "$LATEST_DMG" ]; then
  echo "Swapping oversized DMG background for resize tolerance..."
  bash "$ROOT_DIR/scripts/internal/fix-dmg-window-bounds.sh" "$LATEST_DMG" "Memmy Installer" "$DESKTOP_DIR" || \
    echo "Warning: could not swap DMG background — resize may show white edges."
else
  echo "Packaging completed without a DMG artifact." >&2
  exit 1
fi
