import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directory = resolve(process.argv[2]);
const target = process.argv[3];
const selection = process.argv[4] ?? "both";
if (!["both", "memory"].includes(selection)) throw new Error("Expected runtime selection: both or memory");
const hostTarget = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
if (target !== hostTarget) throw new Error(`Expected ${target}, running on ${hostTarget}`);
const agentVersion = JSON.parse(await readFile(join(repo, "App/memmy-agent/package.json"))).version;
const memoryVersion = JSON.parse(await readFile(join(repo, "Memory/package.json"))).version;
const root = await mkdtemp(join(tmpdir(), "runtime-artifact-check-"));
let service;
let serviceExit;
let logs = "";
try {
  const runtimes = [["memory", memoryVersion, "tar.gz"]];
  if (selection === "both") runtimes.unshift(["agent", agentVersion, "tgz"]);
  for (const [kind, version, extension] of runtimes) {
    await mkdir(join(root, kind));
    run("tar", ["-xzf", join(directory, `memmy-${kind}-runtime-${version}-${target}.${extension}`), "-C", join(root, kind)]);
  }
  const agentRoot = join(root, "agent/package");
  if (selection === "both") {
    const agent = JSON.parse(await readFile(join(agentRoot, "agent-runtime.json")));
    if (agent.target !== target || agent.version !== agentVersion || agent.nodeAbi !== process.versions.modules) {
      throw new Error("Agent runtime metadata does not match the runner");
    }
    if (run(process.execPath, [join(agentRoot, "dist/main.js"), "--version"]).trim() !== agentVersion) {
      throw new Error("Agent runtime version check failed");
    }
  }
  for (const packageRoot of selection === "memory" ? [join(root, "memory")] : [agentRoot, join(root, "memory")]) {
    const require = createRequire(join(packageRoot, "package.json"));
    const Database = require("better-sqlite3");
    const database = new Database(":memory:");
    if (packageRoot.endsWith("memory")) require("sqlite-vec").load(database);
    database.prepare("SELECT 1").get();
    database.close();
  }
  const socket = createServer();
  await new Promise((resolvePort, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", resolvePort); });
  const port = socket.address().port;
  await new Promise((done) => socket.close(done));
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify({ storage: { mode: "local", backend: "sqlite", sqlitePath: join(root, "memory.sqlite") }, agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false } }));
  service = spawn(process.execPath, [join(root, "memory/dist/src/server/index.js"), "--config", config, "--port", String(port)], {
    cwd: root, env: { ...process.env, MEMMY_MEMORY_HOME: join(root, "home"), MEMORY_SERVICE_HOME: join(root, "home") }, stdio: ["ignore", "pipe", "pipe"]
  });
  serviceExit = new Promise((done) => service.once("close", done));
  service.on("error", (error) => { logs += String(error); });
  for (const stream of [service.stdout, service.stderr]) stream.on("data", (chunk) => { logs = (logs + chunk).slice(-8000); });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (service.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { healthy = true; break; }
    } catch {}
    await delay(200);
  }
  if (!healthy) throw new Error(`Memory runtime failed health check: ${logs}`);
  console.log(`Verified ${selection === "both" ? `Agent ${agentVersion}, ` : ""}Memory ${memoryVersion}, target ${target}, Node ABI ${process.versions.modules}`);
} finally {
  if (service) {
    service.kill();
    await Promise.race([serviceExit, delay(3000)]);
    if (service.exitCode === null) { service.kill("SIGKILL"); await serviceExit; }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.stderr}`);
  return result.stdout;
}
