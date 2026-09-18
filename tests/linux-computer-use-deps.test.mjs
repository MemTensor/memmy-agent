import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = path.resolve(import.meta.dirname, "../scripts/internal/linux/install-computer-use-deps.sh");
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture({ manager = "apt-get", rootUser = false, sudo = true, available = false, ...overrides } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "memmy-ocu-deps-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  function tool(name, body) {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/bash\n${body}\n`);
    chmodSync(file, 0o755);
  }
  tool("id", `printf '%s\\n' ${rootUser ? 0 : 1000}`);
  if (sudo) tool("sudo", 'printf "sudo %s\\n" "$*" >> "$LOG"\n[ "${DENY_SUDO:-0}" = 0 ] || exit 1\nexec "$@"');
  if (manager) tool(manager, [
    'printf "package %s\\n" "$*" >> "$LOG"',
    '[ "${FAIL_AT:-}" != "$1" ] || exit 42',
    'if [ "$1" != update ] && [ "${BROKEN_AFTER_INSTALL:-0}" = 0 ]; then printf ready > "$READY"; fi',
  ].join("\n"));
  const ready = path.join(root, "ready");
  if (available) writeFileSync(ready, "ready");
  return {
    run(extra = {}) {
      // No host package manager is reachable. Only the dependency probe is mocked;
      // execute the real privilege, installation, error and recheck control flow.
      const result = spawnSync("/bin/bash", ["-c", 'source "$HELPER"; computer_use_dependencies_available() { [ -f "$READY" ]; }; install_computer_use_dependencies'], {
        encoding: "utf8",
        env: { PATH: bin, HELPER: helper, READY: ready, LOG: path.join(root, "log"), ...overrides, ...extra },
      });
      return { ...result, log: existsSync(path.join(root, "log")) ? readFileSync(path.join(root, "log"), "utf8") : "" };
    },
  };
}

describe("Linux Computer Use system dependency installation", () => {
  it("skips all privileged operations when dependencies are already present", () => {
    const result = fixture({ available: true, sudo: false }).run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.log).toBe("");
  });
  it.each([
    ["apt-get", "install -y --no-install-recommends python3 python3-gi gir1.2-atspi-2.0 gir1.2-gtk-3.0 at-spi2-core"],
    ["dnf", "install -y python3 python3-gobject gtk3 at-spi2-core"],
    ["pacman", "-S --needed --noconfirm python python-gobject gtk3 at-spi2-core"],
  ])("installs with %s and does nothing on a second run", (manager, command) => {
    const instance = fixture({ manager });
    const first = instance.run();
    expect(first.status, first.stderr).toBe(0);
    expect(first.log).toContain(`sudo ${manager} ${command}\n`);
    expect(first.log).toContain(`package ${command}\n`);
    expect(instance.run().log).toBe(first.log);
  });
  it("does not require sudo when already running as root", () => {
    const result = fixture({ rootUser: true, sudo: false }).run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.log).toMatch(/^package update\npackage install/);
  });
  it("allows an explicit headless opt-out without privileges or a supported package manager", () => {
    const result = fixture({ manager: null, sudo: false }).run({ MEMMY_INSTALL_COMPUTER_USE_DEPS: "0" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("desktop automation may be unavailable");
    expect(result.log).toBe("");
  });
  it.each([
    [{ sudo: false }, "sudo is unavailable"],
    [{ DENY_SUDO: "1" }, "apt-get failed"],
    [{ manager: null }, "Automatic installation supports"],
    [{ FAIL_AT: "update" }, "apt-get failed"],
    [{ FAIL_AT: "install" }, "apt-get failed"],
    [{ manager: "dnf", FAIL_AT: "install" }, "dnf failed"],
    [{ manager: "pacman", FAIL_AT: "-S" }, "pacman failed"],
    [{ BROKEN_AFTER_INSTALL: "1" }, "custom Python"],
    [{ MEMMY_INSTALL_COMPUTER_USE_DEPS: "yes" }, "must be 0 or 1"],
  ])("reports failure instead of claiming dependencies are ready: %j", (options, message) => {
    const result = fixture(options).run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stdout).not.toContain("system dependencies are ready");
    if (options.FAIL_AT === "update" || options.DENY_SUDO) expect(result.log).not.toContain("package install");
  });
});
