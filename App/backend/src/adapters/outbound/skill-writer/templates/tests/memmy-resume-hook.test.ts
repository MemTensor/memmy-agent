import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "../../workspace-bridge/runtime-loader.js";
import { renderMemmyResumeHookScript } from "../memmy-resume-hook.js";
import { renderMemmyResumeHookScript as renderCliHook } from "../../../../../../../../Memory/src/agent-source/integration/templates/memmy-resume-hook.js";

describe("memmy resume hook stop capture", () => {
  let tempDir = "";
  let runtimeAsset = "";

  beforeAll(async () => {
    runtimeAsset = await loadMemmyWorkspaceBridgeRuntimeAsset();
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it.each([
    ["desktop", renderMemmyResumeHookScript],
    ["memory CLI", renderCliHook],
  ])("%s Claude hook ignores inherited Cursor events without requests or state writes", async (_label, render) => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-inherited-cursor-hook-"));
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ sessionId: "unexpected-session" }));
    });
    await listen(server);
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const script = installHookFixture(tempDir, "claude_code", "claude-code", endpoint, runtimeAsset, render);
      const filesBefore = readDirectory(tempDir).sort();
      // Cursor can pass through its own event names or map them to Claude names.
      for (const event of ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop", "preCompact", "sessionEnd",
        "SessionStart", "UserPromptSubmit", "Stop", "PostCompact", "SessionEnd"]) {
        const result = await runHook(script, {
          hook_event_name: event, cursor_version: "3.17.19", session_id: "cursor-session",
          conversation_id: "cursor-session", generation_id: "cursor-turn",
          prompt: "Explain branch and worktree", text: "A worktree is a separate checkout",
          last_assistant_message: "A worktree is a separate checkout", cwd: tempDir,
        });
        expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
      }
      expect(paths).toEqual([]);
      expect(readDirectory(tempDir).sort()).toEqual(filesBefore);
    } finally {
      await close(server);
    }
  }, 30000);

  it.each([
    ["desktop", renderMemmyResumeHookScript],
    ["memory CLI", renderCliHook],
  ])("%s captures a Cursor turn once when both hooks run, and still captures native Claude turns", async (_label, render) => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-dual-cursor-hook-"));
    const requests: Array<{ path: string; body: Record<string, any> }> = [];
    const server = createServer(async (request, response) => {
      const body = await requestBody(request);
      requests.push({ path: request.url ?? "", body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/health") {
        response.end(JSON.stringify({ features: { l3WorldModelProtocolVersions: [2] } }));
      } else if (request.url === "/api/v1/sessions/open") {
        response.end(JSON.stringify({ sessionId: `session-${(body.namespace as { source: string }).source}` }));
      } else if (request.url === "/api/v1/turns/start") {
        response.end(JSON.stringify({ sessionId: body.sessionId, turnId: body.turnId, episodeId: `episode-${body.sessionId}` }));
      } else {
        response.end(JSON.stringify({ ok: true }));
      }
    });
    await listen(server);
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const scripts = ["cursor", "claude"].map(name => {
        const directory = join(tempDir, name);
        mkdirSync(directory);
        return installHookFixture(directory, name === "cursor" ? "cursor" : "claude_code",
          name === "cursor" ? "cursor" : "claude-code", endpoint, runtimeAsset, render);
      });
      const payload = {
        cursor_version: "3.17.19", session_id: "cursor-conversation", conversation_id: "cursor-conversation",
        generation_id: "cursor-turn", prompt: "Explain branch and worktree", cwd: tempDir,
      };
      for (const event of ["beforeSubmitPrompt", "afterAgentResponse", "stop"]) {
        for (const script of scripts) {
          const result = await runHook(script, { ...payload, hook_event_name: event,
            text: "A worktree is a separate checkout", last_assistant_message: "A worktree is a separate checkout" });
          expect(result.status).toBe(0);
          expect(result.stderr).toBe("");
        }
      }
      const completions = () => requests.filter(request => request.path.endsWith("/complete"));
      expect(completions()).toHaveLength(1);
      expect(completions()[0]?.body).toMatchObject({
        namespace: { source: "cursor" }, query: payload.prompt, answer: "A worktree is a separate checkout",
      });
      expect(requests.filter(request => request.path === "/api/v1/turns/start")).toHaveLength(1);
      expect(requests.some(request => request.body.namespace?.source === "claude_code")).toBe(false);

      // Host detection uses event provenance, not inherited terminal environment.
      for (const event of ["UserPromptSubmit", "Stop"]) {
        const result = await runHook(scripts[1]!, {
          hook_event_name: event, session_id: "native-claude-session", turn_id: "claude-turn",
          prompt: "Explain native Claude capture", last_assistant_message: "Captured by Claude only", cwd: tempDir,
        });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe("");
      }
      expect(completions()).toHaveLength(2);
      expect(completions()[1]?.body).toMatchObject({
        namespace: { source: "claude_code" }, query: "Explain native Claude capture", answer: "Captured by Claude only",
      });
    } finally {
      await close(server);
    }
  }, 30000);

  it("captures the user prompt instead of the last tool result when turn state is missing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-resume-hook-stop-"));
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      requests.push({ path: request.url ?? "", body: body ? JSON.parse(body) : {} });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/sessions/open") {
        response.end(JSON.stringify({ sessionId: "server-session", status: "open" }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const hookScriptPath = join(tempDir, "memmy-resume-hook.mjs");
      writeFileSync(hookScriptPath, renderMemmyResumeHookScript({ source: "claude_code", mode: "claude-code" }));
      writeFileSync(join(tempDir, "memmy-workspace-bridge.mjs"), runtimeAsset);
      writeFileSync(join(tempDir, "memmy-memory-config.json"), JSON.stringify({
        memmy_config_path: join(tempDir, "missing-config.yaml"),
        endpoint: `http://127.0.0.1:${port}`,
        token: ""
      }));

      const toolResultText = "src/auth/login.ts\n42: if (password == storedHash) { grantSession(user); }";
      const transcriptPath = join(tempDir, "transcript.jsonl");
      writeFileSync(transcriptPath, [
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "please fix the login bug in auth" }] } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
          { type: "text", text: "Let me look at the code first." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/auth/login.ts" } }
        ] } }),
        JSON.stringify({ type: "user", message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: toolResultText }] }
        ] } }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixed: login.ts now compares hashes." }] } })
      ].join("\n") + "\n");

      const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
        const child = spawn(process.execPath, [hookScriptPath], {
          env: { ...process.env, MEMMY_CONFIG: join(tempDir, "missing-config.yaml") }
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (status) => resolve({ status, stderr }));
        child.stdin.end(JSON.stringify({
          hook_event_name: "Stop",
          session_id: "stop-capture-session",
          transcript_path: transcriptPath,
          stop_hook_active: false
        }));
      });

      expect(result.status).toBe(0);
      const complete = requests.find((request) => request.path.includes("/complete"));
      expect(complete?.body?.query).toBe("please fix the login bug in auth");
      expect(complete?.body?.answer).toBe("Fixed: login.ts now compares hashes.");
    } finally {
      server.close();
    }
  }, 30000);

  it.each([
    ["codex", "codex" as const],
    ["claude_code", "claude-code" as const],
    ["cursor", "cursor" as const],
  ])("opens %s SessionStart with the pinned v2 identity and injects one L3 snapshot", async (source, mode) => {
    tempDir = mkdtempSync(join(tmpdir(), `memmy-${source}-l3-start-`));
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const body = await requestBody(request);
      requests.push({ method: request.method ?? "", path: request.url ?? "", body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/health") {
        response.end(JSON.stringify({
          features: { l3WorldModelProtocolVersions: [2], workspaceBridgeProtocolVersions: ["1"] },
        }));
        return;
      }
      if (request.url === "/api/v1/sessions/open") {
        response.end(JSON.stringify({ sessionId: "memory-session", projectId: `ws_${"b".repeat(64)}` }));
        return;
      }
      if (request.url?.startsWith("/api/v1/l3-world-model/sessions/memory-session/context?")) {
        response.end(JSON.stringify({
          sessionId: "memory-session",
          projectId: `ws_${"b".repeat(64)}`,
          memoryId: "l3-1",
          memoryVersion: 7,
          renderedContext: "Keep the package boundary stable.",
          sourceMemoryIds: ["l1-1"],
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await listen(server);
    try {
      const port = (server.address() as { port: number }).port;
      const hookScriptPath = installHookFixture(tempDir, source, mode, `http://127.0.0.1:${port}`, runtimeAsset);
      const result = await runHook(hookScriptPath, {
        hook_event_name: "SessionStart",
        session_id: "host-session",
        source: "startup",
        cwd: tempDir,
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as Record<string, any>;
      const context = mode === "cursor"
        ? output.additional_context
        : output.hookSpecificOutput?.additionalContext;
      expect(context).toContain('<memmy_l3_world_model version="2">');
      expect(context).toContain("Keep the package boundary stable.");
      const opened = requests.find((item) => item.path === "/api/v1/sessions/open")?.body as Record<string, any>;
      expect(opened).toMatchObject({
        l3WorldModelProtocolVersion: 2,
        l3WorldModelTransition: "allow_legacy_rollover",
        workspaceHostId: "a".repeat(64),
        namespace: {
          source,
          userId: "installed-owner",
          sessionKey: `${source}-memory-host-session`,
        },
      });
      expect(opened).not.toHaveProperty("sessionId");
      expect(requests.filter((item) => item.path.includes("/context?"))).toHaveLength(1);
      expect(requests.some((item) => item.path.includes("environment-sync"))).toBe(false);
    } finally {
      await close(server);
    }
  }, 30000);

  it("sends a resume-only boundary on PostCompact without loading L3 or writing boundary state", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-codex-l3-compact-"));
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const body = await requestBody(request);
      requests.push({ method: request.method ?? "", path: request.url ?? "", body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/v1/health") {
        response.end(JSON.stringify({ features: { l3WorldModelProtocolVersions: [2] } }));
        return;
      }
      if (request.url === "/api/v1/sessions/open") {
        response.end(JSON.stringify({ sessionId: "memory-session", projectId: `ws_${"b".repeat(64)}` }));
        return;
      }
      if (request.url?.startsWith("/api/v1/sessions/memory-session/l3-world-model-trace-head?")) {
        response.end(JSON.stringify({ throughL1MemoryId: "l1-last", traceSeq: 9 }));
        return;
      }
      if (request.url === "/api/v1/sessions/memory-session/l3-world-model-boundary") {
        response.end(JSON.stringify({ batches: [] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await listen(server);
    try {
      const port = (server.address() as { port: number }).port;
      const hookScriptPath = installHookFixture(tempDir, "codex", "codex", `http://127.0.0.1:${port}`, runtimeAsset);
      const result = await runHook(hookScriptPath, {
        hook_event_name: "PostCompact",
        session_id: "host-session",
        cwd: tempDir,
      });

      expect(result.status).toBe(0);
      const opened = requests.find((item) => item.path === "/api/v1/sessions/open")?.body;
      expect(opened).toMatchObject({ l3WorldModelTransition: "resume_only" });
      const boundary = requests.find((item) => item.path.endsWith("/l3-world-model-boundary"))?.body;
      expect(boundary).toMatchObject({ trigger: "token_compaction", throughL1MemoryId: "l1-last" });
      expect(requests.some((item) => item.path.includes("/context"))).toBe(false);
      expect(requests.some((item) => item.path.includes("environment-sync"))).toBe(false);
      expect(readDirectory(tempDir).some((name) => /boundary|cursor.*\.json/iu.test(name))).toBe(false);
    } finally {
      await close(server);
    }
  }, 30000);

  it("returns the host's empty success response when short-hook health cannot be parsed", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-cursor-health-failure-"));
    const paths: string[] = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      paths.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end("not-json");
    });
    await listen(server);
    try {
      const port = (server.address() as { port: number }).port;
      const hookScriptPath = installHookFixture(tempDir, "cursor", "cursor", `http://127.0.0.1:${port}`, runtimeAsset);
      const result = await runHook(hookScriptPath, {
        hook_event_name: "sessionStart",
        session_id: "host-session",
        cwd: tempDir,
      });

      expect(result).toMatchObject({ status: 0, stdout: "{}" });
      expect(paths).toEqual(["/api/v1/health"]);
    } finally {
      await close(server);
    }
  }, 30000);
});

function installHookFixture(
  directory: string,
  source: string,
  mode: "claude-code" | "codex" | "cursor",
  endpoint: string,
  runtimeAsset: string,
  render = renderMemmyResumeHookScript,
): string {
  const hookScriptPath = join(directory, "memmy-resume-hook.mjs");
  writeFileSync(hookScriptPath, render({ source, mode }));
  writeFileSync(join(directory, "memmy-workspace-bridge.mjs"), runtimeAsset);
  writeFileSync(join(directory, "memmy-memory-config.json"), JSON.stringify({
    memmy_config_path: join(directory, "missing-config.yaml"),
    endpoint,
    token: "",
    userId: "installed-owner",
    workspaceHostId: "a".repeat(64),
  }));
  return hookScriptPath;
}

async function runHook(scriptPath: string, payload: Record<string, unknown>): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, MEMMY_CONFIG: join(dirname(scriptPath), "missing-config.yaml") },
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.method === "GET") return {};
  let value = "";
  for await (const chunk of request) value += chunk;
  return value ? JSON.parse(value) as Record<string, unknown> : {};
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function readDirectory(directory: string): string[] {
  return readdirSync(directory);
}
