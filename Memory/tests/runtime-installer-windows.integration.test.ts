import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { installMemoryRuntime, runtimeTarget } from "../src/cli/runtime-installer.js";

// Opt in on an interactive Windows desktop with permission to create a user task:
// MEMMY_WINDOWS_SERVICE_INTEGRATION=1 npm test -w @memmy/memory -- tests/runtime-installer-windows.integration.test.ts
// MainWindowHandle checks cannot replace a manual check for transient console flashes.
const enabled = process.platform === "win32" && process.env.MEMMY_WINDOWS_SERVICE_INTEGRATION === "1";

describe.skipIf(!enabled)("Windows scheduled Memory launcher integration", () => {
  it("remains supervised, ignores duplicate runs, and stops and starts its process tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "memmy-windows-task-test-"));
    const home = join(root, "memory home 测试");
    const runtimeDirectory = join(root, "runtime");
    const taskName = `Memmy Memory Integration ${randomUUID()}`;
    const startsPath = join(root, "starts.jsonl");
    const trackedPids = new Set<number>();
    let taskRegistered = false;
    const entrypoint = join(runtimeDirectory, "dist", "src", "server", "index.js");
    mkdirSync(join(runtimeDirectory, "dist", "src", "server"), { recursive: true });
    writeFileSync(join(runtimeDirectory, "memory-runtime.json"), JSON.stringify({
      version: "2.1.1", protocolVersion: 1, target: runtimeTarget(process.platform, process.arch),
    }));
    writeFileSync(entrypoint, [
      'const { appendFileSync } = require("node:fs");',
      `appendFileSync(${JSON.stringify(startsPath)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid, electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE }) + "\\n");`,
      'console.log("fixture stdout " + process.pid);',
      'console.error("fixture stderr " + process.pid);',
      "setInterval(() => {}, 1000);",
      // Bound an orphan's lifetime even if the test runner itself is interrupted.
      "setTimeout(() => process.exit(0), 120000).unref();",
    ].join("\n"));

    try {
      await installMemoryRuntime({
        home, runtimeDirectory, nodeExecutable: process.execPath,
        skipServiceRegistration: true, skipHealthCheck: true,
      });
      const launcher = join(home, "bin", "memmy-memory-service.js");
      expect(existsSync(launcher)).toBe(true);
      const xmlPath = join(root, "integration-task.xml");
      // Register only this unique test task. The product installer's registration
      // path deliberately stays disabled so an installed Memmy service is untouched.
      writeFileSync(xmlPath, `\uFEFF${taskXml(launcher)}`, "utf16le");
      windowsCommand("schtasks.exe", ["/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
      taskRegistered = true;
      windowsCommand("schtasks.exe", ["/Run", "/TN", taskName]);
      await waitUntil(() => readStarts(startsPath).length === 1, "first fixture startup");
      const first = readStarts(startsPath)[0]!;
      trackedPids.add(first.pid);
      trackedPids.add(first.parentPid);
      expect(first.electronRunAsNode).toBe("1");
      await waitUntil(() => taskState(taskName) === 4, "TASK_STATE_RUNNING");
      expect(mainWindowHandle(first.pid)).toBe("0");
      expect(mainWindowHandle(first.parentPid)).toBe("0");

      windowsCommand("schtasks.exe", ["/Run", "/TN", taskName]);
      // Observe a full second while the original fixture remains alive.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await delay(200);
        expect(readStarts(startsPath)).toHaveLength(1);
        expect(processAlive(first.pid)).toBe(true);
      }
      expect(taskState(taskName)).toBe(4);

      windowsCommand("schtasks.exe", ["/End", "/TN", taskName]);
      await waitUntil(() => !processAlive(first.pid) && !processAlive(first.parentPid), "stopped launcher descendants");
      await waitUntil(() => taskState(taskName) !== 4, "stopped task");

      windowsCommand("schtasks.exe", ["/Run", "/TN", taskName]);
      await waitUntil(() => readStarts(startsPath).length === 2, "second fixture startup");
      const second = readStarts(startsPath)[1]!;
      trackedPids.add(second.pid);
      trackedPids.add(second.parentPid);
      expect(processAlive(second.pid)).toBe(true);
      await waitUntil(() => taskState(taskName) === 4, "restarted task");
      const logs = join(home, "memory-service", "logs");
      await waitUntil(() => [first.pid, second.pid].every((pid) =>
        readText(join(logs, "service.log")).includes(`fixture stdout ${pid}`)
        && readText(join(logs, "service-error.log")).includes(`fixture stderr ${pid}`)), "appended stdout and stderr");
      windowsCommand("schtasks.exe", ["/End", "/TN", taskName]);
      await waitUntil(() => !processAlive(second.pid) && !processAlive(second.parentPid), "stopped restarted descendants");
    } finally {
      let cleanupError: unknown;
      if (taskRegistered) {
        windowsCommand("schtasks.exe", ["/End", "/TN", taskName], true);
        try {
          windowsCommand("schtasks.exe", ["/Delete", "/TN", taskName, "/F"]);
        } catch (error) { cleanupError = error; }
      }
      for (const start of readStarts(startsPath)) {
        trackedPids.add(start.pid);
        trackedPids.add(start.parentPid);
      }
      // If /End fails the assertion, clean up only recorded fixture processes
      // whose command lines still reference this unique temporary directory.
      for (const pid of trackedPids) {
        powershell(`$fixture = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($fixture -and $fixture.CommandLine -and $fixture.CommandLine.Contains(${psQuote(root)})) { Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue }`, true);
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      if (cleanupError) throw cleanupError;
    }
  }, 90_000);
});

interface FixtureStart { pid: number; parentPid: number; electronRunAsNode?: string; }

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readStarts(path: string): FixtureStart[] {
  // A writer may still be appending the last line while the test polls.
  return readText(path).split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as FixtureStart);
}

function windowsCommand(command: string, args: string[], allowFailure = false): string {
  if (!enabled) throw new Error("Windows service integration is not enabled");
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout || result.error?.message}`);
  }
  return result.stdout?.trim() ?? "";
}

function powershell(command: string, allowFailure = false): string {
  return windowsCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], allowFailure);
}

function taskState(taskName: string): number {
  return Number(powershell(`$scheduler = New-Object -ComObject Schedule.Service; $scheduler.Connect(); [int]$scheduler.GetFolder('\\').GetTask(${psQuote(taskName)}).State`));
}

function mainWindowHandle(pid: number): string {
  return powershell(`(Get-Process -Id ${pid} -ErrorAction Stop).MainWindowHandle.ToInt64()`);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function psQuote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function taskXml(launcher: string): string {
  const wscript = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
<Actions Context="Author"><Exec><Command>${xmlEscape(wscript)}</Command><Arguments>/B /Nologo /E:JScript ${xmlEscape(`"${launcher}"`)}</Arguments></Exec></Actions>
</Task>\n`;
}
