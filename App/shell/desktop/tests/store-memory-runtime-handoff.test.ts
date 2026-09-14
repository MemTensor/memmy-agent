import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureMemoryService, stopManagedChildrenForDesktopExit, type ManagedChild, type PackagedRuntimeConfig } from "../src/main/runtime-services.js";

const oldContent = "a".repeat(64);
const newContent = "b".repeat(64);
const fixture = resolve(import.meta.dirname, "fixtures/store-memory-runtime.cjs");

describe.runIf(process.platform === "win32")("Store Memory runtime handoff", () => {
  it.each([
    { name: "changed content at the same version", store: true, replace: true },
    { name: "legacy runtime without content identity", store: true, installedContent: null, replace: true },
    { name: "identical content ignoring hash case", store: true, bundledContent: oldContent.toUpperCase(), replace: false },
    { name: "invalid bundled content identity", store: true, bundledContent: "not-a-sha256", replace: false },
    { name: "a newer installed Memory", store: true, installedVersion: "2.1.3", replace: false },
    { name: "non-Store Windows", store: false, replace: false },
    { name: "non-Windows runtime", store: true, platform: "linux" as const, replace: false },
    { name: "another executable's standalone runtime", store: true, foreignExecutable: true, replace: false },
    { name: "a mismatched runtime PID", store: true, foreignPid: true, replace: false },
    { name: "a mismatched runtime entry", store: true, foreignEntry: true, replace: false }
  ])("handles $name without changing unrelated services", async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "memmy-store-memory-handoff-"));
    const home = join(root, "home");
    const serviceHome = join(home, "memory-service");
    const runtimeDir = join(serviceHome, "runtime", "fixture");
    const entrypoint = join(runtimeDir, "dist/src/server/index.js");
    const bundled = join(root, "bundled");
    let previous: ChildProcess | undefined;
    const children: ManagedChild[] = [];
    try {
      await mkdir(dirname(entrypoint), { recursive: true });
      await copyFile(fixture, entrypoint);
      const installed = { version: scenario.installedVersion ?? "2.1.2", protocolVersion: 1, contentId: scenario.installedContent === null ? undefined : oldContent };
      await writeFile(join(runtimeDir, "memory-runtime.json"), JSON.stringify(installed));
      await writeFile(join(serviceHome, "current.json"), JSON.stringify({
        version: installed.version, protocolVersion: 1, runtimeDir,
        entrypoint: scenario.foreignEntry ? join(runtimeDir, "dist/src/server/other.js") : entrypoint,
        runtimeExecutable: scenario.foreignExecutable ? join(root, "standalone-node.exe") : process.execPath
      }));
      for (const relative of ["dist/src/cli/index.js", "dist/src/server/index.js"]) {
        await mkdir(dirname(join(bundled, relative)), { recursive: true });
        await copyFile(fixture, join(bundled, relative));
      }
      await writeFile(join(bundled, "memory-runtime.json"), JSON.stringify({
        version: "2.1.2", protocolVersion: 1, contentId: scenario.bundledContent ?? newContent
      }));
      const configPath = join(home, "config.yaml");
      const memoryDatabasePath = join(home, "memory.sqlite");
      previous = spawn(process.execPath, [entrypoint, "--config", configPath, "--db", memoryDatabasePath, "--port", "0"], {
        windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"]
      });
      const [message] = await once(previous, "message", { signal: AbortSignal.timeout(5_000) });
      const port = (message as { port: number }).port;
      if (scenario.foreignPid) {
        const runningPath = join(serviceHome, "runtime.json");
        const running = JSON.parse(await readFile(runningPath, "utf8"));
        await writeFile(runningPath, JSON.stringify({ ...running, pid: process.pid }));
      }
      const config: PackagedRuntimeConfig = {
        configPath, memoryDatabasePath, memoryBaseUrl: `http://127.0.0.1:${port}`, memoryToken: "fixture-token",
        memoryListenHost: "127.0.0.1", memoryListenPort: port, agentWorkspace: join(home, "workspace"),
        agentGatewayBaseUrl: "http://127.0.0.1:18980", agentGatewayHealthHost: "127.0.0.1",
        agentGatewayHealthPort: 18970, agentGatewayBootstrapSecret: "fixture"
      };
      const options = {
        appPath: root, appDatabaseFile: join(home, "app.sqlite"), resourcesPath: root, logDirectory: root,
        logLevel: "info" as const, runtimeExecutable: process.execPath, offlineMemoryRuntimeDirectory: bundled,
        isWindowsStore: scenario.store, platform: scenario.platform ?? "win32" as const
      };
      const entries = { memoryEntry: entrypoint, agentEntry: "unused" };
      await ensureMemoryService(entries, config, children, options);
      expect(children).toHaveLength(scenario.replace ? 1 : 0);
      if (scenario.replace) {
        expect(previous.exitCode).toBe(0);
        expect(await readFile(join(serviceHome, "shutdown-requested"), "utf8")).toBe("yes");
        const response = await fetch(`${config.memoryBaseUrl}/api/v1/health`, { headers: { authorization: "Bearer fixture-token" } });
        expect(await response.json()).toMatchObject({ serviceVersion: "2.1.2", contentId: newContent });
        const replacementPid = children[0]!.process.pid;
        await ensureMemoryService(entries, config, children, options);
        expect(children).toHaveLength(1);
        expect(children[0]!.process.pid).toBe(replacementPid);
        expect(children[0]!.process.exitCode).toBeNull();
      } else {
        expect(previous.exitCode).toBeNull();
        await expect(readFile(join(serviceHome, "shutdown-requested"))).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await stopManagedChildrenForDesktopExit(children, true);
      if (previous && previous.exitCode === null && previous.signalCode === null) {
        const exited = once(previous, "exit");
        previous.kill();
        await exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("enables reconciliation only for a packaged Store startup", async () => {
    const main = await readFile(resolve(import.meta.dirname, "../src/main/main.ts"), "utf8");
    expect(main.includes("isWindowsStore: app.isPackaged && isWindowsStoreApp()")).toBe(true);
  });
});
