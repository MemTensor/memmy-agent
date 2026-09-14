import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const devStartPath = fileURLToPath(new URL("../../../../scripts/dev-start.sh", import.meta.url));
const memoryCliPath = fileURLToPath(new URL("../../../../Memory/src/cli/index.ts", import.meta.url));
const agentConfigLoaderPath = fileURLToPath(new URL("../../../memmy-agent/src/config/loader.ts", import.meta.url));

describe("development CLI launchers", () => {
  it("defaults development startup to the international edition", () => {
    const script = String.raw`set -euo pipefail
source scripts/dev-start.sh
unset MEMMY_APP_EDITION MEMMY_ACCOUNT_CHANNEL

configure_dev_edition /path/that/does/not/exist
test "$MEMMY_APP_EDITION" = "intl"
test "$MEMMY_ACCOUNT_CHANNEL" = "email"`;
    const result = spawnSync("bash", ["-s"], { cwd: repoRoot, encoding: "utf8", input: script });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  }, 15_000);

  it("loads the domestic edition from a dotenv file and derives its account channel", () => {
    const script = String.raw`set -euo pipefail
source scripts/dev-start.sh
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
printf '%s\n' 'MEMMY_APP_EDITION=cn' > "$test_dir/.env"
unset MEMMY_APP_EDITION MEMMY_ACCOUNT_CHANNEL

configure_dev_edition "$test_dir/.env"
test "$MEMMY_APP_EDITION" = "cn"
test "$MEMMY_ACCOUNT_CHANNEL" = "phone"`;
    const result = spawnSync("bash", ["-s"], { cwd: repoRoot, encoding: "utf8", input: script });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("rejects an unsupported development edition", () => {
    const script = String.raw`set -euo pipefail
source scripts/dev-start.sh
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
printf '%s\n' 'MEMMY_APP_EDITION=staging' > "$test_dir/.env"
unset MEMMY_APP_EDITION MEMMY_ACCOUNT_CHANNEL

configure_dev_edition "$test_dir/.env"`;
    const result = spawnSync("bash", ["-s"], { cwd: repoRoot, encoding: "utf8", input: script });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MEMMY_APP_EDITION must be either cn or intl");
  });

  it("configures the explicit development edition before starting dependencies", () => {
    const script = String.raw`set -euo pipefail
source scripts/dev-start.sh
export MEMMY_APP_EDITION=cn
unset MEMMY_ACCOUNT_CHANNEL
require_command() {
  channel="$(printenv MEMMY_ACCOUNT_CHANNEL || printf '%s' unset)"
  printf '%s/%s\n' "$MEMMY_APP_EDITION" "$channel"
  exit 0
}

run_main`;
    const result = spawnSync("bash", ["-s"], { cwd: repoRoot, encoding: "utf8", input: script });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toBe("cn/phone\n");
  });

  it("recognizes endpoint-only credentials in model-preset runtime config", () => {
    const script = String.raw`set -euo pipefail
source scripts/dev-start.sh
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
cat > "$test_dir/config.yaml" <<'YAML'
agents:
  defaults:
    modelPreset: memmy-account
    provider: auto
    model: stale-model
providers:
  memmy_account:
    endpoints:
      chat:
        apiKey: account-token
modelPresets:
  memmy-account:
    provider: memmy_account
    endpoint: chat
    model: agent_chat
YAML
MEMMY_CONFIG_PATH="$test_dir/config.yaml"

config_has_agent_model`;
    const result = spawnSync("bash", ["-s"], { cwd: repoRoot, encoding: "utf8", input: script });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("does not accept legacy provider/model defaults without a model preset", () => {
    const script = String.raw`set -euo pipefail
source scripts/dev-start.sh
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
cat > "$test_dir/config.yaml" <<'YAML'
agents:
  defaults:
    provider: memmy_account
    model: agent_chat
providers:
  memmy_account:
    apiKey: account-token
YAML
MEMMY_CONFIG_PATH="$test_dir/config.yaml"

if config_has_agent_model; then
  exit 1
fi`;
    const result = spawnSync("bash", ["-s"], { cwd: repoRoot, encoding: "utf8", input: script });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("keeps memory initialization compatible with the current agent config contract", () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-dev-config-contract-"));
    const configPath = join(root, "config.yaml");
    try {
      const init = spawnSync(
        "node",
        [
          "--import", "tsx",
          memoryCliPath,
          "init",
          "--home", root,
          "--config", configPath,
          "--db", join(root, "memory.sqlite"),
          "--skip-agent-skills"
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, HOME: root, VITEST: "true" }
        }
      );
      expect(init.status, init.stderr || init.stdout).toBe(0);
      const config = YAML.parse(readFileSync(configPath, "utf8"));
      expect(config.memmyMemory.embedding).toEqual({ mode: "local", provider: "local" });

      const validate = spawnSync(
        "node",
        [
          "--import", "tsx",
          "--input-type=module",
          "--eval",
          `import { loadConfig } from ${JSON.stringify(pathToFileURL(agentConfigLoaderPath).href)}; loadConfig(process.env.MEMMY_CONFIG);`
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, MEMMY_CONFIG: configPath, VITEST: "true" }
        }
      );
      expect(validate.status, validate.stderr || validate.stdout).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("reinstalls memmy-agent dependencies when file validators are missing", () => {
    const script = String.raw`set -euo pipefail
source scripts/dev-start.sh

install_calls=0
dependencies_installed=0

node_can_resolve_from_dir() {
  local package="$2"
  case "$package" in
    html-validate|smol-toml)
      test "$dependencies_installed" -eq 1
      ;;
    *)
      return 0
      ;;
  esac
}

npm() {
  test "$1" = "ci"
  test "$2" = "--prefix"
  test "$3" = "$MEMMY_AGENT_DIR"
  test "$4" = "--include=dev"
  install_calls=$((install_calls + 1))
  dependencies_installed=1
}

ensure_memmy_agent_dependencies
test "$install_calls" -eq 1`;
    const result = spawnSync("bash", ["-s"], { cwd: repoRoot, encoding: "utf8", input: script });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("migrates managed Windows launchers and preserves unrelated files", () => {
    const source = readFileSync(devStartPath, "utf8");
    expect(source).toContain('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then');

    const script = String.raw`set -euo pipefail
test_home="$(mktemp -d)"
trap 'rm -rf "$test_home"' EXIT
export HOME="$test_home"
uname() { printf '%s\n' 'MINGW64_NT-10.0'; }
cygpath() { printf '%s\n' 'C:\current\Memory\dist\src\cli\index.js'; }
source scripts/dev-start.sh

source_path="$test_home/current/Memory/dist/src/cli/index.js"
legacy_path="$HOME/.local/bin/memmy-memory"
cmd_path="$legacy_path.cmd"
mkdir -p "$(dirname "$source_path")" "$(dirname "$legacy_path")"
printf '#!/usr/bin/env node\n' > "$source_path"
printf '#!/usr/bin/env bash\nexec node "/old/Memory/dist/src/cli/index.js" "$@"\n' > "$legacy_path"

install_user_cli_link memmy-memory "$source_path"
test ! -e "$legacy_path"
test -f "$cmd_path"
grep -F 'node "C:\current\Memory\dist\src\cli\index.js" %*' "$cmd_path"

rm -f "$cmd_path"
printf 'documentation mentions Memory/dist/src/cli/index.js\n' > "$legacy_path"
if (install_user_cli_link memmy-memory "$source_path"); then
  exit 1
fi
grep -Fx 'documentation mentions Memory/dist/src/cli/index.js' "$legacy_path"

rm -f "$legacy_path"
touch "$source_path.backup"
ln -s "$source_path.backup" "$legacy_path"
if (install_user_cli_link memmy-memory "$source_path"); then
  exit 1
fi
test -L "$legacy_path"

rm -f "$legacy_path"
uname() { printf '%s\n' 'Darwin'; }
install_user_cli_link memmy-memory "$source_path"
test -L "$legacy_path"
test "$(readlink "$legacy_path")" = "$source_path"
test ! -e "$cmd_path"`;
    const result = spawnSync("bash", ["-s"], { cwd: repoRoot, encoding: "utf8", input: script });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  }, 15_000);

  it("keeps the non-Windows symlink branch", () => {
    const source = readFileSync(devStartPath, "utf8");

    expect(source).toContain("MINGW*|MSYS*|CYGWIN*");
    expect(source).toContain('ln -s "$source" "$target"');
  });

  it("replaces the legacy Memory viewer CLI launcher with a development symlink", () => {
    const script = String.raw`set -euo pipefail
test_home="$(mktemp -d)"
trap 'rm -rf "$test_home"' EXIT
export HOME="$test_home"
source scripts/dev-start.sh

source_path="$test_home/current/Memory/dist/src/cli/index.js"
target="$HOME/.local/bin/memmy-memory"
mkdir -p "$(dirname "$source_path")" "$(dirname "$target")"
printf '#!/usr/bin/env node\n' > "$source_path"
printf '#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 %q %q "$@"\n' \
  "$test_home/runtime/node" "/old/Memory/dist/src/cli/index.js" > "$target"

install_user_cli_link memmy-memory "$source_path"
test -L "$target"
test "$(readlink "$target")" = "$source_path"

unlink "$target"
printf '#!/bin/sh\necho unrelated\n' > "$target"
if (install_user_cli_link memmy-memory "$source_path"); then
  exit 1
fi
grep -Fx 'echo unrelated' "$target"`;
    const result = spawnSync("bash", ["-s"], { cwd: repoRoot, encoding: "utf8", input: script });

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
