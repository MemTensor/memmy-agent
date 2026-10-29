import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSourceTurnRequest, readCodexSourceTurn } from "@memmy/agent-source-core";
import { renderMemmyResumeHookScript } from "../src/agent-source/integration/templates/memmy-resume-hook.js";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "../src/agent-source/integration/workspace-bridge/runtime-loader.js";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const createdAt = "2026-09-09T10:00:00.000Z";
const expectedNamespace = { source: "codex", profileId: "default", userId: "fixture-owner", sessionKey: "native-session" };
function record(type: string, payload: unknown) { return JSON.stringify({ type, timestamp: createdAt, payload }); }
function transcript(complete = true) {
  return [record("session_meta", { id: "native-session", cwd: "/project" }), record("event_msg", { type: "task_started", turn_id: "native-turn" }),
    record("response_item", { type: "message", role: "user", content: [{ text: "Fix the parser" }] }),
    record("response_item", { type: "custom_tool_call", call_id: "a", name: "read", input: { path: "parser.ts" } }),
    record("response_item", { type: "custom_tool_call_output", call_id: "a", output: "source contents" }),
    record("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ text: "Fixed the parser" }] }),
    ...(complete ? [record("event_msg", { type: "task_complete", turn_id: "native-turn" })] : [])].join("\n") + "\n";
}
async function fixture(responseStatus = "stored") {
  const dir = mkdtempSync(join(tmpdir(), "memmy-native-hook-")); directories.push(dir);
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let data = ""; for await (const chunk of req) data += chunk;
    requests.push({ path: req.url ?? "", body: data ? JSON.parse(data) : {} });
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/health") res.end(JSON.stringify({ features: {} }));
    else if (req.url === "/api/v1/sessions/open") res.end(JSON.stringify({ sessionId: "runtime-session" }));
    else if (req.url === "/api/v1/turns/start") res.end(JSON.stringify({ turnId: "native-turn", episodeId: "episode-1" }));
    else res.end(JSON.stringify({ status: responseStatus, reason: responseStatus === "pending" ? "episode_closed" : undefined, result: { rawTurnId: "raw-1" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  writeFileSync(join(dir, "memmy-resume-hook.mjs"), renderMemmyResumeHookScript({ source: "codex", mode: "codex" }));
  writeFileSync(join(dir, "memmy-workspace-bridge.mjs"), await loadMemmyWorkspaceBridgeRuntimeAsset());
  writeFileSync(join(dir, "memmy-memory-config.json"), JSON.stringify({ endpoint, userId: "fixture-owner", memmy_config_path: join(dir, "missing.yaml") }));
  const path = join(dir, "transcript.jsonl"); writeFileSync(path, transcript());
  return { dir, path, requests, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
async function run(dir: string, path: string, extra: Record<string, unknown> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(dir, "memmy-resume-hook.mjs")]);
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", status => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop", session_id: "native-session", turn_id: "native-turn", transcript_path: path, ...extra }));
  });
}

describe("installed Codex Hook native capture", () => {
  it("submits exactly the scanner canonical content without pending state or opening a runtime Session", async () => {
    const f = await fixture();
    try {
      const result = await run(f.dir, f.path);
      expect(result.status).toBe(0); expect(result.stderr).toBe("");
      expect(f.requests).toHaveLength(1);
      const turn = (await readCodexSourceTurn(f.path)).turn!;
      expect(f.requests[0]).toEqual({ path: "/api/v1/source-turns/complete", body: { ...buildSourceTurnRequest(turn, "hook"), namespace: expectedNamespace, adapterId: "memmy-codex-hook" } });
      expect(f.requests[0]?.body.toolCalls).toEqual([{ id: "a", name: "read", input: { path: "parser.ts" }, output: "source contents" }]);
    } finally { await f.close(); }
  });

  it("does not post incomplete source content and logs a reason that scanning can later recover", async () => {
    const f = await fixture();
    try {
      writeFileSync(f.path, transcript(false).replace('"final_answer"', '"commentary"'));
      expect((await run(f.dir, f.path)).stderr).toContain("turn_incomplete");
      expect(f.requests).toHaveLength(0);
      writeFileSync(f.path, transcript());
      expect((await run(f.dir, f.path)).stderr).toBe("");
      expect(f.requests).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("captures Stop before task_complete using the same final-answer fields as the subsequent scan", async () => {
    const f = await fixture();
    try {
      writeFileSync(f.path, transcript(false));
      const hookResult = await run(f.dir, f.path);
      expect(hookResult.stderr).toBe("");
      expect(f.requests).toHaveLength(1);
      expect((await readCodexSourceTurn(f.path)).turn).toBeNull();
      const completedRecords = transcript().trim().split("\n").map(line => JSON.parse(line));
      completedRecords[completedRecords.length - 1].timestamp = "2026-09-09T10:00:02.000Z";
      writeFileSync(f.path, completedRecords.map(record => JSON.stringify(record)).join("\n") + "\n");
      const scanned = (await readCodexSourceTurn(f.path)).turn!;
      expect(scanned.completionEvidence).toBe("final_answer:native-turn");
      expect(scanned.completedAt).toBe(createdAt);
      expect(f.requests[0]?.body).toEqual({ ...buildSourceTurnRequest(scanned, "hook"), namespace: expectedNamespace, adapterId: "memmy-codex-hook" });
    } finally { await f.close(); }
  });

  it("requires the native turn ID when Stop arrives before task_complete", async () => {
    const f = await fixture();
    try {
      writeFileSync(f.path, transcript(false));
      expect((await run(f.dir, f.path, { turn_id: undefined })).stderr).toContain("turn_incomplete");
      expect(f.requests).toHaveLength(0);
    } finally { await f.close(); }
  });

  it("preserves start state on pending completion and leaves a recoverable capture reason", async () => {
    const f = await fixture("pending");
    try {
      await run(f.dir, f.path, { hook_event_name: "UserPromptSubmit", prompt: "Fix the parser" });
      const stateFiles = readdirSync(f.dir).filter(name => name.startsWith("memmy-turn-state-"));
      expect(stateFiles).toHaveLength(1);
      writeFileSync(join(f.dir, "missing.yaml"), [
        "app:", "  userId: switched-app-owner", "memmyMemory:", "  userId: switched-memory-owner", "",
      ].join("\n"));
      const result = await run(f.dir, f.path);
      expect(result.stderr).toContain("episode_closed");
      expect(readdirSync(f.dir)).toContain(stateFiles[0]);
      expect(f.requests.at(-1)?.body.sessionId).toBe("runtime-session");
      expect(f.requests.at(-1)?.body.namespace).toEqual(expectedNamespace);
    } finally { await f.close(); }
  });
  it.each(["cancelled", "failed"])("does not turn an explicit %s Stop into a succeeded L1", async (status) => {
    const f = await fixture();
    try {
      writeFileSync(f.path, transcript(false));
      await run(f.dir, f.path, { status });
      expect(f.requests).toHaveLength(0);
    } finally { await f.close(); }
  });

});
