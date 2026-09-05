import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { expect, it, vi } from "vitest";
import {
  ensureMemoryService,
  stopManagedChild,
  stopManagedChildrenForDesktopExit,
  type ManagedChild,
  type PackagedRuntimeConfig,
} from "../src/main/runtime-services.js";

it("restarts persistent Memory repeatedly after Desktop exits and reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "memmy-desktop-memory-restart-"));
  const configPath = join(root, "config.yaml");
  const databasePath = join(root, "memory.sqlite");
  const runtimePath = join(root, "memory-service", "runtime.json");
  const entry = join(root, "memory.mjs");
  const tsxApi = import.meta.resolve("tsx/esm/api");
  const serverEntry = new URL("../../../../Memory/src/server/index.ts", import.meta.url).href;
  await writeFile(entry, [
    `import { register } from ${JSON.stringify(tsxApi)};`,
    "register();",
    `const { main } = await import(${JSON.stringify(serverEntry)});`,
    "await main();",
  ].join("\n"));
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, "127.0.0.1", done));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  const port = address.port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = {
    memmyMemory: {
      storage: { mode: "local", backend: "sqlite", sqlitePath: databasePath, endpoint: baseUrl },
      agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false },
    },
  };
  await writeFile(configPath, YAML.stringify(config));
  const runtimeConfig: PackagedRuntimeConfig = {
    configPath,
    agentWorkspace: join(root, "workspace"),
    memoryDatabasePath: databasePath,
    memoryBaseUrl: baseUrl,
    memoryToken: "",
    memoryListenHost: "127.0.0.1",
    memoryListenPort: port,
    agentGatewayBaseUrl: "http://127.0.0.1:18980",
    agentGatewayHealthHost: "127.0.0.1",
    agentGatewayHealthPort: 18970,
    agentGatewayBootstrapSecret: "test-secret",
  };
  const entries = { memoryEntry: entry, agentEntry: join(root, "unused-agent.js") };
  const options = {
    appPath: root,
    appDatabaseFile: join(root, "app.sqlite"),
    resourcesPath: root,
    logDirectory: root,
    logLevel: "info" as const,
    runtimeExecutable: process.execPath,
  };
  const firstDesktopChildren: ManagedChild[] = [];
  const reopenedDesktopChildren: ManagedChild[] = [];
  const restartFromDesktop = vi.fn();

  try {
    await ensureMemoryService(entries, runtimeConfig, firstDesktopChildren, options, true, restartFromDesktop);
    const memory = firstDesktopChildren[0]!;
    expect(memory.process.connected).toBe(true);
    await waitFor(async () => existsSync(runtimePath));
    let previous = JSON.parse(await readFile(runtimePath, "utf8")) as { pid: number; startedAt: string };

    await stopManagedChildrenForDesktopExit(firstDesktopChildren, false);
    // An exiting Desktop closes its IPC pipe while the detached Memory stays alive.
    await new Promise<void>((done) => {
      memory.process.once("disconnect", done);
      memory.process.disconnect();
    });
    expect(memory.process.exitCode).toBeNull();
    expect((await fetch(`${baseUrl}/api/v1/health`)).ok).toBe(true);

    await ensureMemoryService(entries, runtimeConfig, reopenedDesktopChildren, options, true, vi.fn());
    expect(reopenedDesktopChildren).toEqual([]);

    for (const timeZone of ["+00:00", "+08:00", "-04:00"]) {
      await writeFile(configPath, YAML.stringify({
        ...config,
        agents: { defaults: { timezone: timeZone } },
      }));
      const response = await fetch(`${baseUrl}/api/v1/system/restart`, {
        method: "POST",
        headers: { "x-memmy-viewer": "1", "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(202);
      await response.json();
      await waitFor(async () => {
        const current = JSON.parse(await readFile(runtimePath, "utf8")) as typeof previous;
        if (current.startedAt === previous.startedAt) return false;
        const health = await fetch(`${baseUrl}/api/v1/health`);
        if (!health.ok) return false;
        const currentConfig = await fetch(`${baseUrl}/api/v1/config`, { headers: { "x-memmy-viewer": "1" } });
        const body = await currentConfig.json() as { config: { timeZone?: string } };
        expect(body.config.timeZone).toBe(timeZone);
        expect(current.pid).toBe(previous.pid);
        previous = current;
        return true;
      });
      expect(JSON.parse(await readFile(`${databasePath}.server.lock`, "utf8"))).toMatchObject({ pid: memory.process.pid });
    }
    expect(restartFromDesktop).not.toHaveBeenCalled();
    const exited = new Promise<void>((done) => memory.process.once("exit", () => done()));
    const shutdown = await fetch(`${baseUrl}/api/v1/admin/shutdown`, {
      method: "POST",
    });
    expect(shutdown.ok).toBe(true);
    await exited;
    expect(existsSync(`${databasePath}.server.lock`)).toBe(false);
    expect(existsSync(join(root, "memory-service", "service.lock"))).toBe(false);
    expect(existsSync(runtimePath)).toBe(false);
    expect(await readFile(join(root, "memory.log"), "utf8")).not.toMatch(/MaxListenersExceededWarning|service\.restart\.failed|database connection is not open/);
  } finally {
    await Promise.all(firstDesktopChildren.map(stopManagedChild));
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      // Runtime state and the HTTP endpoint are replaced during restart.
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 25));
  }
  throw new Error("Memory did not finish restarting after Desktop reopened", { cause: lastError });
}
