import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeepseekHarnessSkillTarget } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("DeepSeek Harness skill target", () => {
  it("installs and uninstalls the plugin, patch, and skill without replacing user patches", async () => {
    const rootDirectory = createRoot();
    const memmyConfigPath = join(rootDirectory, "memmy-config.yaml");
    const patchPath = join(rootDirectory, "cordis.patch.yml");
    writeFileSync(memmyConfigPath, "storage:\n  endpoint: http://127.0.0.1:18991\n", "utf8");
    writeFileSync(
      patchPath,
      ["# user patch", "- insert:", "    - id: user-plugin", "      name: '@example/user-plugin'", ""].join("\n"),
      "utf8"
    );
    const target = createDeepseekHarnessSkillTarget({ rootDirectory, memmyConfigPath });

    await target.installPlugin?.("deepseek_harness");

    const pluginDirectory = installedPluginDirectory(rootDirectory);
    const pluginPath = join(pluginDirectory, "index.mjs");
    const clientPath = join(pluginDirectory, "client.js");
    const packagePath = join(pluginDirectory, "package.json");
    const skillPath = join(rootDirectory, "skills", "memmy-memory", "SKILL.md");
    const patch = readFileSync(patchPath, "utf8");
    expect(existsSync(pluginPath)).toBe(true);
    const packageManifest = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    expect(packageManifest).toMatchObject({
      name: "@memmy/memmy-memory",
      type: "module",
      exports: {
        ".": "./index.mjs",
        "./client": "./client.js"
      },
      dsh: { client: { platform: "web" } }
    });
    expect(packageManifest).not.toHaveProperty("version");
    expect(readFileSync(skillPath, "utf8")).toContain('memmy-memory search "query text" --source deepseek_harness');
    expect(patch).toContain("id: user-plugin");
    expect(patch).toContain("# memmy-memory plugin:start");
    expect(patch).not.toContain("plugin:start v=");
    expect(patch).toContain("name: '@memmy/memmy-memory'");
    expect(patch).toContain(memmyConfigPath);
    expect(YAML.parse(patch)).toHaveLength(2);
    expect(spawnSync(process.execPath, ["--check", pluginPath], { encoding: "utf8" })).toMatchObject({ status: 0 });
    expect(spawnSync(process.execPath, ["--check", clientPath], { encoding: "utf8" })).toMatchObject({ status: 0 });
    await expect(target.isInstalled("deepseek_harness")).resolves.toBe(true);

    await target.uninstallPlugin?.("deepseek_harness");

    expect(existsSync(pluginDirectory)).toBe(false);
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
    expect(readFileSync(patchPath, "utf8")).toBe(
      ["# user patch", "- insert:", "    - id: user-plugin", "      name: '@example/user-plugin'", ""].join("\n")
    );
    await expect(target.isInstalled("deepseek_harness")).resolves.toBe(false);
  });

  it("restores an empty patch after uninstall", async () => {
    const rootDirectory = createRoot();
    const patchPath = join(rootDirectory, "cordis.patch.yml");
    writeFileSync(patchPath, "[]\n", "utf8");
    const target = createDeepseekHarnessSkillTarget({ rootDirectory });

    await target.installPlugin?.("deepseek_harness");
    await target.uninstallPlugin?.("deepseek_harness");

    expect(readFileSync(patchPath, "utf8")).toBe("[]\n");
  });

  it("does not create a missing DeepSeek Harness home", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-dsh-target-missing-"));
    const rootDirectory = join(tempDir, ".dsh");
    const target = createDeepseekHarnessSkillTarget({ rootDirectory });

    await expect(target.resolveRootDirectory()).resolves.toBeNull();
    await expect(target.isInstalled("deepseek_harness")).resolves.toBe(false);
    await expect(target.installPlugin?.("deepseek_harness")).rejects.toThrow("DeepSeek Harness is not installed");
    expect(existsSync(rootDirectory)).toBe(false);
  });

  it("marks stale plugin files as needing a reinstall", async () => {
    const rootDirectory = createRoot();
    const target = createDeepseekHarnessSkillTarget({ rootDirectory });
    await target.installPlugin?.("deepseek_harness");
    const pluginPath = join(installedPluginDirectory(rootDirectory), "index.mjs");
    writeFileSync(pluginPath, `${readFileSync(pluginPath, "utf8")}\n// stale source\n`, "utf8");

    await expect(target.isInstalled("deepseek_harness")).resolves.toBe(false);

    await target.installPlugin?.("deepseek_harness");
    const packagePath = join(installedPluginDirectory(rootDirectory), "package.json");
    const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    writeFileSync(packagePath, JSON.stringify({ ...manifest, version: "0.2.0" }, null, 2) + "\n", "utf8");

    await expect(target.isInstalled("deepseek_harness")).resolves.toBe(false);
  });

  it("publishes an optimistic user bubble until the durable user message arrives", async () => {
    const rootDirectory = createRoot();
    const target = createDeepseekHarnessSkillTarget({ rootDirectory });
    await target.installPlugin?.("deepseek_harness");
    const clientPath = join(installedPluginDirectory(rootDirectory), "client.js");
    let handoff: { id: string; factory(): Record<string, any> } | undefined;
    runInNewContext(readFileSync(clientPath, "utf8"), {
      window: { __ModuleLoader__: { load: (value: typeof handoff) => { handoff = value; } } }
    });
    expect(handoff?.id).toBe("@memmy/memmy-memory");

    let definition: Record<string, any> | undefined;
    const client = handoff?.factory();
    expect(client?.inject).toEqual([]);
    client?.apply({
      get(name: string) {
        return name === "conversationEvents"
          ? { register: (value: Record<string, any>) => { definition = value; } }
          : undefined;
      }
    });
    const message = {
      id: "user-1",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "立即显示这条消息" }]
    };
    const inserted = {
      type: "agent/inbox/spliced",
      seq: 10,
      time: 1000,
      data: { target: "next-turn", start: 0, inserted: [message] }
    };
    const startMatch = { ...definition?.match(inserted), event: inserted, location: { kind: "session" } };
    const state = definition?.start({}, startMatch);
    const context = {
      key: "optimistic:user-1",
      id: "user-1",
      state,
      start: startMatch,
      matches: [startMatch]
    };

    expect(definition?.buildViewNode(context)).toMatchObject({
      kind: "user",
      anchorSeq: 10,
      visibility: "visible",
      data: { kind: "user", content: message.content }
    });
    const durable = { type: "user/message", seq: 14, time: 2000, data: message };
    expect(definition?.match(durable)).toEqual({ id: "user-1", role: "update" });
    const settled = definition?.update({ ...context, state }, { event: durable });
    expect(definition?.buildViewNode({ ...context, state: settled })).toMatchObject({
      key: "optimistic:user-1",
      visibility: "hidden"
    });
  });

  it("prefers the uiConversation event registry when both APIs are available", async () => {
    const rootDirectory = createRoot();
    const target = createDeepseekHarnessSkillTarget({ rootDirectory });
    await target.installPlugin?.("deepseek_harness");
    const clientPath = join(installedPluginDirectory(rootDirectory), "client.js");
    let handoff: { id: string; factory(): Record<string, any> } | undefined;
    runInNewContext(readFileSync(clientPath, "utf8"), {
      window: { __ModuleLoader__: { load: (value: typeof handoff) => { handoff = value; } } }
    });

    let modernRegistrations = 0;
    let legacyRegistrations = 0;
    const client = handoff?.factory();
    client?.apply({
      get(name: string) {
        if (name === "uiConversation") {
          return { events: { register: () => { modernRegistrations += 1; } } };
        }
        if (name === "conversationEvents") {
          return { register: () => { legacyRegistrations += 1; } };
        }
        return undefined;
      }
    });

    expect(modernRegistrations).toBe(1);
    expect(legacyRegistrations).toBe(0);
  });

  it("fails clearly when neither conversation event API is available", async () => {
    const rootDirectory = createRoot();
    const target = createDeepseekHarnessSkillTarget({ rootDirectory });
    await target.installPlugin?.("deepseek_harness");
    const clientPath = join(installedPluginDirectory(rootDirectory), "client.js");
    let handoff: { id: string; factory(): Record<string, any> } | undefined;
    runInNewContext(readFileSync(clientPath, "utf8"), {
      window: { __ModuleLoader__: { load: (value: typeof handoff) => { handoff = value; } } }
    });

    const client = handoff?.factory();
    expect(() => client?.apply({ get: () => undefined })).toThrow(
      "memmy-memory requires uiConversation.events or conversationEvents"
    );
  });

  it("replaces legacy versioned patch markers", async () => {
    const rootDirectory = createRoot();
    const patchPath = join(rootDirectory, "cordis.patch.yml");
    writeFileSync(patchPath, [
      "# memmy-memory plugin:start",
      "- insert:",
      "    - id: memmy-memory",
      "      name: '/old/current/index.mjs'",
      "# memmy-memory plugin:end",
      "# memmy-memory plugin:start v=1",
      "- insert:",
      "    - id: memmy-memory",
      "      name: '/old/memmy-memory/index.mjs'",
      "# memmy-memory plugin:end v=1",
      ""
    ].join("\n"), "utf8");
    const target = createDeepseekHarnessSkillTarget({ rootDirectory });

    await target.installPlugin?.("deepseek_harness");

    const patch = readFileSync(patchPath, "utf8");
    expect(patch).toContain("# memmy-memory plugin:start\n");
    expect(patch).not.toContain(" v=1");
    expect(YAML.parse(patch)).toHaveLength(1);
  });

  it("injects memory after the query and captures reasoning with annotated tool traces", async () => {
    const rootDirectory = createRoot();
    installDshPackageStubs(rootDirectory);
    const target = createDeepseekHarnessSkillTarget({
      rootDirectory,
      memmyConfigPath: join(rootDirectory, "missing-memmy-config.yaml")
    });
    await target.installPlugin?.("deepseek_harness");
    const pluginPath = join(installedPluginDirectory(rootDirectory), "index.mjs");
    const plugin = await import(pathToFileURL(pluginPath).href + "?test=" + crypto.randomUUID()) as {
      apply(ctx: Record<string, unknown>, config?: Record<string, unknown>): void;
    };
    const listeners = new Map<string, (...args: any[]) => any>();
    const registeredTools: Array<Record<string, any>> = [];
    const ctx = {
      logger: { warn: vi.fn() },
      systemPrompt: { section: vi.fn() },
      tools: { register: (tool: Record<string, any>) => registeredTools.push(tool) },
      on: (event: string, listener: (...args: any[]) => any) => {
        listeners.set(event, listener);
        return () => listeners.delete(event);
      },
      effect: (register: () => unknown) => {
        register();
        return () => undefined;
      }
    };
    plugin.apply(ctx);
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const targetUrl = url instanceof Request ? new URL(url.url) : url instanceof URL ? url : new URL(String(url));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      requests.push({ path: targetUrl.pathname, body });
      if (targetUrl.pathname === "/api/v1/sessions/open") return jsonResponse({ sessionId: "memmy-session-1" });
      if (targetUrl.pathname === "/api/v1/turns/start") {
        return jsonResponse({
          turnId: "memmy-turn-1",
          sourceMemoryIds: ["memory-1"],
          injectedContext: { markdown: "User prefers concise answers." }
        });
      }
      if (targetUrl.pathname === "/api/v1/turns/memmy-turn-1/complete") return jsonResponse({ ok: true });
      return jsonResponse({}, 404);
    }));
    const session = { id: "dsh-session-1", header: { cwd: "/project", agentPreset: "web" } };
    const agent = { id: "agent-1", session };
    const userMessage = {
      id: "user-1",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "检查 README" }]
    };
    const runtimeContext = {
      id: "runtime-context-1",
      role: "user",
      source: { kind: "runtime-context" },
      content: [{ type: "text", text: "Current runtime context." }]
    };

    listeners.get("session/event")?.(session, { type: "turn/start", data: { turn: 1 } });
    const decision = await listeners.get("agent/pre-step")?.(
      { agent, messages: [userMessage], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: [userMessage, runtimeContext] })
    ) as { messages: Array<{ source: { kind: string }; content: Array<{ text: string }> }> };

    expect(decision.messages[0]).toBe(userMessage);
    expect(decision.messages[1]?.source.kind).toBe("plugin");
    expect(decision.messages[1]?.content[0]?.text).toContain("User prefers concise answers.");
    expect(decision.messages[1]?.content[0]?.text).toContain("<current_user_request>\n检查 README");
    expect(decision.messages[2]).toBe(runtimeContext);

    listeners.get("session/event")?.(session, { type: "user/message", data: userMessage });
    listeners.get("session/event")?.(session, {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: "reasoning", text: "先分析 README 的内容。" },
            { type: "text", text: "我先读取 README。" },
            { type: "tool-call", id: "call-1", name: "read", arguments: '{"filePath":"README.md"}' }
          ]
        }
      }
    });
    listeners.get("session/event")?.(session, {
      type: "tool/call",
      data: { turn: 1, step: 1, callId: "call-1", name: "read", arguments: '{"filePath":"README.md"}' }
    });
    listeners.get("session/event")?.(session, {
      type: "tool/result",
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: "tool", callId: "call-1" },
          content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "README contents" }] }]
        }
      }
    });
    listeners.get("session/event")?.(session, {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: "reasoning", text: "README 已读取，可以给出结论。" },
            { type: "text", text: "检查完成" }
          ]
        }
      }
    });
    listeners.get("session/event")?.(session, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } }
    });
    await listeners.get("session/flush")?.(session);

    expect(registeredTools.map((tool) => tool.name)).toEqual([
      "memmy_memory_search",
      "memmy_memory_get",
      "memmy_memory_add"
    ]);
    expect(requests.find((request) => request.path === "/api/v1/turns/start")?.body).toMatchObject({
      query: "检查 README",
      source: "deepseek_harness"
    });
    expect(requests.find((request) => request.path.endsWith("/complete"))?.body).toMatchObject({
      sessionId: "memmy-session-1",
      query: "检查 README",
      answer: "我先读取 README。\n\n检查完成",
      reasoningSummary: "先分析 README 的内容。\n\nREADME 已读取，可以给出结论。",
      status: "succeeded",
      source: "deepseek_harness",
      toolCalls: [{
        id: "call-1",
        name: "read",
        arguments: { filePath: "README.md" },
        thinkingBefore: "先分析 README 的内容。",
        assistantTextBefore: "我先读取 README。"
      }],
      toolResults: [{ tool_call_id: "call-1", output: "README contents" }],
      sourceMemoryIds: ["memory-1"]
    });
  });
});

function createRoot(): string {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-dsh-target-"));
  const rootDirectory = join(tempDir, ".dsh");
  mkdirSync(join(rootDirectory, "profiles"), { recursive: true });
  return rootDirectory;
}

function installedPluginDirectory(rootDirectory: string): string {
  return join(rootDirectory, "profiles", "node_modules", "@memmy", "memmy-memory");
}

function installDshPackageStubs(rootDirectory: string): void {
  const nodeModules = join(rootDirectory, "profiles", "node_modules", "@deepseek-ai");
  for (const [name, source] of [
    ["dsh-llm", "export function createUserMessage(input) { return { id: 'plugin-message', role: 'user', ...input }; }\n"],
    ["dsh-tools", "export function defineTool(options) { return options; }\n"]
  ]) {
    const directory = join(nodeModules, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@deepseek-ai/${name}`, type: "module", exports: "./index.js" }), "utf8");
    writeFileSync(join(directory, "index.js"), source, "utf8");
  }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
