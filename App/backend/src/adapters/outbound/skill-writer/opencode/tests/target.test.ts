/** Target tests. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillManifest } from "../../types.js";
import { createOpencodeSkillTarget } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("opencode skill target", () => {
  it("installs, replaces, and uninstalls the global Memmy bootstrap and Skill directory", async () => {
    const { rootDirectory, manifest } = createFixture();
    const target = createOpencodeSkillTarget({ rootDirectory });
    mkdirSync(join(rootDirectory, "skills", "memmy-memory", "references"), { recursive: true });
    writeFileSync(join(rootDirectory, "skills", "memmy-memory", "references", "search.md"), "old reference", "utf8");
    writeFileSync(
      join(rootDirectory, "AGENTS.md"),
      ["manual", "<!-- memmy-memory cli : start -->", "old cli", "<!-- memmy-memory cli : end -->", ""].join("\n"),
      "utf8"
    );

    await target.install(manifest);
    expect(readTargetFile(rootDirectory)).toContain("The `memmy-memory` skill is installed at `skills/memmy-memory/SKILL.md`.");
    expect(readTargetFile(rootDirectory)).not.toContain("Call memmy-memory search when context is needed.");
    const skillFile = readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8");
    expect(skillFile).toContain("# Memmy");
    expect(skillFile).toContain("Call memmy-memory search when context is needed.");
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory", "references"))).toBe(false);
    await expect(target.isInstalled("opencode")).resolves.toBe(true);

    writeFileSync(
      join(rootDirectory, "AGENTS.md"),
      ["manual prefix", "<!-- memmy:start v=1 -->", "old", "<!-- memmy:end v=1 -->", "manual suffix", ""].join("\n"),
      "utf8"
    );
    await target.install(manifest);
    await target.uninstall("opencode");
    expect(readTargetFile(rootDirectory)).toBe(["manual prefix", "manual suffix", ""].join("\n"));
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
  });

  it("initializes a missing Opencode config directory", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-opencode-missing-"));
    const rootDirectory = join(tempDir, ".config", "opencode");
    const target = createOpencodeSkillTarget({ rootDirectory });
    const manifest = createManifest("opencode");

    await expect(target.resolveRootDirectory()).resolves.toBe(rootDirectory);
    await expect(target.isInstalled("opencode")).resolves.toBe(false);
    await target.install(manifest);
    expect(existsSync(join(rootDirectory, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"))).toBe(true);
  });

  it("installs and uninstalls the native OpenCode Memmy plugin", async () => {
    const { rootDirectory } = createFixture();
    const memmyConfigPath = join(rootDirectory, "memmy-config.yaml");
    writeFileSync(
      memmyConfigPath,
      "memmyMemory:\n  storage:\n    endpoint: http://127.0.0.1:18991\n    token: opencode-token\n",
      "utf8"
    );
    writeFileSync(join(rootDirectory, "AGENTS.md"), "manual instructions\n", "utf8");
    const target = createOpencodeSkillTarget({ rootDirectory, memmyConfigPath });

    await target.installPlugin?.("opencode");

    const pluginPath = join(rootDirectory, "plugins", "memmy-memory.js");
    const pluginConfigPath = join(rootDirectory, "plugins", "memmy-memory-config.json");
    const commandPath = join(rootDirectory, "commands", "memmy-resume.md");
    const pluginSource = readFileSync(pluginPath, "utf8");
    const pluginConfig = JSON.parse(readFileSync(pluginConfigPath, "utf8")) as {
      endpoint?: string;
      memmy_config_path?: string;
      token?: string;
    };
    const commandSource = readFileSync(commandPath, "utf8");
    const skillSource = readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8");

    expect(pluginConfig).toEqual({
      memmy_config_path: memmyConfigPath,
      endpoint: "http://127.0.0.1:18991",
      token: "opencode-token"
    });
    expect(pluginSource).toContain('import { tool } from "@opencode-ai/plugin";');
    expect(pluginSource).toContain("export const MemmyMemoryPlugin");
    expect(pluginSource).toContain('"chat.message"');
    expect(pluginSource).toContain('"experimental.text.complete"');
    expect(pluginSource).toContain('event: async ({ event }) =>');
    expect(pluginSource).toContain("dispose: async () =>");
    expect(pluginSource).toContain("memmy_memory_search: tool");
    expect(commandSource).toContain("MEMMY_RESUME_COMMAND_ARGUMENTS:");
    expect(commandSource).toContain("$ARGUMENTS");
    expect(skillSource).toContain("# Memmy Memory");
    expect(skillSource).toContain("A Memmy Memory Hook or plugin is installed for this agent.");
    expect(skillSource).toContain("The installed integration automatically recalls relevant context and captures completed turns.");
    expect(skillSource).toContain('memmy-memory search "query text" --source opencode');
    expect(skillSource).not.toContain("memmy-memory add");
    expect(skillSource).not.toContain("Call memmy-memory search when context is needed.");
    expect(readTargetFile(rootDirectory)).toContain("manual instructions");
    expect(readTargetFile(rootDirectory)).toContain("The `memmy-memory` skill is installed");

    await target.uninstallPlugin?.("opencode");

    expect(existsSync(pluginPath)).toBe(false);
    expect(existsSync(pluginConfigPath)).toBe(false);
    expect(existsSync(commandPath)).toBe(false);
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
    expect(readTargetFile(rootDirectory)).toBe("manual instructions\n");
  });

  it("recalls context and flushes a completed OpenCode turn with tool traces", async () => {
    const { rootDirectory } = createFixture();
    const target = createOpencodeSkillTarget({
      rootDirectory,
      memmyConfigPath: join(rootDirectory, "missing-memmy-config.yaml")
    });
    await target.installPlugin?.("opencode");
    const hooks = await loadPluginHooks(rootDirectory);
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const targetUrl = url instanceof Request ? new URL(url.url) : url instanceof URL ? url : new URL(String(url));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      requests.push({ path: targetUrl.pathname, body });
      if (targetUrl.pathname === "/api/v1/sessions/open") {
        return jsonResponse({ sessionId: "memmy-session-1" });
      }
      if (targetUrl.pathname === "/api/v1/turns/start") {
        return jsonResponse({
          turnId: "memmy-turn-1",
          episodeId: "episode-1",
          sourceMemoryIds: ["trace-1"],
          injectedContext: { markdown: "User prefers concise answers." }
        });
      }
      if (targetUrl.pathname === "/api/v1/turns/memmy-turn-1/complete") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    try {
      const parts: PluginPart[] = [{
        id: "part-user-1",
        messageID: "message-user-1",
        sessionID: "session-1",
        type: "text",
        text: "请检查 README"
      }];
      await hooks["chat.message"](
        { sessionID: "session-1", messageID: "message-user-1", agent: "build" },
        { message: { id: "message-user-1" }, parts }
      );
      expect(parts[0]?.text).toContain('<memmy_memory_context source="turn_start">');
      expect(parts[0]?.text).toContain("User prefers concise answers.");
      expect(parts[0]?.text).toContain("<current_user_request>\n请检查 README");

      await hooks["tool.execute.before"](
        { tool: "read", sessionID: "session-1", callID: "call-1" },
        { args: { filePath: "README.md" } }
      );
      await hooks["tool.execute.after"](
        { tool: "read", sessionID: "session-1", callID: "call-1", args: { filePath: "README.md" } },
        { title: "README.md", output: "README contents", metadata: {} }
      );
      await hooks["experimental.text.complete"](
        { sessionID: "session-1", messageID: "message-assistant-1", partID: "part-assistant-1" },
        { text: "检查完成" }
      );
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "session-1" } } });
      await hooks.dispose();

      expect(requests.find((request) => request.path === "/api/v1/turns/start")?.body).toMatchObject({
        query: "请检查 README",
        source: "opencode",
        turnId: "message-user-1"
      });
      expect(requests.find((request) => request.path.endsWith("/complete"))?.body).toMatchObject({
        adapterId: "memmy-opencode-plugin",
        sessionId: "memmy-session-1",
        query: "请检查 README",
        answer: "检查完成",
        status: "succeeded",
        toolCalls: [{ id: "call-1", name: "read", arguments: { filePath: "README.md" } }],
        toolResults: [{ tool_call_id: "call-1", content: "README contents", output: "README contents" }],
        sourceMemoryIds: ["trace-1"]
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles the OpenCode resume command and injects the selected episode", async () => {
    const { rootDirectory } = createFixture();
    const target = createOpencodeSkillTarget({
      rootDirectory,
      memmyConfigPath: join(rootDirectory, "missing-memmy-config.yaml")
    });
    await target.installPlugin?.("opencode");
    const hooks = await loadPluginHooks(rootDirectory);
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const targetUrl = url instanceof Request ? new URL(url.url) : url instanceof URL ? url : new URL(String(url));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      requests.push({ path: targetUrl.pathname, body });
      if (targetUrl.pathname === "/api/v1/memory/search") {
        return jsonResponse({ debug: { hits: [{ id: "trace-1", score: 0.95 }] } });
      }
      if (targetUrl.pathname === "/api/v1/memory/trace-1") {
        return jsonResponse({
          id: "trace-1",
          updatedAt: "2026-07-09T10:00:00.000Z",
          refs: {
            episode: { id: "episode-1", title: "Resume task", status: "open", updatedAt: "2026-07-09T10:00:00.000Z" },
            rawTurn: { userText: "Implement the feature" }
          }
        });
      }
      if (targetUrl.pathname === "/api/v1/memory/episode-1") {
        return jsonResponse({
          id: "episode-1",
          title: "Resume task",
          body: "Full episode context",
          updatedAt: "2026-07-09T10:00:00.000Z",
          timeline: {
            rawTurns: [{ turnId: "old-turn", userText: "Implement the feature", assistantText: "Started" }],
            items: [{ id: "trace-1", memoryLayer: "L1", summary: "Work in progress" }]
          }
        });
      }
      if (targetUrl.pathname === "/api/v1/sessions/open") {
        return jsonResponse({ sessionId: "memmy-session-resume" });
      }
      if (targetUrl.pathname === "/api/v1/turns/start") {
        return jsonResponse({ turnId: "memmy-turn-resume", injectedContext: { markdown: "Additional context" } });
      }
      if (targetUrl.pathname.endsWith("/complete")) {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    try {
      const commandParts: PluginPart[] = [{
        id: "command-part",
        messageID: "command-message",
        sessionID: "session-resume",
        type: "text",
        text: "MEMMY_RESUME_COMMAND_ARGUMENTS:\n测试 query\nMEMMY_RESUME_COMMAND_END"
      }];
      await hooks["chat.message"](
        { sessionID: "session-resume", messageID: "command-message", agent: "build" },
        { message: { id: "command-message" }, parts: commandParts }
      );
      expect(commandParts[0]?.text).toContain('Memmy resume candidates for "测试 query"');
      expect(commandParts[0]?.text).toContain("1. episode-1");
      expect(requests.find((request) => request.path === "/api/v1/memory/search")?.body.query).toBe("测试 query");

      const selectionParts: PluginPart[] = [{
        id: "selection-part",
        messageID: "selection-message",
        sessionID: "session-resume",
        type: "text",
        text: "1"
      }];
      await hooks["chat.message"](
        { sessionID: "session-resume", messageID: "selection-message", agent: "build" },
        { message: { id: "selection-message" }, parts: selectionParts }
      );
      expect(selectionParts[0]?.text).toContain('<memmy_memory_context source="resume">');
      expect(selectionParts[0]?.text).toContain("Episode id: episode-1");
      expect(selectionParts[0]?.text).toContain("Full episode context");
      expect(selectionParts[0]?.text).toContain("Additional context");
      await hooks.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

interface PluginPart {
  id: string;
  messageID: string;
  sessionID: string;
  type: string;
  text: string;
  synthetic?: boolean;
}

interface OpencodePluginHooks {
  "chat.message": (
    input: { sessionID: string; messageID: string; agent: string },
    output: { message: { id: string }; parts: PluginPart[] }
  ) => Promise<void>;
  "tool.execute.before": (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown }
  ) => Promise<void>;
  "tool.execute.after": (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown }
  ) => Promise<void>;
  "experimental.text.complete": (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string }
  ) => Promise<void>;
  event(input: { event: { type: string; properties: Record<string, unknown> } }): Promise<void>;
  dispose(): Promise<void>;
}

async function loadPluginHooks(rootDirectory: string): Promise<OpencodePluginHooks> {
  const pluginDirectory = join(rootDirectory, "plugins");
  const pluginSource = readFileSync(join(pluginDirectory, "memmy-memory.js"), "utf8").replace(
    'import { tool } from "@opencode-ai/plugin";',
    [
      "const schemaValue = () => ({ optional() { return this; } });",
      "const tool = (definition) => definition;",
      "tool.schema = { string: schemaValue, enum: schemaValue, array: schemaValue };"
    ].join("\n")
  );
  const runtimePath = join(pluginDirectory, `memmy-memory-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(runtimePath, pluginSource, "utf8");
  const module = await import(pathToFileURL(runtimePath).href) as {
    MemmyMemoryPlugin(input: {
      client: { app: { log(input: unknown): Promise<void> } };
      directory: string;
      worktree: string;
    }): Promise<OpencodePluginHooks>;
  };
  return module.MemmyMemoryPlugin({
    client: { app: { async log() { return undefined; } } },
    directory: rootDirectory,
    worktree: rootDirectory
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createFixture(): { rootDirectory: string; manifest: SkillManifest } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-opencode-skill-"));
  return {
    rootDirectory: tempDir,
    manifest: createManifest("opencode")
  };
}

function createManifest(targetId: string): SkillManifest {
  return {
    targetId,
    content: ["# Memmy", "Call memmy-memory search when context is needed."].join("\n"),
    marker: "<!-- memmy:start v=1 -->"
  };
}

function readTargetFile(rootDirectory: string): string {
  return readFileSync(join(rootDirectory, "AGENTS.md"), "utf8");
}
