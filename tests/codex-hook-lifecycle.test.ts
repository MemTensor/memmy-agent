import { appendFileSync } from "node:fs";
import { createSkillDistributionService } from "../App/backend/src/services/skill-distribution-service.js";
import { createSkillTargetRegistry as backendRegistry } from "../App/backend/src/adapters/outbound/skill-writer/target-registry.js";
import { createAgentSourceExecutor } from "../Memory/src/agent-source/runtime.js";
import { createSourceRegistry } from "../Memory/src/agent-source/adapters/source-registry.js";
import { createSkillTargetRegistry as memoryRegistry } from "../Memory/src/agent-source/integration/target-registry.js";
import type { MemoryService } from "../Memory/src/service/memory-service.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexSkillTarget as memoryTarget } from "../Memory/src/agent-source/integration/codex/target.js";
import { createCodexSkillTarget as backendTarget } from "../App/backend/src/adapters/outbound/skill-writer/codex/target.js";
import { trustMemmyCodexHooks as memoryTrust } from "../Memory/src/agent-source/integration/codex/hook-trust.js";
import { trustMemmyCodexHooks as backendTrust } from "../App/backend/src/adapters/outbound/skill-writer/codex/hook-trust.js";

vi.mock("../Memory/src/cli/analytics.js", () => ({ getOrCreateInstallationId: () => "codex-hook-fixture" }));
vi.mock("../App/backend/src/analytics/analytics-transport.js", () => ({ getOrCreateInstallationId: () => "codex-hook-fixture" }));
const directories: string[] = [];
const fixtureProcess = fileURLToPath(new URL("./fixtures/codex-hook-process.cjs", import.meta.url));
const events = ["SessionStart", "UserPromptSubmit", "Stop", "PostCompact", "SessionEnd"];
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const rootDirectory = mkdtempSync(join(tmpdir(), "memmy codex hook "));
  directories.push(rootDirectory);
  return { rootDirectory, memmyConfigPath: join(rootDirectory, "memmy.yaml") };
}
function newProcess(home: string, payload: Record<string, unknown>): Promise<{ executed: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixtureProcess, "dispatch", JSON.stringify(payload)], {
      env: { ...process.env, CODEX_HOME: home }, stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    child.on("error", reject);
    child.on("close", code => code === 0 && !stderr ? resolve(JSON.parse(stdout)) : reject(new Error(`${code}: ${stderr}`)));
  });
}

describe.each([
  { name: "Memory", createTarget: memoryTarget, trust: memoryTrust },
  { name: "Backend", createTarget: backendTarget, trust: backendTrust }
])("$name Codex installation lifecycle", ({ createTarget, trust }) => {
  it("trusts a canonical hooks path returned for a linked CODEX_HOME", async () => {
    const f = fixture();
    const physical = join(f.rootDirectory, "physical"); mkdirSync(physical);
    const alias = join(f.rootDirectory, "linked home"); symlinkSync(physical, alias, "junction");
    const target = createTarget({ ...f, rootDirectory: alias, trustHooks: options => trust({ ...options, codexExecutable: process.execPath, appServerArguments: [fixtureProcess, "canonical-path"] }) });
    await target.installPlugin!("codex");
    expect(await target.isInstalled("codex")).toBe(true);
    await target.uninstallPlugin!("codex");
  });
  it("rolls back hooks if bootstrap installation fails", async () => {
    const f = fixture();
    mkdirSync(join(f.rootDirectory, "AGENTS.md"));
    const target = createTarget({ ...f, trustHooks: async () => {} });
    await expect(target.installPlugin!("codex")).rejects.toThrow();
    expect(existsSync(join(f.rootDirectory, "hooks.json"))).toBe(false);
    expect(existsSync(join(f.rootDirectory, "hooks", "memmy-resume-hook.mjs"))).toBe(false);
  });
  it("restores previous skills and instructions when trust fails after replacing them", async () => {
    const f = fixture();
    const original = createTarget({ ...f, trustHooks: async () => {} });
    await original.installPlugin!("codex");
    const previousInstructions = readFileSync(join(f.rootDirectory, "AGENTS.md"), "utf8");
    const skill = join(f.rootDirectory, "skills", "memmy-memory", "SKILL.md");
    writeFileSync(skill, "previous skill");
    const updating = createTarget({ ...f, trustHooks: async () => { throw new Error("trust failed"); } });
    await expect(updating.installPlugin!("codex")).rejects.toThrow("trust failed");
    expect(readFileSync(skill, "utf8")).toBe("previous skill");
    expect(readFileSync(join(f.rootDirectory, "AGENTS.md"), "utf8")).toBe(previousInstructions);
  });
  it("updates and removes Windows CRLF instruction markers without duplication", async () => {
    const f = fixture();
    const target = createTarget({ ...f, trustHooks: async () => {} });
    const instructions = join(f.rootDirectory, "AGENTS.md");
    writeFileSync(instructions, "Keep my instructions\r\n");
    await target.installPlugin!("codex");
    writeFileSync(instructions, readFileSync(instructions, "utf8").replace(/\r?\n/g, "\r\n"));
    await target.installPlugin!("codex");
    expect(readFileSync(instructions, "utf8").match(/memmy:start/g)).toHaveLength(1);
    writeFileSync(instructions, readFileSync(instructions, "utf8").replace(/\r?\n/g, "\r\n"));
    await target.uninstallPlugin!("codex");
    expect(readFileSync(instructions, "utf8")).toBe("Keep my instructions\r\n");
  });
  it("restores a preexisting non-directory skill path when trust fails", async () => {
    const f = fixture();
    const skills = join(f.rootDirectory, "skills"); mkdirSync(skills);
    const skillPath = join(skills, "memmy-memory"); writeFileSync(skillPath, "previous file");
    const target = createTarget({ ...f, trustHooks: async () => { throw new Error("trust failed"); } });
    await expect(target.installPlugin!("codex")).rejects.toThrow("trust failed");
    expect(readFileSync(skillPath, "utf8")).toBe("previous file");
  });
  it.each([false, true])("serializes removal after an in-flight installation (trust failure: %s)", async (fail) => {
    const f = fixture();
    const original = createTarget({ ...f, trustHooks: async () => {} });
    await original.installPlugin!("codex");
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const updating = createTarget({ ...f, trustHooks: async () => { entered(); await gate; if (fail) throw new Error("trust failed"); } });
    const install = updating.installPlugin!("codex");
    const observedInstall = install.catch(error => error);
    await started;
    const removing = original.uninstallPlugin!("codex");
    // Give an uncoordinated removal time to finish before trust completes.
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    await observedInstall; await removing;
    expect(await original.isInstalled("codex")).toBe(false);
    expect(existsSync(join(f.rootDirectory, "hooks", "memmy-resume-hook.mjs"))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.rootDirectory, "hooks.json"), "utf8")).hooks).toBeUndefined();
  });
  it("fails executable preflight before writing any hook or skill file", async () => {
    const f = fixture();
    vi.stubEnv("MEMMY_CODEX_EXECUTABLE", join(f.rootDirectory, "missing-codex"));
    const target = createTarget(f);
    await expect(target.installPlugin!("codex")).rejects.toThrow("configured Codex executable is unavailable");
    expect(readdirSync(f.rootDirectory)).toEqual([]);
  });
  it("restores the previous installation after a real child process rejects trust", async () => {
    const f = fixture();
    const hooksPath = join(f.rootDirectory, "hooks.json");
    const previous = '{"hooks":{"Stop":[]},"custom":"keep"}\n';
    writeFileSync(hooksPath, previous);
    const target = createTarget({ ...f, trustHooks: options => trust({ ...options, codexExecutable: process.execPath, appServerArguments: [fixtureProcess, "fail-write"] }) });
    await expect(target.installPlugin!("codex")).rejects.toThrow("fixture trust write failed");
    expect(readFileSync(hooksPath, "utf8")).toBe(previous);
    expect(readdirSync(join(f.rootDirectory, "hooks"))).toEqual([]);
    expect(existsSync(join(f.rootDirectory, "AGENTS.md"))).toBe(false);
  });
  it("captures installed hooks once, then new processes run no Memmy hooks after uninstall", async () => {
    const f = fixture();
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (req, res) => {
      let text = ""; for await (const chunk of req) text += chunk;
      requests.push({ path: req.url!, body: text ? JSON.parse(text) : {} });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/health") res.end(JSON.stringify({ features: {} }));
      else if (req.url === "/api/v1/sessions/open") res.end(JSON.stringify({ sessionId: "runtime-fixture" }));
      else if (req.url === "/api/v1/turns/start") res.end(JSON.stringify({ turnId: "turn-1", episodeId: "episode-1" }));
      else res.end(JSON.stringify({ status: "stored", result: { rawTurnId: "raw-1" } }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      writeFileSync(f.memmyConfigPath, `app:\n  userId: fixture-owner\nmemmyMemory:\n  endpoint: ${endpoint}\n`);
      const unrelated = { PreToolUse: [{ hooks: [{ type: "command", command: "echo unrelated", timeout: 10 }] }] };
      writeFileSync(join(f.rootDirectory, "hooks.json"), JSON.stringify({ hooks: unrelated }));
      const target = createTarget({ ...f, trustHooks: options => trust({ ...options, codexExecutable: process.execPath, appServerArguments: [fixtureProcess] }) });
      const transcript = join(f.rootDirectory, "transcript.jsonl");
      const records = [
        { type: "session_meta", payload: { id: "session-1", cwd: f.rootDirectory } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
        { type: "response_item", payload: { type: "message", role: "user", content: [{ text: "Fix parser" }] } },
        { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "Parser fixed" }] } },
        { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } }
      ];
      writeFileSync(transcript, records.map(record => JSON.stringify({ timestamp: "2026-10-27T00:00:00Z", ...record })).join("\n") + "\n");
      await target.installPlugin!("codex");
      await target.installPlugin!("codex");
      const payload = { session_id: "session-1", turn_id: "turn-1", transcript_path: transcript, prompt: "Fix parser", cwd: f.rootDirectory };
      for (const event of events) {
        expect(await newProcess(f.rootDirectory, { ...payload, hook_event_name: event })).toEqual({ executed: 1 });
      }
      const captures = requests.filter(request => request.path === "/api/v1/source-turns/complete");
      expect(captures).toHaveLength(1);
      expect(captures[0]!.body).toMatchObject({ adapterId: "memmy-codex-hook", namespace: { source: "codex", userId: "fixture-owner" } });
      expect(JSON.stringify(captures[0]!.body)).toContain("Parser fixed");
      // Removal must still work when the executable is gone or its override is invalid.
      vi.stubEnv("MEMMY_CODEX_EXECUTABLE", join(f.rootDirectory, "removed-codex"));
      await target.uninstallPlugin!("codex");
      await target.uninstallPlugin!("codex");
      expect(JSON.parse(readFileSync(join(f.rootDirectory, "hooks.json"), "utf8"))).toEqual({ hooks: unrelated });
      expect(existsSync(join(f.rootDirectory, "hooks", "memmy-resume-hook.mjs"))).toBe(false);
      expect(existsSync(join(f.rootDirectory, "hooks", "memmy-memory-config.json"))).toBe(false);
      expect(existsSync(join(f.rootDirectory, "skills", "memmy-memory"))).toBe(false);
      expect(existsSync(join(f.rootDirectory, "skills", "memmy-resume"))).toBe(false);
      expect(readFileSync(join(f.rootDirectory, "AGENTS.md"), "utf8")).not.toContain("memmy:start");
      const count = requests.length;
      const filesAfterUninstall = readdirSync(join(f.rootDirectory, "hooks")).sort();
      for (const event of events) {
        expect(await newProcess(f.rootDirectory, { ...payload, session_id: "new-session", hook_event_name: event })).toEqual({ executed: 0 });
      }
      expect(requests).toHaveLength(count);
      expect(readdirSync(join(f.rootDirectory, "hooks")).sort()).toEqual(filesAfterUninstall);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }, 30000);
});

// Exercise the real callers: a plugin uninstall must not enqueue a second skill removal.
describe.each([
  { name: "Memory", createTarget: memoryTarget },
  { name: "Backend", createTarget: backendTarget }
])("$name review regressions", ({ name, createTarget }) => {
  it.each(["failure", "timeout"])("preserves instructions saved while waiting for trust (%s)", async reason => {
    const f = fixture();
    const instructions = join(f.rootDirectory, "AGENTS.md");
    writeFileSync(instructions, "Personal instructions\n");
    const target = createTarget({ ...f, trustHooks: async () => {
      appendFileSync(instructions, "New personal instructions\n");
      throw new Error(reason);
    } });
    await expect(target.installPlugin!("codex")).rejects.toThrow(reason);
    expect(readFileSync(instructions, "utf8")).toBe("Personal instructions\nNew personal instructions\n");
    expect(await createTarget(f).isInstalled("codex")).toBe(false);
  });
  it.each(["file", "directory", "link"])("preserves later edits/additions to skills (%s)", async kind => {
    const f = fixture();
    const skill = join(f.rootDirectory, "skills", "memmy-memory");
    const target = createTarget({ ...f, trustHooks: async () => {
      if (kind === "link") {
        const external = join(f.rootDirectory, "external"); mkdirSync(external);
        rmSync(skill, { recursive: true }); symlinkSync(external, skill, "junction");
      }
      writeFileSync(join(skill, kind === "file" ? "SKILL.md" : "user.txt"), "new user file");
      throw new Error("trust failed");
    } });
    await expect(target.installPlugin!("codex")).rejects.toThrow("preserved conflicting user edits");
    expect(readFileSync(join(skill, kind === "file" ? "SKILL.md" : "user.txt"), "utf8")).toBe("new user file");
    expect(existsSync(join(f.rootDirectory, "hooks", "memmy-resume-hook.mjs"))).toBe(false);
  });
  it("keeps SessionEnd at 3 seconds across refresh while preserving other events", async () => {
    const f = fixture();
    const target = createTarget({ ...f, trustHooks: async () => {} });
    await target.installPlugin!("codex");
    await target.installPlugin!("codex");
    const hooks = JSON.parse(readFileSync(join(f.rootDirectory, "hooks.json"), "utf8")).hooks;
    for (const event of events) expect(hooks[event][0].hooks[0].timeout).toBe(event === "SessionEnd" ? 3 : 60);
  });
  it.each([false, true])("serializes update, complete uninstall and reinstall through the actual caller (failure: %s)", async fail => {
    const f = fixture();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    let updates = 0;
    const target = createTarget({ ...f, trustHooks: async () => {
      if (++updates === 2) { entered(); await gate; if (fail) throw new Error("trust failed"); }
    } });
    const service = createSkillDistributionService({ targetRegistry: backendRegistry([target]) });
    const executor = createAgentSourceExecutor({
      service: {} as MemoryService, configPath: f.memmyConfigPath, statePath: join(f.rootDirectory, "state.json"),
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "codex", displayName: "Codex", builtin: true, dataPath: f.rootDirectory },
        detect: async () => true, async *scan() {}
      }]), integrationRegistry: memoryRegistry([target])
    });
    const install = () => name === "Backend" ? service.installPlugin("codex") : executor.mutateConnection("codex", "plugin", "POST");
    const remove = () => name === "Backend" ? service.uninstallPlugin("codex") : executor.mutateConnection("codex", "plugin", "DELETE");
    try {
      await install();
      const update = install().catch(error => error);
      await started;
      const removing = remove();
      // Let async registry/state work reach the per-home queue before requesting reinstall.
      await new Promise(r => setTimeout(r, 30));
      const reinstalling = install();
      release();
      await update; await removing; await reinstalling;
      expect(await createTarget(f).isInstalled("codex")).toBe(true);
      const hooks = JSON.parse(readFileSync(join(f.rootDirectory, "hooks.json"), "utf8")).hooks;
      for (const event of events) expect(hooks[event]).toHaveLength(1);
      for (const skill of ["memmy-memory", "memmy-resume"]) expect(existsSync(join(f.rootDirectory, "skills", skill, "SKILL.md"))).toBe(true);
      if (name === "Memory") {
        const state = JSON.parse(readFileSync(join(f.rootDirectory, "state.json"), "utf8")).sources.codex;
        expect(state.status).not.toBe("not_connected");
        expect(state.autoInjectSuppressed).toBeUndefined();
        expect((await executor.list()).sources[0]!.status).not.toBe("not_connected");
      }
      await remove();
      expect(await createTarget(f).isInstalled("codex")).toBe(false);
      for (const event of events) expect(await newProcess(f.rootDirectory, { hook_event_name: event })).toEqual({ executed: 0 });
    } finally { release(); await executor.dispose(); }
  });
});

describe.each(["Backend", "Memory"])("%s cross-process installation lock", integration => {
  it("waits for the other process rollback before uninstall; reopening never resurrects hooks", async () => {
    const f = fixture();
    const script = fileURLToPath(new URL("./fixtures/codex-installation-process.mjs", import.meta.url));
    const loader = fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url));
    const run = (side: string, action: string) => {
      const child = spawn(process.execPath, ["--import", loader, script, f.rootDirectory, side, action], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = ""; child.stderr.on("data", data => { stderr += data; });
      const done = new Promise<void>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr)));
      });
      return { child, done };
    };
    const install = run(integration, "install");
    let removal: ReturnType<typeof run> | undefined;
    try {
      await vi.waitFor(() => expect(existsSync(join(f.rootDirectory, "entered"))).toBe(true));
      appendFileSync(join(f.rootDirectory, "AGENTS.md"), "Cross-process personal edit\n");
      removal = run(integration === "Memory" ? "Backend" : "Memory", "remove");
      await new Promise(r => setTimeout(r, 250));
      // The second process cannot remove files while the first awaits trust.
      expect(existsSync(join(f.rootDirectory, "hooks", "memmy-resume-hook.mjs"))).toBe(true);
      writeFileSync(join(f.rootDirectory, "release"), "");
      await install.done; await removal.done;
      expect(await memoryTarget(f).isInstalled("codex")).toBe(false);
      expect(readFileSync(join(f.rootDirectory, "AGENTS.md"), "utf8")).toContain("Cross-process personal edit");
      for (const skill of ["memmy-memory", "memmy-resume"]) expect(existsSync(join(f.rootDirectory, "skills", skill))).toBe(false);
      for (const event of events) expect(await newProcess(f.rootDirectory, { hook_event_name: event })).toEqual({ executed: 0 });
    } finally {
      writeFileSync(join(f.rootDirectory, "release"), "");
      await install.done;
      await removal?.done;
    }
  }, 15000);
});
