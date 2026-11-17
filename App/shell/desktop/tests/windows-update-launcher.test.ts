import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createWindowsUpdateLauncherFile, waitForWindowsUpdateLauncher } from "../src/main/windows-update-launcher.js";

describe("Windows update launcher", () => {
  it("encodes the PowerShell launcher as UTF-16LE with BOM without losing Chinese paths or arguments", () => {
    const helperPath = "D:\\测试路径\\Memmy\\data\\Memmy\\updates\\install-win-update.ps1";
    const installerPath = "D:\\测试路径\\Memmy\\data\\Memmy\\updates\\Memmy-1.1.0.exe";
    const appPath = "D:\\测试路径\\Memmy\\Memmy.exe";
    const logPath = "D:\\测试路径\\Memmy\\data\\Memmy\\updates\\win-update-install.log";
    const markerPath = "D:\\测试路径\\Memmy\\data\\Memmy\\prepared-required-update.json";
    const command = [
      "powershell.exe",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      helperPath,
      installerPath,
      appPath,
      logPath,
      "4242",
      "1",
      markerPath,
      "1.1.0"
    ];

    const launcherFile = createWindowsUpdateLauncherFile(command);

    expect([...launcherFile.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    const decoded = launcherFile.toString("utf16le");
    expect(decoded.startsWith("\uFEFF")).toBe(true);
    expect(decoded).toContain("Start-Process @startArguments");
    expect(decoded).toContain("WindowStyle = 'Hidden'");
    expect(decoded).toContain("Remove-Item -LiteralPath $launcherPath -Force");
    expect(decoded).not.toContain("WScript");
    expect(decoded).not.toContain("CreateObject");
    for (const argument of command) {
      expect(decoded).toContain(argument.replaceAll("'", "''"));
    }
  });

  it("keeps a single-argument helper command valid", () => {
    const decoded = createWindowsUpdateLauncherFile(["helper.ps1"]).toString("utf16le");

    expect(decoded).toContain("FilePath = 'helper.ps1'");
    expect(decoded).not.toContain("['ArgumentList']");
  });

  it("quotes spaced paths, empty arguments, embedded quotes, and trailing backslashes", () => {
    const decoded = createWindowsUpdateLauncherFile([
      "powershell.exe", "-File", "C:\\测试 User\\O'Brien\\helper.ps1", "", "C:\\ending slash\\", 'value"quoted'
    ]).toString("utf16le");

    expect(decoded).toContain(String.raw`$startArguments['ArgumentList'] = '"-File" "C:\测试 User\O''Brien\helper.ps1" "" "C:\ending slash\\" "value\"quoted"'`);
    expect(decoded).toContain("ErrorAction = 'Stop'");
    expect(decoded).toContain("Add-Content -LiteralPath ($launcherPath + '.log')");
    expect(decoded).toContain("[Console]::Error.WriteLine($message)");
    expect(decoded).toContain("$exitCode = 1");
  });

  it("rejects a missing helper executable", () => {
    expect(() => createWindowsUpdateLauncherFile([])).toThrow("requires an executable");
    expect(() => createWindowsUpdateLauncherFile([""])).toThrow("requires an executable");
  });

  it.runIf(process.platform === "win32")(
    "launches a PowerShell helper from a Chinese path through the launcher script",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-ps-launcher-"));
      const chineseRoot = join(root, "中文路径 O'Brien User");
      const helperPath = join(chineseRoot, "probe.ps1");
      const markerPath = join(chineseRoot, "marker.txt");
      const launcherPath = join(root, "launcher.ps1");
      try {
        await mkdir(chineseRoot, { recursive: true });
        await writeFile(
          helperPath,
          'param([string]$Marker)\n[System.IO.File]::WriteAllBytes($Marker, [System.Text.Encoding]::UTF8.GetBytes($PSCommandPath))\n',
          "utf8"
        );
        await writeFile(launcherPath, createWindowsUpdateLauncherFile([
          "powershell.exe",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-WindowStyle",
          "Hidden",
          "-File",
          helperPath,
          markerPath
        ]));

        const powerShellPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const result = spawnSync(powerShellPath, [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          launcherPath
        ], { encoding: "utf8" });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);

        let markerContent: string | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          markerContent = await readFile(markerPath, "utf8").catch(() => undefined);
          if (markerContent) break;
          await delay(50);
        }
        expect(markerContent).toBe(helperPath);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "preserves the child's received Windows arguments exactly",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-launcher-argv-"));
      const probeRoot = join(root, "中文路径 O'Brien User");
      const helperPath = join(probeRoot, "argument probe.cjs");
      const markerPath = join(probeRoot, "received arguments.json");
      const launcherPath = join(probeRoot, "launcher.ps1");
      const expected = ["spaced argument", "中文内容", "O'Brien", "", "C:\\trailing directory\\", 'embedded"quote', 'slash\\"quote'];
      try {
        await mkdir(probeRoot, { recursive: true });
        await writeFile(helperPath, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));\n', "utf8");
        await writeFile(launcherPath, createWindowsUpdateLauncherFile([process.execPath, helperPath, markerPath, ...expected]));
        const result = runLauncher(launcherPath);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        let received: string | undefined;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          received = await readFile(markerPath, "utf8").catch(() => undefined);
          if (received) break;
          await delay(50);
        }
        expect(JSON.parse(received ?? "null")).toEqual(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "returns failure and retains diagnostics when the helper cannot be started",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-launcher-failure-"));
      const launcherPath = join(root, "launcher.ps1");
      try {
        await writeFile(launcherPath, createWindowsUpdateLauncherFile([join(root, "missing helper.exe")]));
        const result = runLauncher(launcherPath);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Failed to start Memmy Windows update helper");
        expect(await readFile(`${launcherPath}.log`, "utf8")).toContain("Failed to start Memmy Windows update helper");
        await expect(readFile(launcherPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

describe("Windows update launcher acknowledgement", () => {
  function launcher() {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    return { child, result: waitForWindowsUpdateLauncher(child as unknown as ChildProcess) };
  }

  it("waits for a successful launcher exit and removes its event listeners", async () => {
    const { child, result } = launcher();
    const completed = vi.fn();
    void result.then(completed);
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    child.emit("close", 0, null);
    await expect(result).resolves.toBeUndefined();
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([[1, null], [null, "SIGTERM"]] as const)("rejects a failed launcher exit (%s, %s)", async (code, signal) => {
    const { child, result } = launcher();
    child.emit("close", code, signal);
    await expect(result).rejects.toThrow("Windows update launcher exited");
    expect(child.listenerCount("close")).toBe(0);
  });

  it("rejects a spawn error without waiting for the timeout", async () => {
    const { child, result } = launcher();
    const error = new Error("PowerShell executable is unavailable");
    child.emit("error", error);
    await expect(result).rejects.toBe(error);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("rejects a stalled launcher and terminates it at the deadline", async () => {
    vi.useFakeTimers();
    try {
      const { child, result } = launcher();
      const failure = expect(result).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.listenerCount("close")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function runLauncher(launcherPath: string) {
  const powerShellPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return spawnSync(powerShellPath, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath], { encoding: "utf8" });
}
