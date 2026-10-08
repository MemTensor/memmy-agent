import { describe, expect, it } from "vitest";
import { isWindows11, windowsObserverCommand } from "../../../../src/tools/computer-history/win/win11.js";

describe("Windows 11 Computer History platform gate", () => {
  it("accepts Windows 11 builds while rejecting Windows 10 and other platforms", () => {
    expect(isWindows11("win32", "10.0.22000")).toBe(true);
    expect(isWindows11("win32", "10.0.22631")).toBe(true);
    expect(isWindows11("win32", "10.0.19045")).toBe(false);
    expect(isWindows11("darwin", "10.0.22631")).toBe(false);
  });

  it("starts the bundled observer as a noninteractive PowerShell file", () => {
    const command = windowsObserverCommand();
    expect(command.binary.toLowerCase()).toMatch(/windowspowershell[\\/]v1\.0[\\/]powershell\.exe$/u);
    expect(command.args).toContain("-NonInteractive");
    expect(command.args.at(-2)).toBe("-File");
    expect(command.args.at(-1)).toMatch(/win11-observer\.ps1$/u);
  });
});
