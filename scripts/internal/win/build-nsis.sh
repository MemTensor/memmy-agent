#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT_DIR/scripts/internal/shared/package-logging.sh"
DESKTOP_DIR="$ROOT_DIR/App/shell/desktop"
AGENT_DIR="$ROOT_DIR/App/memmy-agent"
MEMORY_DIR="$ROOT_DIR/Memory"
MIGRATIONS_DIR="$ROOT_DIR/Migrations"
LOCAL_API_CONTRACTS_DIR="$ROOT_DIR/App/backend/local-api-contracts"
RUNTIME_DIR="$DESKTOP_DIR/dist/runtime"
MIGRATIONS_STAGING_DIR="$DESKTOP_DIR/dist/Migrations"
CLI_BIN_DIR="$RUNTIME_DIR/bin"
EMBEDDING_MODELS_DIR="$DESKTOP_DIR/dist/embedding-models"
EMBEDDING_MODEL_ID="${MEMMY_EMBEDDING_MODEL:-Xenova/all-MiniLM-L6-v2}"
PACKAGE_ARCH="x64"
WINDOWS_SIGNING_BUILDER_ARGS=()

to_node_readable_path() {
  local input_path="$1"

  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$input_path"
    return
  fi

  printf '%s\n' "$input_path"
}

read_package_version() {
  local package_json_path
  package_json_path="$(to_node_readable_path "$1")"

  node - "$package_json_path" <<'NODE'
const { readFileSync } = require("node:fs");

const [packageJsonPath] = process.argv.slice(2);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

if (!packageJson.version) {
  throw new Error(`Missing version in ${packageJsonPath}`);
}

process.stdout.write(packageJson.version);
NODE
}

configure_npm_script_shell() {
  local bash_path
  bash_path="$(command -v bash || true)"
  if [ -z "$bash_path" ]; then
    return
  fi

  export npm_config_script_shell="${MEMMY_NPM_SCRIPT_SHELL:-$(to_node_readable_path "$bash_path")}"
  export NPM_CONFIG_SCRIPT_SHELL="$npm_config_script_shell"
}

npm_with_configured_script_shell() {
  if [ -n "${npm_config_script_shell:-}" ]; then
    npm --script-shell "$npm_config_script_shell" "$@"
    return
  fi

  npm "$@"
}

resolve_electron_dist() {
  local electron_dist="${MEMMY_ELECTRON_DIST:-}"

  if [ -z "$electron_dist" ] && [ -f "$DESKTOP_DIR/node_modules/electron/dist/electron.exe" ]; then
    electron_dist="$DESKTOP_DIR/node_modules/electron/dist"
  fi

  if [ -n "$electron_dist" ]; then
    to_node_readable_path "$electron_dist"
  fi
}

if [ -n "${MEMMY_DESKTOP_VERSION:-}" ]; then
  DESKTOP_VERSION="$MEMMY_DESKTOP_VERSION"
else
  DESKTOP_VERSION="$(read_package_version "$DESKTOP_DIR/package.json")"
fi
node "$ROOT_DIR/scripts/internal/shared/verify-package-version.mjs" --expected "$DESKTOP_VERSION"
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
configure_npm_script_shell

if [ "${MEMMY_SKIP_CODESIGN:-}" = "1" ]; then
  BUILDER_CONFIG="electron-builder.win.unsigned.yml"
  PACKAGE_SIGNING="unsigned"
else
  BUILDER_CONFIG="electron-builder.win.yml"
  PACKAGE_SIGNING="signed"
fi

case "${MEMMY_ACCOUNT_CHANNEL:-phone}" in
  email)
    PACKAGE_EDITION="intl"
    ;;
  phone|"")
    PACKAGE_EDITION="cn"
    ;;
  *)
    echo "Unsupported MEMMY_ACCOUNT_CHANNEL: ${MEMMY_ACCOUNT_CHANNEL:-}" >&2
    exit 1
    ;;
esac

FINAL_EXE="$DESKTOP_DIR/release/Memmy-$DESKTOP_VERSION-win32-$PACKAGE_ARCH-$PACKAGE_EDITION-$PACKAGE_SIGNING.exe"
ARTIFACT_NAME="Memmy-$DESKTOP_VERSION-win32-$PACKAGE_ARCH-$PACKAGE_EDITION-$PACKAGE_SIGNING.\${ext}"
package_log_init "win-$DESKTOP_VERSION-$PACKAGE_ARCH-$PACKAGE_EDITION-$PACKAGE_SIGNING" "$DESKTOP_DIR/release/logs"
package_install_error_trap
package_log "Windows package context: version=$DESKTOP_VERSION arch=$PACKAGE_ARCH edition=$PACKAGE_EDITION signing=$PACKAGE_SIGNING installer=$FINAL_EXE"

log() {
  package_log "$*"
}

run_with_retries() {
  local max_attempts="$1"
  shift

  local attempt=1
  while true; do
    if "$@"; then
      return
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      return 1
    fi

    log "Command failed; retrying ($((attempt + 1))/$max_attempts): $*"
    sleep $((attempt * 3))
    attempt=$((attempt + 1))
  done
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

verify_migration_state_compatibility_module() {
  local module_path
  module_path="$(to_node_readable_path "$1")"

  MEMMY_MIGRATION_STATE_MODULE_PATH="$module_path" node --input-type=module --eval '
    import { pathToFileURL } from "node:url";
    const modulePath = process.env.MEMMY_MIGRATION_STATE_MODULE_PATH;
    if (!modulePath) throw new Error("Migrations state-store path is unavailable");
    const stateStore = await import(pathToFileURL(modulePath).href);
    if (stateStore.CURRENT_MIGRATION_STATE_FORMAT_VERSION !== 2 || JSON.stringify(stateStore.SUPPORTED_MIGRATION_STATE_FORMAT_VERSIONS) !== "[1,2]") {
      throw new Error("Migrations runtime state compatibility mismatch");
    }
    const legacyState = stateStore.validateMigrationState({ formatVersion: 1, scope: "agent-workspace", applied: [] }, []);
    const currentState = stateStore.validateMigrationState({ formatVersion: 2, scope: "agent-workspace", applied: [] }, []);
    if (legacyState.formatVersion !== 2 || currentState.formatVersion !== 2) {
      throw new Error("Migrations runtime state behavior mismatch");
    }
  '
}

patch_electron_builder_nsis_refresh() {
  local template_path="$ROOT_DIR/node_modules/app-builder-lib/templates/nsis/uninstaller.nsh"
  local windows_template_path
  windows_template_path="$(to_node_readable_path "$template_path")"

  node - "$windows_template_path" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");

const [templatePath] = process.argv.slice(2);
const source = readFileSync(templatePath, "utf8");
const eol = source.includes("\r\n") ? "\r\n" : "\n";
const marker = "refresh the desktop after shortcuts were actually removed";

if (source.includes(marker)) {
  process.exit(0);
}

const original = [
  "  # refresh the desktop",
  "  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'",
].join(eol);
const replacement = [
  "  ${ifNot} ${isKeepShortcuts}",
  `    # ${marker}`,
  "    System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'",
  "  ${endIf}",
].join(eol);

if (!source.includes(original)) {
  throw new Error(`Unable to find electron-builder NSIS refresh block in ${templatePath}`);
}

writeFileSync(templatePath, source.replace(original, replacement));
NODE
}

download_url_to_file() {
  local url="$1"
  local output_path="$2"
  local windows_output_path
  windows_output_path="$(to_node_readable_path "$output_path")"

  if command -v curl.exe >/dev/null 2>&1; then
    curl.exe -L --fail --retry 3 --connect-timeout 30 --output "$windows_output_path" "$url"
    return
  fi

  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { param([string]\$Url, [string]\$OutputPath) \$ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri \$Url -OutFile \$OutputPath -MaximumRedirection 10 }" "$url" "$windows_output_path"
    return
  fi

  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --retry 3 --connect-timeout 30 --output "$output_path" "$url"
    return
  fi

  echo "Unable to download $url: neither powershell.exe nor curl is available." >&2
  return 1
}

install_better_sqlite3_prebuild_with_download_fallback() {
  local electron_version="$1"
  local install_output
  local install_status
  local prebuild_url
  local prebuild_file

  log "Trying direct better-sqlite3 prebuild download fallback"
  set +e
  install_output="$(../.bin/prebuild-install --platform win32 --arch x64 --runtime electron --target "$electron_version" --verbose 2>&1)"
  install_status=$?
  set -e
  printf '%s\n' "$install_output"

  if [ "$install_status" -eq 0 ]; then
    return
  fi

  prebuild_url="$(printf '%s\n' "$install_output" | sed -nE 's/.*(https:\/\/[^[:space:]]+\.tar\.gz).*/\1/p' | tail -n 1)"
  if [ -z "$prebuild_url" ]; then
    echo "Unable to locate better-sqlite3 prebuild URL in prebuild-install output." >&2
    return "$install_status"
  fi

  mkdir -p prebuilds
  prebuild_file="prebuilds/$(basename "$prebuild_url")"
  log "Downloading better-sqlite3 prebuild with fallback downloader: $prebuild_url"
  download_url_to_file "$prebuild_url" "$prebuild_file"

  ../.bin/prebuild-install --platform win32 --arch x64 --runtime electron --target "$electron_version"
}

create_memory_runtime_manifest() {
  node - "$ROOT_DIR/package.json" "$MEMORY_DIR/package.json" "$ROOT_DIR/App/backend/local-api-contracts/package.json" "$MIGRATIONS_DIR/package.json" "$RUNTIME_DIR/memory/package.json" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");

const [projectPackagePath, sourcePackagePath, contractsPackagePath, migrationsPackagePath, runtimePackagePath] = process.argv.slice(2);
const projectPackage = JSON.parse(readFileSync(projectPackagePath, "utf8"));
const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, "utf8"));
const contractsPackage = JSON.parse(readFileSync(contractsPackagePath, "utf8"));
const migrationsPackage = JSON.parse(readFileSync(migrationsPackagePath, "utf8"));
const dependencies = { ...(sourcePackage.dependencies ?? {}) };
delete dependencies["@memmy/local-api-contracts"];
delete dependencies["@memmy/migrations"];
Object.assign(dependencies, contractsPackage.dependencies, migrationsPackage.dependencies);
const runtimePackage = {
  name: "@memmy/packaged-memory-runtime",
  version: projectPackage.version,
  private: true,
  type: "module",
  dependencies
};

writeFileSync(runtimePackagePath, `${JSON.stringify(runtimePackage, null, 2)}\n`);
NODE

  create_memory_runtime_lock
}

write_desktop_edition_manifest() {
  local account_channel="${MEMMY_ACCOUNT_CHANNEL:-phone}"
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

  node "$ROOT_DIR/scripts/internal/shared/write-desktop-edition-manifest.mjs" \
    --output "$DESKTOP_DIR/dist/main/desktop-edition.json" \
    --edition "$edition" \
    --account-channel "$account_channel" \
    --signing "$PACKAGE_SIGNING"
}

create_memory_runtime_lock() {
  npm install --prefix "$RUNTIME_DIR/memory" --package-lock-only --ignore-scripts --os=win32 --cpu=x64
}

create_windows_cli_launcher() {
  local output_path="$1"
  local asar_entry="$2"

  cat > "$output_path" <<EOF
@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "RESOURCES_DIR=%%~fI"
for %%I in ("%RESOURCES_DIR%\..") do set "APP_DIR=%%~fI"
set "APP_EXEC=%APP_DIR%\Memmy.exe"
set "ENTRY=%RESOURCES_DIR%\app.asar\\$asar_entry"

if not exist "%APP_EXEC%" (
  echo Cannot find Memmy executable: "%APP_EXEC%" 1>&2
  exit /b 1
)

if not defined MEMMY_CONFIG if exist "%USERPROFILE%\.memmy\config.yaml" set "MEMMY_CONFIG=%USERPROFILE%\.memmy\config.yaml"
set "ELECTRON_RUN_AS_NODE=1"
if not defined NODE_ENV set "NODE_ENV=production"

"%APP_EXEC%" "%ENTRY%" %*
exit /b %ERRORLEVEL%
EOF
}

require_windows_signing_env() {
  local csc_link="${WIN_CSC_LINK:-${CSC_LINK:-}}"
  local csc_password="${WIN_CSC_KEY_PASSWORD:-${CSC_KEY_PASSWORD:-}}"
  local csc_sha1="${WIN_CSC_SHA1:-${CSC_SHA1:-}}"
  local csc_subject="${WIN_CSC_SUBJECT_NAME:-${CSC_SUBJECT_NAME:-}}"
  local timestamp_server="${WIN_CSC_TIMESTAMP_SERVER:-${CSC_TIMESTAMP_SERVER:-http://timestamp.digicert.com}}"

  if [ -n "$csc_link" ] && [ -n "$csc_password" ]; then
    return
  fi

  if [ -n "$csc_sha1" ] || [ -n "$csc_subject" ]; then
    if [ -n "$csc_sha1" ]; then
      WINDOWS_SIGNING_BUILDER_ARGS+=(--config.win.signtoolOptions.certificateSha1="$csc_sha1")
    fi
    if [ -n "$csc_subject" ]; then
      WINDOWS_SIGNING_BUILDER_ARGS+=(--config.win.signtoolOptions.certificateSubjectName="$csc_subject")
    fi
    WINDOWS_SIGNING_BUILDER_ARGS+=(--config.win.signtoolOptions.rfc3161TimeStampServer="$timestamp_server")
    return
  fi

  if [ -n "$csc_link" ] || [ -n "$csc_password" ]; then
    cat >&2 <<'EOF'
Windows PFX signing requires both:
  WIN_CSC_LINK=/absolute/path/to/windows-code-signing.pfx
  WIN_CSC_KEY_PASSWORD=...
EOF
    exit 1
  fi

  cat >&2 <<'EOF'
Windows signed packaging requires a Windows code-signing certificate.

Use one of these methods:

1. PFX certificate:
  WIN_CSC_LINK=/absolute/path/to/windows-code-signing.pfx
  WIN_CSC_KEY_PASSWORD=...

2. SimplySign / Windows certificate store:
  WIN_CSC_SHA1=<certificate SHA1 thumbprint>

Optional:
  WIN_CSC_TIMESTAMP_SERVER=http://timestamp.digicert.com

Electron-builder fallback names are also accepted:
  CSC_LINK=/absolute/path/to/windows-code-signing.pfx
  CSC_KEY_PASSWORD=...
  CSC_SHA1=<certificate SHA1 thumbprint>

For an unsigned local smoke package, run:
  npm run package:win:unsigned
EOF
  exit 1
}

verify_windows_x64_native_module() {
  local native_file="$1"
  local description="$2"

  require_packaged_runtime_file "$native_file"
  local file_description
  file_description="$(file "$native_file")"
  echo "$file_description"

  case "$file_description" in
    *PE32+*x86-64* | *PE32+*AMD64*)
      ;;
    *)
      echo "Expected a Windows x64 $description native module: $native_file" >&2
      exit 1
      ;;
  esac
}

verify_windows_better_sqlite3_runtime() {
  local runtime_dir="$1"
  local electron_executable="$DESKTOP_DIR/node_modules/electron/dist/electron.exe"
  local node_runtime_dir
  node_runtime_dir="$(to_node_readable_path "$runtime_dir")"

  require_packaged_runtime_file "$electron_executable"
  MEMMY_BETTER_SQLITE_RUNTIME_DIR="$node_runtime_dir" \
    ELECTRON_RUN_AS_NODE=1 \
    "$electron_executable" --input-type=module --eval '
      import { createRequire } from "node:module";
      import path from "node:path";
      import { pathToFileURL } from "node:url";
      const runtimeDir = process.env.MEMMY_BETTER_SQLITE_RUNTIME_DIR;
      if (!runtimeDir) throw new Error("better-sqlite3 runtime directory is unavailable");
      const require = createRequire(pathToFileURL(path.join(runtimeDir, "package.json")));
      const Database = require("better-sqlite3");
      const database = new Database(":memory:");
      try {
        const row = database.prepare("SELECT 1 AS ok").get();
        if (row?.ok !== 1) throw new Error("better-sqlite3 smoke query failed");
      } finally {
        database.close();
      }
    '
}

verify_packaged_file_matches_runtime() {
  local runtime_file="$1"
  local packaged_file="$2"
  local description="$3"

  if ! cmp -s "$runtime_file" "$packaged_file"; then
    echo "Packaged $description differs from the runtime artifact that passed smoke validation." >&2
    exit 1
  fi
}

verify_windows_native_module() {
  require_packaged_runtime_file "$RUNTIME_DIR/memory/node_modules/@memmy/local-api-contracts/dist/index.js"
  require_packaged_runtime_file "$RUNTIME_DIR/memory/node_modules/@memmy/migrations/dist/index.js"
  verify_windows_x64_native_module \
    "$RUNTIME_DIR/memory/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
    "Memory better-sqlite3"
}

verify_windows_onnxruntime_module() {
  local onnxruntime_node="$RUNTIME_DIR/memory/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node"
  local onnxruntime_dir
  onnxruntime_dir="$(dirname "$onnxruntime_node")"

  if [ ! -f "$onnxruntime_node" ]; then
    echo "Missing onnxruntime-node Windows x64 native module: $onnxruntime_node" >&2
    exit 1
  fi

  local file_description
  file_description="$(file "$onnxruntime_node")"
  echo "$file_description"

  case "$file_description" in
    *PE32+*x86-64* | *PE32+*AMD64*)
      ;;
    *)
      echo "Expected a Windows x64 onnxruntime-node native module." >&2
      exit 1
      ;;
  esac

  require_packaged_runtime_file "$onnxruntime_dir/onnxruntime.dll"
  require_packaged_runtime_glob "$onnxruntime_dir/*.dll"
}

verify_windows_sharp_module() {
  local sharp_dir="$RUNTIME_DIR/memory/node_modules/@img/sharp-win32-x64/lib"

  require_packaged_runtime_file "$sharp_dir/sharp-win32-x64.node"
  require_packaged_runtime_glob "$sharp_dir/libvips*.dll"
}

verify_windows_agent_native_artifacts() {
  local node_pty_dir="$RUNTIME_DIR/memmy-agent/node_modules/openclaw/node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64"

  require_packaged_runtime_file "$RUNTIME_DIR/memmy-agent/node_modules/@memmy/local-api-contracts/dist/index.js"
  if [ -L "$RUNTIME_DIR/memmy-agent/node_modules/@memmy/local-api-contracts" ]; then
    echo "Packaged local API contracts must not be a symbolic link." >&2
    exit 1
  fi
  verify_windows_x64_native_module \
    "$RUNTIME_DIR/memmy-agent/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
    "memmy-agent better-sqlite3"
  require_packaged_runtime_file "$node_pty_dir/conpty.node"
  require_packaged_runtime_file "$node_pty_dir/conpty/conpty.dll"
  require_packaged_runtime_file "$node_pty_dir/conpty/OpenConsole.exe"
  require_packaged_runtime_glob "$RUNTIME_DIR/memmy-agent/node_modules/openclaw/node_modules/sqlite-vec-windows-x64/vec0.*"
}

verify_packaged_windows_unpacked_artifacts() {
  local unpacked_runtime="$DESKTOP_DIR/release/win-unpacked/resources/app.asar.unpacked/dist/runtime"
  local packaged_embedding_model="$DESKTOP_DIR/release/win-unpacked/resources/embedding-models/$EMBEDDING_MODEL_ID"

  require_packaged_runtime_file "$DESKTOP_DIR/release/win-unpacked/resources/app.asar"
  verify_packaged_runtime_config_boundary "$DESKTOP_DIR/release/win-unpacked/resources"
  verify_windows_x64_native_module \
    "$unpacked_runtime/memory/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
    "packaged Memory better-sqlite3"
  verify_windows_x64_native_module \
    "$unpacked_runtime/memmy-agent/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
    "packaged memmy-agent better-sqlite3"
  verify_packaged_file_matches_runtime \
    "$RUNTIME_DIR/memory/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
    "$unpacked_runtime/memory/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
    "Memory better-sqlite3 module"
  verify_packaged_file_matches_runtime \
    "$RUNTIME_DIR/memmy-agent/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
    "$unpacked_runtime/memmy-agent/node_modules/better-sqlite3/build/Release/better_sqlite3.node" \
    "memmy-agent better-sqlite3 module"
  require_packaged_runtime_file "$unpacked_runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime.dll"
  require_packaged_runtime_glob "$unpacked_runtime/memory/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/*.dll"
  require_packaged_runtime_glob "$unpacked_runtime/memory/node_modules/@img/sharp-win32-x64/lib/libvips*.dll"
  require_packaged_runtime_file "$unpacked_runtime/memmy-agent/node_modules/@memmy/migrations/dist/index.js"
  require_packaged_runtime_file "$unpacked_runtime/memmy-agent/node_modules/@memmy/migrations/dist/state-store.js"
  verify_migration_state_compatibility_module \
    "$unpacked_runtime/memmy-agent/node_modules/@memmy/migrations/dist/state-store.js"
  require_packaged_runtime_file "$packaged_embedding_model/config.json"
  require_packaged_runtime_file "$packaged_embedding_model/tokenizer.json"
  require_packaged_runtime_file "$packaged_embedding_model/onnx/model_quantized.onnx"
  if [ -L "$unpacked_runtime/memmy-agent/node_modules/@memmy/migrations" ]; then
    echo "Packaged migrations package must not be a symbolic link." >&2
    exit 1
  fi
  require_packaged_runtime_file "$unpacked_runtime/memmy-agent/node_modules/openclaw/node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/conpty.dll"
  require_packaged_runtime_file "$unpacked_runtime/memmy-agent/node_modules/openclaw/node_modules/@lydell/node-pty-win32-x64/prebuilds/win32-x64/conpty/OpenConsole.exe"
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
    --asar "$(to_node_readable_path "$asar_file")" \
    --expected "$DESKTOP_VERSION"
}

npm_ci_win_x64() {
  local package_dir="$1"

  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix "$package_dir" --omit=dev --ignore-scripts --os=win32 --cpu=x64
}

install_better_sqlite3_win_x64() {
  local runtime_dir="$1"
  local electron_version
  electron_version="${MEMMY_ELECTRON_VERSION:-$(read_package_version "$DESKTOP_DIR/node_modules/electron/package.json")}"

  (
    cd "$runtime_dir/node_modules/better-sqlite3"
    run_with_retries 3 ../.bin/prebuild-install --platform win32 --arch x64 --runtime electron --target "$electron_version" ||
      install_better_sqlite3_prebuild_with_download_fallback "$electron_version"
  )
}

package_step_start "Validate Windows signing configuration"
if [ "${MEMMY_SKIP_CODESIGN:-}" != "1" ]; then
  require_windows_signing_env
else
  log "MEMMY_SKIP_CODESIGN=1, building unsigned Windows smoke package"
fi

package_step_start "Install root workspace dependencies if needed"
if [ ! -d "$ROOT_DIR/node_modules" ]; then
  log "Installing root workspace dependencies"
  npm_with_configured_script_shell install
else
  log "Root workspace dependencies already available"
fi
package_step_start "Install migrations workspace dev dependencies"
npm_with_configured_script_shell install --workspace @memmy/migrations --include=dev

package_step_start "Build migrations package"
npm_with_configured_script_shell run build --prefix "$MIGRATIONS_DIR"

package_step_start "Build local API contracts package"
npm_with_configured_script_shell run build -w @memmy/local-api-contracts

package_step_start "Install memmy-agent workspace dependencies"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_with_configured_script_shell ci --prefix "$AGENT_DIR"

package_step_start "Build Memory workspace"
npm_with_configured_script_shell run build -w @memmy/memory

package_step_start "Build memmy-agent runtime"
npm_with_configured_script_shell run build --prefix "$AGENT_DIR"

package_step_start "Build Electron desktop shell"
npm_with_configured_script_shell run build -w @memmy/desktop
package_step_start "Write desktop edition manifest"
write_desktop_edition_manifest

package_step_start "Prepare Windows x64 packaged runtime"
rm -rf "$RUNTIME_DIR"
rm -rf "$MIGRATIONS_STAGING_DIR"
rm -rf "$EMBEDDING_MODELS_DIR"
mkdir -p "$RUNTIME_DIR/memory" "$RUNTIME_DIR/memmy-agent" "$CLI_BIN_DIR"
mkdir -p "$MIGRATIONS_STAGING_DIR"
cp "$MIGRATIONS_DIR/package.json" "$MIGRATIONS_STAGING_DIR/package.json"
cp -R "$MIGRATIONS_DIR/dist" "$MIGRATIONS_STAGING_DIR/dist"

cp -R "$MEMORY_DIR/dist/src" "$RUNTIME_DIR/memory/src"
package_step_start "Create Windows Memory runtime manifest"
create_memory_runtime_manifest

package_step_start "Install Windows x64 Memory runtime dependencies"
npm_ci_win_x64 "$RUNTIME_DIR/memory"
mkdir -p "$RUNTIME_DIR/memory/node_modules/@memmy/local-api-contracts" "$RUNTIME_DIR/memory/node_modules/@memmy/migrations"
cp "$ROOT_DIR/App/backend/local-api-contracts/package.json" "$RUNTIME_DIR/memory/node_modules/@memmy/local-api-contracts/package.json"
cp -R "$ROOT_DIR/App/backend/local-api-contracts/dist" "$RUNTIME_DIR/memory/node_modules/@memmy/local-api-contracts/dist"
cp "$MIGRATIONS_STAGING_DIR/package.json" "$RUNTIME_DIR/memory/node_modules/@memmy/migrations/package.json"
cp -R "$MIGRATIONS_STAGING_DIR/dist" "$RUNTIME_DIR/memory/node_modules/@memmy/migrations/dist"
install_better_sqlite3_win_x64 "$RUNTIME_DIR/memory"
package_step_start "Verify Windows x64 Memory runtime artifacts"
verify_windows_native_module
verify_windows_better_sqlite3_runtime "$RUNTIME_DIR/memory"
verify_windows_onnxruntime_module
verify_windows_sharp_module

package_step_start "Stage Windows memmy-agent runtime files"
cp -R "$AGENT_DIR/dist" "$RUNTIME_DIR/memmy-agent/dist"
cp "$AGENT_DIR/package.json" "$RUNTIME_DIR/memmy-agent/package.json"
cp "$AGENT_DIR/package-lock.json" "$RUNTIME_DIR/memmy-agent/package-lock.json"

package_step_start "Install Windows x64 memmy-agent runtime dependencies"
npm_ci_win_x64 "$RUNTIME_DIR/memmy-agent"
install_better_sqlite3_win_x64 "$RUNTIME_DIR/memmy-agent"
package_step_start "Stage Windows memmy-agent workspace runtime packages"
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
package_step_start "Verify Windows memmy-agent runtime artifacts"
verify_windows_agent_native_artifacts
verify_windows_better_sqlite3_runtime "$RUNTIME_DIR/memmy-agent"
package_step_start "Verify Windows memmy-agent runtime exports"
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

package_step_start "Prune and verify Windows runtime versions"
node "$ROOT_DIR/scripts/internal/shared/prune-runtime-env-files.mjs" "$RUNTIME_DIR"
RUNTIME_NODE_DIR="$(to_node_readable_path "$RUNTIME_DIR")"
node "$ROOT_DIR/scripts/internal/shared/verify-package-version.mjs" \
  --expected "$DESKTOP_VERSION" \
  --runtime-root "$RUNTIME_NODE_DIR"

package_step_start "Create Windows CLI launchers and embedding model"
create_windows_cli_launcher "$CLI_BIN_DIR/memmy-memory.cmd" "dist\\runtime\\memory\\src\\cli\\index.js"
create_windows_cli_launcher "$CLI_BIN_DIR/memmy.cmd" "dist\\runtime\\memmy-agent\\dist\\main.js"
node "$ROOT_DIR/scripts/internal/shared/prepare-embedding-model.mjs" "$EMBEDDING_MODELS_DIR"

package_step_start "Patch electron-builder NSIS template"
patch_electron_builder_nsis_refresh

package_step_start "Run electron-builder Windows NSIS packaging"
cd "$DESKTOP_DIR"

BUILDER_ARGS=(--config "$BUILDER_CONFIG")
BUILDER_ARGS+=(--config.extraMetadata.version="$DESKTOP_VERSION")
ELECTRON_DIST="$(resolve_electron_dist)"
if [ -n "$ELECTRON_DIST" ]; then
  log "Using Electron dist: $ELECTRON_DIST"
  BUILDER_ARGS+=(--config.electronDist="$ELECTRON_DIST")
fi
if [ "${#WINDOWS_SIGNING_BUILDER_ARGS[@]}" -gt 0 ]; then
  BUILDER_ARGS+=("${WINDOWS_SIGNING_BUILDER_ARGS[@]}")
fi

npx electron-builder "${BUILDER_ARGS[@]}" --win nsis --x64 "$@" --config.artifactName="$ARTIFACT_NAME"
package_step_start "Verify packaged Windows app artifacts"
verify_packaged_windows_unpacked_artifacts

if [ ! -f "$FINAL_EXE" ]; then
  echo "Packaging completed without the expected installer: $FINAL_EXE" >&2
  exit 1
fi

package_log_finish 0
log "Done. Windows installer is ready: $FINAL_EXE"
