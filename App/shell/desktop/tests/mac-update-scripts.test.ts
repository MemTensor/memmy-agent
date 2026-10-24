import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMacDmgUpdateInstallScript, createMacDmgUpdateStageScript } from "../src/main/mac-update-scripts.js";

let root: string;
let destination: string;
let staged: string;
let marker: string;
let log: string;
let tools: Record<string, string>;

function fixture(app: string, tag: string, fields: Record<string, string> = {}) {
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  const values = { CFBundleIdentifier: "cn.memtensor.memmy", CFBundleExecutable: "Memmy", LSMinimumSystemVersion: "12.0", CFBundleShortVersionString: "1.2.2-rc.1", ...fields };
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>${Object.entries(values).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join("")}</dict></plist>`);
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "Memmy"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "architecture"), "arm64 x86_64");
  fs.writeFileSync(path.join(app, "signature"), "valid");
  fs.writeFileSync(path.join(app, "team"), "MEMMYTEAM1");
  fs.writeFileSync(path.join(app, "tag"), tag);
}

function mockTool(name: string, script: string) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  return file;
}

function instrument(script: string) {
  for (const [binary, replacement] of Object.entries(tools)) script = script.replaceAll(binary, `'${replacement}'`);
  return script;
}

function install(options: { expectedVersion?: string; currentVersion?: string } = {}) {
  const helper = path.join(root, "install.zsh");
  fs.writeFileSync(helper, instrument(createMacDmgUpdateInstallScript({ architecture: "arm64", teamIdentifier: "MEMMYTEAM1", expectedVersion: "1.2.2-rc.1", currentVersion: "1.2.1", ...options })));
  return spawnSync("/bin/zsh", [helper, "unused.dmg", destination, log, "99999999", "0", marker, staged, `${staged}.ready`], { encoding: "utf8", timeout: 10_000 });
}

describe.runIf(process.platform === "darwin")("macOS automatic update validation and rollback", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-update-兼容-"));
    destination = path.join(root, "Memmy.app");
    staged = path.join(root, "Memmy.staged.app");
    marker = path.join(root, "prepared.json");
    log = path.join(root, "update.log");
    fixture(destination, "original");
    fixture(staged, "replacement");
    fs.writeFileSync(`${staged}.ready`, "");
    fs.writeFileSync(marker, "pending");
    tools = {
      "/usr/bin/pgrep": mockTool("pgrep", "exit 1"),
      "/usr/bin/lipo": mockTool("lipo", 'case " $(cat "$(dirname "$3")/architecture") " in *" $2 "*) exit 0;; *) exit 1;; esac'),
      "/usr/bin/sw_vers": mockTool("sw_vers", "echo 14.0"),
      "/usr/bin/xattr": mockTool("xattr", "exit 0"),
      "/usr/bin/codesign": mockTool("codesign", `for arg in "$@"; do app="$arg"; done
if [ "$1" = -dv ]; then echo "TeamIdentifier=$(cat "$app/team")" >&2; exit 0; fi
for arg in "$@"; do if [ "$arg" = -R ] && [ -f "$app/untrusted-chain" ]; then exit 1; fi; done
if [ -f "$app/fail-after-replace" ] && [ "$app" = '${destination}' ]; then exit 1; fi
[ "$(cat "$app/signature")" = valid ]`),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("replaces a compatible app and removes the completion marker", () => {
    const result = install();
    expect(result.error).toBeUndefined();
    expect(result.status, fs.readFileSync(log, "utf8")).toBe(0);
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("replacement");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(`${destination}.update-backup`)).toBe(false);
  }, 15_000);

  it.each([
    ["advertised version", () => fixture(staged, "replacement", { CFBundleShortVersionString: "1.2.1" })],
    ["bundle identifier", () => fixture(staged, "replacement", { CFBundleIdentifier: "other.app" })],
    ["executable escape", () => fixture(staged, "replacement", { CFBundleExecutable: "../Memmy" })],
    ["architecture", () => fs.writeFileSync(path.join(staged, "Contents", "MacOS", "architecture"), "x86_64")],
    ["minimum OS", () => fixture(staged, "replacement", { LSMinimumSystemVersion: "14.1" })],
    ["missing minimum OS", () => fixture(staged, "replacement", { LSMinimumSystemVersion: "" })],
    ["signature", () => fs.writeFileSync(path.join(staged, "signature"), "invalid")],
    ["signing team", () => fs.writeFileSync(path.join(staged, "team"), "OTHERTEAM1")],
    ["Apple Developer ID certificate", () => fs.writeFileSync(path.join(staged, "untrusted-chain"), "")],
  ])("keeps the original app when the update fails %s validation", (_reason, corrupt) => {
    corrupt();
    expect(install().status).not.toBe(0);
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("original");
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(`${destination}.update-backup`)).toBe(false);
  });

  it.each([
    ["1.2.1", "1.2.2-rc.1", false],
    ["1.2.2-rc.1", "1.2.2-rc.1", false],
    ["1.2.2-rc.1", "1.2.2", false],
    ["1.2.2", "1.2.2-rc.1", true],
    ["1.2.2-rc.10", "1.2.2-rc.2", true],
  ])("compares package %s against current %s with prerelease precedence", (version, currentVersion, allowed) => {
    fixture(staged, "replacement", { CFBundleShortVersionString: version });
    expect(install({ expectedVersion: version, currentVersion }).status === 0).toBe(allowed);
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe(allowed ? "replacement" : "original");
  });

  it("rejects a symlink at the destination without changing its target", () => {
    const original = path.join(root, "original.app");
    fs.renameSync(destination, original);
    fs.symlinkSync(original, destination);
    expect(install().status).not.toBe(0);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(original, "tag"), "utf8")).toBe("original");
  });

  it("restores the original when validation fails after the new bundle has replaced it", () => {
    fs.writeFileSync(path.join(staged, "fail-after-replace"), "");
    expect(install().status).not.toBe(0);
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("original");
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toContain("previous app restored");
  });

  it("leaves the active installer's lock in place when a second installer starts", () => {
    fs.mkdirSync(`${marker}.lock`);
    fixture(`${destination}.update-tmp`, "active replacement");
    expect(install().status).toBe(0);
    expect(fs.existsSync(`${marker}.lock`)).toBe(true);
    expect(fs.readFileSync(path.join(`${destination}.update-tmp`, "tag"), "utf8")).toBe("active replacement");
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("original");
  });

  it("preserves the original backup when the failed replacement cannot be removed", () => {
    fs.writeFileSync(path.join(staged, "fail-after-replace"), "");
    tools["/bin/rm"] = mockTool("rm", `for arg in "$@"; do last="$arg"; done
if [ "$last" = '${destination}' ]; then exit 1; fi
exec /bin/rm "$@"`);
    expect(install().status).not.toBe(0);
    expect(fs.readFileSync(path.join(`${destination}.update-backup`, "tag"), "utf8")).toBe("original");
    expect(fs.existsSync(path.join(destination, "Memmy.app.update-backup"))).toBe(false);
    expect(fs.readFileSync(log, "utf8")).toContain("rollback failed; original is at");
  });

  it("preserves a prior rollback backup before starting another update", () => {
    fixture(`${destination}.update-backup`, "original recovery backup");
    fixture(destination, "previous failed replacement");
    expect(install().status).not.toBe(0);
    expect(fs.readFileSync(path.join(`${destination}.update-backup`, "tag"), "utf8")).toBe("original recovery backup");
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("previous failed replacement");
    expect(fs.readFileSync(path.join(staged, "tag"), "utf8")).toBe("replacement");
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toContain("recovery is required; previous app preserved");
  });

  it("rejects an incompatible package during staging before marking it ready", () => {
    const dmg = path.join(root, "dmg");
    fixture(path.join(dmg, "Memmy.app"), "replacement", { LSMinimumSystemVersion: "15.0" });
    tools["/usr/bin/hdiutil"] = mockTool("hdiutil", 'if [ "$1" = attach ]; then cp -R "$2"/. "$6"; fi');
    const helper = path.join(root, "stage.zsh");
    fs.writeFileSync(helper, instrument(createMacDmgUpdateStageScript({ architecture: "arm64", teamIdentifier: "MEMMYTEAM1", expectedVersion: "1.2.2-rc.1", currentVersion: "1.2.1" })));
    const result = spawnSync("/bin/zsh", [helper, dmg, staged, `${staged}.ready`, log], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(`${staged}.ready`)).toBe(false);
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("original");
  });
});
