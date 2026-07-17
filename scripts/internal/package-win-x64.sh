#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/App/shell/desktop"
AGENT_DIR="$ROOT_DIR/App/memmy-agent"
MEMORY_DIR="$ROOT_DIR/Memory"
RUNTIME_DIR="$DESKTOP_DIR/dist/runtime"
CLI_BIN_DIR="$RUNTIME_DIR/bin"
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

DESKTOP_VERSION="${MEMMY_DESKTOP_VERSION:-$(read_package_version "$DESKTOP_DIR/package.json")}"
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

log() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
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
  node - "$MEMORY_DIR/package.json" "$RUNTIME_DIR/memory/package.json" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");

const [sourcePackagePath, runtimePackagePath] = process.argv.slice(2);
const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, "utf8"));
const runtimePackage = {
  name: "@memmy/packaged-memory-runtime",
  private: true,
  type: "module",
  dependencies: sourcePackage.dependencies ?? {}
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

  cat > "$DESKTOP_DIR/dist/main/desktop-edition.json" <<EOF
{
  "edition": "$edition",
  "accountChannel": "$account_channel",
  "signing": "$PACKAGE_SIGNING"
}
EOF
}

create_memory_runtime_lock() {
  if [ -f "$MEMORY_DIR/package-lock.json" ]; then
    cp "$MEMORY_DIR/package-lock.json" "$RUNTIME_DIR/memory/package-lock.json"
    return
  fi

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

verify_windows_native_module() {
  local better_sqlite_node="$RUNTIME_DIR/memory/node_modules/better-sqlite3/build/Release/better_sqlite3.node"

  if [ ! -f "$better_sqlite_node" ]; then
    echo "Missing better-sqlite3 native module: $better_sqlite_node" >&2
    exit 1
  fi

  local file_description
  file_description="$(file "$better_sqlite_node")"
  echo "$file_description"

  case "$file_description" in
    *PE32+*x86-64* | *PE32+*AMD64*)
      ;;
    *)
      echo "Expected a Windows x64 better-sqlite3 native module." >&2
      exit 1
      ;;
  esac
}

verify_windows_onnxruntime_module() {
  local onnxruntime_node="$RUNTIME_DIR/memory/node_modules/onnxruntime-node/bin/napi-v3/win32/x64/onnxruntime_binding.node"

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
}

npm_ci_win_x64() {
  local package_dir="$1"

  npm ci --prefix "$package_dir" --omit=dev --ignore-scripts --os=win32 --cpu=x64
}

install_better_sqlite3_win_x64() {
  local electron_version
  electron_version="${MEMMY_ELECTRON_VERSION:-$(read_package_version "$DESKTOP_DIR/node_modules/electron/package.json")}"

  (
    cd "$RUNTIME_DIR/memory/node_modules/better-sqlite3"
    run_with_retries 3 ../.bin/prebuild-install --platform win32 --arch x64 --runtime electron --target "$electron_version" ||
      install_better_sqlite3_prebuild_with_download_fallback "$electron_version"
  )
}

if [ "${MEMMY_SKIP_CODESIGN:-}" != "1" ]; then
  require_windows_signing_env
else
  log "MEMMY_SKIP_CODESIGN=1, building unsigned Windows smoke package"
fi

if [ ! -d "$ROOT_DIR/node_modules" ]; then
  log "Installing root workspace dependencies"
  npm_with_configured_script_shell install
fi

log "Installing memmy-agent dependencies"
npm_with_configured_script_shell ci --prefix "$AGENT_DIR"

log "Building Memory workspace"
npm_with_configured_script_shell run build -w @memmy/memory

log "Building memmy-agent CLI"
npm_with_configured_script_shell run build --prefix "$AGENT_DIR"

log "Building Electron desktop shell"
npm_with_configured_script_shell run build -w @memmy/desktop
write_desktop_edition_manifest

log "Preparing Windows x64 packaged runtime"
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR/memory" "$RUNTIME_DIR/memmy-agent" "$CLI_BIN_DIR"

cp -R "$MEMORY_DIR/dist/src" "$RUNTIME_DIR/memory/src"
create_memory_runtime_manifest

log "Installing Windows x64 Memory runtime dependencies"
npm_ci_win_x64 "$RUNTIME_DIR/memory"
install_better_sqlite3_win_x64
verify_windows_native_module
verify_windows_onnxruntime_module

cp -R "$AGENT_DIR/dist" "$RUNTIME_DIR/memmy-agent/dist"
cp "$AGENT_DIR/package.json" "$RUNTIME_DIR/memmy-agent/package.json"
cp "$AGENT_DIR/package-lock.json" "$RUNTIME_DIR/memmy-agent/package-lock.json"

log "Installing Windows x64 memmy-agent runtime dependencies"
npm_ci_win_x64 "$RUNTIME_DIR/memmy-agent"

log "Creating Windows CLI launchers"
create_windows_cli_launcher "$CLI_BIN_DIR/memmy-memory.cmd" "dist\\runtime\\memory\\src\\cli\\index.js"
create_windows_cli_launcher "$CLI_BIN_DIR/memmy.cmd" "dist\\runtime\\memmy-agent\\dist\\main.js"

patch_electron_builder_nsis_refresh

log "Packaging Windows x64 installer"
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

if [ ! -f "$FINAL_EXE" ]; then
  echo "Packaging completed without the expected installer: $FINAL_EXE" >&2
  exit 1
fi

log "Done. Windows installer is ready: $FINAL_EXE"
