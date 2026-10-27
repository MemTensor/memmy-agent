import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
