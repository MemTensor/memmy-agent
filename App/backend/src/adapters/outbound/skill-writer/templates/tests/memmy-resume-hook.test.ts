import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadMemmyWorkspaceBridgeRuntimeAsset } from "../../workspace-bridge/runtime-loader.js";
import { renderMemmyResumeHookScript } from "../memmy-resume-hook.js";

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
): string {
  const hookScriptPath = join(directory, "memmy-resume-hook.mjs");
  writeFileSync(hookScriptPath, renderMemmyResumeHookScript({ source, mode }));
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
