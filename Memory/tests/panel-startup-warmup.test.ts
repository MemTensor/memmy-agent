import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { MemoryDb } from "../src/storage/db.js";

it("prepares device statistics after real service startup without any HTTP request or UID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "panel-service-warmup-"));
  const path = join(directory, "memory.sqlite"), config = join(directory, "config.json");
  const db = new MemoryDb({ path });
  db.db.prepare(`INSERT INTO memories(id,timeline,user_id,memory_value,memory_layer,status,info_json,created_at,updated_at)
    VALUES('startup','now','old-owner','content','L1','activated','{"source":"codex"}','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z')`).run();
  db.close();
  writeFileSync(config, JSON.stringify({ agents: { defaults: { timezone: "+08:00" } }, memmyMemory: {
    storage: { mode: "local", backend: "sqlite", sqlitePath: path },
    agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false },
    algorithm: { enableMemoryAdd: false }
  } }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(MEMMY_|MEMORY_)/.test(key)) delete env[key];
  env.MEMMY_ENABLE_MEMORY_ADD = "false";
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs",import.meta.url)), "--input-type=module", "--eval",
    `import { main } from ${JSON.stringify(new URL("../src/server/index.ts",import.meta.url).href)}; await main(${JSON.stringify(["--config",config,"--db",path,"--port","0"])});`], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout?.on("data", data => { output += String(data); });
  child.stderr?.on("data", data => { output += String(data); });
  const exited = new Promise<void>(done => child.once("exit", () => done()));
  let reader: MemoryDb | undefined;
  try {
    await expect.poll(() => {
      if (child.exitCode !== null) throw new Error(output);
      const state = join(directory, "memory-service/runtime.json");
      return existsSync(state) && JSON.parse(readFileSync(state, "utf8")).status;
    }, { timeout: 15_000 }).toBe("ready");
    reader = new MemoryDb({ path, readonly: true });
    await expect.poll(() => reader!.db.prepare("SELECT count(*) FROM panel_memory_facts").pluck().get(), { timeout: 15_000 }).toBe(1);
    expect(reader.db.prepare("SELECT count(*) FROM panel_memory_dirty").pluck().get()).toBe(0);
    expect(reader.db.prepare("SELECT user_id FROM memories WHERE id='startup'").pluck().get()).toBe("old-owner");
  } finally {
    reader?.close(); child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited; clearTimeout(force); rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);
