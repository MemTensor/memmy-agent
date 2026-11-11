import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "..");
const wrapper = path.join(root, "scripts/internal/linux/run-installer-with-network-retries.sh");
const roots = [];
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function runFixture({ failures = 0, message = "Temporary failure resolving 'ports.ubuntu.com'", exit = 42, teeFails = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "memmy-installer-network-"));
  roots.push(directory);
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  function tool(name, body) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/bash\n${body}\n`);
    chmodSync(file, 0o755);
  }
  // Keep the actual retry/control flow; avoid sleeping or contacting any host service.
  tool("timeout", 'printf "timeout %s\\n" "$*" >> "$CALLS"\nwhile [[ "$1" == --* ]]; do shift; done\nshift\nexec "$@"');
  tool("getent", 'printf "getent %s\\n" "$*" >> "$CALLS"\nexit 2');
  tool("sleep", 'printf "sleep %s\\n" "$*" >> "$CALLS"');
  if (teeFails) tool("tee", 'cat >/dev/null\nexit 73');
  const installer = path.join(directory, "installer.sh");
  writeFileSync(installer, `#!/bin/bash
count=0
[[ ! -f "$COUNT" ]] || count="$(< "$COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$COUNT"
if (( count <= FAILURES )); then
  printf '%s\\n' "$FAILURE_MESSAGE" >&2
  exit "$FAILURE_EXIT"
fi
printf ready > "$INSTALLED"
printf '%s\\n' 'The real installer completed.'
`);
  const result = spawnSync("/bin/bash", [wrapper, installer], {
    encoding: "utf8",
    env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, RUNNER_TEMP: directory,
      COUNT: path.join(directory, "count"), CALLS: path.join(directory, "calls"), INSTALLED: path.join(directory, "installed"),
      FAILURES: String(failures), FAILURE_MESSAGE: message, FAILURE_EXIT: String(exit) },
  });
  return { ...result, directory, attempts: Number(readFileSync(path.join(directory, "count"), "utf8")),
    installed: existsSync(path.join(directory, "installed")),
    calls: existsSync(path.join(directory, "calls")) ? readFileSync(path.join(directory, "calls"), "utf8") : "" };
}

describe("Linux CI installer network recovery", () => {
  it("accepts only a successful real installation after transient DNS failures", () => {
    const result = runFixture({ failures: 2 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.attempts).toBe(3);
    expect(result.installed).toBe(true);
    expect(result.calls).toContain("sleep 5\n");
    expect(result.calls).toContain("sleep 10\n");
    expect(result.calls).toContain("getent ahosts ports.ubuntu.com\n");
    expect(result.stdout).toContain("timeout 600s");
    expect(result.stderr).toContain("Transient installer network failure");
  });
  it("preserves a persistent DNS failure instead of skipping dependencies or passing", () => {
    const result = runFixture({ failures: 20 });
    expect(result.status).toBe(42);
    expect(result.attempts).toBe(3);
    expect(result.installed).toBe(false);
    expect(result.stderr).toContain("Linux installer network failure");
    const directory = result.stdout.match(/Installer attempt logs: (.+)/)[1];
    for (const attempt of [1, 2, 3]) {
      expect(readFileSync(path.join(directory, `attempt-${attempt}.log`), "utf8")).toContain("Temporary failure resolving");
    }
  });
  it.each([
    "E: Unable to locate package gir1.2-atspi-2.0",
    "sudo: a password is required",
    "AssertionError: gateway did not restart",
  ])("does not retry a permanent installer error: %s", message => {
    const result = runFixture({ failures: 20, message });
    expect(result.status).toBe(42);
    expect(result.attempts).toBe(1);
    expect(result.calls).not.toContain("sleep");
    expect(result.stderr).toContain("not retrying");
  });
  it("does not repeat an already successful installation", () => {
    const result = runFixture();
    expect(result.status, result.stderr).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.installed).toBe(true);
  });
  it("fails if the successful installer output could not be recorded", () => {
    const result = runFixture({ teeFails: true });
    expect(result.status).toBe(73);
    expect(result.attempts).toBe(1);
    expect(result.stderr).toContain("Cannot preserve installer output");
  });
  it("keeps all real architecture, install/update, and release upload gates", () => {
    const workflow = YAML.parse(readFileSync(path.join(root, ".github/workflows/linux-cli-installer.yml"), "utf8"));
    const smoke = workflow.jobs["install-smoke"];
    expect(smoke.timeoutMinutes ?? smoke["timeout-minutes"]).toBe(40);
    expect(smoke.strategy.matrix.include.map(entry => entry.architecture)).toEqual(["x64", "arm64"]);
    const run = smoke.steps.find(step => step.name === "Install twice and exercise the CLI").run;
    expect(run.match(/run-installer-with-network-retries\.sh release-assets\/install\.sh/g)).toHaveLength(3);
    expect(run).toContain("check-open-computer-use.mjs");
    expect(run).toContain('[[ "$gateway_pid_after_update" != "$gateway_pid_before_update" ]]');
    expect(run).toContain('"$MEMMY_BIN_DIR/memmy-memory" health');
    expect(run).not.toContain("MEMMY_INSTALL_COMPUTER_USE_DEPS=0");
    expect(smoke["continue-on-error"]).toBeUndefined();
    expect(workflow.jobs.upload.needs).toEqual(["build", "install-smoke"]);
  });
});
