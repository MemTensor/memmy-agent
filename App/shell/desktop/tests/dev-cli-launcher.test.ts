import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const devStartPath = fileURLToPath(new URL("../../../../scripts/dev-start.sh", import.meta.url));

describe("development CLI launchers", () => {
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
