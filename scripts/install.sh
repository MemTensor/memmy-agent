#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${MEMMY_GITHUB_REPOSITORY:-MemTensor/memmy-agent}"
ARCHIVE_NAME="memmy-agent-linux-cli.tar.gz"
CHECKSUM_NAME="$ARCHIVE_NAME.sha256"
INSTALL_ROOT="${MEMMY_INSTALL_ROOT:-$HOME/.local/share/memmy-agent}"
BIN_DIR="${MEMMY_BIN_DIR:-$HOME/.local/bin}"
MEMMY_HOME_DIR="${MEMMY_HOME:-$HOME/.memmy}"
CONFIG_PATH="${MEMMY_CONFIG:-$MEMMY_HOME_DIR/config.yaml}"
WORKSPACE_DIR="${MEMMY_AGENT_WORKSPACE:-$MEMMY_HOME_DIR/workspace}"
MEMORY_DB_PATH="${MEMMY_MEMORY_DB:-$MEMMY_HOME_DIR/memory-service/memory.sqlite}"
SYSTEMD_USER_DIR="${MEMMY_SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
MEMORY_UNIT="$SYSTEMD_USER_DIR/memmy-memory.service"
GATEWAY_UNIT="$SYSTEMD_USER_DIR/memmy-gateway.service"
GATEWAY_ENV_FILE="$MEMMY_HOME_DIR/systemd/gateway.env"

fail() {
  printf 'memmy installer: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

if [ "$(uname -s)" != "Linux" ]; then
  fail "this installer supports Linux only"
fi

case "$(uname -m)" in
  x86_64|amd64)
    PLATFORM_ARCH="x64"
    ;;
  aarch64|arm64)
    PLATFORM_ARCH="arm64"
    ;;
  *)
    fail "unsupported Linux architecture: $(uname -m) (expected x86_64 or arm64)"
    ;;
esac

for command_name in node npm curl tar systemctl; do
  require_command "$command_name"
done
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  fail "required SHA-256 tool not found (install sha256sum or shasum)"
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')" \
  || fail "could not determine Node.js version"
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "Node.js 22 or newer is required (found $(node --version))"
fi
NODE_BIN="$(command -v node)"
case "$NODE_BIN" in
  /*) ;;
  *) NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")" ;;
esac

if ! systemctl --user show-environment >/dev/null 2>&1; then
  fail "systemd --user is required and no user service manager is available"
fi

VERSION="${MEMMY_VERSION:-}"
if [ -z "$VERSION" ]; then
  LATEST_URL="$(curl --fail --silent --show-error --location \
    --output /dev/null --write-out '%{url_effective}' \
    "https://github.com/$REPOSITORY/releases/latest")" \
    || fail "could not resolve the latest GitHub Release"
  VERSION="${LATEST_URL##*/}"
fi
VERSION="${VERSION#v}"
if [[ ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  fail "invalid release version: $VERSION"
fi

if [ -n "${MEMMY_RELEASE_BASE_URL:-}" ]; then
  ASSET_BASE="${MEMMY_RELEASE_BASE_URL%/}"
else
  ASSET_BASE="https://github.com/$REPOSITORY/releases/download/v$VERSION"
fi

mkdir -p "$INSTALL_ROOT/releases" "$BIN_DIR"
WORK_DIR="$(mktemp -d "$INSTALL_ROOT/.install.XXXXXX")"
CONFIG_EXISTED="false"
CONFIG_BACKUP="$WORK_DIR/config.before-install"
if [ -f "$CONFIG_PATH" ]; then
  cp -p "$CONFIG_PATH" "$CONFIG_BACKUP"
  CONFIG_EXISTED="true"
fi
restore_config() {
  if [ "$CONFIG_EXISTED" = "true" ]; then
    mkdir -p "$(dirname "$CONFIG_PATH")"
    cp -p "$CONFIG_BACKUP" "$CONFIG_PATH"
  else
    rm -f "$CONFIG_PATH"
  fi
}
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

ARCHIVE_PATH="$WORK_DIR/$ARCHIVE_NAME"
CHECKSUM_PATH="$WORK_DIR/$CHECKSUM_NAME"
printf 'Downloading Memmy Agent %s for Linux %s...\n' "$VERSION" "$PLATFORM_ARCH"
curl --fail --silent --show-error --location --retry 3 --retry-all-errors \
  --output "$ARCHIVE_PATH" "$ASSET_BASE/$ARCHIVE_NAME" \
  || fail "download failed: $ASSET_BASE/$ARCHIVE_NAME"
curl --fail --silent --show-error --location --retry 3 --retry-all-errors \
  --output "$CHECKSUM_PATH" "$ASSET_BASE/$CHECKSUM_NAME" \
  || fail "checksum download failed: $ASSET_BASE/$CHECKSUM_NAME"

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$WORK_DIR" && sha256sum --check "$CHECKSUM_NAME") \
    || fail "SHA-256 verification failed"
else
  EXPECTED_SHA256="$(awk '{print $1; exit}' "$CHECKSUM_PATH")"
  ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
  [ "$EXPECTED_SHA256" = "$ACTUAL_SHA256" ] || fail "SHA-256 verification failed"
fi

while IFS= read -r archive_entry; do
  case "$archive_entry" in
    /*|../*|*/../*|*/..)
      fail "archive contains an unsafe path: $archive_entry"
      ;;
  esac
done < <(tar -tzf "$ARCHIVE_PATH")

PAYLOAD_DIR="$WORK_DIR/payload"
mkdir -p "$PAYLOAD_DIR"
tar -xzf "$ARCHIVE_PATH" --no-same-owner --no-same-permissions -C "$PAYLOAD_DIR"

AGENT_DIR="$PAYLOAD_DIR/App/memmy-agent"
[ -f "$PAYLOAD_DIR/package.json" ] || fail "archive is missing package.json"
[ -f "$PAYLOAD_DIR/package-lock.json" ] || fail "archive is missing package-lock.json"
[ -f "$AGENT_DIR/package.json" ] || fail "archive is missing App/memmy-agent/package.json"
[ -f "$AGENT_DIR/package-lock.json" ] || fail "archive is missing App/memmy-agent/package-lock.json"
[ -f "$AGENT_DIR/dist/main.js" ] || fail "archive is missing the Memmy CLI entrypoint"
[ -f "$PAYLOAD_DIR/Memory/dist/src/server/index.js" ] \
  || fail "archive is missing the Memory service entrypoint"
[ -f "$PAYLOAD_DIR/Memory/dist/src/cli/index.js" ] \
  || fail "archive is missing the memmy-memory CLI entrypoint"
[ -f "$PAYLOAD_DIR/App/backend/dist/src/services/builtin-skill-target-registry.js" ] \
  || fail "archive is missing the existing agent Hook/plugin integration registry"
[ -f "$PAYLOAD_DIR/App/backend/dist/src/adapters/outbound/skill-writer/templates/memmy-resume-hook.js" ] \
  || fail "archive is missing the existing agent Hook template"
[ -f "$PAYLOAD_DIR/App/backend/dist/src/adapters/outbound/skill-writer/templates/memmy-opencode-plugin.js" ] \
  || fail "archive is missing the existing native plugin template"
[ -f "$PAYLOAD_DIR/resources/embedding-models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx" ] \
  || fail "archive is missing the bundled embedding model"

printf 'Installing Memory runtime production dependencies for this Linux machine...\n'
(cd "$PAYLOAD_DIR" && npm ci --omit=dev --workspaces \
  --include-workspace-root=false --no-audit --no-fund) \
  || fail "Memory runtime dependency installation failed; the previous Memmy installation is unchanged"
printf 'Installing Agent production dependencies for this Linux machine...\n'
(cd "$AGENT_DIR" && npm ci --omit=dev --no-audit --no-fund) \
  || fail "Agent dependency installation failed; the previous Memmy installation is unchanged"

mkdir -p "$MEMMY_HOME_DIR" "$(dirname "$CONFIG_PATH")" "$(dirname "$MEMORY_DB_PATH")" "$WORKSPACE_DIR"
chmod 0700 "$MEMMY_HOME_DIR" "$(dirname "$MEMORY_DB_PATH")" "$WORKSPACE_DIR"

MEMORY_INIT_ARGS=(
  init
  --home "$MEMMY_HOME_DIR"
  --config "$CONFIG_PATH"
  --endpoint "http://127.0.0.1:18960"
  --db "$MEMORY_DB_PATH"
  --skip-agent-skills
  --generate-token-if-missing
)
if ! "$NODE_BIN" "$PAYLOAD_DIR/Memory/dist/src/cli/index.js" "${MEMORY_INIT_ARGS[@]}" >/dev/null; then
  restore_config
  fail "could not initialize the local Memory configuration"
fi
chmod 0600 "$CONFIG_PATH"

RELEASE_DIR="$INSTALL_ROOT/releases/$VERSION-$(date +%s)-$$"
mv "$PAYLOAD_DIR" "$RELEASE_DIR"

PREVIOUS_RELEASE=""
if [ -L "$INSTALL_ROOT/current" ]; then
  PREVIOUS_RELEASE="$(readlink "$INSTALL_ROOT/current")"
fi
MEMORY_WAS_ACTIVE="false"
if systemctl --user is-active --quiet memmy-memory.service >/dev/null 2>&1; then
  MEMORY_WAS_ACTIVE="true"
fi
GATEWAY_WAS_ACTIVE="false"
if systemctl --user is-active --quiet memmy-gateway.service >/dev/null 2>&1; then
  GATEWAY_WAS_ACTIVE="true"
fi
CURRENT_LINK="$INSTALL_ROOT/.current.$$"
ln -s "$RELEASE_DIR" "$CURRENT_LINK"
mv -Tf "$CURRENT_LINK" "$INSTALL_ROOT/current"

LAUNCHER_TEMP="$BIN_DIR/.memmy.$$"
{
  printf '#!/usr/bin/env bash\n'
  printf 'set -euo pipefail\n'
  printf 'MEMMY_INSTALL_ROOT=%q\n' "$INSTALL_ROOT"
  printf 'export MEMMY_HOME=%q\n' "$MEMMY_HOME_DIR"
  printf 'export MEMMY_CONFIG=%q\n' "$CONFIG_PATH"
  printf 'export MEMMY_AGENT_WORKSPACE=%q\n' "$WORKSPACE_DIR"
  printf 'export MEMMY_GATEWAY_ENV_FILE=%q\n' "$GATEWAY_ENV_FILE"
  printf 'export MEMMY_LINUX_SYSTEMD_GATEWAY=1\n'
  printf 'exec %q "$MEMMY_INSTALL_ROOT/current/App/memmy-agent/dist/main.js" "$@"\n' "$NODE_BIN"
} > "$LAUNCHER_TEMP"
chmod 0755 "$LAUNCHER_TEMP"
mv -f "$LAUNCHER_TEMP" "$BIN_DIR/memmy"

MEMORY_LAUNCHER_TEMP="$BIN_DIR/.memmy-memory.$$"
{
  printf '#!/usr/bin/env bash\n'
  printf 'set -euo pipefail\n'
  printf 'MEMMY_INSTALL_ROOT=%q\n' "$INSTALL_ROOT"
  printf 'export MEMMY_HOME=%q\n' "$MEMMY_HOME_DIR"
  printf 'export MEMMY_CONFIG=%q\n' "$CONFIG_PATH"
  printf 'export MEMMY_AGENT_INTEGRATION_ROOT="$MEMMY_INSTALL_ROOT/current/App/backend/dist/src"\n'
  printf 'exec %q "$MEMMY_INSTALL_ROOT/current/Memory/dist/src/cli/index.js" "$@"\n' "$NODE_BIN"
} > "$MEMORY_LAUNCHER_TEMP"
chmod 0755 "$MEMORY_LAUNCHER_TEMP"
mv -f "$MEMORY_LAUNCHER_TEMP" "$BIN_DIR/memmy-memory"

systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

systemd_environment_file_path() {
  local value="$1"
  case "$value" in
    *$'\n'*|*$'\r'*)
      fail "Gateway environment file path contains a newline"
      ;;
  esac
  # EnvironmentFile parses its path as a raw value rather than a quoted word.
  # Preserve spaces, but escape '%' so it is not expanded as a specifier.
  value="${value//%/%%}"
  printf '%s' "$value"
}

mkdir -p "$SYSTEMD_USER_DIR"

MEMORY_UNIT_TEMP="$SYSTEMD_USER_DIR/.memmy-memory.service.$$"
{
  printf '[Unit]\n'
  printf 'Description=Memmy Memory Service\n\n'
  printf '[Service]\n'
  printf 'Type=simple\n'
  printf 'Environment=%s\n' "$(systemd_quote "MEMMY_HOME=$MEMMY_HOME_DIR")"
  printf 'Environment=%s\n' "$(systemd_quote "MEMMY_CONFIG=$CONFIG_PATH")"
  printf 'Environment=%s\n' "$(systemd_quote "MEMMY_EMBEDDING_MODEL_ROOT=$INSTALL_ROOT/current/resources/embedding-models")"
  printf 'ExecStart=%s %s --config %s --host 127.0.0.1 --port 18960 --db %s\n' \
    "$(systemd_quote "$NODE_BIN")" \
    "$(systemd_quote "$INSTALL_ROOT/current/Memory/dist/src/server/index.js")" \
    "$(systemd_quote "$CONFIG_PATH")" \
    "$(systemd_quote "$MEMORY_DB_PATH")"
  printf 'Restart=on-failure\n'
  printf 'RestartSec=3s\n'
  printf 'TimeoutStopSec=15s\n'
  printf 'UMask=0077\n\n'
  printf '[Install]\n'
  printf 'WantedBy=default.target\n'
} > "$MEMORY_UNIT_TEMP"
chmod 0644 "$MEMORY_UNIT_TEMP"
mv -f "$MEMORY_UNIT_TEMP" "$MEMORY_UNIT"

GATEWAY_UNIT_TEMP="$SYSTEMD_USER_DIR/.memmy-gateway.service.$$"
{
  printf '[Unit]\n'
  printf 'Description=Memmy Agent Gateway\n'
  printf 'Wants=memmy-memory.service\n'
  printf 'After=memmy-memory.service\n'
  printf 'StartLimitIntervalSec=60s\n'
  printf 'StartLimitBurst=5\n\n'
  printf '[Service]\n'
  printf 'Type=simple\n'
  printf 'Environment=%s\n' "$(systemd_quote "MEMMY_HOME=$MEMMY_HOME_DIR")"
  printf 'Environment=%s\n' "$(systemd_quote "MEMMY_CONFIG=$CONFIG_PATH")"
  printf 'Environment=%s\n' "$(systemd_quote "MEMMY_AGENT_WORKSPACE=$WORKSPACE_DIR")"
  printf 'Environment=%s\n' "$(systemd_quote "MEMMY_GATEWAY_ENV_FILE=$GATEWAY_ENV_FILE")"
  # EnvironmentFile does not unquote paths like Environment=/ExecStart= do. The
  # optional-file prefix and absolute path must therefore both remain unquoted.
  printf 'EnvironmentFile=-%s\n' "$(systemd_environment_file_path "$GATEWAY_ENV_FILE")"
  printf 'Environment=MEMMY_MEMORY_URL=http://127.0.0.1:18960\n'
  printf 'Environment=MEMORY_SERVICE_URL=http://127.0.0.1:18960\n'
  printf 'ExecStart=%s %s gateway --config %s --workspace %s\n' \
    "$(systemd_quote "$NODE_BIN")" \
    "$(systemd_quote "$INSTALL_ROOT/current/App/memmy-agent/dist/main.js")" \
    "$(systemd_quote "$CONFIG_PATH")" \
    "$(systemd_quote "$WORKSPACE_DIR")"
  printf 'Restart=on-failure\n'
  printf 'RestartSec=3s\n'
  printf 'TimeoutStopSec=15s\n'
  printf 'UMask=0077\n\n'
  printf '[Install]\n'
  printf 'WantedBy=default.target\n'
} > "$GATEWAY_UNIT_TEMP"
chmod 0644 "$GATEWAY_UNIT_TEMP"
mv -f "$GATEWAY_UNIT_TEMP" "$GATEWAY_UNIT"

rollback_current_release() {
  restore_config
  if [ -n "$PREVIOUS_RELEASE" ]; then
    local rollback_link="$INSTALL_ROOT/.rollback.$$"
    ln -s "$PREVIOUS_RELEASE" "$rollback_link"
    mv -Tf "$rollback_link" "$INSTALL_ROOT/current"
    systemctl --user restart memmy-memory.service >/dev/null 2>&1 || true
    if [ "$GATEWAY_WAS_ACTIVE" = "true" ]; then
      systemctl --user restart memmy-gateway.service >/dev/null 2>&1 || true
    fi
  else
    systemctl --user disable --now memmy-memory.service >/dev/null 2>&1 || true
    unlink "$INSTALL_ROOT/current" >/dev/null 2>&1 || true
  fi
}

if ! systemctl --user daemon-reload; then
  rollback_current_release
  fail "could not reload the systemd user manager"
fi
if ! systemctl --user enable --now memmy-memory.service; then
  rollback_current_release
  fail "could not enable and start memmy-memory.service"
fi
if [ "$MEMORY_WAS_ACTIVE" = "true" ]; then
  if ! systemctl --user restart memmy-memory.service; then
    rollback_current_release
    fail "could not restart memmy-memory.service after update"
  fi
fi
MEMORY_READY="false"
for ((_attempt = 1; _attempt <= 200; _attempt++)); do
  MEMORY_PID_BEFORE="$(systemctl --user show memmy-memory.service --property=MainPID --value 2>/dev/null || true)"
  if [[ "$MEMORY_PID_BEFORE" =~ ^[1-9][0-9]*$ ]] \
    && [ "$MEMORY_PID_BEFORE" -gt 1 ] \
    && kill -0 "$MEMORY_PID_BEFORE" >/dev/null 2>&1 \
    && "$BIN_DIR/memmy-memory" health >/dev/null 2>&1; then
    sleep 0.25
    MEMORY_PID_AFTER="$(systemctl --user show memmy-memory.service --property=MainPID --value 2>/dev/null || true)"
    if [ "$MEMORY_PID_AFTER" = "$MEMORY_PID_BEFORE" ] \
      && kill -0 "$MEMORY_PID_AFTER" >/dev/null 2>&1; then
      MEMORY_READY="true"
      break
    fi
  fi
  sleep 0.15
done
if [ "$MEMORY_READY" != "true" ]; then
  rollback_current_release
  fail "memmy-memory.service did not become healthy; check systemctl --user status memmy-memory.service"
fi
if [ "$GATEWAY_WAS_ACTIVE" = "true" ] && [ -f "$GATEWAY_ENV_FILE" ]; then
  if ! systemctl --user restart memmy-gateway.service; then
    rollback_current_release
    fail "could not restart memmy-gateway.service after update"
  fi
  GATEWAY_READY="false"
  GATEWAY_LAST_PID=""
  GATEWAY_STABLE_SAMPLES=0
  for ((_attempt = 1; _attempt <= 200; _attempt++)); do
    GATEWAY_PID="$(systemctl --user show memmy-gateway.service --property=MainPID --value 2>/dev/null || true)"
    if systemctl --user is-active --quiet memmy-gateway.service >/dev/null 2>&1 \
      && [[ "$GATEWAY_PID" =~ ^[1-9][0-9]*$ ]] \
      && [ "$GATEWAY_PID" -gt 1 ] \
      && kill -0 "$GATEWAY_PID" >/dev/null 2>&1; then
      if [ "$GATEWAY_PID" = "$GATEWAY_LAST_PID" ]; then
        GATEWAY_STABLE_SAMPLES=$((GATEWAY_STABLE_SAMPLES + 1))
      else
        GATEWAY_LAST_PID="$GATEWAY_PID"
        GATEWAY_STABLE_SAMPLES=0
      fi
      if [ "$GATEWAY_STABLE_SAMPLES" -ge 14 ]; then
        GATEWAY_READY="true"
        break
      fi
    else
      GATEWAY_LAST_PID=""
      GATEWAY_STABLE_SAMPLES=0
    fi
    sleep 0.15
  done
  if [ "$GATEWAY_READY" != "true" ]; then
    rollback_current_release
    fail "memmy-gateway.service did not become stable after update; check systemctl --user status memmy-gateway.service"
  fi
fi

PATH_UPDATED="false"
case ":$PATH:" in
  *":$BIN_DIR:"*)
    ;;
  *)
    if [ "$BIN_DIR" = "$HOME/.local/bin" ]; then
      PROFILE_PATH="$HOME/.profile"
      PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
      if [ ! -f "$PROFILE_PATH" ] || ! grep -Fqx "$PATH_LINE" "$PROFILE_PATH"; then
        printf '\n%s\n' "$PATH_LINE" >> "$PROFILE_PATH"
      fi
      PATH_UPDATED="true"
    fi
    ;;
esac

trap - EXIT
rm -rf "$WORK_DIR"

# Keep the current release and at most one previous release for manual rollback.
for old_release in "$INSTALL_ROOT"/releases/*; do
  [ -d "$old_release" ] || continue
  if [ "$old_release" != "$RELEASE_DIR" ] && [ "$old_release" != "$PREVIOUS_RELEASE" ]; then
    rm -rf "$old_release"
  fi
done

printf 'Memmy Agent %s installed successfully.\n' "$VERSION"
if [ "$PATH_UPDATED" = "true" ]; then
  printf 'Open a new terminal, or run: export PATH="$HOME/.local/bin:$PATH"\n'
elif ! command -v memmy >/dev/null 2>&1; then
  printf 'Add %s to PATH, then run memmy.\n' "$BIN_DIR"
fi
printf 'Memory service: systemctl --user status memmy-memory.service\n'
printf 'Gateway service: systemctl --user status memmy-gateway.service\n'
printf 'Start Memmy with: memmy\n'
