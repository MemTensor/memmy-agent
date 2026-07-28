import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const devStartPath = fileURLToPath(new URL("../../../../scripts/dev-start.sh", import.meta.url));

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
  });

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
});
