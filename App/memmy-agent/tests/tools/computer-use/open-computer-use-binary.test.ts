import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isManagedOcuConfig, legacyMacAppAgentExecutable, legacyMacAppAgentPids, managedOcuEnvironment, openComputerUseEnvironment, resolveOpenComputerUseCommand } from "../../../src/tools/computer-use/open-computer-use-binary.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bundled Memmy Computer Use command", () => {
  it('retires only the previous agent from the same Memmy installation', () => {
    const old = '/Applications/Memmy.app/Contents/Resources/app.asar.unpacked/dist/runtime/memmy-agent/node_modules/open-computer-use/dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse';
    expect(legacyMacAppAgentExecutable('/Applications/Memmy.app/Contents/Resources/app.asar/dist/runtime/memmy-agent')).toBe(old);
    expect(legacyMacAppAgentExecutable('/Applications/Memmy.app/Contents/Resources/app.asar.unpacked/dist/runtime/memmy-agent')).toBe(old);
    expect(legacyMacAppAgentExecutable('/Applications/Other.app/Contents/Resources/app.asar/dist/runtime/memmy-agent')).toBeNull();
    const processes = [
      ` 101 ${old} __open-computer-use-app-agent /tmp/open-computer-use-agent-1.sock`,
      ` 102 ${old} doctor`,
      ` 103 /Applications/Other.app/Contents/MacOS/OpenComputerUse __open-computer-use-app-agent /tmp/other.sock`,
      ` 104 ${old}.backup __open-computer-use-app-agent /tmp/other.sock`,
      ` 105 ${old} __open-computer-use-app-agent /tmp/open-computer-use-agent-2.sock`,
    ].join('\n');
    expect(legacyMacAppAgentPids(processes, old)).toEqual([101, 105]);
  });

  it("uses the stable macOS development helper selected by dev-start", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-dev-ocu-"));
    roots.push(root);
    const binary = path.join(root, "Applications", "Memmy Computer Use.app", "Contents", "MacOS", "MemmyComputerUse");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "fixture", { mode: 0o755 });
    const environment = { MEMMY_DEV_COMPUTER_USE_BINARY: binary };
    expect(resolveOpenComputerUseCommand("open-computer-use", { platform: "darwin", packageRoot: root, environment })).toBe(binary);
    expect(resolveOpenComputerUseCommand("/custom/helper", { environment })).toBe("/custom/helper");
    expect(() => resolveOpenComputerUseCommand("open-computer-use", { platform: "linux", packageRoot: root, environment }))
      .toThrow(/native runtime is missing/);
  });

  it("does not apply the development helper override to a packaged app", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-packaged-ocu-"));
    roots.push(root);
    const packageRoot = path.join(root, "app.asar.unpacked", "memmy-agent");
    const binary = path.join(packageRoot, "dist/native-computer-use/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "fixture", { mode: 0o755 });
    expect(resolveOpenComputerUseCommand("open-computer-use", {
      platform: "darwin", packageRoot, environment: { MEMMY_DEV_COMPUTER_USE_BINARY: "/missing/dev-helper" },
    })).toBe(binary);
  });

  it("fails clearly when the configured development helper is unavailable", () => {
    for (const binary of ["/missing/dev-helper", "relative/helper"]) {
      expect(() => resolveOpenComputerUseCommand("open-computer-use", {
        platform: "darwin", packageRoot: "/tmp/dev-package",
        environment: { MEMMY_DEV_COMPUTER_USE_BINARY: binary },
      })).toThrow(/Development Computer Use helper is missing|must be an absolute path|must be inside Memmy Computer Use/);
    }
  });

  it('refuses a legacy helper even when the override points to an executable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-legacy-ocu-'));
    roots.push(root);
    const legacy = path.join(root, 'Open Computer Use.app', 'Contents', 'MacOS', 'OpenComputerUse');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, 'fixture', { mode: 0o755 });
    expect(() => resolveOpenComputerUseCommand('open-computer-use', {
      platform: 'darwin', packageRoot: root, environment: { MEMMY_DEV_COMPUTER_USE_BINARY: legacy },
    })).toThrow(/must be inside Memmy Computer Use/);
  });

  it("passes Linux desktop session variables through MCP without leaking unrelated environment variables", () => {
    const inherited = { DISPLAY: ":1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", PRIVATE_TOKEN: "secret" };
    expect(openComputerUseEnvironment("open-computer-use", { DISPLAY: ":2" }, "linux", inherited)).toEqual({
      DISPLAY: ":2", DBUS_SESSION_BUS_ADDRESS: inherited.DBUS_SESSION_BUS_ADDRESS,
    });
    expect(openComputerUseEnvironment("other-server", null, "linux", inherited)).toBeNull();
    expect(openComputerUseEnvironment("open-computer-use", null, "darwin", inherited)).toBeNull();
  });
  it("makes the built-in Windows PowerShell backend available with a minimal PATH", () => {
    expect(openComputerUseEnvironment("open-computer-use", { Path: "D:\\custom" }, "win32", { SystemRoot: "C:\\Windows" })).toEqual({
      PATH: "D:\\custom;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    });
  });
  it("uses the Memmy Windows helper as a managed session without macOS app-agent settings", () => {
    const cfg = { command: "open-computer-use", args: ["mcp"] };
    expect(isManagedOcuConfig("memmy_computer_use", cfg, "win32")).toBe(true);
    expect(isManagedOcuConfig("open_computer_use", cfg, "win32")).toBe(true);
    expect(isManagedOcuConfig("memmy_computer_use", { ...cfg, command: "custom-helper" }, "win32")).toBe(false);
    expect(managedOcuEnvironment("C:\\Program Files\\Memmy\\memmy-computer-use.exe", { PATH: "C:\\Windows" }, "win32"))
      .toEqual({ PATH: "C:\\Windows" });
    expect(() => managedOcuEnvironment("open-computer-use", null, "win32")).toThrow(/missing/);
  });
  it('forwards locked use to the Mac helper only after desktop consent is active', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-lock-gate-'));
    roots.push(root);
    const binary = path.join(root, 'Memmy Computer Use.app', 'Contents', 'MacOS', 'MemmyComputerUse');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, 'fixture', { mode: 0o755 });
    const configured = { MEMMY_LOCKED_MAC_USE_ENABLED: '1' };
    expect(managedOcuEnvironment(binary, configured, 'darwin').MEMMY_LOCKED_MAC_USE_ENABLED).toBe('0');
    vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
    expect(managedOcuEnvironment(binary, configured, 'darwin').MEMMY_LOCKED_MAC_USE_ENABLED).toBe('0');
    const consent = path.join(root, 'locked-mac-consent.json');
    fs.writeFileSync(consent, JSON.stringify({ version: 1, granted: false, grantedAt: null }));
    vi.stubEnv('MEMMY_LOCKED_MAC_CONSENT_FILE', consent);
    expect(managedOcuEnvironment(binary, null, 'darwin').MEMMY_LOCKED_MAC_USE_ENABLED).toBe('0');
    fs.writeFileSync(consent, JSON.stringify({ version: 1, granted: true, grantedAt: '2026-09-29T00:00:00.000Z' }));
    expect(managedOcuEnvironment(binary, null, 'darwin').MEMMY_LOCKED_MAC_USE_ENABLED).toBe('1');
  });
  it.each([
    ["darwin", "arm64", "dist/native-computer-use/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse"],
    ["darwin", "x64", "dist/native-computer-use/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse"],
    ["linux", "x64", "dist/native-computer-use/linux/amd64/memmy-computer-use"],
    ["linux", "arm64", "dist/native-computer-use/linux/arm64/memmy-computer-use"],
    ["win32", "x64", "dist/native-computer-use/windows/amd64/memmy-computer-use.exe"],
    ["win32", "arm64", "dist/native-computer-use/windows/arm64/memmy-computer-use.exe"],
  ])("selects the executable for %s %s outside asar", (platform, arch, relative) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-ocu-"));
    roots.push(root);
    const packageRoot = path.join(root, "app.asar", "memmy-agent");
    const binary = path.join(root, "app.asar.unpacked", "memmy-agent", relative);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "fixture", { mode: 0o755 });
    expect(resolveOpenComputerUseCommand("open-computer-use", { platform, arch, packageRoot })).toBe(binary);
  });

  it("retains explicit commands and refuses missing desktop bundles", () => {
    for (const command of ["/custom/open-computer-use", "./open-computer-use", "C:\\custom\\open-computer-use.exe", "npx"]) {
      expect(resolveOpenComputerUseCommand(command)).toBe(command);
    }
    expect(() => resolveOpenComputerUseCommand("open-computer-use", { packageRoot: "/missing-ocu-package" })).toThrow(/Memmy Computer Use native runtime is missing/);
    expect(resolveOpenComputerUseCommand("open-computer-use", { platform: "freebsd" })).toBe("open-computer-use");
    expect(() => resolveOpenComputerUseCommand("open-computer-use", { arch: "ia32" })).toThrow(/does not support ia32/);
  });
});
