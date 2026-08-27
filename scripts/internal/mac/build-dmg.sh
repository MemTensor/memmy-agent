#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/App/shell/desktop"
AGENT_DIR="$ROOT_DIR/App/memmy-agent"
MEMORY_DIR="$ROOT_DIR/Memory"
MIGRATIONS_DIR="$ROOT_DIR/Migrations"
LOCAL_API_CONTRACTS_DIR="$ROOT_DIR/App/backend/local-api-contracts"
RUNTIME_DIR="$DESKTOP_DIR/dist/runtime"
MIGRATIONS_STAGING_DIR="$DESKTOP_DIR/dist/Migrations"
CLI_BIN_DIR="$RUNTIME_DIR/bin"
DMG_HELPER_DIR="$DESKTOP_DIR/dist/dmg"
EMBEDDING_MODELS_DIR="$DESKTOP_DIR/dist/embedding-models"
EMBEDDING_MODEL_ID="${MEMMY_EMBEDDING_MODEL:-Xenova/all-MiniLM-L6-v2}"
source "$ROOT_DIR/scripts/internal/shared/package-logging.sh"
package_log_init "mac-build-dmg" "$DESKTOP_DIR/release/logs"
package_install_error_trap

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

  node "$ROOT_DIR/scripts/internal/shared/write-desktop-edition-manifest.mjs" \
    --output "$DESKTOP_DIR/dist/main/desktop-edition.json" \
    --edition "$edition" \
    --account-channel "$account_channel" \
    --signing "$package_signing"
}

# Resolves NSMicrophoneUsageDescription from the package edition (cn/intl).
resolve_microphone_usage_description() {
  local edition="${MEMMY_APP_EDITION:-}"

  if [ -z "$edition" ]; then
    case "${MEMMY_ACCOUNT_CHANNEL:-phone}" in
      email)
        edition="intl"
        ;;
      *)
        edition="cn"
        ;;
    esac
  fi

  case "$edition" in
    intl)
      printf '%s' "Memmy uses the microphone only when you start voice input."
      ;;
    cn)
      printf '%s' "Memmy 仅在你开始语音输入时使用麦克风"
      ;;
    *)
      echo "Unsupported package edition for microphone usage description: $edition" >&2
      exit 1
      ;;
  esac
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

  ROOT_DIR="$ROOT_DIR" MEMORY_DIR="$MEMORY_DIR" MEMORY_RUNTIME_DIR="$output_dir" \
    LOCAL_API_CONTRACTS_DIR="$LOCAL_API_CONTRACTS_DIR" MIGRATIONS_DIR="$MIGRATIONS_DIR" \
    node --input-type=module <<'NODE'
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const rootDir = requiredEnv("ROOT_DIR");
const memoryDir = requiredEnv("MEMORY_DIR");
const runtimeDir = requiredEnv("MEMORY_RUNTIME_DIR");
const contractsDir = requiredEnv("LOCAL_API_CONTRACTS_DIR");
const migrationsDir = requiredEnv("MIGRATIONS_DIR");
const runtimeName = "memmy-memory-runtime";
const projectPackage = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const runtimeVersion = projectPackage.version;

const memoryPackage = JSON.parse(await readFile(join(memoryDir, "package.json"), "utf8"));
const contractsPackage = JSON.parse(await readFile(join(rootDir, "App/backend/local-api-contracts/package.json"), "utf8"));
const migrationsPackage = JSON.parse(await readFile(join(rootDir, "Migrations/package.json"), "utf8"));
const rootLock = JSON.parse(await readFile(join(rootDir, "package-lock.json"), "utf8"));
const dependencies = { ...(memoryPackage.dependencies ?? {}) };
delete dependencies["@memmy/local-api-contracts"];
delete dependencies["@memmy/migrations"];
Object.assign(dependencies, contractsPackage.dependencies, migrationsPackage.dependencies);
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

prune_node_modules_non_runtime_files() {
  local runtime_root="$1"

  if [ ! -d "$runtime_root" ]; then
    return
  fi

  local modules_dir
  while IFS= read -r modules_dir; do
    if [ ! -d "$modules_dir" ]; then
      continue
    fi

    local package_dir disposable_dir
    for package_dir in "$modules_dir"/* "$modules_dir"/@*/*; do
      if [ ! -d "$package_dir" ]; then
        continue
      fi

      for disposable_dir in \
        "$package_dir/test" \
        "$package_dir/tests" \
        "$package_dir/__tests__" \
        "$package_dir/doc" \
        "$package_dir/docs" \
        "$package_dir/example" \
        "$package_dir/examples" \
        "$package_dir/coverage" \
        "$package_dir/.github"; do
        rm -rf "$disposable_dir"
      done
    done

    if [ ! -d "$modules_dir" ]; then
      continue
    fi

    find "$modules_dir" -type f \( \
      -iname "README" -o \
      -iname "README*.md" -o \
      -iname "README*.mdown" -o \
      -iname "README*.markdown" -o \
      -iname "README*.rst" -o \
      -iname "README*.txt" -o \
      -iname "CHANGELOG" -o \
      -iname "CHANGELOG*.md" -o \
      -iname "CHANGELOG*.mdown" -o \
      -iname "CHANGELOG*.markdown" -o \
      -iname "CHANGELOG*.rst" -o \
      -iname "CHANGELOG*.txt" -o \
      -iname "CONTRIBUTING" -o \
      -iname "CONTRIBUTING*.md" -o \
      -iname "CONTRIBUTING*.mdown" -o \
      -iname "CONTRIBUTING*.markdown" -o \
      -iname "CONTRIBUTING*.rst" -o \
      -iname "CONTRIBUTING*.txt" -o \
      -iname "CODE_OF_CONDUCT" -o \
      -iname "CODE_OF_CONDUCT*.md" -o \
      -iname "CODE_OF_CONDUCT*.mdown" -o \
      -iname "CODE_OF_CONDUCT*.markdown" -o \
      -iname "CODE_OF_CONDUCT*.rst" -o \
      -iname "CODE_OF_CONDUCT*.txt" -o \
      -iname "SECURITY" -o \
      -iname "SECURITY*.md" -o \
      -iname "SECURITY*.mdown" -o \
      -iname "SECURITY*.markdown" -o \
      -iname "SECURITY*.rst" -o \
      -iname "SECURITY*.txt" \
    \) ! \( \
      -iname "LICENSE*" -o \
      -iname "NOTICE*" -o \
      -iname "COPYING*" \
    \) -delete

    find "$modules_dir" -type f \( \
      -iname "*.test.js" -o \
      -iname "*.test.cjs" -o \
      -iname "*.test.mjs" -o \
      -iname "*.test.ts" -o \
      -iname "*.test.tsx" -o \
      -iname "*.spec.js" -o \
      -iname "*.spec.cjs" -o \
      -iname "*.spec.mjs" -o \
      -iname "*.spec.ts" -o \
      -iname "*.spec.tsx" -o \
      -iname "test.js" -o \
      -iname "tests.json" \
    \) -delete
  done < <(find "$runtime_root" -type d -name node_modules)
}

require_packaged_runtime_file() {
  local required_file="$1"

  if [ ! -f "$required_file" ]; then
    echo "Missing required packaged runtime file: $required_file" >&2
    exit 1
  fi
}

require_packaged_runtime_glob() {
  local required_pattern="$1"

  if ! compgen -G "$required_pattern" >/dev/null; then
    echo "Missing required packaged runtime file matching: $required_pattern" >&2
    exit 1
  fi
}

verify_mac_memory_native_artifacts() {
  local target_cpu="$1"

  require_packaged_runtime_file "$RUNTIME_DIR/memory/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  require_packaged_runtime_glob "$RUNTIME_DIR/memory/node_modules/sqlite-vec-darwin-$target_cpu/vec0.*"
  require_packaged_runtime_file "$RUNTIME_DIR/memory/node_modules/onnxruntime-node/bin/napi-v3/darwin/$target_cpu/onnxruntime_binding.node"
  require_packaged_runtime_glob "$RUNTIME_DIR/memory/node_modules/onnxruntime-node/bin/napi-v3/darwin/$target_cpu/libonnxruntime*.dylib"
  require_packaged_runtime_file "$RUNTIME_DIR/memory/node_modules/@img/sharp-darwin-$target_cpu/lib/sharp-darwin-$target_cpu.node"
  require_packaged_runtime_glob "$RUNTIME_DIR/memory/node_modules/@img/sharp-libvips-darwin-$target_cpu/lib/libvips*.dylib"
}

verify_mac_agent_native_artifacts() {
  local target_cpu="$1"
  local node_pty_dir="$RUNTIME_DIR/memmy-agent/node_modules/openclaw/node_modules/@lydell/node-pty-darwin-$target_cpu/prebuilds/darwin-$target_cpu"

  require_packaged_runtime_file "$RUNTIME_DIR/memmy-agent/node_modules/@memmy/local-api-contracts/dist/index.js"
  if [ -L "$RUNTIME_DIR/memmy-agent/node_modules/@memmy/local-api-contracts" ]; then
    echo "Packaged local API contracts must not be a symbolic link." >&2
    exit 1
  fi
  require_packaged_runtime_file "$node_pty_dir/pty.node"
  require_packaged_runtime_file "$node_pty_dir/spawn-helper"
  require_packaged_runtime_glob "$RUNTIME_DIR/memmy-agent/node_modules/openclaw/node_modules/sqlite-vec-darwin-$target_cpu/vec0.*"
}

resolve_packaged_mac_app_path() {
  local target_cpu="$1"
  local app_path="$DESKTOP_DIR/release/mac-$target_cpu/Memmy.app"

  if [ "$target_cpu" = "x64" ] && [ ! -d "$app_path" ]; then
    app_path="$DESKTOP_DIR/release/mac/Memmy.app"
  fi

  printf '%s\n' "$app_path"
}

verify_packaged_mac_unpacked_artifacts() {
  local target_cpu="$1"
  local app_path
  app_path="$(resolve_packaged_mac_app_path "$target_cpu")"
  local unpacked_runtime="$app_path/Contents/Resources/app.asar.unpacked/dist/runtime"
  local packaged_embedding_model="$app_path/Contents/Resources/embedding-models/$EMBEDDING_MODEL_ID"

  require_packaged_runtime_file "$app_path/Contents/Resources/app.asar"
  verify_packaged_runtime_config_boundary "$app_path/Contents/Resources"
  require_packaged_runtime_glob "$unpacked_runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/darwin/$target_cpu/libonnxruntime*.dylib"
  require_packaged_runtime_glob "$unpacked_runtime/memory/node_modules/@img/sharp-libvips-darwin-$target_cpu/lib/libvips*.dylib"
  require_packaged_runtime_file "$unpacked_runtime/memmy-agent/node_modules/@memmy/migrations/dist/index.js"
  require_packaged_runtime_file "$packaged_embedding_model/config.json"
  require_packaged_runtime_file "$packaged_embedding_model/tokenizer.json"
  require_packaged_runtime_file "$packaged_embedding_model/onnx/model_quantized.onnx"
  if [ -L "$unpacked_runtime/memmy-agent/node_modules/@memmy/migrations" ]; then
    echo "Packaged migrations package must not be a symbolic link." >&2
    exit 1
  fi
  require_packaged_runtime_file "$unpacked_runtime/memmy-agent/node_modules/openclaw/node_modules/@lydell/node-pty-darwin-$target_cpu/prebuilds/darwin-$target_cpu/spawn-helper"
}

verify_packaged_runtime_config_boundary() {
  local resources_root="$1"
  local asar_file="$resources_root/app.asar"
  local forbidden_env

  forbidden_env="$(find "$resources_root" \( -type f -o -type l \) \( -name ".env" -o -name ".env.*" \) -print -quit)"
  if [ -n "$forbidden_env" ]; then
    echo "Packaged resources contain a forbidden environment file." >&2
    exit 1
  fi
  node "$ROOT_DIR/scripts/internal/shared/verify-packaged-asar.mjs" \
    --asar "$asar_file" \
    --expected "$DESKTOP_VERSION"
}

prune_mac_runtime_artifacts() {
  local target_cpu="$1"

  echo "Pruning macOS runtime artifacts for darwin-$target_cpu."
  find "$RUNTIME_DIR" -type f -name "*.map" -delete
  node "$ROOT_DIR/scripts/internal/shared/prune-runtime-env-files.mjs" "$RUNTIME_DIR"
  prune_node_modules_non_runtime_files "$RUNTIME_DIR"
  rm -f "$RUNTIME_DIR/memmy-agent/dist/skills/README.md"

  while IFS= read -r module_dir; do
    prune_better_sqlite3_build_artifacts "$module_dir"
  done < <(find "$RUNTIME_DIR" -path "*/node_modules/better-sqlite3" -type d)

  while IFS= read -r napi_dir; do
    prune_onnxruntime_native_artifacts "$target_cpu" "$napi_dir"
  done < <(find "$RUNTIME_DIR" -path "*/node_modules/onnxruntime-node/bin/napi-v3" -type d)
}

cd "$ROOT_DIR"
if [ -n "${MEMMY_DESKTOP_VERSION:-}" ]; then
  DESKTOP_VERSION="$MEMMY_DESKTOP_VERSION"
else
  DESKTOP_VERSION="$(node -p "require('$DESKTOP_DIR/package.json').version")"
fi
package_step_start "Verify macOS package version metadata"
node scripts/internal/shared/verify-package-version.mjs --expected "$DESKTOP_VERSION"
export MEMMY_VERSION_SYNC_CHECK_ONLY=1

for builder_arg in "$@"; do
  case "$builder_arg" in
    --config.extraMetadata.version="$DESKTOP_VERSION")
      ;;
    --config.extraMetadata.version|--config.extraMetadata.version=*)
      echo "Desktop package version metadata must match $DESKTOP_VERSION." >&2
      exit 1
      ;;
    --config|--config=*|--config.extraMetadata|--config.extraMetadata=*)
      echo "Desktop package configuration is managed by the packaging scripts." >&2
      exit 1
      ;;
  esac
done

BUILDER_CONFIG="electron-builder.yml"
TARGET_CPU="$(resolve_target_cpu "$@")"
if [ "${MEMMY_SKIP_CODESIGN:-}" = "1" ]; then
  BUILDER_CONFIG="electron-builder.unsigned.yml"
  echo "Building unsigned DMG for local testing. This build is not notarized."
fi

echo "Preparing macOS $TARGET_CPU package."
package_log "macOS package context: version=$DESKTOP_VERSION arch=$TARGET_CPU builderConfig=$BUILDER_CONFIG signing=${MEMMY_PACKAGE_SIGNING:-${MEMMY_SKIP_CODESIGN:+unsigned}}"

package_step_start "Install root workspace dependencies if needed"
if [ ! -x "$ROOT_DIR/node_modules/.bin/tsc" ] || [ ! -x "$ROOT_DIR/node_modules/.bin/electron-builder" ]; then
  npm install
else
  package_log "Root workspace dependencies already available."
fi
package_step_start "Install migrations workspace dev dependencies"
npm install --workspace @memmy/migrations --include=dev
package_step_start "Check frontend desktop workspace dependencies"
if npm ls --workspace @memmy/frontend-desktop --depth=0 >/dev/null 2>&1; then
  echo "Frontend desktop workspace dependencies already installed."
else
  npm install --workspace @memmy/frontend-desktop --no-package-lock
fi

echo "Building migrations package."
package_step_start "Build migrations package"
npm --prefix "$MIGRATIONS_DIR" run build

echo "Building local API contracts package."
package_step_start "Build local API contracts package"
npm run build -w @memmy/local-api-contracts

echo "Installing memmy-agent dependencies."
package_step_start "Install memmy-agent workspace dependencies"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix "$AGENT_DIR"

package_step_start "Build Memory workspace"
npm run build -w @memmy/memory
package_step_start "Build memmy-agent runtime"
npm --prefix "$AGENT_DIR" run build
package_step_start "Build Electron desktop shell"
npm run build -w @memmy/desktop
package_step_start "Write desktop edition manifest"
write_desktop_edition_manifest

package_step_start "Prepare packaged runtime staging directories"
rm -rf "$RUNTIME_DIR"
rm -rf "$DMG_HELPER_DIR"
rm -rf "$MIGRATIONS_STAGING_DIR"
rm -rf "$EMBEDDING_MODELS_DIR"
mkdir -p "$RUNTIME_DIR/memory" "$RUNTIME_DIR/memmy-agent" "$CLI_BIN_DIR" "$DMG_HELPER_DIR"
mkdir -p "$MIGRATIONS_STAGING_DIR"
cp "$MIGRATIONS_DIR/package.json" "$MIGRATIONS_STAGING_DIR/package.json"
cp -R "$MIGRATIONS_DIR/dist" "$MIGRATIONS_STAGING_DIR/dist"
cp -R "$MEMORY_DIR/dist/src" "$RUNTIME_DIR/memory/src"
cp -R "$AGENT_DIR/dist" "$RUNTIME_DIR/memmy-agent/dist"
package_step_start "Create Memory runtime manifest"
create_memory_runtime_manifest "$RUNTIME_DIR/memory"
package_step_start "Resolve Memory runtime lockfile"
npm install --prefix "$RUNTIME_DIR/memory" --package-lock-only --ignore-scripts --os=darwin --cpu="$TARGET_CPU"
package_step_start "Install Memory runtime production dependencies"
npm ci --prefix "$RUNTIME_DIR/memory" --omit=dev --os=darwin --cpu="$TARGET_CPU"
package_step_start "Stage Memory workspace runtime packages"
MEMORY_RUNTIME_CONTRACTS_DIR="$RUNTIME_DIR/memory/node_modules/@memmy/local-api-contracts"
MEMORY_RUNTIME_MIGRATIONS_DIR="$RUNTIME_DIR/memory/node_modules/@memmy/migrations"
rm -rf "$MEMORY_RUNTIME_CONTRACTS_DIR" "$MEMORY_RUNTIME_MIGRATIONS_DIR"
mkdir -p "$MEMORY_RUNTIME_CONTRACTS_DIR" "$MEMORY_RUNTIME_MIGRATIONS_DIR"
cp "$ROOT_DIR/App/backend/local-api-contracts/package.json" "$MEMORY_RUNTIME_CONTRACTS_DIR/package.json"
cp -R "$ROOT_DIR/App/backend/local-api-contracts/dist" "$MEMORY_RUNTIME_CONTRACTS_DIR/dist"
cp "$MIGRATIONS_STAGING_DIR/package.json" "$MEMORY_RUNTIME_MIGRATIONS_DIR/package.json"
cp -R "$MIGRATIONS_STAGING_DIR/dist" "$MEMORY_RUNTIME_MIGRATIONS_DIR/dist"
require_packaged_runtime_file "$MEMORY_RUNTIME_CONTRACTS_DIR/dist/index.js"
require_packaged_runtime_file "$MEMORY_RUNTIME_MIGRATIONS_DIR/dist/index.js"
package_step_start "Rebuild Memory native modules for Electron"
ELECTRON_VERSION="$(node -p "require('./App/shell/desktop/node_modules/electron/package.json').version")"
node_modules/.bin/electron-rebuild \
  -f \
  -v "$ELECTRON_VERSION" \
  -a "$TARGET_CPU" \
  -w better-sqlite3 \
  -m "$RUNTIME_DIR/memory"
package_step_start "Install memmy-agent runtime production dependencies"
cp "$AGENT_DIR/package.json" "$RUNTIME_DIR/memmy-agent/package.json"
cp "$AGENT_DIR/package-lock.json" "$RUNTIME_DIR/memmy-agent/package-lock.json"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix "$RUNTIME_DIR/memmy-agent" --omit=dev --os=darwin --cpu="$TARGET_CPU"
package_step_start "Stage memmy-agent workspace runtime packages"
RUNTIME_LOCAL_API_CONTRACTS_DIR="$RUNTIME_DIR/memmy-agent/node_modules/@memmy/local-api-contracts"
rm -rf "$RUNTIME_LOCAL_API_CONTRACTS_DIR"
mkdir -p "$RUNTIME_LOCAL_API_CONTRACTS_DIR"
cp "$LOCAL_API_CONTRACTS_DIR/package.json" "$RUNTIME_LOCAL_API_CONTRACTS_DIR/package.json"
cp -R "$LOCAL_API_CONTRACTS_DIR/dist" "$RUNTIME_LOCAL_API_CONTRACTS_DIR/dist"
if [ -L "$RUNTIME_LOCAL_API_CONTRACTS_DIR" ]; then
  echo "Packaged local API contracts must not be a symbolic link." >&2
  exit 1
fi
if [ ! -f "$RUNTIME_LOCAL_API_CONTRACTS_DIR/dist/index.js" ]; then
  echo "Packaged local API contracts entrypoint is missing." >&2
  exit 1
fi
RUNTIME_MIGRATIONS_DIR="$RUNTIME_DIR/memmy-agent/node_modules/@memmy/migrations"
rm -rf "$RUNTIME_MIGRATIONS_DIR"
mkdir -p "$RUNTIME_MIGRATIONS_DIR"
cp "$MIGRATIONS_STAGING_DIR/package.json" "$RUNTIME_MIGRATIONS_DIR/package.json"
cp -R "$MIGRATIONS_STAGING_DIR/dist" "$RUNTIME_MIGRATIONS_DIR/dist"
if [ -L "$RUNTIME_MIGRATIONS_DIR" ]; then
  echo "Packaged migrations package must not be a symbolic link." >&2
  exit 1
fi
if [ ! -f "$RUNTIME_MIGRATIONS_DIR/dist/index.js" ]; then
  echo "Packaged migrations entrypoint is missing." >&2
  exit 1
fi
rm -rf "$MIGRATIONS_STAGING_DIR"
if [ -e "$MIGRATIONS_STAGING_DIR" ]; then
  echo "Migrations staging directory was not removed." >&2
  exit 1
fi
package_step_start "Verify memmy-agent runtime exports"
(
  cd "$RUNTIME_DIR/memmy-agent"
  node --input-type=module --eval '
    import fs from "node:fs";
    import path from "node:path";
    import { createRequire } from "node:module";
    import {
      CURRENT_MIGRATION_STATE_FORMAT_VERSION,
      SUPPORTED_MIGRATION_STATE_FORMAT_VERSIONS,
      runMigrations,
    } from "@memmy/migrations";
    import { cloudServiceFromDesktopRuntimeManifest } from "@memmy/local-api-contracts";
    import { createConnection } from "@playwright/mcp";
    import { chromium } from "playwright";
    const require = createRequire(import.meta.url);
    const runtimePackage = require("./package.json");
    const mcpPath = require.resolve("@playwright/mcp/package.json");
    const playwrightPath = require.resolve("playwright/package.json");
    const corePath = require.resolve("playwright-core/package.json");
    const mcpPackage = require(mcpPath);
    const playwrightPackage = require(playwrightPath);
    const corePackage = require(corePath);
    if (typeof runMigrations !== "function") throw new Error("Migrations runtime export is unavailable");
    if (typeof cloudServiceFromDesktopRuntimeManifest !== "function") throw new Error("Local API contracts runtime export is unavailable");
    if (CURRENT_MIGRATION_STATE_FORMAT_VERSION !== 2 || JSON.stringify(SUPPORTED_MIGRATION_STATE_FORMAT_VERSIONS) !== "[1,2]") throw new Error("Migrations runtime state compatibility mismatch");
    if (typeof createConnection !== "function" || typeof chromium?.executablePath !== "function") throw new Error("Playwright MCP runtime exports are unavailable");
    if (mcpPackage.version !== runtimePackage.dependencies["@playwright/mcp"]) throw new Error("Playwright MCP runtime version mismatch");
    if (playwrightPackage.version !== runtimePackage.dependencies.playwright || corePackage.version !== runtimePackage.dependencies.playwright) throw new Error("Playwright runtime version mismatch");
    if (!fs.existsSync(path.join(path.dirname(playwrightPath), "cli.js"))) throw new Error("Playwright runtime CLI is missing");
    const commandEntrypoint = "./dist/entrypoints/cli/commands.js";
    if (!fs.readFileSync(commandEntrypoint, "utf8").includes("browser-prepare")) throw new Error("browser-prepare command is missing");
  '
)
package_step_start "Rebuild memmy-agent native modules for Electron"
node_modules/.bin/electron-rebuild \
  -f \
  -v "$ELECTRON_VERSION" \
  -a "$TARGET_CPU" \
  -w better-sqlite3 \
  -m "$RUNTIME_DIR/memmy-agent"
package_step_start "Create CLI launchers"
create_cli_launcher "$CLI_BIN_DIR/memmy-memory" "dist/runtime/memory/src/cli/index.js"
create_cli_launcher "$CLI_BIN_DIR/memmy" "dist/runtime/memmy-agent/dist/main.js"
create_cli_installer "$CLI_BIN_DIR/install-cli"
create_dmg_cli_installer_command "$DMG_HELPER_DIR/Install CLI.command"
package_step_start "Prune and verify macOS runtime artifacts"
prune_mac_runtime_artifacts "$TARGET_CPU"
verify_mac_memory_native_artifacts "$TARGET_CPU"
verify_mac_agent_native_artifacts "$TARGET_CPU"
package_step_start "Verify packaged runtime versions"
node "$ROOT_DIR/scripts/internal/shared/verify-package-version.mjs" \
  --expected "$DESKTOP_VERSION" \
  --runtime-root "$RUNTIME_DIR"
package_step_start "Prepare bundled embedding model"
node "$ROOT_DIR/scripts/internal/shared/prepare-embedding-model.mjs" "$EMBEDDING_MODELS_DIR"

if [ "${MEMMY_PACKAGE_PREPARE_ONLY:-}" = "1" ]; then
  echo "Prepared desktop runtime resources at $RUNTIME_DIR"
  package_log_finish 0
  exit 0
fi

cd "$DESKTOP_DIR"
# DMG background images are committed static assets and are no longer generated during packaging.
# For style changes, see the historical generator in git history.
MEMMY_MICROPHONE_USAGE_DESCRIPTION="$(resolve_microphone_usage_description)"
echo "Using edition microphone usage description: $MEMMY_MICROPHONE_USAGE_DESCRIPTION"

BUILDER_ARGS=(--config "$BUILDER_CONFIG")
if [ -n "${MEMMY_ELECTRON_DIST:-}" ]; then
  BUILDER_ARGS+=(--config.electronDist="$MEMMY_ELECTRON_DIST")
fi
BUILDER_ARGS+=(--config.mac.extendInfo.NSMicrophoneUsageDescription="$MEMMY_MICROPHONE_USAGE_DESCRIPTION")

package_step_start "Run electron-builder macOS DMG packaging"
npx electron-builder "${BUILDER_ARGS[@]}" --mac dmg "$@"
package_step_start "Verify packaged macOS app artifacts"
verify_packaged_mac_unpacked_artifacts "$TARGET_CPU"

LATEST_DMG="$(ls -t release/*.dmg 2>/dev/null | head -1 || true)"
if [ -n "$LATEST_DMG" ]; then
  echo "Swapping oversized DMG background for resize tolerance..."
  package_step_start "Patch DMG window background"
  bash "$ROOT_DIR/scripts/internal/shared/fix-dmg-window-bounds.sh" "$LATEST_DMG" "Memmy Installer" "$DESKTOP_DIR" || \
    echo "Warning: could not swap DMG background — resize may show white edges."
else
  echo "Packaging completed without a DMG artifact." >&2
  exit 1
fi
package_log_finish 0
