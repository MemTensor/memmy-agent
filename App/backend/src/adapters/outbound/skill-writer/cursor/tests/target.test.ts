/** Target tests. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCursorDataPaths } from "../../../agent-paths.js";
import { createCursorSkillTarget } from "../index.js";
import type { SkillManifest } from "../../types.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("cursor skill target", () => {
  it("installs Memmy into Cursor's global Skill directory", async () => {
    const { rootDirectory, manifest } = createFixture();
    const target = createCursorSkillTarget({ rootDirectory });

    await target.install(manifest);

    const skillFile = readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8");
    expect(skillFile).toContain("# Memmy");
    expect(skillFile).toContain("Call memmy-memory search when context is needed.");
    expect(existsSync(join(rootDirectory, "rules", "memmy.md"))).toBe(false);
    await expect(target.isInstalled("cursor")).resolves.toBe(true);
  });

  it("replaces an existing Skill directory without changing unrelated files", async () => {
    const { rootDirectory, manifest } = createFixture();
    const target = createCursorSkillTarget({ rootDirectory });
    mkdirSync(join(rootDirectory, "skills", "memmy-memory", "references"), { recursive: true });
    writeFileSync(join(rootDirectory, "skills", "memmy-memory", "references", "search.md"), "old reference", "utf8");
    writeFileSync(join(rootDirectory, "unrelated.md"), "manual\n", "utf8");

    await target.install(manifest);

    expect(readFileSync(join(rootDirectory, "unrelated.md"), "utf8")).toBe("manual\n");
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory", "references"))).toBe(false);
  });

  it("uninstalls only the Memmy Skill directory", async () => {
    const { rootDirectory, manifest } = createFixture();
    const target = createCursorSkillTarget({ rootDirectory });
    writeFileSync(join(rootDirectory, "unrelated.md"), "manual\n", "utf8");
    await target.install(manifest);

    await target.uninstall("cursor");

    expect(readFileSync(join(rootDirectory, "unrelated.md"), "utf8")).toBe("manual\n");
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
    await expect(target.isInstalled("cursor")).resolves.toBe(false);
  });

  it("initializes a missing Cursor config directory", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-cursor-missing-"));
    const rootDirectory = join(tempDir, ".cursor");
    const target = createCursorSkillTarget({ rootDirectory });
    const manifest = createManifest("cursor");

    await expect(target.resolveRootDirectory()).resolves.toBe(rootDirectory);
    await expect(target.isInstalled("cursor")).resolves.toBe(false);
    await target.install(manifest);
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"))).toBe(true);
  });

  it("replaces an app-hosted hook idempotently without changing unrelated hooks", async () => {
    const { rootDirectory, memmyConfigPath } = createFixture();
    const target = createCursorSkillTarget({ rootDirectory, memmyConfigPath });
    const unrelatedHook = { command: "'/usr/local/bin/custom-hook'", timeout: 10 };
    const appHostedHook = {
      command: "'/Applications/Memmy.app/Contents/MacOS/Memmy' '/Users/test/hooks/memmy-resume-hook.mjs'",
      timeout: 60
    };
    writeFileSync(join(rootDirectory, "hooks.json"), JSON.stringify({
      version: 1,
      hooks: {
        beforeSubmitPrompt: [unrelatedHook, appHostedHook],
        afterAgentResponse: [unrelatedHook, appHostedHook],
        stop: [unrelatedHook, appHostedHook]
      }
    }));

    await target.installPlugin?.("cursor");
    await target.installPlugin?.("cursor");

    const config = JSON.parse(readFileSync(join(rootDirectory, "hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ command: string; timeout: number }>>;
    };
    for (const event of ["beforeSubmitPrompt", "afterAgentResponse", "stop"]) {
      expect(config.hooks[event]).toHaveLength(2);
      expect(config.hooks[event]?.[0]).toEqual(unrelatedHook);
      expectSafeNodeHookCommand(config.hooks[event]?.[1]?.command);
    }
  });

  it("installs a resume Skill and reads the current memmyMemory storage instead of legacy storage", async () => {
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
      [
        "memosMemory:",
        "  storage:",
        '    endpoint: "http://127.0.0.1:18799"',
        '    token: "legacy-token"',
        "memmyMemory:",
        "  storage:",
        `    endpoint: "http://127.0.0.1:${address.port}"`,
        '    token: "test-token"',
        ""
      ].join("\n"),
      "utf8"
    );
    const target = createCursorSkillTarget({ rootDirectory, memmyConfigPath });

    try {
      await target.installPlugin?.("cursor");

      const hookScriptPath = join(rootDirectory, "hooks", "memmy-resume-hook.mjs");
      const hooksConfig = JSON.parse(readFileSync(join(rootDirectory, "hooks.json"), "utf8")) as {
        version: number;
        hooks: {
          afterAgentResponse: Array<{ command: string; timeout: number }>;
          beforeSubmitPrompt: Array<{ command: string; timeout: number }>;
          stop: Array<{ command: string; timeout: number }>;
        };
      };
      expect(hooksConfig.version).toBe(1);
      const submitHook = hooksConfig.hooks.beforeSubmitPrompt[0];
      const responseHook = hooksConfig.hooks.afterAgentResponse[0];
      const stopHook = hooksConfig.hooks.stop[0];
      assert(submitHook, "beforeSubmitPrompt hook must be installed");
      assert(responseHook, "afterAgentResponse hook must be installed");
      assert(stopHook, "stop hook must be installed");
      expect(submitHook).toMatchObject({
        timeout: 60
      });
      expect(submitHook).not.toHaveProperty("matcher");
      expect(submitHook.command).toContain("memmy-resume-hook.mjs");
      expect(submitHook.command).not.toContain("Electron.app");
      expectSafeNodeHookCommand(submitHook.command);
      expect(responseHook).toMatchObject({ timeout: 60 });
      expect(responseHook.command).toContain("memmy-resume-hook.mjs");
      expect(stopHook).toMatchObject({ timeout: 60 });
      expect(stopHook.command).toContain("memmy-resume-hook.mjs");

      const run = await runNodeHook(
        hookScriptPath,
        JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "/memmy-resume 测试query" })
      );

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      const output = JSON.parse(run.stdout) as { continue: boolean; user_message: string };
      expect(output.continue).toBe(false);
      expect(output.user_message).toContain('Memmy resume candidates for "测试query" (top 5 episodes from L1 top20):');
      expect(output.user_message).not.toContain(". score ");
      expect(output.user_message).toContain("1. episode_1");
      expect(output.user_message).toContain("first_query: First query 1");
      expect(output.user_message).toContain("tail_summary: Last L1 summary 1");
      expect(output.user_message).not.toContain("Assistant raw summary 1");
      expect(output.user_message).toContain("5. episode_5");
      expect(output.user_message).not.toContain("6. episode_6");
      expect(output.user_message).toContain("Enter 1-5 to select an episode to resume.");
      expect(requestBody).toMatchObject({
        query: "测试query",
        layers: ["L1"],
        limit: 20,
        verbose: true,
        source: "cursor"
      });
      expect(authorization).toBe("Bearer test-token");
      const skillFile = readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8");
      expect(skillFile).toContain("# Memmy Memory");
      expect(skillFile).toContain("A Memmy Memory Hook or plugin is installed for this agent.");
      expect(skillFile).toContain('memmy-memory search "query text" --source cursor');
      expect(skillFile).not.toContain("memmy-memory add");
      const resumeSkillFile = readFileSync(join(rootDirectory, "skills", "memmy-resume", "SKILL.md"), "utf8");
      expect(resumeSkillFile).toContain("name: memmy-resume");
      expect(resumeSkillFile).toContain("disable-model-invocation: true");
      expect(resumeSkillFile).toContain("memmy-memory search");

      const selectionRun = await runNodeHook(
        hookScriptPath,
        JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "1" })
      );
      const selectionOutput = JSON.parse(selectionRun.stdout) as { continue: boolean; user_message: string };
      expect(selectionOutput.continue).toBe(false);
      expect(selectionOutput.user_message).toContain("Episode id: episode_1");
      expect(selectionOutput.user_message).toContain("Full episode body 1");

      await runNodeHook(
        hookScriptPath,
        JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "/memmy-resume another query" })
      );
      const cancelRun = await runNodeHook(
        hookScriptPath,
        JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "/memmy-resume cancel" })
      );
      const cancelOutput = JSON.parse(cancelRun.stdout) as { continue: boolean; user_message: string };
      expect(cancelOutput.continue).toBe(false);
      expect(cancelOutput.user_message).toBe("Memmy resume selection cancelled.");

      await target.uninstallPlugin?.("cursor");
      expect(existsSync(hookScriptPath)).toBe(false);
      const hooksAfter = JSON.parse(readFileSync(join(rootDirectory, "hooks.json"), "utf8")) as {
        hooks?: { afterAgentResponse?: unknown; beforeSubmitPrompt?: unknown; stop?: unknown };
      };
      expect(hooksAfter.hooks?.beforeSubmitPrompt).toBeUndefined();
      expect(hooksAfter.hooks?.afterAgentResponse).toBeUndefined();
      expect(hooksAfter.hooks?.stop).toBeUndefined();
      expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
      expect(existsSync(join(rootDirectory, "skills", "memmy-resume"))).toBe(false);
    } finally {
      await close(server);
    }
  });

  it("includes the request URL and underlying network cause when resume search cannot connect", async () => {
    const { rootDirectory, memmyConfigPath } = createFixture();
    const server = createServer();
    await listen(server);
    const address = server.address() as AddressInfo;
    await close(server);
    writeFileSync(
      memmyConfigPath,
      ["memmyMemory:", "  storage:", `    endpoint: "http://127.0.0.1:${address.port}"`, ""].join("\n"),
      "utf8"
    );
    const target = createCursorSkillTarget({ rootDirectory, memmyConfigPath });

    await target.installPlugin?.("cursor");
    const hookScriptPath = join(rootDirectory, "hooks", "memmy-resume-hook.mjs");
    const run = await runNodeHook(
      hookScriptPath,
      JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "/memmy-resume unreachable" })
    );
    const output = JSON.parse(run.stdout) as { continue: boolean; user_message: string };

    expect(output.continue).toBe(false);
    expect(output.user_message).toContain(
      `Memmy request to http://127.0.0.1:${address.port}/api/v1/memory/search failed:`
    );
    expect(output.user_message).toContain("ECONNREFUSED");
  });

  it("falls back to the installed endpoint snapshot when runtime YAML has no endpoint", async () => {
    const { rootDirectory, memmyConfigPath } = createFixture();
    let searchRequested = false;
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/api/v1/memory/search") {
        searchRequested = true;
        writeJsonResponse(response, 200, { hits: [] });
        return;
      }
      writeJsonResponse(response, 404, {});
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    writeFileSync(memmyConfigPath, "memmyMemory:\n  enabled: true\n", "utf8");
    const target = createCursorSkillTarget({ rootDirectory, memmyConfigPath });

    try {
      await target.installPlugin?.("cursor");
      writeFileSync(
        join(rootDirectory, "hooks", "memmy-memory-config.json"),
        JSON.stringify({
          memmy_config_path: memmyConfigPath,
          endpoint: `http://127.0.0.1:${address.port}`
        }),
        "utf8"
      );
      const run = await runNodeHook(
        join(rootDirectory, "hooks", "memmy-resume-hook.mjs"),
        JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "/memmy-resume snapshot" })
      );
      const output = JSON.parse(run.stdout) as { user_message: string };

      expect(searchRequested).toBe(true);
      expect(output.user_message).toBe('No L1 Memmy memories found for: "snapshot"');
    } finally {
      await close(server);
    }
  });

  it("captures only completed Cursor turns and drops user-cancelled turns", async () => {
    const { rootDirectory, memmyConfigPath } = createFixture();
    const requests: Array<{ body: Record<string, unknown>; path: string }> = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const body = request.method === "POST" ? JSON.parse(await readRequestBody(request)) as Record<string, unknown> : {};
      requests.push({ path: url.pathname, body });
      if (request.method === "GET" && url.pathname === "/api/v1/health") {
        writeJsonResponse(response, 200, { features: {} });
        return;
      }
      if (url.pathname === "/api/v1/sessions/open") {
        writeJsonResponse(response, 200, { sessionId: "cursor-memory-session", status: "open" });
        return;
      }
      if (url.pathname === "/api/v1/turns/start") {
        writeJsonResponse(response, 200, {
          turnId: "cursor-turn-1",
          sourceMemoryIds: ["cursor-memory-1"],
          injectedContext: { markdown: "Cursor historical context" }
        });
        return;
      }
      if (url.pathname === "/api/v1/source-turns/complete") {
        writeJsonResponse(response, 200, { status: "stored", result: { l1MemoryIds: ["trace-1"] } });
        return;
      }
      writeJsonResponse(response, 404, {});
    });
    await listen(server);
    const address = server.address() as AddressInfo;
    writeFileSync(
      memmyConfigPath,
      ["storage:", '  endpoint: "http://127.0.0.1:' + address.port + '"', ""].join("\n"),
      "utf8"
    );
    const target = createCursorSkillTarget({ rootDirectory, memmyConfigPath });
    const eventBase = {
      conversation_id: "cursor-conversation-1",
      generation_id: "cursor-generation-1",
      workspace_roots: ["/tmp/cursor-project"]
    };
    const cursorHome = join(rootDirectory, "cursor-home");
    // The completed turn is the one Cursor already wrote to its own database. The cancelled
    // and unfinished generations are deliberately absent or missing their closing answer.
    writeCursorTurnFixture(cursorHome, [
      {
        conversationId: eventBase.conversation_id,
        requestId: "cursor-generation-1",
        bubbleId: "bubble-user-1",
        query: "继续检查 episode 生命周期",
        answer: "Cursor 生命周期修复完成"
      },
      {
        conversationId: eventBase.conversation_id,
        requestId: "cursor-generation-3",
        bubbleId: "bubble-user-3",
        query: "当前尚未完成的问题",
        answer: ""
      }
    ]);

    try {
      await target.installPlugin?.("cursor");
      const hookScriptPath = join(rootDirectory, "hooks", "memmy-resume-hook.mjs");
      const start = await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          ...eventBase,
          hook_event_name: "beforeSubmitPrompt",
          prompt: "继续检查 episode 生命周期"
        }),
        cursorHome
      );
      expect(start.status).toBe(0);
      expect(JSON.parse(start.stdout)).toEqual({ continue: true });

      const agentResponse = await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          ...eventBase,
          hook_event_name: "afterAgentResponse",
          text: "Cursor 生命周期修复完成"
        }),
        cursorHome
      );
      expect(agentResponse.status).toBe(0);
      expect(JSON.parse(agentResponse.stdout)).toEqual({});

      const stop = await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          ...eventBase,
          hook_event_name: "stop",
          status: "completed"
        }),
        cursorHome
      );
      expect(stop.status).toBe(0);
      expect(JSON.parse(stop.stdout)).toEqual({});
      expect(requests.map((item) => item.path)).toEqual([
        "/api/v1/health",
        "/api/v1/sessions/open",
        "/api/v1/turns/start",
        "/api/v1/source-turns/complete"
      ]);
      expect(requests[1]?.body).toMatchObject({
        sessionId: "cursor-memory-cursor-conversation-1",
        source: "cursor",
        workspacePath: "/tmp/cursor-project"
      });
      expect(requests[2]?.body).toMatchObject({
        adapterId: "memmy-cursor-hook",
        requestId: "cursor-start:cursor-generation-1",
        sessionId: "cursor-memory-session",
        turnId: "cursor-generation-1",
        query: "继续检查 episode 生命周期"
      });
      // The durable turn id is the user bubble, not the hook-only generation id, so the
      // offline scan recomputes the same identity from the same rows.
      expect(requests[3]?.body).toMatchObject({
        adapterId: "memmy-cursor-hook",
        channel: "hook",
        sessionId: "cursor-memory-session",
        query: "继续检查 episode 生命周期",
        answer: "Cursor 生命周期修复完成",
        sourceMemoryIds: ["cursor-memory-1"],
        status: "succeeded",
        sourceTurn: {
          source: "cursor",
          conversationId: "cursor-conversation-1",
          turnId: "bubble-user-1",
          completionEvidence: "assistant_text:bubble-assistant-1"
        }
      });
      expect(requests[3]?.body).not.toHaveProperty("episodeId");

      const cancelledEvent = {
        ...eventBase,
        generation_id: "cursor-generation-2"
      };
      await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          ...cancelledEvent,
          hook_event_name: "beforeSubmitPrompt",
          prompt: "这个任务会被用户取消"
        }),
        cursorHome
      );
      await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          ...cancelledEvent,
          hook_event_name: "afterAgentResponse",
          text: "尚未完成的部分回复"
        }),
        cursorHome
      );
      await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          ...cancelledEvent,
          hook_event_name: "stop",
          status: "cancelled"
        }),
        cursorHome
      );
      expect(requests.slice(4).map((item) => item.path)).toEqual([
        "/api/v1/health",
        "/api/v1/sessions/open",
        "/api/v1/turns/start"
      ]);

      // A generation Cursor never persisted stays unwritten instead of being guessed at.
      await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          ...cancelledEvent,
          hook_event_name: "stop",
          status: "completed"
        }),
        cursorHome
      );
      expect(requests).toHaveLength(7);

      const incompleteEvent = {
        ...eventBase,
        generation_id: "cursor-generation-3"
      };
      await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          ...incompleteEvent,
          hook_event_name: "beforeSubmitPrompt",
          prompt: "当前尚未完成的问题"
        }),
        cursorHome
      );
      const unfinished = await runNodeHook(
        hookScriptPath,
        JSON.stringify({
          ...incompleteEvent,
          hook_event_name: "stop",
          status: "completed"
        }),
        cursorHome
      );
      expect(unfinished.stderr).toContain("turn_incomplete");
      expect(requests.slice(7).map((item) => item.path)).toEqual([
        "/api/v1/health",
        "/api/v1/sessions/open",
        "/api/v1/turns/start"
      ]);
    } finally {
      await close(server);
    }
  }, 15_000);
});

function createFixture(): {
  rootDirectory: string;
  memmyConfigPath: string;
  manifest: SkillManifest;
} {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-cursor-skill-"));
  const memmyConfigPath = join(tempDir, "memmy-config.yaml");

  return {
    rootDirectory: tempDir,
    memmyConfigPath,
    manifest: createManifest("cursor")
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

/**
 * Writes the Cursor globalStorage rows a finished turn is read back from. A turn whose
 * answer is empty stays unfinished on disk, which is how Cursor looks before the closing
 * assistant bubble is flushed.
 */
function writeCursorTurnFixture(homeDirectory: string, turns: ReadonlyArray<{
  conversationId: string;
  requestId: string;
  bubbleId: string;
  query: string;
  answer: string;
}>): void {
  const databasePath = resolveCursorDataPaths({ homeDirectory, environment: {} }).globalStateDbPath;
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS composerHeaders (composerId TEXT PRIMARY KEY, isSubagent INTEGER, subagentTypeName TEXT)");
    const byConversation = new Map<string, Array<Record<string, unknown>>>();
    for (const [index, turn] of turns.entries()) {
      const bubbles = byConversation.get(turn.conversationId) ?? [];
      bubbles.push({
        bubbleId: turn.bubbleId,
        type: 1,
        text: turn.query,
        createdAt: `2026-09-16T10:0${index}:00.000Z`,
        requestId: turn.requestId
      });
      if (turn.answer) {
        bubbles.push({
          bubbleId: turn.bubbleId.replace("user", "assistant"),
          type: 2,
          text: turn.answer,
          createdAt: `2026-09-16T10:0${index}:30.000Z`
        });
      }
      byConversation.set(turn.conversationId, bubbles);
    }
    for (const [conversationId, bubbles] of byConversation) {
      db.prepare("INSERT OR REPLACE INTO composerHeaders (composerId, isSubagent, subagentTypeName) VALUES (?, 0, '')")
        .run(conversationId);
      db.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)").run(
        `composerData:${conversationId}`,
        JSON.stringify({
          composerId: conversationId,
          fullConversationHeadersOnly: bubbles.map((bubble) => ({
            bubbleId: bubble.bubbleId,
            type: bubble.type,
            createdAt: bubble.createdAt
          }))
        })
      );
      for (const bubble of bubbles) {
        db.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)")
          .run(`bubbleId:${conversationId}:${String(bubble.bubbleId)}`, JSON.stringify({ _v: 3, ...bubble }));
      }
    }
  } finally {
    db.close();
  }
}

async function runNodeHook(scriptPath: string, input: string, homeDirectory?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(homeDirectory ? { HOME: homeDirectory, USERPROFILE: homeDirectory, XDG_CONFIG_HOME: join(homeDirectory, ".config") } : {})
    }
  });
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
