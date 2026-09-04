#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MEMMY_AGENT_DIR="$ROOT_DIR/App/memmy-agent"
DESKTOP_DIR="$ROOT_DIR/App/shell/desktop"
ELECTRON_PACKAGE_DIR="$DESKTOP_DIR/node_modules/electron"
MEMORY_CLI_ENTRY="$ROOT_DIR/Memory/dist/src/cli/index.js"
MEMMY_CONFIG_PATH="${MEMMY_CONFIG:-$HOME/.memmy/config.yaml}"
MEMMY_WORKSPACE_IS_EXPLICIT=0
if [[ -n "${MEMMY_WORKSPACE:-}" ]]; then
  MEMMY_WORKSPACE_IS_EXPLICIT=1
fi
MEMMY_WORKSPACE_DIR="${MEMMY_WORKSPACE:-$HOME/.memmy/workspace}"
MEMMY_APP_DATABASE_FILE="${MEMMY_APP_DATABASE:-}"
MEMMY_BIN_DIR="$HOME/.local/bin"
MEMMY_MEMORY_BIND_HOST="${MEMMY_MEMORY_HOST:-${MEMORY_SERVICE_HOST:-127.0.0.1}}"
MEMMY_MEMORY_PORT_VALUE="${MEMMY_MEMORY_PORT:-${MEMORY_SERVICE_PORT:-18960}}"
MEMMY_MEMORY_CLIENT_HOST="$MEMMY_MEMORY_BIND_HOST"
if [[ "$MEMMY_MEMORY_CLIENT_HOST" == "0.0.0.0" || "$MEMMY_MEMORY_CLIENT_HOST" == "::" ]]; then
  MEMMY_MEMORY_CLIENT_HOST="127.0.0.1"
fi
MEMMY_MEMORY_ENDPOINT="${MEMMY_MEMORY_URL:-${MEMORY_SERVICE_URL:-http://$MEMMY_MEMORY_CLIENT_HOST:$MEMMY_MEMORY_PORT_VALUE}}"
MEMMY_MEMORY_TOKEN_VALUE="${MEMMY_MEMORY_TOKEN:-${MEMORY_SERVICE_TOKEN:-}}"
CONCURRENTLY_BIN="$ROOT_DIR/node_modules/.bin/concurrently"
WAIT_ON_BIN="$ROOT_DIR/node_modules/.bin/wait-on"
LOG_DIR="$ROOT_DIR/.tmp/dev-stack"

export MEMMY_CONFIG="$MEMMY_CONFIG_PATH"
export MEMMY_MEMORY_URL="${MEMMY_MEMORY_URL:-$MEMMY_MEMORY_ENDPOINT}"
export MEMMY_MEMORY_LAYER_URL="${MEMMY_MEMORY_LAYER_URL:-$MEMMY_MEMORY_ENDPOINT}"
if [[ -n "$MEMMY_MEMORY_TOKEN_VALUE" ]]; then
  export MEMMY_MEMORY_TOKEN="${MEMMY_MEMORY_TOKEN:-$MEMMY_MEMORY_TOKEN_VALUE}"
  export MEMMY_MEMORY_LAYER_TOKEN="${MEMMY_MEMORY_LAYER_TOKEN:-$MEMMY_MEMORY_TOKEN_VALUE}"
fi

log() {
  printf '[dev-start] %s\n' "$*"
}

read_dev_edition_from_env_file() {
  local env_file="$1"
  local line name value

  [[ -f "$env_file" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ ! "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      continue
    fi

    name="${BASH_REMATCH[2]}"
    [[ "$name" == "MEMMY_APP_EDITION" ]] || continue

    value="${BASH_REMATCH[3]}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && "$value" == *\" ]] || [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi
    printf '%s\n' "$value"
    return 0
  done <"$env_file"

  return 1
}

configure_dev_edition() {
  local env_file="${1:-$ROOT_DIR/.env}"
  local edition="${MEMMY_APP_EDITION:-}"

  if [[ -z "$edition" ]]; then
    edition="$(read_dev_edition_from_env_file "$env_file" || true)"
  fi
  edition="${edition:-intl}"

  case "$edition" in
    cn)
      export MEMMY_ACCOUNT_CHANNEL="phone"
      ;;
    intl)
      export MEMMY_ACCOUNT_CHANNEL="email"
      ;;
    *)
      printf '[dev-start] MEMMY_APP_EDITION must be either cn or intl; received: %s\n' "$edition" >&2
      return 1
      ;;
  esac
  export MEMMY_APP_EDITION="$edition"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_command() {
  if ! command_exists "$1"; then
    printf '[dev-start] missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

node_can_resolve() {
  node --input-type=module --eval 'import.meta.resolve(process.argv[1])' "$1" >/dev/null 2>&1
}

node_can_resolve_from_dir() {
  local dir="$1"
  local package="$2"
  (
    cd "$dir"
    node --input-type=module --eval 'import.meta.resolve(process.argv[1])' "$package" >/dev/null 2>&1
  )
}

ensure_npm_dependencies() {
  local package
  local -a missing_packages=()
  local -a required_packages=(
    "concurrently"
    "wait-on"
    "@types/proper-lockfile/index.d.ts"
    "electron-log/main"
    "electron-log/renderer"
    "@xyflow/react"
  )

  for package in "${required_packages[@]}"; do
    if ! node_can_resolve "$package"; then
      missing_packages+=("$package")
    fi
  done

  if [[ ${#missing_packages[@]} -eq 0 ]]; then
    return
  fi

  log "installing npm dependencies (missing: ${missing_packages[*]})"
  cd "$ROOT_DIR"
  npm install

  missing_packages=()
  for package in "${required_packages[@]}"; do
    if ! node_can_resolve "$package"; then
      missing_packages+=("$package")
    fi
  done

  if [[ ${#missing_packages[@]} -ne 0 ]]; then
    printf '[dev-start] npm dependencies are still missing after install: %s\n' "${missing_packages[*]}" >&2
    exit 1
  fi
}

electron_runtime_available() {
  (
    cd "$DESKTOP_DIR"
    node --eval 'const fs = require("node:fs"); const executable = require("electron"); if (!fs.existsSync(executable)) process.exit(1);'
  ) >/dev/null 2>&1
}

ensure_electron_runtime() {
  local electron_platform electron_platform_path electron_zip_path

  if [[ ! -f "$ELECTRON_PACKAGE_DIR/install.js" ]]; then
    printf '[dev-start] missing Electron package at %s; run npm install first\n' "$ELECTRON_PACKAGE_DIR" >&2
    exit 1
  fi

  log "ensuring Electron runtime is installed after native dependency rebuild"
  (
    cd "$ELECTRON_PACKAGE_DIR"
    node install.js
  )

  if ! electron_runtime_available; then
    require_command unzip
    log "Electron installer returned before extraction completed; extracting the verified artifact synchronously"
    electron_zip_path="$(
      cd "$ELECTRON_PACKAGE_DIR"
      node --input-type=module <<'NODE'
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { downloadArtifact } = require("@electron/get");
const { version } = require("./package.json");
const platform = process.env.npm_config_platform || process.platform;
const arch = process.env.npm_config_arch || process.arch;
const zipPath = await downloadArtifact({
  version,
  artifactName: "electron",
  platform,
  arch,
  cacheRoot: process.env.electron_config_cache,
  checksums: require("./checksums.json")
});

process.stdout.write(zipPath);
NODE
    )"
    electron_platform="${npm_config_platform:-$(node --print 'process.platform')}"
    case "$electron_platform" in
      darwin|mas)
        electron_platform_path="Electron.app/Contents/MacOS/Electron"
        ;;
      win32)
        electron_platform_path="electron.exe"
        ;;
      *)
        electron_platform_path="electron"
        ;;
    esac
    mkdir -p "$ELECTRON_PACKAGE_DIR/dist"
    unzip -q -o "$electron_zip_path" -d "$ELECTRON_PACKAGE_DIR/dist"
    printf '%s' "$electron_platform_path" >"$ELECTRON_PACKAGE_DIR/path.txt"
  fi

  if ! electron_runtime_available; then
    printf '[dev-start] Electron runtime is still unavailable after installation\n' >&2
    exit 1
  fi
}

ensure_memmy_agent_dependencies() {
  local package
  local -a missing_packages=()
  local -a required_packages=(
    "html-validate"
    "ink"
    "parse5"
    "postcss"
    "react"
    "smol-toml"
    "typescript"
    "@playwright/mcp"
    "playwright"
  )

  for package in "${required_packages[@]}"; do
    if ! node_can_resolve_from_dir "$MEMMY_AGENT_DIR" "$package"; then
      missing_packages+=("$package")
    fi
  done

  if [[ ${#missing_packages[@]} -eq 0 ]]; then
    return
  fi

  log "installing memmy-agent npm dependencies (missing: ${missing_packages[*]})"
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix "$MEMMY_AGENT_DIR" --include=dev

  missing_packages=()
  for package in "${required_packages[@]}"; do
    if ! node_can_resolve_from_dir "$MEMMY_AGENT_DIR" "$package"; then
      missing_packages+=("$package")
    fi
  done

  if [[ ${#missing_packages[@]} -ne 0 ]]; then
    printf '[dev-start] memmy-agent npm dependencies are still missing after install: %s\n' "${missing_packages[*]}" >&2
    exit 1
  fi
}

path_contains_dir() {
  local dir="$1"
  local entry expanded
  local -a path_entries
  IFS=':' read -r -a path_entries <<<"${PATH:-}"
  for entry in "${path_entries[@]}"; do
    [[ -n "$entry" ]] || continue
    expanded="${entry/#\~/$HOME}"
    if [[ "$expanded" == "$dir" ]]; then
      return 0
    fi
  done
  return 1
}

ensure_memmy_bin_on_path() {
  mkdir -p "$MEMMY_BIN_DIR"

  if path_contains_dir "$MEMMY_BIN_DIR"; then
    return
  fi

  local shell_name profile marker
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)
      profile="$HOME/.zshrc"
      ;;
    bash)
      profile="$HOME/.bashrc"
      ;;
    *)
      profile="$HOME/.profile"
      ;;
  esac

  marker="# Memmy CLI PATH"
  if [[ -f "$profile" ]] && grep -Fq "$marker" "$profile"; then
    log "~/.local/bin PATH entry already managed in $profile"
  else
    printf '\n%s\nexport PATH="$HOME/.local/bin:$PATH"\n' "$marker" >>"$profile"
    log "added ~/.local/bin to PATH in $profile; open a new terminal or run: source $profile"
  fi

  export PATH="$MEMMY_BIN_DIR:$PATH"
}

is_windows_shell() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) return 0 ;;
    *) return 1 ;;
  esac
}

user_cli_path() {
  local name="$1"
  if is_windows_shell; then
    printf '%s/%s.cmd\n' "$MEMMY_BIN_DIR" "$name"
    return
  fi

  printf '%s/%s\n' "$MEMMY_BIN_DIR" "$name"
}

is_managed_user_cli_target() {
  local name="$1"
  local path="$2"
  local expected_suffix contents

  case "$name" in
    memmy-memory) expected_suffix="Memory/dist/src/cli/index.js" ;;
    memmy) expected_suffix="App/memmy-agent/dist/main.js" ;;
    *) return 1 ;;
  esac

  if [[ -L "$path" ]]; then
    contents="$(readlink "$path")"
    contents="$(printf '%s' "$contents" | tr '\\' '/')"
    [[ "$contents" == "$expected_suffix" || "$contents" == *"/$expected_suffix" ]]
    return
  fi

  [[ -f "$path" ]] || return 1
  contents="$(<"$path")"
  contents="$(printf '%s' "$contents" | tr '\\' '/')"
  if [[ "$contents" == '#!/usr/bin/env bash'* ]] && [[ "$contents" == *'exec node "'*"$expected_suffix"'" "$@"'* ]]; then
    return 0
  fi
  if [[ "$contents" == $'#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 '*"$expected_suffix"*' "$@"' ]]; then
    return 0
  fi
  [[ "$contents" == *'rem Managed by Memmy dev-start.'* ]] \
    && [[ "$contents" == *'node "'*"$expected_suffix"'" %*'* ]]
}

install_user_cli_link() {
  local name="$1"
  local source="$2"
  local legacy_target="$MEMMY_BIN_DIR/$name"
  local target
  target="$(user_cli_path "$name")"

  if [[ ! -f "$source" ]]; then
    printf '[dev-start] missing built CLI source: %s\n' "$source" >&2
    exit 1
  fi

  chmod +x "$source"
  mkdir -p "$MEMMY_BIN_DIR"

  if is_windows_shell; then
    local candidate windows_source
    require_command cygpath

    for candidate in "$legacy_target" "$target"; do
      if [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
        continue
      fi
      if ! is_managed_user_cli_target "$name" "$candidate"; then
        printf '[dev-start] refusing to replace unmanaged CLI at %s\n' "$candidate" >&2
        exit 1
      fi
      rm -f "$candidate"
    done

    windows_source="$(cygpath -w "$source")"
    printf '@echo off\r\nrem Managed by Memmy dev-start.\r\nnode "%s" %%*\r\nexit /b %%ERRORLEVEL%%\r\n' "$windows_source" > "$target"
    log "installed $name -> $source"
    return
  fi

  if [[ -e "$target" || -L "$target" ]]; then
    if [[ ! -L "$target" ]] && ! is_managed_user_cli_target "$name" "$target"; then
      printf '[dev-start] refusing to replace non-symlink CLI at %s\n' "$target" >&2
      exit 1
    fi
    if [[ ! -L "$target" ]]; then
      log "removing legacy managed $name command at $target"
    fi
    unlink "$target"
  fi

  ln -s "$source" "$target"
  log "installed $name -> $source"
}

detect_installed_memory_agents() {
  printf ''
}

build_and_install_memory_cli() {
  require_command node
  require_command npm

  log "building memmy-memory CLI"
  cd "$ROOT_DIR"
  npm run memory:build

  ensure_memmy_bin_on_path

  log "initializing memmy-memory config at $MEMMY_CONFIG_PATH"
  if [[ -n "$MEMMY_MEMORY_TOKEN_VALUE" ]]; then
    node "$MEMORY_CLI_ENTRY" init \
      --config "$MEMMY_CONFIG_PATH" \
      --endpoint "$MEMMY_MEMORY_ENDPOINT" \
      --skip-agent-skills \
      --token "$MEMMY_MEMORY_TOKEN_VALUE" >/dev/null
  else
    node "$MEMORY_CLI_ENTRY" init \
      --config "$MEMMY_CONFIG_PATH" \
      --endpoint "$MEMMY_MEMORY_ENDPOINT" \
      --skip-agent-skills >/dev/null
  fi

  install_user_cli_link "memmy-memory" "$MEMORY_CLI_ENTRY"

  "$(user_cli_path "memmy-memory")" --version >/dev/null
  log "memmy-memory command is ready in $MEMMY_BIN_DIR"
}

stop_existing_stack() {
  local pids
  pids="$(
    {
      lsof -tiTCP:19000 -sTCP:LISTEN || true
      lsof -tiTCP:18960 -sTCP:LISTEN || true
      lsof -tiTCP:"$MEMMY_MEMORY_PORT_VALUE" -sTCP:LISTEN || true
      lsof -tiTCP:18970 -sTCP:LISTEN || true
      lsof -tiTCP:18980 -sTCP:LISTEN || true
      lsof -tiTCP:18990 -sTCP:LISTEN || true
      lsof -tiTCP:18997 -sTCP:LISTEN || true
      lsof -tiTCP:18999 -sTCP:LISTEN || true
      pgrep -f "electron dist/main/main.js" || true
      pgrep -f "Electron.app/Contents/MacOS/Electron dist/main/main.js" || true
      pgrep -f "/Memmy.app/Contents/MacOS/Memmy" || true
      pgrep -f "concurrently -k -n renderer,desktop" || true
      pgrep -f "npm run dev:desktop" || true
      pgrep -f "npm run dev -w @memmy/frontend-desktop" || true
      pgrep -f "npm run dev -w @memmy/desktop" || true
      pgrep -f "node_modules/vite/bin/vite.js --host 127.0.0.1" || true
      pgrep -f "Memory/src/server/index.ts" || true
      pgrep -f "$ROOT_DIR/Memory/dist/src/server/index.js" || true
      pgrep -f "$ROOT_DIR/Memory/dist/src/cli/index.js.*serve" || true
      pgrep -f "$ROOT_DIR/Memory/src/cli/index.ts.*serve" || true
      pgrep -f "node .*dist/main.js serve" || true
      pgrep -f "node .*dist/main.js gateway" || true
    } 2>/dev/null | sort -u
  )"

  if [[ -z "$pids" ]]; then
    log "no existing default dev stack processes found"
    return
  fi

  log "stopping existing default dev stack processes: $pids"
  kill $pids 2>/dev/null || true
  sleep 2

  local still_running
  still_running="$(
    {
      lsof -tiTCP:19000 -sTCP:LISTEN || true
      lsof -tiTCP:18960 -sTCP:LISTEN || true
      lsof -tiTCP:"$MEMMY_MEMORY_PORT_VALUE" -sTCP:LISTEN || true
      lsof -tiTCP:18970 -sTCP:LISTEN || true
      lsof -tiTCP:18980 -sTCP:LISTEN || true
      lsof -tiTCP:18990 -sTCP:LISTEN || true
      lsof -tiTCP:18997 -sTCP:LISTEN || true
      lsof -tiTCP:18999 -sTCP:LISTEN || true
    } 2>/dev/null | sort -u
  )"

  if [[ -n "$still_running" ]]; then
    log "force stopping processes still listening on default ports: $still_running"
    kill -9 $still_running 2>/dev/null || true
  fi
}

config_has_agent_model() {
  local node_command="${MEMMY_RUNTIME_NODE_PATH:-}"
  if [[ -z "$node_command" ]]; then
    if command_exists node; then
      node_command="$(command -v node)"
    elif command_exists node.exe; then
      node_command="$(command -v node.exe)"
    else
      return 1
    fi
  fi

  local config_path_for_node="$MEMMY_CONFIG_PATH"
  if [[ "$node_command" == *.exe ]] && command_exists wslpath; then
    config_path_for_node="$(wslpath -w "$MEMMY_CONFIG_PATH")"
  fi

  "$node_command" --input-type=module - "$config_path_for_node" <<'NODE'
import fs from "node:fs";
import { parse } from "yaml";

const configPath = process.argv[2];
if (!configPath || !fs.existsSync(configPath)) process.exit(1);

let config;
try {
  config = parse(fs.readFileSync(configPath, "utf8")) ?? {};
} catch {
  process.exit(1);
}

const defaults = config.agents?.defaults ?? {};
const presetName = defaults.modelPreset;
const preset = presetName ? config.modelPresets?.[presetName] : null;
const providerName = preset?.provider;
const endpointName = preset?.endpoint;
const modelName = preset?.model;
const provider = providerName ? config.providers?.[providerName] : null;
const endpoint = endpointName ? provider?.endpoints?.[endpointName] : null;
const apiKey = endpoint?.apiKey ?? provider?.apiKey;

if (!presetName || !providerName || !endpointName || !modelName || !endpoint || !apiKey) process.exit(1);
process.exit(0);
NODE
}

wait_for_agent_model_config() {
  if config_has_agent_model; then
    log "agent model config is ready"
    return
  fi

  log "waiting for model config in $MEMMY_CONFIG_PATH"
  log "finish account or BYOK setup in the desktop app; agent services will start automatically after config is written"
  while ! config_has_agent_model; do
    sleep 2
  done
  log "agent model config is ready"
}

run_agent_api() {
  require_command node
  export MEMMY_AGENT_WORKSPACE="${MEMMY_AGENT_WORKSPACE:-$MEMMY_WORKSPACE_DIR}"
  cd "$ROOT_DIR"
  wait_for_agent_model_config
  cd "$MEMMY_AGENT_DIR"
  exec node dist/main.js serve
}

run_main() {
  configure_dev_edition
  require_command node
  require_command npm
  require_command lsof
  export MEMMY_RUNTIME_NODE_PATH="${MEMMY_RUNTIME_NODE_PATH:-$(command -v node)}"
  local runtime_node_dir
  runtime_node_dir="$(cd "$(dirname "$MEMMY_RUNTIME_NODE_PATH")" && pwd)"
  export PATH="$runtime_node_dir:$PATH"
  hash -r
  log "using Node $("$MEMMY_RUNTIME_NODE_PATH" --version) from $MEMMY_RUNTIME_NODE_PATH"
  log "using desktop edition $MEMMY_APP_EDITION with $MEMMY_ACCOUNT_CHANNEL account channel"

  if [[ -z "$MEMMY_APP_DATABASE_FILE" ]]; then
    MEMMY_APP_DATABASE_FILE="$("$MEMMY_RUNTIME_NODE_PATH" --eval '
      const os = require("node:os");
      const path = require("node:path");
      const appData = process.platform === "win32"
        ? (process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"))
        : process.platform === "darwin"
          ? path.join(os.homedir(), "Library", "Application Support")
          : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
      process.stdout.write(path.resolve(appData, "Memmy", "app.sqlite"));
    ')"
  fi

  ensure_npm_dependencies

  if [[ ! -x "$CONCURRENTLY_BIN" ]]; then
    printf '[dev-start] missing concurrently binary at %s; run npm install first\n' "$CONCURRENTLY_BIN" >&2
    exit 1
  fi
  if [[ ! -x "$WAIT_ON_BIN" ]]; then
    printf '[dev-start] missing wait-on binary at %s; run npm install first\n' "$WAIT_ON_BIN" >&2
    exit 1
  fi

  stop_existing_stack

  log "building memmy-agent from current source"
  ensure_memmy_agent_dependencies
  cd "$MEMMY_AGENT_DIR"
  npm run build

  local config_parent config_name
  config_parent="$(dirname "$MEMMY_CONFIG_PATH")"
  config_name="$(basename "$MEMMY_CONFIG_PATH")"
  mkdir -p "$config_parent"
  config_parent="$(cd "$config_parent" && pwd -P)"
  MEMMY_CONFIG_PATH="$config_parent/$config_name"
  export MEMMY_CONFIG="$MEMMY_CONFIG_PATH"

  log "rebuilding better-sqlite3 for local Node runtime"
  cd "$ROOT_DIR"
  npm rebuild better-sqlite3
  "$MEMMY_RUNTIME_NODE_PATH" --eval \
    'const Database = require("better-sqlite3"); const db = new Database(":memory:"); db.close();'

  unset MEMMY_MIGRATIONS_READY_CONFIG MEMMY_MIGRATIONS_READY_WORKSPACE MEMMY_MIGRATIONS_READY_SESSION_DAG MEMMY_MIGRATIONS_READY_APP_DATABASE
  log "running startup migrations"
  cd "$MEMMY_AGENT_DIR"
  local migration_args=(dist/main.js migrate --config "$MEMMY_CONFIG_PATH" --app-database "$MEMMY_APP_DATABASE_FILE")
  if [[ "$MEMMY_WORKSPACE_IS_EXPLICIT" == "1" ]]; then
    mkdir -p "$MEMMY_WORKSPACE_DIR"
    MEMMY_WORKSPACE_DIR="$(cd "$MEMMY_WORKSPACE_DIR" && pwd -P)"
    migration_args+=(--workspace "$MEMMY_WORKSPACE_DIR")
  fi
  "$MEMMY_RUNTIME_NODE_PATH" "${migration_args[@]}"

  MEMMY_WORKSPACE_DIR="$("$MEMMY_RUNTIME_NODE_PATH" - "$MEMMY_CONFIG_PATH" "$HOME/.memmy/workspace" <<'NODE'
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const YAML = require("yaml");
const [configPath, fallback] = process.argv.slice(2);
let configured;
try {
  const root = YAML.parse(fs.readFileSync(configPath, "utf8")) || {};
  configured = root?.agents?.defaults?.workspace;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const selected = typeof configured === "string" && configured.trim() ? configured.trim() : fallback;
const expanded = selected === "~" || selected.startsWith("~/")
  ? path.join(os.homedir(), selected.slice(2))
  : selected;
process.stdout.write(path.resolve(expanded));
NODE
)"
  mkdir -p "$MEMMY_WORKSPACE_DIR"
  MEMMY_WORKSPACE_DIR="$(cd "$MEMMY_WORKSPACE_DIR" && pwd -P)"
  export MEMMY_AGENT_WORKSPACE="$MEMMY_WORKSPACE_DIR"
  export MEMMY_MIGRATIONS_READY_CONFIG="$MEMMY_CONFIG_PATH"
  export MEMMY_MIGRATIONS_READY_WORKSPACE="$MEMMY_WORKSPACE_DIR"
  export MEMMY_MIGRATIONS_READY_SESSION_DAG="${MEMMY_AGENT_SESSION_DAG_DIR:-$(dirname "$MEMMY_WORKSPACE_DIR")/session-dag}"
  export MEMMY_APP_DATABASE="$MEMMY_APP_DATABASE_FILE"
  export MEMMY_MIGRATIONS_READY_APP_DATABASE="$MEMMY_APP_DATABASE_FILE"

  build_and_install_memory_cli

  ensure_electron_runtime

  cd "$MEMMY_AGENT_DIR"

  install_user_cli_link "memmy" "$MEMMY_AGENT_DIR/dist/main.js"
  "$(user_cli_path "memmy")" --version >/dev/null
  log "memmy command is ready in $MEMMY_BIN_DIR"

  log "refreshing non-interactive memmy-agent onboard state"
  node dist/main.js onboard --defaults </dev/null

  log "starting agent API, frontend, and desktop backend; Electron manages Memory and supervises gateway"
  cd "$ROOT_DIR"
  mkdir -p "$LOG_DIR"
  exec "$CONCURRENTLY_BIN" -k -n agent-api,frontend,backend -c cyan,magenta,yellow \
    "bash -c 'set -o pipefail; bash scripts/dev-start.sh --agent-api 2>&1 | tee .tmp/dev-stack/agent-api.log'" \
    "bash -c 'set -o pipefail; npm run dev -w @memmy/frontend-desktop -- --host 127.0.0.1 2>&1 | tee .tmp/dev-stack/frontend.log'" \
    "bash -c 'set -o pipefail; ./node_modules/.bin/wait-on http://127.0.0.1:19000 && env -u ELECTRON_RUN_AS_NODE npm run dev -w @memmy/desktop 2>&1 | tee .tmp/dev-stack/backend.log'"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    --agent-api)
      run_agent_api
      ;;
    "")
      run_main
      ;;
    *)
      printf 'Usage: %s [--agent-api]\n' "$0" >&2
      exit 2
      ;;
  esac
fi
