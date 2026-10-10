import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openComputerUseEnvironment, resolveOpenComputerUseCommand } from "../../../src/tools/computer-use/open-computer-use-binary.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bundled Open Computer Use command", () => {
  it("uses the stable macOS development helper selected by dev-start", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-dev-ocu-"));
    roots.push(root);
    const binary = path.join(root, "Applications", "Open Computer Use.app", "Contents", "MacOS", "OpenComputerUse");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "fixture", { mode: 0o755 });
    const environment = { MEMMY_DEV_COMPUTER_USE_BINARY: binary };
    expect(resolveOpenComputerUseCommand("open-computer-use", { platform: "darwin", packageRoot: root, environment })).toBe(binary);
    expect(resolveOpenComputerUseCommand("/custom/helper", { environment })).toBe("/custom/helper");
    expect(resolveOpenComputerUseCommand("open-computer-use", { platform: "linux", packageRoot: root, environment })).toBe("open-computer-use");
  });

  it("does not apply the development helper override to a packaged app", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-packaged-ocu-"));
    roots.push(root);
    const packageRoot = path.join(root, "app.asar.unpacked", "node_modules", "open-computer-use");
    const binary = path.join(packageRoot, "dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse");
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
      })).toThrow(/Development Computer Use helper is missing|must be an absolute path/);
    }
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
  it.each([
    ["darwin", "arm64", "dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse"],
    ["darwin", "x64", "dist/Open Computer Use.app/Contents/MacOS/OpenComputerUse"],
    ["linux", "x64", "dist/linux/amd64/open-computer-use"],
    ["linux", "arm64", "dist/linux/arm64/open-computer-use"],
    ["win32", "x64", "dist/windows/amd64/open-computer-use.exe"],
    ["win32", "arm64", "dist/windows/arm64/open-computer-use.exe"],
  ])("selects the executable for %s %s outside asar", (platform, arch, relative) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-ocu-"));
    roots.push(root);
    const packageRoot = path.join(root, "app.asar", "node_modules", "open-computer-use");
    const binary = path.join(root, "app.asar.unpacked", "node_modules", "open-computer-use", relative);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "fixture", { mode: 0o755 });
    expect(resolveOpenComputerUseCommand("open-computer-use", { platform, arch, packageRoot })).toBe(binary);
  });

  it("retains explicit commands, unsupported targets and PATH fallback for missing bundles", () => {
    for (const command of ["/custom/open-computer-use", "./open-computer-use", "C:\\custom\\open-computer-use.exe", "npx"]) {
      expect(resolveOpenComputerUseCommand(command)).toBe(command);
    }
    expect(resolveOpenComputerUseCommand("open-computer-use", { packageRoot: "/missing-ocu-package" })).toBe("open-computer-use");
    expect(resolveOpenComputerUseCommand("open-computer-use", { platform: "freebsd" })).toBe("open-computer-use");
    expect(resolveOpenComputerUseCommand("open-computer-use", { arch: "ia32" })).toBe("open-computer-use");
  });
});
