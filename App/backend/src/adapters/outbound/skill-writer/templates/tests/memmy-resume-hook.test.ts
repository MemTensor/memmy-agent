import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderMemmyResumeHookScript } from "../memmy-resume-hook.js";

describe("memmy resume hook stop capture", () => {
  let tempDir = "";

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
});
