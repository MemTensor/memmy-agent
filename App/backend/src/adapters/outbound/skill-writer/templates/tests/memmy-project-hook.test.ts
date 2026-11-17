/**
 * 项目钩子：本机项目指令、协作项目段与项目知识库。脚本按真实安装的样子写进临时目录，
 * 用 node 子进程跑，与宿主的调用方式一致。
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadMemmyProjectHookRuntimeAsset } from "../../project-hook/runtime-loader.js";
import { renderMemmyProjectHookScript } from "../memmy-project-hook.js";

const LOCAL_INSTRUCTIONS = "本项目约定：提交信息用英文。";
const COLLAB_INSTRUCTIONS = "团队约定：先看 PRD，再改代码。";

let tempDir = "";
let runtimeAsset = "";

beforeAll(async () => {
  runtimeAsset = await loadMemmyProjectHookRuntimeAsset();
});

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("memmy project hook", () => {
  it("gives Claude Code the local and collab sections on session start and after compaction", async () => {
    const fixture = installFixture("claude-code");
    writeLocalInstructions(fixture, tempDir);
    writeCollabInstructions(fixture, tempDir, "claude_code");

    for (const event of ["SessionStart", "PostCompact"]) {
      const result = await runHook(fixture.script, {
        hook_event_name: event,
        session_id: "host-session",
        cwd: tempDir
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const context = responseContext(result.stdout);
      expect(context).toContain('<project_instructions source="memmy">');
      expect(context).toContain(LOCAL_INSTRUCTIONS);
      expect(context).toContain('<collab_project name="MemOS">');
      expect(context).toContain("当前工作目录属于 Memmy 协作项目「MemOS」，成员有孙起、孙落");
      expect(context).toContain("先用 memmy-project 在本项目的任务里查");
      expect(context).toContain(COLLAB_INSTRUCTIONS);
      // 本机约定在前，团队约定在其后。
      expect(context.indexOf(LOCAL_INSTRUCTIONS)).toBeLessThan(context.indexOf(COLLAB_INSTRUCTIONS));
    }
  }, 30000);

  it("tells the agent which collab project it is in even without background and guidelines", async () => {
    const fixture = installFixture("claude-code");
    writeFileSync(join(fixture.memmyHome, "collab-project-instructions.json"), JSON.stringify({
      version: 1,
      projects: {
        "p-2": {
          scopes: [{ sourceId: "claude_code", groupId: tempDir, roots: [tempDir] }],
          name: "演示",
          members: ["孙起"],
          text: "",
          updatedAt: "2026-11-13T02:00:00.000Z"
        }
      }
    }));

    const result = await runHook(fixture.script, { hook_event_name: "SessionStart", session_id: "host-session", cwd: tempDir });
    expect(result.status).toBe(0);
    const context = responseContext(result.stdout);
    expect(context).toContain('<collab_project name="演示">');
    expect(context).toContain("当前工作目录属于 Memmy 协作项目「演示」，成员有孙起");
    expect(context).not.toContain("所有者设定了以下背景与规范");
  }, 30000);

  it("gives Claude Code only this turn's project knowledge on prompt submit", async () => {
    const fixture = installFixture("claude-code");
    writeLocalInstructions(fixture, tempDir);
    writeCollabInstructions(fixture, tempDir, "claude_code");
    const server = await knowledgeServer();
    try {
      writeRuntimeJson(fixture, server.endpoint);
      const result = await runHook(fixture.script, {
        hook_event_name: "UserPromptSubmit",
        session_id: "host-session",
        prompt: "出差住宿标准是多少",
        cwd: tempDir
      });
      expect(result.stderr).toBe("");
      const context = responseContext(result.stdout);
      expect(context).toContain("memmy_knowledge_context");
      expect(context).toContain("住宿上限 500 元");
      // Claude Code 的会话开始上下文会持续整个会话，提交提示词时不再重复项目指令。
      expect(context).not.toContain("project_instructions");
      expect(server.requests).toEqual([{ query: "出差住宿标准是多少", workspace: tempDir }]);
    } finally {
      await server.close();
    }
  }, 30000);

  it("gives Codex the project sections on prompt submit as well as the knowledge", async () => {
    const fixture = installFixture("codex");
    writeLocalInstructions(fixture, tempDir);
    writeCollabInstructions(fixture, tempDir, "codex");
    const server = await knowledgeServer();
    try {
      writeRuntimeJson(fixture, server.endpoint);
      const result = await runHook(fixture.script, {
        hook_event_name: "UserPromptSubmit",
        session_id: "host-session",
        prompt: "出差住宿标准是多少",
        cwd: tempDir
      });
      expect(result.stderr).toBe("");
      const context = responseContext(result.stdout);
      expect(context).toContain('<project_instructions source="memmy">');
      expect(context).toContain(COLLAB_INSTRUCTIONS);
      expect(context).toContain("memmy_knowledge_context");
      expect(context.indexOf(COLLAB_INSTRUCTIONS)).toBeLessThan(context.indexOf("memmy_knowledge_context"));
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 30000);

  it("gives Cursor the project sections on session start and prompt submit, without knowledge", async () => {
    const fixture = installFixture("cursor");
    writeLocalInstructions(fixture, tempDir);
    writeCollabInstructions(fixture, tempDir, "cursor");
    const server = await knowledgeServer();
    try {
      writeRuntimeJson(fixture, server.endpoint);
      for (const event of ["sessionStart", "beforeSubmitPrompt"]) {
        const result = await runHook(fixture.script, {
          hook_event_name: event,
          conversation_id: "cursor-conversation",
          prompt: "出差住宿标准是多少",
          cwd: tempDir
        });
        expect(result.status).toBe(0);
        const payload = JSON.parse(result.stdout) as Record<string, unknown>;
        const context = String(payload.additional_context ?? "");
        expect(context).toContain(LOCAL_INSTRUCTIONS);
        expect(context).toContain(COLLAB_INSTRUCTIONS);
        expect(context).not.toContain("memmy_knowledge_context");
      }
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  }, 30000);

  it("leaves collab content out while collaboration is not authorized", async () => {
    const fixture = installFixture("codex");
    writeLocalInstructions(fixture, tempDir);
    writeCollabInstructions(fixture, tempDir, "codex");
    writeAccess(fixture, { granted: false, disabledAgents: [] });
    const server = await knowledgeServer();
    try {
      writeRuntimeJson(fixture, server.endpoint);
      const result = await runHook(fixture.script, {
        hook_event_name: "UserPromptSubmit",
        session_id: "host-session",
        prompt: "出差住宿标准是多少",
        cwd: tempDir
      });
      const context = responseContext(result.stdout);
      expect(context).toContain(LOCAL_INSTRUCTIONS);
      expect(context).not.toContain("<collab_project");
      expect(context).not.toContain("memmy_knowledge_context");
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  }, 30000);

  it("leaves collab content out for an agent turned off in the settings", async () => {
    const fixture = installFixture("codex");
    writeLocalInstructions(fixture, tempDir);
    writeCollabInstructions(fixture, tempDir, "codex");
    writeAccess(fixture, { granted: true, disabledAgents: ["codex"] });
    const server = await knowledgeServer();
    try {
      writeRuntimeJson(fixture, server.endpoint);
      const result = await runHook(fixture.script, {
        hook_event_name: "SessionStart",
        session_id: "host-session",
        cwd: tempDir
      });
      const context = responseContext(result.stdout);
      expect(context).toContain(LOCAL_INSTRUCTIONS);
      expect(context).not.toContain("<collab_project");
    } finally {
      await server.close();
    }
  }, 30000);

  it("leaves out instructions that only cover another agent's units", async () => {
    const fixture = installFixture("claude-code");
    writeCollabForOtherAgents(fixture);
    const result = await runHook(fixture.script, {
      hook_event_name: "SessionStart",
      session_id: "host-session",
      cwd: tempDir
    });
    const context = responseContext(result.stdout);
    expect(context).not.toContain("<collab_project");
    expect(context).not.toContain("只属于其他 Agent 的团队约定");
  }, 30000);

  it("leaves a session outside any project without project instructions", async () => {
    const fixture = installFixture("claude-code");
    writeFileSync(join(fixture.memmyHome, "project-instructions.json"), JSON.stringify({
      version: 1,
      projects: {
        [join(tempDir, "some-project")]: {
          text: "别的项目的指令",
          origin: "local",
          cloudProjectId: null,
          updatedAt: "2026-10-24T12:00:00.000Z"
        }
      }
    }));
    const result = await runHook(fixture.script, {
      hook_event_name: "SessionStart",
      session_id: "host-session",
      cwd: tempDir
    });
    expect(result.stdout).not.toContain("project_instructions");
    expect(result.stdout).not.toContain("别的项目的指令");
  }, 30000);

  it("skips inherited Cursor events in Claude Code mode", async () => {
    const fixture = installFixture("claude-code");
    writeLocalInstructions(fixture, tempDir);
    for (const event of ["SessionStart", "UserPromptSubmit", "PostCompact"]) {
      const result = await runHook(fixture.script, {
        hook_event_name: event,
        cursor_version: "3.17.19",
        session_id: "cursor-session",
        prompt: "Explain branch and worktree",
        cwd: tempDir
      });
      expect(result).toEqual({ status: 0, stdout: "", stderr: "" });
    }
  }, 30000);

  it("writes the host's empty success response when there is nothing to inject", async () => {
    const fixture = installFixture("codex");
    const result = await runHook(fixture.script, {
      hook_event_name: "SessionStart",
      session_id: "host-session",
      cwd: tempDir
    });
    expect(result).toMatchObject({ status: 0, stdout: JSON.stringify({ continue: true, suppressOutput: true }) });
  }, 30000);

  it("writes the empty success response when its own config is unreadable", async () => {
    const fixture = installFixture("cursor");
    rmSync(join(dirname(fixture.script), "memmy-project-config.json"), { force: true });
    const result = await runHook(fixture.script, {
      hook_event_name: "sessionStart",
      session_id: "host-session",
      cwd: tempDir
    });
    expect(result).toMatchObject({ status: 0, stdout: "{}" });
  }, 30000);
});

interface ProjectHookFixture {
  script: string;
  memmyHome: string;
}

function installFixture(mode: "claude-code" | "codex" | "cursor"): ProjectHookFixture {
  tempDir = mkdtempSync(join(tmpdir(), `memmy-project-hook-${mode}-`));
  const memmyHome = join(tempDir, "memmy");
  mkdirSync(memmyHome, { recursive: true });
  writeFileSync(join(memmyHome, "config.yaml"), "", "utf8");
  const script = join(tempDir, "memmy-project-hook.mjs");
  writeFileSync(script, renderMemmyProjectHookScript({ source: sourceFor(mode), mode }));
  writeFileSync(join(dirname(script), "memmy-project-runtime.mjs"), runtimeAsset);
  writeFileSync(join(dirname(script), "memmy-project-config.json"), JSON.stringify({
    memmy_config_path: join(memmyHome, "config.yaml")
  }));
  // 默认按「已授权协作、没有关掉的 Agent」起一份，授权与开关的差异放在各自用例里改。
  writeFileSync(join(memmyHome, "collab-agent-access.json"), JSON.stringify({
    granted: true,
    askedInProject: true,
    disabledAgents: []
  }));
  return { script, memmyHome };
}

function sourceFor(mode: "claude-code" | "codex" | "cursor"): string {
  return mode === "claude-code" ? "claude_code" : mode;
}

function writeLocalInstructions(fixture: ProjectHookFixture, directory: string): void {
  writeFileSync(join(fixture.memmyHome, "project-instructions.json"), JSON.stringify({
    version: 1,
    projects: {
      [directory]: {
        text: LOCAL_INSTRUCTIONS,
        origin: "local",
        cloudProjectId: null,
        updatedAt: "2026-10-24T12:00:00.000Z"
      }
    }
  }));
}

function writeCollabInstructions(fixture: ProjectHookFixture, directory: string, sourceId: string): void {
  writeFileSync(join(fixture.memmyHome, "collab-project-instructions.json"), JSON.stringify({
    version: 1,
    projects: {
      "p-1": {
        scopes: [{ sourceId, groupId: directory, roots: [directory] }],
        name: "MemOS",
        members: ["孙起", "孙落"],
        text: COLLAB_INSTRUCTIONS,
        updatedAt: "2026-10-28T12:00:00.000Z"
      }
    }
  }));
}

function writeCollabForOtherAgents(fixture: ProjectHookFixture): void {
  writeFileSync(join(fixture.memmyHome, "collab-project-instructions.json"), JSON.stringify({
    version: 1,
    projects: {
      "p-1": {
        scopes: [
          { sourceId: "cursor", groupId: join(tempDir, "MemOS.code-workspace"), roots: [tempDir] },
          { sourceId: "codex", groupId: "project-1", roots: [tempDir] }
        ],
        text: "只属于其他 Agent 的团队约定",
        updatedAt: "2026-10-28T12:00:00.000Z"
      }
    }
  }));
}

/** 授权文件与后端是同一份：配置目录下的 `collab-agent-access.json`。 */
function writeAccess(fixture: ProjectHookFixture, state: { granted: boolean; disabledAgents: string[] }): void {
  writeFileSync(join(fixture.memmyHome, "collab-agent-access.json"), JSON.stringify(state));
}

function writeRuntimeJson(fixture: ProjectHookFixture, endpoint: string): void {
  writeFileSync(join(fixture.memmyHome, "runtime.json"), JSON.stringify({ baseUrl: endpoint, localToken: "local-token" }));
}

async function knowledgeServer(): Promise<{
  endpoint: string;
  requests: Array<{ query: string; workspace: string }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ query: string; workspace: string }> = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await requestBody(request);
    if (request.url === "/api/knowledge/recall") {
      requests.push({ query: String(body.query ?? ""), workspace: String(body.workspace ?? "") });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        enabled: true,
        evidence: [{ id: "source-1", title: "差旅制度", content: "住宿上限 500 元" }]
      }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

function responseContext(stdout: string): string {
  const payload = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
    additional_context?: string;
  };
  return payload.hookSpecificOutput?.additionalContext ?? payload.additional_context ?? "";
}

async function runHook(scriptPath: string, payload: Record<string, unknown>): Promise<{
  status: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: { ...process.env, MEMMY_HOME: join(dirname(scriptPath), "memmy") }
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
