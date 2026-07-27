/** Target tests. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeCodeSkillTarget } from "../index.js";
import type { SkillManifest } from "../../types.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("claude code skill target", () => {
  it("installs Memmy bootstrap into CLAUDE.md and full content into the Skill directory", async () => {
    const { rootDirectory, manifest } = createFixture();
    const target = createClaudeCodeSkillTarget({ rootDirectory });

    await target.install(manifest);

    expect(readTargetFile(rootDirectory)).toContain("The `memmy-memory` skill is installed at `skills/memmy-memory/SKILL.md`.");
    expect(readTargetFile(rootDirectory)).not.toContain("Call memmy-memory search when context is needed.");
    const skillFile = readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8");
    expect(skillFile).toContain("# Memmy");
    expect(skillFile).toContain("Call memmy-memory search when context is needed.");
    await expect(target.isInstalled("claude_code")).resolves.toBe(true);
  });

  it("replaces marker blocks, old Skill directory, and legacy CLI inject files", async () => {
    const { rootDirectory, manifest } = createFixture();
    const filePath = join(rootDirectory, "CLAUDE.md");
    const target = createClaudeCodeSkillTarget({ rootDirectory });
    mkdirSync(join(rootDirectory, "skills", "memmy-memory", "references"), { recursive: true });
    writeFileSync(join(rootDirectory, "skills", "memmy-memory", "references", "search.md"), "old reference", "utf8");
    writeFileSync(
      filePath,
      [
        "manual prefix",
        "<!-- memmy-memory cli : start -->",
        "old cli",
        "<!-- memmy-memory cli : end -->",
        "<!-- memmy:start v=1 -->",
        "old",
        "<!-- memmy:end v=1 -->",
        "manual suffix",
        ""
      ].join("\n"),
      "utf8"
    );

    await target.install(manifest);
    expect(readTargetFile(rootDirectory)).toBe(
      [
        "manual prefix",
        "<!-- memmy:start v=1 -->",
        "# Memmy Memory",
        "",
        "The `memmy-memory` skill is installed at `skills/memmy-memory/SKILL.md`.",
        "Use that skill when prior memory may be relevant to the current request.",
        "<!-- memmy:end v=1 -->",
        "manual suffix",
        ""
      ].join("\n")
    );
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory", "references"))).toBe(false);

    await target.uninstall("claude_code");
    expect(readTargetFile(rootDirectory)).toBe(["manual prefix", "manual suffix", ""].join("\n"));
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
  });

  it("does not create Claude Code directory when Claude Code is not installed", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-claude-missing-"));
    const rootDirectory = join(tempDir, ".claude");
    const target = createClaudeCodeSkillTarget({ rootDirectory });
    const manifest = createManifest("claude_code");

    await expect(target.resolveRootDirectory()).resolves.toBeNull();
    await expect(target.isInstalled("claude_code")).resolves.toBe(false);
    await expect(target.install(manifest)).rejects.toThrow("Claude Code is not installed");
    expect(existsSync(rootDirectory)).toBe(false);
  });

  it("replaces an app-hosted hook idempotently without changing unrelated hooks", async () => {
    const { rootDirectory, memmyConfigPath } = createFixture();
    const target = createClaudeCodeSkillTarget({ rootDirectory, memmyConfigPath });
    const unrelatedHook = { type: "command", command: "'/usr/local/bin/custom-hook'", timeout: 10 };
    const appHostedHook = {
      type: "command",
      command: "'/Volumes/Memmy Installer/Memmy.app/Contents/MacOS/Memmy' '/Users/test/hooks/memmy-resume-hook.mjs'",
      timeout: 60
    };
    writeFileSync(join(rootDirectory, "settings.json"), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ matcher: "", hooks: [unrelatedHook, appHostedHook] }],
        Stop: [{ matcher: "", hooks: [unrelatedHook, appHostedHook] }]
      }
    }));

    await target.installPlugin?.("claude_code");
    await target.installPlugin?.("claude_code");

    const settings = JSON.parse(readFileSync(join(rootDirectory, "settings.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    for (const event of ["UserPromptSubmit", "Stop"]) {
      const commands = settings.hooks[event]?.flatMap((entry) => entry.hooks.map((hook) => hook.command)) ?? [];
      expect(commands).toHaveLength(2);
      expect(commands).toContain(unrelatedHook.command);
      expectSafeNodeHookCommand(commands.find((command) => command.includes("memmy-resume-hook.mjs")));
    }
  });

  it("installs a UserPromptSubmit hook that blocks resume commands with top L1 candidates", async () => {
    const { rootDirectory, memmyConfigPath } = createFixture();
    let requestBody: Record<string, unknown> | undefined;
    let authorization = "";
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      authorization = String(request.headers.authorization || "");
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/api/v1/memory/search") {
        requestBody = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
        writeJsonResponse(response, 200, { hits: createHits(6) });
        return;
      }
      const detail = createMemoryDetail(url.pathname);
      writeJsonResponse(response, detail ? 200 : 404, detail || {});
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    writeFileSync(
      memmyConfigPath,
      ["storage:", `  endpoint: "http://127.0.0.1:${address.port}"`, '  token: "test-token"', ""].join("\n"),
      "utf8"
    );
    const target = createClaudeCodeSkillTarget({ rootDirectory, memmyConfigPath });

    try {
      await target.installPlugin?.("claude_code");

      const hookScriptPath = join(rootDirectory, "hooks", "memmy-resume-hook.mjs");
      const settings = JSON.parse(readFileSync(join(rootDirectory, "settings.json"), "utf8")) as {
        hooks: {
          Stop: Array<{ hooks: Array<{ command: string; timeout: number; type: string }> }>;
          UserPromptSubmit: Array<{ hooks: Array<{ command: string; timeout: number; type: string }> }>;
        };
      };
      expect(settings.hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({
        type: "command",
        timeout: 60
      });
      expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain("memmy-resume-hook.mjs");
      expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).not.toContain("Electron.app");
      expectSafeNodeHookCommand(settings.hooks.UserPromptSubmit[0].hooks[0].command);
      expect(settings.hooks.Stop[0].hooks[0]).toMatchObject({
        type: "command",
        timeout: 60
      });
      expect(settings.hooks.Stop[0].hooks[0].command).toContain("memmy-resume-hook.mjs");
      const commandFilePath = join(rootDirectory, "commands", "memmy-resume.md");
      const commandFile = readFileSync(commandFilePath, "utf8");
      expect(commandFile).toContain("argument-hint: <query | 1-5 | cancel>");
      expect(commandFile).toContain("MEMMY_RESUME_COMMAND_ARGUMENTS:");
      expect(commandFile).toContain("$ARGUMENTS");

      const run = await runNodeHook(
        hookScriptPath,
        JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "/memmy-resume 测试query" })
      );

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      const output = JSON.parse(run.stdout) as { decision: string; reason: string };
      expect(output.decision).toBe("block");
      expect(output.reason).toContain('Memmy resume candidates for "测试query" (top 5 episodes from L1 top20):');
      expect(output.reason).not.toContain(". score ");
      expect(output.reason).toContain("1. episode_1");
      expect(output.reason).toContain("first_query: First query 1");
      expect(output.reason).toContain("tail_summary: Last L1 summary 1");
      expect(output.reason).not.toContain("Assistant raw summary 1");
      expect(output.reason).toContain("5. episode_5");
      expect(output.reason).not.toContain("6. episode_6");
      expect(output.reason).toContain("Enter 1-5 to select an episode to resume.");
      expect(requestBody).toMatchObject({
        query: "测试query",
        layers: ["L1"],
        limit: 20,
        verbose: true,
        source: "claude_code"
      });
      requestBody = undefined;
      const commandExpandedRun = await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          prompt: [
            "MEMMY_RESUME_COMMAND_ARGUMENTS:",
            "命令展开后的 query",
            "MEMMY_RESUME_COMMAND_END",
            "",
            "This slash command is a parser shim."
          ].join("\n")
        })
      );
      expect(commandExpandedRun.status).toBe(0);
      const commandExpandedOutput = JSON.parse(commandExpandedRun.stdout) as { decision: string; reason: string };
      expect(commandExpandedOutput.decision).toBe("block");
      expect(commandExpandedOutput.reason).toContain('Memmy resume candidates for "命令展开后的 query"');
      expect(requestBody).toMatchObject({
        query: "命令展开后的 query",
        layers: ["L1"],
        limit: 20,
        verbose: true,
        source: "claude_code"
      });
      expect(authorization).toBe("Bearer test-token");
      expect(readTargetFile(rootDirectory)).toContain(
        "The `memmy-memory` skill is installed at `skills/memmy-memory/SKILL.md`."
      );
      const skillFile = readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8");
      expect(skillFile).toContain("# Memmy Memory");
      expect(skillFile).toContain("A Memmy Memory Hook or plugin is installed for this agent.");
      expect(skillFile).toContain('memmy-memory search "query text" --source claude_code');
      expect(skillFile).not.toContain("memmy-memory add");

      await target.uninstallPlugin?.("claude_code");
      expect(existsSync(hookScriptPath)).toBe(false);
      expect(existsSync(commandFilePath)).toBe(false);
      const settingsAfter = JSON.parse(readFileSync(join(rootDirectory, "settings.json"), "utf8")) as {
        hooks?: { Stop?: unknown; UserPromptSubmit?: unknown };
      };
      expect(settingsAfter.hooks?.UserPromptSubmit).toBeUndefined();
      expect(settingsAfter.hooks?.Stop).toBeUndefined();
      expect(readTargetFile(rootDirectory)).not.toContain("memmy-memory");
      expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
    } finally {
      await close(server);
    }
  });

  it("uses one started turn and episode when capturing a completed Claude Code turn", async () => {
    const { rootDirectory, memmyConfigPath } = createFixture();
    const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const body = request.method === "POST" ? JSON.parse(await readRequestBody(request)) as Record<string, unknown> : {};
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/api/v1/sessions/open") {
        writeJsonResponse(response, 200, { sessionId: "claude-memory-session", status: "open" });
        return;
      }
      if (url.pathname === "/api/v1/turns/start") {
        writeJsonResponse(response, 200, {
          turnId: "claude-turn-1",
          episodeId: "claude-episode-1",
          sourceMemoryIds: ["claude-memory-1"],
          injectedContext: { markdown: "Claude historical context" }
        });
        return;
      }
      if (url.pathname === "/api/v1/turns/claude-turn-1/complete") {
        writeJsonResponse(response, 200, { turnId: "claude-turn-1", l1MemoryId: "trace-1" });
        return;
      }
      writeJsonResponse(response, 404, {});
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    writeFileSync(
      memmyConfigPath,
      ["storage:", `  endpoint: "http://127.0.0.1:${address.port}"`, ""].join("\n"),
      "utf8"
    );
    const target = createClaudeCodeSkillTarget({ rootDirectory, memmyConfigPath });

    try {
      await target.installPlugin?.("claude_code");
      const hookScriptPath = join(rootDirectory, "hooks", "memmy-resume-hook.mjs");
      const start = await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "claude-session-1",
          prompt: "继续修复 episode 切换问题",
          cwd: "/tmp/claude-project"
        })
      );
      expect(start.status).toBe(0);
      expect(JSON.parse(start.stdout)).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit"
        }
      });

      const stop = await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: "claude-session-1",
          cwd: "/tmp/claude-project",
          last_assistant_message: "修复已经完成"
        })
      );
      expect(stop.status).toBe(0);
      expect(JSON.parse(stop.stdout)).toEqual({ continue: true, suppressOutput: true });
      expect(requests.map((item) => item.path)).toEqual([
        "/api/v1/sessions/open",
        "/api/v1/turns/start",
        "/api/v1/sessions/open",
        "/api/v1/turns/claude-turn-1/complete"
      ]);
      expect(requests[0]?.body).toMatchObject({
        sessionId: "claude_code-memory-claude-session-1",
        source: "claude_code",
        workspacePath: "/tmp/claude-project"
      });
      expect(requests[1]?.body).toMatchObject({
        adapterId: "memmy-claude_code-hook",
        sessionId: "claude-memory-session",
        query: "继续修复 episode 切换问题"
      });
      expect(requests[3]?.body).toMatchObject({
        adapterId: "memmy-claude_code-hook",
        sessionId: "claude-memory-session",
        episodeId: "claude-episode-1",
        query: "继续修复 episode 切换问题",
        answer: "修复已经完成",
        sourceMemoryIds: ["claude-memory-1"]
      });
    } finally {
      await close(server);
    }
  });
});

function createFixture(): { rootDirectory: string; memmyConfigPath: string; manifest: SkillManifest } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-claude-skill-"));
  const memmyConfigPath = join(tempDir, "memmy-config.yaml");
  return {
    rootDirectory: tempDir,
    memmyConfigPath,
    manifest: createManifest("claude_code")
  };
}

function expectSafeNodeHookCommand(command: string | undefined): void {
  expect(command).toContain("memmy-resume-hook.mjs");
  expect(command).not.toMatch(/\.app[\\/]contents[\\/]macos[\\/]/i);
  expect(command).not.toContain("Memmy.app");
  expect(command).not.toContain("Electron.app");
}

function createManifest(targetId: string): SkillManifest {
  return {
    targetId,
    content: ["# Memmy", "Call memmy-memory search when context is needed."].join("\n"),
    marker: "<!-- memmy:start v=1 -->"
  };
}

function readTargetFile(rootDirectory: string): string {
  return readFileSync(join(rootDirectory, "CLAUDE.md"), "utf8");
}

function createHits(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_value, index) => ({
    id: `trace_${index + 1}`,
    memoryLayer: "L1",
    title: `Memory ${index + 1}`,
    score: 1 - index * 0.1,
    summary: `Summary ${index + 1}`
  }));
}

function createMemoryDetail(pathname: string): Record<string, unknown> | undefined {
  const id = decodeURIComponent(pathname.replace(/^\/api\/v1\/memory\//u, ""));
  const traceMatch = id.match(/^trace_(\d+)$/u);
  if (traceMatch) {
    return createTraceDetail(Number(traceMatch[1]));
  }
  const episodeMatch = id.match(/^episode_(\d+)$/u);
  if (episodeMatch) {
    return createEpisodeDetail(Number(episodeMatch[1]));
  }
  return undefined;
}

function createTraceDetail(index: number): Record<string, unknown> {
  return {
    id: `trace_${index}`,
    memoryLayer: "L1",
    updatedAt: episodeTimestamp(index),
    refs: {
      episode: {
        id: `episode_${index}`,
        title: `Episode ${index}`,
        summary: `Episode summary ${index}`,
        status: "closed",
        startedAt: episodeTimestamp(index),
        endedAt: episodeTimestamp(index),
        updatedAt: episodeTimestamp(index)
      },
      rawTurn: {
        userText: `First query ${index}`
      }
    }
  };
}

function createEpisodeDetail(index: number): Record<string, unknown> {
  return {
    id: `episode_${index}`,
    title: `Episode ${index}`,
    summary: `Episode summary ${index}`,
    updatedAt: episodeTimestamp(index),
    body: `Full episode body ${index}`,
    timeline: {
      rawTurns: [
        { turnId: `turn_${index}_1`, userText: `First query ${index}`, assistantText: `Initial answer ${index}` },
        { turnId: `turn_${index}_2`, userText: `Follow up ${index}`, summary: `Assistant raw summary ${index}` }
      ],
      items: [
        { id: `trace_${index}_early`, memoryLayer: "L1", title: `Early L1 ${index}`, summary: `Early L1 summary ${index}` },
        { id: `trace_${index}_last`, memoryLayer: "L1", title: `Last L1 ${index}`, summary: `Last L1 summary ${index}` },
        { id: `memory_${index}`, memoryLayer: "L2", title: `Related memory ${index}` }
      ]
    }
  };
}

function episodeTimestamp(index: number): string {
  return `2026-07-${String(8 - Math.min(index, 7)).padStart(2, "0")}T10:00:00.000Z`;
}

function writeJsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function runNodeHook(scriptPath: string, input: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [scriptPath], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(input);
  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 0));
  });
  return {
    status,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8")
  };
}
