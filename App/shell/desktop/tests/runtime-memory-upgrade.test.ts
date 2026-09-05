import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureMemoryService,
  spawnNodeService,
  stopManagedChild,
  type ManagedChild,
  type PackagedRuntimeConfig,
} from "../src/main/runtime-services.js";

const roots: string[] = [];
const processes: ManagedChild[] = [];

afterEach(async () => {
  await Promise.all(processes.splice(0).map((child) => stopManagedChild(child)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(options: {
  version?: string;
  delay?: number;
  independent?: boolean;
  identity?: boolean;
  shutdownDelay?: number;
  wrongConfig?: boolean;
  stopFails?: boolean;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "memmy-runtime-upgrade-"));
  roots.push(root);
  const home = join(root, "home");
  const bundled = join(root, "bundled");
  const serviceHome = join(home, "memory-service");
  const runtimeDir = join(serviceHome, "runtime", "2.1.0", "fixture");
  const entry = join(runtimeDir, "dist", "src", "server", "index.js");
  const cli = join(bundled, "dist", "src", "cli", "index.js");
  await mkdir(dirname(entry), { recursive: true });
  await mkdir(dirname(cli), { recursive: true });
  const reservation = createServer();
  await new Promise<void>((resolveListen) => reservation.listen(0, "127.0.0.1", resolveListen));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("expected TCP address");
  const port = address.port;
  await new Promise<void>((resolveClose) => reservation.close(() => resolveClose()));
  const config: PackagedRuntimeConfig = {
    configPath: join(home, "config.yaml"), agentWorkspace: join(home, "workspace"),
    memoryDatabasePath: join(home, "memory.sqlite"), memoryBaseUrl: `http://127.0.0.1:${port}`,
    memoryToken: "", memoryListenHost: "127.0.0.1", memoryListenPort: port,
    agentGatewayBaseUrl: "http://127.0.0.1:18980", agentGatewayHealthHost: "127.0.0.1",
    agentGatewayHealthPort: 18970, agentGatewayBootstrapSecret: "fixture",
  };
  const source = [
    "const fs = require('node:fs'); const path = require('node:path'); const http = require('node:http');",
    "const args = process.argv.slice(2); const arg = key => args[args.indexOf(key) + 1];",
    "const db = arg('--db'); const config = arg('--config'); const port = Number(arg('--port'));",
    "const serviceHome = path.join(path.dirname(config), 'memory-service');",
    "const lock = db + '.server.lock'; const version = process.env.FIXTURE_VERSION || '2.1.1';",
    "fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, sqlitePath: db, host: '127.0.0.1', port }));",
    "const server = http.createServer((request, response) => {",
    "  if (request.url === '/api/v1/health') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: process.env.FIXTURE_IDENTITY !== 'false', protocolVersion: 1, serviceVersion: version })); return; }",
    "  if (request.url === '/api/v1/admin/shutdown') { response.end('{}'); setImmediate(shutdown); return; }",
    "  response.writeHead(404); response.end();",
    "});",
    "function shutdown() { server.close(() => { setTimeout(() => { fs.rmSync(lock, { force: true }); fs.rmSync(path.join(serviceHome, 'runtime.json'), { force: true }); process.exit(0); }, Number(process.env.FIXTURE_SHUTDOWN_DELAY || 0)); }); server.closeAllConnections(); }",
    "process.on('SIGTERM', shutdown);",
    "setTimeout(() => server.listen(port, '127.0.0.1', () => {",
    "  fs.writeFileSync(path.join(serviceHome, 'runtime.json'), JSON.stringify({ pid: process.pid, endpoint: 'http://127.0.0.1:' + port, configPath: process.env.FIXTURE_WRONG_CONFIG === 'true' ? config + '.other' : config, sqlitePath: db, serviceVersion: version, protocolVersion: 1 }));",
    "}), Number(process.env.FIXTURE_DELAY || 0));",
  ].join("\n");
  await writeFile(entry, source);
  await writeFile(join(bundled, "server.cjs"), source);
  await writeFile(join(bundled, "memory-runtime.json"), JSON.stringify({ version: "2.1.1", protocolVersion: 1 }));
  await writeFile(join(serviceHome, "current.json"), JSON.stringify({
    version: options.version ?? "2.1.0", protocolVersion: 1, runtimeDir, entrypoint: entry,
    runtimeExecutable: options.independent ? join(root, "independent-node") : process.execPath,
  }));
  await writeFile(cli, [
    "const fs = require('node:fs'); const path = require('node:path');",
    "const args = process.argv.slice(2); const arg = key => args[args.indexOf(key) + 1];",
    `if (args[0] === 'stop') process.exit(${options.stopFails ? 17 : 0});`,
    "if (args[0] !== 'install' || !args.includes('--skip-service-registration')) process.exit(17);",
    "const home = arg('--home'); const bundled = arg('--runtime-directory');",
    "if (fs.existsSync(arg('--db') + '.server.lock')) { console.error('install raced existing database owner'); process.exit(18); }",
    "const runtimeDir = path.join(home, 'memory-service', 'runtime', '2.1.1', 'fixture');",
    "const entrypoint = path.join(runtimeDir, 'dist', 'src', 'server', 'index.js');",
    "fs.mkdirSync(path.dirname(entrypoint), { recursive: true }); fs.copyFileSync(path.join(bundled, 'server.cjs'), entrypoint);",
    "fs.writeFileSync(path.join(home, 'memory-service', 'current.json'), JSON.stringify({ version: '2.1.1', protocolVersion: 1, runtimeDir, entrypoint, runtimeExecutable: process.execPath }));",
  ].join("\n"));
  const old = spawnNodeService("memory", entry, ["--config", config.configPath, "--db", config.memoryDatabasePath, "--port", String(port)], {
    FIXTURE_VERSION: options.version ?? "2.1.0", FIXTURE_DELAY: String(options.delay ?? 0),
    FIXTURE_IDENTITY: String(options.identity ?? true),
    FIXTURE_SHUTDOWN_DELAY: String(options.shutdownDelay ?? 0), FIXTURE_WRONG_CONFIG: String(options.wrongConfig ?? false),
  }, { executablePath: process.execPath, logFilePath: join(root, "old.log"), logLevel: "info" });
  processes.push(old);
  const waitUntil = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await check()) return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    throw new Error("fixture did not become ready");
  };
  await waitUntil(async () => readFile(config.memoryDatabasePath + ".server.lock").then(() => true, () => false));
  if (!options.delay) await waitUntil(async () => fetch(config.memoryBaseUrl + "/api/v1/health").then(() => true, () => false));
  const children: ManagedChild[] = [];
  return {
    old, config, children,
    async ensure() {
      try {
        await ensureMemoryService({ memoryEntry: entry, agentEntry: join(root, "unused.js") }, config, children, {
          appPath: root, appDatabaseFile: join(home, "app.sqlite"), resourcesPath: root,
          logDirectory: root, logLevel: "info", runtimeExecutable: process.execPath, offlineMemoryRuntimeDirectory: bundled,
        });
      } finally {
        processes.push(...children);
      }
    },
    async version() {
      return (await (await fetch(config.memoryBaseUrl + "/api/v1/health")).json() as { serviceVersion: string }).serviceVersion;
    },
  };
}

describe("bundled Memory upgrades", () => {
  it("replaces a healthy older Desktop runtime before reusing its endpoint", async () => {
    const running = await fixture();
    await running.ensure();
    expect(await running.version()).toBe("2.1.1");
    expect(running.children).toHaveLength(1);
    expect(running.children[0]?.process.pid).not.toBe(running.old.process.pid);
  });

  it("waits for an older migrating runtime before upgrading and releasing its database lock", async () => {
    const running = await fixture({ delay: 400 });
    await running.ensure();
    expect(await running.version()).toBe("2.1.1");
  });

  it("waits for storage cleanup after HTTP closes before activating the new runtime", async () => {
    const running = await fixture({ shutdownDelay: 150 });
    await running.ensure();
    expect(await running.version()).toBe("2.1.1");
    expect(running.old.process.exitCode).toBe(0);
  });

  it("upgrades through graceful HTTP shutdown when legacy service-manager stop fails", async () => {
    const running = await fixture({ stopFails: true });
    await running.ensure();
    expect(await running.version()).toBe("2.1.1");
    expect(running.old.process.exitCode).toBe(0);
  });

  it.each(["2.1.1", "2.2.0", "unknown"])("reuses a compatible %s runtime", async (version) => {
    const running = await fixture({ version });
    await running.ensure();
    expect(await running.version()).toBe(version);
    expect(running.children).toHaveLength(0);
    expect(running.old.process.exitCode).toBeNull();
  });

  it("leaves a separately installed Memory runtime under its owner's control", async () => {
    const running = await fixture({ independent: true });
    await running.ensure();
    expect(await running.version()).toBe("2.1.0");
    expect(running.children).toHaveLength(0);
    expect(running.old.process.exitCode).toBeNull();
  });

  it("rejects an endpoint without Memory identity without stopping it", async () => {
    const running = await fixture({ identity: false });
    await expect(running.ensure()).rejects.toThrow("unexpected service");
    expect(running.old.process.exitCode).toBeNull();
  });

  it("does not upgrade an endpoint whose running state names another configuration", async () => {
    const running = await fixture({ wrongConfig: true });
    await running.ensure();
    expect(await running.version()).toBe("2.1.0");
    expect(running.children).toHaveLength(0);
    expect(running.old.process.exitCode).toBeNull();
  });
});
