#!/usr/bin/env bash
set -euo pipefail

# Fully uninstall the local Memmy app and user-level data/config/cache/state/preferences/logs.
# Also remove current CLI symlinks, legacy memmy-agent leftovers, and Spotlight-indexed build intermediates.
# Delete only rebuildable or user-level content; never touch source files or finished DMGs. rm -rf is irreversible.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Installed app.
APP_PATH="/Applications/Memmy.app"

# CLI symlinks created by the current installer, plus locations used by older installers.
CLI_SYMLINKS=(
  "$HOME/.local/bin/memmy-memory"
  "$HOME/.local/bin/memmy-agent"
  "$HOME/.local/bin/memmy"
  "/usr/local/bin/memmy-memory"
  "/usr/local/bin/memmy-agent"
  "/usr/local/bin/memmy"
)

# Shell startup files that may persist Memmy environment variables or the managed CLI PATH entry.
SHELL_PROFILES=(
  "$HOME/.zshenv"
  "$HOME/.zprofile"
  "$HOME/.zshrc"
  "$HOME/.zlogin"
  "$HOME/.profile"
  "$HOME/.bash_profile"
  "$HOME/.bash_login"
  "$HOME/.bashrc"
)

# Runtime variables are also cleared explicitly in case launchctl does not expose its environment dictionary.
RUNTIME_ENV_NAMES=(
  MEMMY_HOME
  MEMMY_CONFIG
  MEMMY_WORKSPACE
  MEMMY_AGENT_WORKSPACE
  MEMMY_RUNTIME_CONFIG_PATH
  MEMMY_LOCAL_API_URL
  MEMMY_LOCAL_TOKEN
  MEMMY_MEMORY_URL
  MEMMY_MEMORY_TOKEN
  MEMMY_MEMORY_USER_ID
  MEMMY_MEMORY_DB
  MEMMY_MEMORY_DB_PATH
  MEMMY_MEMORY_HOME
  MEMMY_MEMORY_HOST
  MEMMY_MEMORY_PORT
  MEMMY_MEMORY_LAYER_URL
  MEMMY_MEMORY_LAYER_TOKEN
  MEMORY_SERVICE_URL
  MEMORY_SERVICE_TOKEN
  MEMORY_SERVICE_USER_ID
  MEMORY_SERVICE_DB
  MEMORY_SERVICE_HOME
  MEMORY_SERVICE_HOST
  MEMORY_SERVICE_PORT
)

# User-level data, configuration, cache, state, preferences, and logs.
USER_PATHS=(
  "$HOME/Library/Application Support/Memmy"
  "$HOME/.memmy"
  "$HOME/Library/Logs/Memmy"
  "$HOME/Library/Caches/Memmy"
  "$HOME/Library/Caches/cn.memtensor.memmy"
  "$HOME/Library/Caches/ai.memmy.desktop"
  "$HOME/Library/Preferences/cn.memtensor.memmy.plist"
  "$HOME/Library/Preferences/ai.memmy.desktop.plist"
  "$HOME/Library/Saved Application State/cn.memtensor.memmy.savedState"
  "$HOME/Library/Saved Application State/ai.memmy.desktop.savedState"
  "$HOME/Library/HTTPStorages/cn.memtensor.memmy"
  "$HOME/Library/HTTPStorages/cn.memtensor.memmy.binarycookies"
  "$HOME/Library/WebKit/cn.memtensor.memmy"
)

# Repository build intermediates that can be regenerated; keep finished DMGs.
BUILD_PATHS=(
  "$ROOT_DIR/App/shell/desktop/release/out"
  "$ROOT_DIR/App/shell/desktop/release/stage"
  "$ROOT_DIR/App/shell/desktop/release/mac-arm64"
)

is_memmy_environment_name() {
  [[ "$1" =~ ^(MEMMY_|MEMORY_SERVICE_)[A-Za-z0-9_]*$ ]]
}

clear_environment_name() {
  local name="$1"
  if ! is_memmy_environment_name "$name"; then
    return
  fi

  unset "$name" 2>/dev/null || true
  if command -v launchctl >/dev/null 2>&1; then
    launchctl unsetenv "$name" >/dev/null 2>&1 || true
  fi
}

profile_environment_names() {
  local profile="$1"
  sed -nE 's/^[[:space:]]*(export[[:space:]]+)?((MEMMY|MEMORY_SERVICE)_[A-Za-z0-9_]+)=.*/\2/p' "$profile"
}

launchctl_environment_names() {
  if ! command -v launchctl >/dev/null 2>&1; then
    return
  fi

  launchctl print "gui/$(id -u)" 2>/dev/null \
    | sed -nE 's/^[[:space:]]*((MEMMY|MEMORY_SERVICE)_[A-Za-z0-9_]+)[[:space:]]+=>.*/\1/p'
}

clean_shell_profile() {
  local profile="$1"
  if [ ! -f "$profile" ]; then
    return
  fi

  local temp_file
  temp_file="$(mktemp "${TMPDIR:-/tmp}/memmy-profile.XXXXXX")"
  awk '
    /^[[:space:]]*# Memmy CLI PATH[[:space:]]*$/ {
      skip_managed_path = 1
      next
    }
    skip_managed_path && /^[[:space:]]*export PATH="\$HOME\/\.local\/bin:\$PATH"[[:space:]]*$/ {
      skip_managed_path = 0
      next
    }
    {
      skip_managed_path = 0
    }
    /^[[:space:]]*(export[[:space:]]+)?(MEMMY_|MEMORY_SERVICE_)[A-Za-z0-9_]*=/ {
      next
    }
    {
      print
    }
  ' "$profile" > "$temp_file"

  if cmp -s "$profile" "$temp_file"; then
    rm -f "$temp_file"
    return
  fi

  tee "$profile" < "$temp_file" >/dev/null
  rm -f "$temp_file"
  echo "cleaned-profile: $profile"
}

clear_memmy_environment() {
  local name
  local profile

  for name in "${RUNTIME_ENV_NAMES[@]}"; do
    clear_environment_name "$name"
  done

  while IFS='=' read -r name _; do
    clear_environment_name "$name"
  done < <(env)

  while IFS= read -r name; do
    [ -n "$name" ] && clear_environment_name "$name"
  done < <(launchctl_environment_names)

  for profile in "${SHELL_PROFILES[@]}"; do
    if [ -f "$profile" ]; then
      while IFS= read -r name; do
        [ -n "$name" ] && clear_environment_name "$name"
      done < <(profile_environment_names "$profile")
      clean_shell_profile "$profile"
    fi
  done
}

# 1. Quit all Memmy processes, helpers, and spawned memory/agent runtimes.
echo "==> Quitting Memmy processes"
osascript -e 'quit app "Memmy"' 2>/dev/null || true
sleep 1
pkill -f "$APP_PATH" 2>/dev/null || true
pkill -f "memory-service/memory.sqlite" 2>/dev/null || true

# 1b. Remove Memmy hooks/skills injected into other coding agents (Codex, Claude Code, Cursor,
# Hermes, OpenClaw, OpenCode). Reuse each agent target's own uninstall logic through the repo's
# bundled tsx so we strip only Memmy's marker blocks and hook entries while preserving every other
# setting in those agents' config files; never hand-edit their JSON/Markdown here. Best-effort:
# a missing agent, a broken import, or an absent tsx must not abort the uninstall.
echo "==> Removing Memmy integrations injected into other agents"
TSX_BIN="$ROOT_DIR/node_modules/.bin/tsx"
if [ -x "$TSX_BIN" ]; then
  uninstall_dir="$(mktemp -d "${TMPDIR:-/tmp}/memmy-agent-uninstall.XXXXXX")"
  # .mts forces an ES module so the script below can use top-level await under tsx.
  uninstall_script="$uninstall_dir/uninstall.mts"
  cat > "$uninstall_script" <<'NODE'
const root = process.env.MEMMY_ROOT;
const base = root + "/App/backend/src/adapters/outbound/skill-writer/";
const specs = [
  ["codex/index.ts", "createCodexSkillTarget"],
  ["claude-code/index.ts", "createClaudeCodeSkillTarget"],
  ["cursor/index.ts", "createCursorSkillTarget"],
  ["hermes/index.ts", "createHermesSkillTarget"],
  ["openclaw/index.ts", "createOpenclawSkillTarget"],
  ["opencode/index.ts", "createOpencodeSkillTarget"],
];
for (const [rel, factory] of specs) {
  try {
    const mod = await import(base + rel);
    const target = mod[factory]();
    try {
      if (typeof target.uninstallPlugin === "function") {
        await target.uninstallPlugin(target.targetId);
      }
    } catch (error) {
      console.log("plugin-uninstall-skip: " + target.targetId + " (" + ((error && error.message) || error) + ")");
    }
    await target.uninstall(target.targetId);
    console.log("removed-integration: " + target.targetId);
  } catch (error) {
    console.log("skip-integration: " + rel + " (" + ((error && error.message) || error) + ")");
  }
}
NODE
  MEMMY_ROOT="$ROOT_DIR" "$TSX_BIN" "$uninstall_script" 2>&1 || echo "agent-integration cleanup skipped (non-fatal)"
  rm -rf "$uninstall_dir"
else
  echo "skipped: repo tsx not found ($TSX_BIN); other-agent Memmy hooks/skills left untouched"
fi

# 2. Clear Memmy environment variables and shell startup entries.
echo "==> Clearing Memmy environment variables"
clear_memmy_environment

# 3. Detach leftover Memmy DMG volumes.
echo "==> Detaching leftover DMG volumes"
for vol in /Volumes/Memmy /Volumes/Memmy\ *; do
  [ -d "$vol" ] && hdiutil detach "$vol" -quiet 2>/dev/null || true
done

# 4. Delete the app bundle; the bundled CLI is removed with it.
echo "==> Deleting App: $APP_PATH"
rm -rf "$APP_PATH"

# 5. Delete CLI symlinks.
echo "==> Deleting CLI symlinks"
for link in "${CLI_SYMLINKS[@]}"; do
  if [ -L "$link" ]; then
    rm -f "$link" 2>/dev/null || echo "permission-denied: $link"
  elif [ -e "$link" ]; then
    echo "skipped-non-symlink: $link"
  fi
done

# 6. Delete user-level data, configuration, cache, state, preferences, and logs.
echo "==> Cleaning up user-level traces"
for path in "${USER_PATHS[@]}"; do
  rm -rf "$path"
done

# 7. Delete repository build intermediates while keeping finished DMGs.
echo "==> Cleaning up repository build artifacts (keeping DMGs)"
for path in "${BUILD_PATHS[@]}"; do
  rm -rf "$path"
done

# Result check.
echo "path-check:"
for path in "$APP_PATH" "${CLI_SYMLINKS[@]}" "${USER_PATHS[@]}" "${BUILD_PATHS[@]}"; do
  if [ -e "$path" ] || [ -L "$path" ]; then
    echo "still-exists: $path"
  else
    echo "deleted: $path"
  fi
done

echo "Done. The Spotlight index may lag; leftover Memmy build artifacts will stop appearing in search shortly."
echo "Important: already-running parent apps keep their inherited environment. Fully quit and reopen Codex and all terminals before reinstalling or testing Memmy."
