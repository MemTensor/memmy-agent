import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { spawnNodeService, stopManagedChild, terminateManagedChildrenForDesktopExit } from "../src/main/runtime-services.js";

describe("forced Desktop process cleanup", () => {
  // taskkill /T owns descendant cleanup on Windows. A normal POSIX Agent is not
  // detached; this bare fixture has none of the Agent's graceful child cleanup.
  it.runIf(process.platform === "win32").each([false, true])("terminates the real Agent tree and honors stopMemory=%s", async stopMemory => {
    const root = await mkdtemp(join(tmpdir(), "memmy-force-exit-"));
    const entry = join(root, "fixture.cjs");
    await writeFile(entry, `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      if (process.argv[2] === 'gateway') {
        const recorder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        writeFileSync(process.argv[3], String(recorder.pid));
      } else writeFileSync(process.argv[3], 'memory-ready');
      setInterval(() => {}, 1000);
    `);
    const memoryReady = join(root, "memory.ready");
    const gatewayReady = join(root, "gateway.ready");
    const memory = spawnNodeService("memory", entry, ["memory", memoryReady], {}, {
      logFilePath: join(root, "memory.log"), logLevel: "info", persistOnDesktopExit: true
    });
    const gateway = spawnNodeService("agent-gateway", entry, ["gateway", gatewayReady], {}, {
      logFilePath: join(root, "gateway.log"), logLevel: "info"
    });
    let recorderPid: number | undefined;
    try {
      await vi.waitFor(async () => {
        expect(await readFile(memoryReady, "utf8")).toBe("memory-ready");
        recorderPid = Number(await readFile(gatewayReady, "utf8"));
        expect(recorderPid).toBeGreaterThan(0);
      }, { timeout: 3_000 });
      expect(recorderPid).toBeGreaterThan(0);
      expect(() => process.kill(recorderPid!, 0)).not.toThrow();
      terminateManagedChildrenForDesktopExit([gateway, memory], stopMemory);
      await vi.waitFor(() => {
        expect(() => process.kill(gateway.process.pid!, 0)).toThrow();
        expect(() => process.kill(recorderPid!, 0)).toThrow();
        if (stopMemory) expect(() => process.kill(memory.process.pid!, 0)).toThrow();
        else expect(() => process.kill(memory.process.pid!, 0)).not.toThrow();
      }, { timeout: 3_000 });
    } finally {
      await stopManagedChild(memory);
      await stopManagedChild(gateway);
      if (recorderPid) { try { process.kill(recorderPid, "SIGKILL"); } catch { /* already gone */ } }
      memory.logWriter?.close(); gateway.logWriter?.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("shares the remaining Windows taskkill budget and falls back without spawning after exhaustion", async () => {
    const source = ts.createSourceFile("runtime-services.ts", await readFile(new URL("../src/main/runtime-services.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const names = new Set(["terminateManagedChildrenSync", "terminateManagedChildrenForDesktopExit", "terminateProcessTreeSync"]);
    const code = ts.transpileModule(source.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name?.text ?? ""))
      .map(s => s.getText(source).replace(/^export /, "")).join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    let now = 1_000;
    const taskkill = vi.fn(() => { now = 3_000; throw new Error("fixture timeout"); });
    const children = [11, 12].map(pid => ({ process: { pid, exitCode: null, signalCode: null, kill: vi.fn() } }));
    const context = createContext({ Date: { now: () => now }, process: { platform: "win32" }, execFileSync: taskkill, children });
    runInContext(code + "\nterminateManagedChildrenForDesktopExit(children, false, 3000);", context);
    expect(taskkill).toHaveBeenCalledExactlyOnceWith("taskkill", ["/F", "/T", "/PID", "11"], {
      stdio: "ignore", timeout: 2_000, killSignal: "SIGKILL", windowsHide: true
    });
    children.forEach(child => expect(child.process.kill).toHaveBeenCalledWith("SIGKILL"));
  });
});
