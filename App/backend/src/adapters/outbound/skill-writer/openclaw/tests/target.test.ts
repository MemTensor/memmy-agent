/** Target tests. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillManifest } from "../../types.js";
import { createOpenclawSkillTarget } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("openclaw skill target", () => {
  it("installs, replaces, and uninstalls the Memmy marker block in AGENTS.md", async () => {
    const { rootDirectory, manifest } = createFixture();
    const target = createOpenclawSkillTarget({ rootDirectory });

    await target.install(manifest);
    expect(readTargetFile(rootDirectory)).toContain("Call memmy-memory search when context is needed.");
    const skillFile = readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8");
    expect(skillFile).toContain("# Memmy");
    expect(skillFile).toContain("Call memmy-memory search when context is needed.");
    await expect(target.isInstalled("openclaw")).resolves.toBe(true);

    mkdirSync(join(rootDirectory, "workspace"), { recursive: true });
    writeFileSync(
      join(rootDirectory, "workspace", "AGENTS.md"),
      ["manual prefix", "<!-- memmy:start v=1 -->", "old", "<!-- memmy:end v=1 -->", "manual suffix", ""].join("\n"),
      "utf8"
    );
    await target.install(manifest);
    await target.uninstall("openclaw");
    expect(readTargetFile(rootDirectory)).toBe(["manual prefix", "manual suffix", ""].join("\n"));
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
  });

  it("writes AGENTS.md into the workspace configured by OpenClaw", async () => {
    const { rootDirectory, manifest } = createFixture();
    const workspaceDirectory = join(rootDirectory, "custom-workspace");
    writeFileSync(
      join(rootDirectory, "openclaw.json"),
      JSON.stringify({ agents: { defaults: { workspace: workspaceDirectory } } }),
      "utf8"
    );
    const target = createOpenclawSkillTarget({ rootDirectory });

    await target.install(manifest);

    expect(readFileSync(join(workspaceDirectory, "AGENTS.md"), "utf8")).toContain("Call memmy-memory search when context is needed.");
    expect(existsSync(join(rootDirectory, "AGENTS.md"))).toBe(false);
  });

  it("does not create OpenClaw directory when OpenClaw is not installed", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-openclaw-missing-"));
    const rootDirectory = join(tempDir, ".openclaw");
    const target = createOpenclawSkillTarget({ rootDirectory });
    const manifest = createManifest("openclaw");

    await expect(target.resolveRootDirectory()).resolves.toBeNull();
    await expect(target.isInstalled("openclaw")).resolves.toBe(false);
    await expect(target.install(manifest)).rejects.toThrow("OpenClaw is not installed");
    expect(existsSync(rootDirectory)).toBe(false);
  });

  it("installs the native Memmy memory plugin and selects the memory slot", async () => {
    const { rootDirectory } = createFixture();
    const memmyConfigPath = join(rootDirectory, "memmy-config.yaml");
    writeFileSync(
      memmyConfigPath,
      "storage:\n  endpoint: http://127.0.0.1:18991\n  token: test-token\n",
      "utf8"
    );
    writeFileSync(
      join(rootDirectory, "openclaw.json"),
      JSON.stringify({
        plugins: {
          allow: ["existing"],
          deny: ["memmy-memory", "other"],
          entries: {
            "memmy-memory": {
              config: {
                previous: true
              }
            }
          }
        }
      }),
      "utf8"
    );
    const pluginDirectory = join(rootDirectory, "extensions", "memmy-memory");
    mkdirSync(pluginDirectory, { recursive: true });
    mkdirSync(join(rootDirectory, "workspace"), { recursive: true });
    writeFileSync(
      join(rootDirectory, "workspace", "AGENTS.md"),
      ["manual", "<!-- memmy-memory cli : start -->", "old cli", "<!-- memmy-memory cli : end -->", ""].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(pluginDirectory, "package.json"),
      JSON.stringify({ openclaw: { extensions: ["./index.mjs"] } }),
      "utf8"
    );
    const target = createOpenclawSkillTarget({
      rootDirectory,
      memmyConfigPath
    });

    await target.installPlugin?.("openclaw");

    const pluginManifest = JSON.parse(readFileSync(join(pluginDirectory, "openclaw.plugin.json"), "utf8")) as {
      id?: string;
      kind?: string;
      activation?: { onStartup?: boolean };
      contracts?: { tools?: string[] };
      commandAliases?: Array<{ name?: string; kind?: string }>;
      configSchema?: { properties?: Record<string, unknown>; additionalProperties?: boolean };
    };
    const pluginPackage = JSON.parse(readFileSync(join(pluginDirectory, "package.json"), "utf8")) as {
      name?: string;
      type?: string;
      openclaw?: { id?: string; kind?: string; extensions?: string[] };
    };
    const pluginIndex = readFileSync(join(pluginDirectory, "index.mjs"), "utf8");
    const skillFile = readFileSync(join(rootDirectory, "skills", "memmy-memory", "SKILL.md"), "utf8");
    const config = JSON.parse(readFileSync(join(rootDirectory, "openclaw.json"), "utf8")) as {
      plugins?: {
        slots?: { memory?: string };
        allow?: string[];
        deny?: string[];
        entries?: Record<string, { enabled?: boolean; config?: { endpoint?: string; memmyConfigPath?: string; previous?: boolean; token?: string; runtimeConfigPath?: string }; hooks?: { allowConversationAccess?: boolean; allowPromptInjection?: boolean } }>;
        installs?: Record<string, { installPath?: string; source?: string; sourcePath?: string; version?: string; installedAt?: string }>;
      };
    };

    expect(existsSync(join(pluginDirectory, "package.json"))).toBe(true);
    expect(pluginPackage.name).toBe("memmy-memory");
    expect(pluginPackage.type).toBe("module");
    expect(pluginPackage.openclaw).toEqual({
      id: "memmy-memory",
      kind: "memory",
      extensions: ["./index.mjs"]
    });
    expect(pluginManifest.id).toBe("memmy-memory");
    expect(pluginManifest.kind).toBe("memory");
    expect(pluginManifest.activation?.onStartup).toBe(true);
    expect(pluginManifest.contracts?.tools).toEqual([
      "memmy_memory_search",
      "memmy_memory_get",
      "memmy_memory_add"
    ]);
    expect(pluginManifest.commandAliases).toEqual([{ name: "memmy-resume", kind: "runtime-slash" }]);
    expect(pluginManifest.configSchema?.additionalProperties).toBe(false);
    expect(Object.keys(pluginManifest.configSchema?.properties ?? {}).sort()).toEqual([
      "endpoint",
      "memmyConfigPath",
      "token"
    ]);
    expect(pluginIndex).not.toContain("definePluginEntry");
    expect(pluginIndex).toContain('name: "memmy_memory_search"');
    expect(pluginIndex).toContain('name: "memmy_memory_add"');
    expect(pluginIndex).toContain("api.registerCommand");
    expect(pluginIndex).toContain('name: "memmy-resume"');
    expect(pluginIndex).toContain("async function handleResumeCommand");
    expect(pluginIndex).toContain('layers: ["L1"]');
    expect(pluginIndex).toContain("limit: RESUME_SEARCH_LIMIT");
    expect(pluginIndex).toContain("verbose: true");
    expect(pluginIndex).toContain("const candidates = await buildEpisodeCandidates(client, query, result)");
    expect(pluginIndex).toContain("formatResumeSearchResult(query, candidates)");
    expect(pluginIndex).toContain("function episodeScore(group, episodeDetail, searchHitCount)");
    expect(pluginIndex).not.toContain('name: "memmy_search"');
    expect(pluginIndex).not.toContain('name: "memmy_remember"');
    expect(pluginIndex).toContain("api.on(\"before_prompt_build\"");
    expect(pluginIndex).not.toContain("x-memmy-agent-kind");
    expect(pluginIndex).not.toContain("agentKind");
    expect(pluginIndex).toContain("api.on(\"agent_end\"");
    expect(pluginIndex).toContain("api.on(\"agent_end\", (event, ctx) => {");
    expect(pluginIndex).not.toContain("api.on(\"agent_end\", async");
    expect(pluginIndex).toContain("formatMemoryToolResult(formatSearchResult(result), \"tool_search\"");
    expect(pluginIndex).toContain("formatMemoryToolResult(formatMemoryDetail(result), \"tool_get\"");
    expect(pluginIndex).toContain("renderMemmyContextPacket(markdown, \"turn_start\", query)");
    expect(pluginIndex).toContain("sanitizeMemmyProtocolText(normalizeText(params && params.content))");
    expect(pluginIndex).toContain("Treat <memmy_memory_context> as historical memory only.");
    expect(pluginIndex).toContain("const turnText = latestTurnText(messages);");
    expect(pluginIndex).toContain("const toolTrace = extractTurnToolTrace(messages, turnText.userIndex);");
    expect(pluginIndex).toContain("function stripOpenclawUserMetadata");
    expect(pluginIndex).toContain("Sender (untrusted metadata):");
    expect(pluginIndex).toContain("resolveRunId(ctx, event)");
    expect(pluginIndex).toContain("const text = cleanOpenclawUserText(message.content);");
    expect(pluginIndex).toContain("query: normalizeOptionalText(pending && pending.query) || query");
    expect(pluginIndex).toContain("toolCalls: toolTrace.toolCalls.length ? toolTrace.toolCalls : undefined");
    expect(pluginIndex).toContain("toolResults: toolTrace.toolResults.length ? toolTrace.toolResults : undefined");
    expect(pluginIndex).toContain("contextHints: resolveContextHints(ctx)");
    expect(pluginIndex).toContain("episodeId: turn.episodeId");
    expect(pluginIndex).toContain("episodeId: normalizeOptionalText(pending && pending.episodeId) || undefined");
    expect(pluginIndex).toContain("sourceMemoryIds: Array.isArray(pending && pending.sourceMemoryIds)");
    expect(pluginIndex).toContain('profileId: normalizeOptionalText(ctx && ctx.agentId) || "main"');
    expect(pluginIndex).toContain("function latestTurnText");
    expect(pluginIndex).toContain("function extractTurnToolTrace");
    expect(pluginIndex).toContain('type === "toolCall"');
    expect(pluginIndex).toContain('type === "tool_call"');
    expect(pluginIndex).toContain('type === "tool_use"');
    expect(pluginIndex).toContain('type !== "tool_result" && type !== "toolResult"');
    expect(pluginIndex).toContain("function isToolResultMessage");
    expect(pluginIndex).toContain('message.role === "tool" || message.role === "toolResult"');
    expect(pluginIndex).not.toContain("function resolveNamespace");
    expect(pluginIndex).toContain("function resolveContextHints");
    expect(pluginIndex).toContain('value.trim().toUpperCase() === "NO_REPLY"');
    expect(pluginIndex).not.toContain('latestText(messages, "assistant")');
    expect(pluginIndex).toContain("import { spawnSync } from \"node:child_process\";");
    expect(pluginIndex).toContain("function completeTurnSynchronously");
    expect(pluginIndex).toContain("spawnSync(process.execPath");
    expect(pluginIndex).toContain("const SYNC_COMPLETE_SCRIPT = [");
    expect(pluginIndex).toContain('].join("\\n");');
    expect(pluginIndex).not.toContain('].join("\\\\n");');
    expect(pluginIndex).toContain("function fallbackTurnId");
    expect(pluginIndex).toContain("openclaw-fallback-");
    expect(pluginIndex).toContain("hashText([sessionId, query, answer]");
    expect(pluginIndex).toContain("const MEMMY_FETCH_TIMEOUT_MS = 45000;");
    expect(pluginIndex).toContain("const MEMMY_RECALL_TIMEOUT_MS = 45000;");
    expect(pluginIndex).toContain("timeout: 60000,");
    expect(pluginIndex).toContain("}, MEMMY_RECALL_TIMEOUT_MS);");
    expect(pluginIndex).toContain("async function fetchWithTimeout");
    expect(pluginIndex).toContain("new AbortController()");
    expect(pluginIndex).toContain("toolCalls: Array.isArray(payload.toolCalls) ? payload.toolCalls : undefined");
    expect(pluginIndex).toContain("toolResults: Array.isArray(payload.toolResults) ? payload.toolResults : undefined");
    expect(pluginIndex).toContain("episodeId: payload.episodeId || undefined");
    expect(pluginIndex).toContain("mode: 'turn_complete'");
    expect(pluginIndex).not.toContain("mode: 'memory_add'");
    expect(pluginIndex).not.toContain("contentParts.push('User: '");
    expect(pluginIndex).not.toContain("contentParts.push('Assistant: '");
    expect(pluginIndex).toContain('name: "memmy_memory_get"');
    expect(pluginIndex).toContain('client.get("/api/v1/memory/" + encodeURIComponent(id))');
    expect(pluginIndex).toContain('source: normalizeOptionalText(body && body.source) || "openclaw"');
    expect(pluginIndex).toContain("source: 'openclaw'");
    expect(pluginIndex).toContain("function resolveExternalSessionId");
    expect(pluginIndex).toContain('return "openclaw-memory-" +');
    expect(pluginIndex).toContain("const resolved = await readMemmyConfig(cfg.memmyConfigPath).catch(() => ({}));");
    expect(pluginIndex).toContain("resolved.endpoint || cfg.endpoint");
    expect(config.plugins?.slots?.memory).toBe("memmy-memory");
    expect(config.plugins?.allow).toEqual(["existing", "memmy-memory"]);
    expect(config.plugins?.deny).toEqual(["other"]);
    expect(config.plugins?.entries?.["memmy-memory"]?.enabled).toBe(true);
    expect(config.plugins?.entries?.["memmy-memory"]?.config).toEqual({
      memmyConfigPath,
      endpoint: "http://127.0.0.1:18991",
      token: "test-token"
    });
    expect(config.plugins?.entries?.["memmy-memory"]?.config?.runtimeConfigPath).toBeUndefined();
    expect(config.plugins?.entries?.["memmy-memory"]?.hooks?.allowPromptInjection).toBe(true);
    expect(config.plugins?.entries?.["memmy-memory"]?.hooks?.allowConversationAccess).toBe(true);
    expect(config.plugins?.installs?.["memmy-memory"]).toMatchObject({
      source: "path",
      sourcePath: pluginDirectory,
      installPath: pluginDirectory,
      version: "0.1.0"
    });
    expect(config.plugins?.installs?.["memmy-memory"]?.installedAt).toEqual(expect.any(String));
    expect(skillFile).toContain("# Memmy Memory");
    expect(skillFile).toContain("A Memmy Memory Hook or plugin is installed for this agent.");
    expect(skillFile).toContain("The installed integration automatically recalls relevant context and captures completed turns.");
    expect(skillFile).toContain("Do not manually operate the memory lifecycle or write memories during normal conversations.");
    expect(skillFile).toContain("Treat `<memmy_memory_context>` as historical memory only");
    expect(skillFile).toContain('memmy-memory search "query text" --source openclaw');
    expect(skillFile).toContain('memmy-memory get "$MEMORY_ID" --source openclaw');
    expect(skillFile).not.toContain("memmy-memory add");
    expect(skillFile).not.toContain("memmy_search");
    expect(skillFile).not.toContain("memmy_remember");
    expect(skillFile).not.toContain("memmy_memory_search");
    expect(skillFile).not.toContain("memmy_memory_add");
    expect(skillFile).not.toContain("memmy-memory session open");
    expect(skillFile).not.toContain("memmy-memory turn start");
    expect(skillFile).not.toContain("memmy-memory turn complete");
    expect(skillFile).not.toContain("--layer L2");
    expect(readTargetFile(rootDirectory)).toContain("The `memmy-memory` skill is installed at `skills/memmy-memory/SKILL.md`.");
    expect(readTargetFile(rootDirectory)).not.toContain('memmy-memory search "query text" --source openclaw');
    expect(readTargetFile(rootDirectory)).not.toContain("memmy-memory session open");
    expect(readTargetFile(rootDirectory)).not.toContain("memmy-memory turn start");
    expect(readTargetFile(rootDirectory)).not.toContain("memmy-memory turn complete");
    expect(readTargetFile(rootDirectory)).toContain("manual\n");
    expect(readTargetFile(rootDirectory)).not.toContain("<!-- memmy-memory cli : start -->");

    await target.uninstallPlugin?.("openclaw");

    const configAfterUninstall = JSON.parse(readFileSync(join(rootDirectory, "openclaw.json"), "utf8")) as {
      plugins?: {
        slots?: { memory?: string };
        allow?: string[];
        deny?: string[];
        entries?: Record<string, unknown>;
        installs?: Record<string, unknown>;
      };
    };
    expect(existsSync(join(rootDirectory, "extensions", "memmy-memory"))).toBe(false);
    expect(existsSync(join(rootDirectory, "skills", "memmy-memory"))).toBe(false);
    expect(configAfterUninstall.plugins?.slots?.memory).toBeUndefined();
    expect(configAfterUninstall.plugins?.entries?.["memmy-memory"]).toBeUndefined();
    expect(configAfterUninstall.plugins?.installs?.["memmy-memory"]).toBeUndefined();
    expect(configAfterUninstall.plugins?.allow).toEqual(["existing"]);
    expect(configAfterUninstall.plugins?.deny).toEqual(["other"]);
  });

  it("reads the Memmy endpoint from memmyMemory.storage", async () => {
    const { rootDirectory } = createFixture();
    const memmyConfigPath = join(rootDirectory, "memmy-config.yaml");
    writeFileSync(
      memmyConfigPath,
      "memmyMemory:\n  storage:\n    endpoint: http://127.0.0.1:18991\n    token: nested-token\n",
      "utf8"
    );
    writeFileSync(join(rootDirectory, "openclaw.json"), "{}", "utf8");
    const target = createOpenclawSkillTarget({
      rootDirectory,
      memmyConfigPath
    });

    await target.installPlugin?.("openclaw");

    const config = JSON.parse(readFileSync(join(rootDirectory, "openclaw.json"), "utf8")) as {
      plugins?: {
        entries?: Record<string, { config?: { endpoint?: string; token?: string } }>;
      };
    };
    expect(config.plugins?.entries?.["memmy-memory"]?.config).toMatchObject({
      endpoint: "http://127.0.0.1:18991",
      token: "nested-token"
    });
  });

  it("uses only the resume query for the OpenClaw slash command search", async () => {
    const { rootDirectory } = createFixture();
    const target = createOpenclawSkillTarget({ rootDirectory });
    await target.installPlugin?.("openclaw");

    const pluginPath = join(rootDirectory, "extensions", "memmy-memory", "index.mjs");
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?t=${Date.now()}`) as {
      default: {
        register(api: {
          pluginConfig: Record<string, unknown>;
          logger: { warn: (message: string) => void; info: (message: string) => void };
        registerTool: () => void;
        registerMemoryCapability: () => void;
        registerCommand: (command: { name: string; handler: CommandHandler }) => void;
          on: (name: string, handler: HookHandler) => void;
        }): void;
      };
    };
    let commandHandler: CommandHandler | undefined;
    const handlers = new Map<string, HookHandler>();
    const requestBodies: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const targetUrl = url instanceof Request ? new URL(url.url) : url instanceof URL ? url : new URL(String(url));
      if (typeof init?.body === "string") {
        requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      if (targetUrl.pathname === "/api/v1/memory/search") {
        return jsonResponse({ debug: { hits: createResumeHits(6) } });
      }
      const detail = createResumeMemoryDetail(targetUrl.pathname);
      return jsonResponse(detail || {}, detail ? 200 : 404);
    }) as typeof fetch;

    try {
      pluginModule.default.register({
        pluginConfig: {
          endpoint: "http://memmy.test",
          memmyConfigPath: join(rootDirectory, "missing-memmy-config.yaml")
        },
        logger: { warn: vi.fn(), info: vi.fn() },
        registerTool: vi.fn(),
        registerMemoryCapability: vi.fn(),
        registerCommand(command) {
          if (command.name === "memmy-resume") {
            commandHandler = command.handler;
          }
        },
        on(name, handler) {
          handlers.set(name, handler);
        }
      });

      expect(commandHandler).toBeDefined();
      const result = await commandHandler?.({ args: "测试query" });
      expect(result?.text).toContain("测试query");
      expect(result?.text).not.toContain(". score ");
      expect(result?.text).toContain("1. episode_1");
      expect(result?.text).toContain("first_query: First query 1");
      expect(result?.text).toContain("tail_summary: Last L1 summary 1");
      expect(result?.text).not.toContain("Assistant raw summary 1");
      expect(result?.text).not.toContain("6. episode_6");
      expect(result?.text).toContain("Enter 1-5 to select an episode to resume.");
      expect(requestBodies[0]?.query).toBe("测试query");
      expect(requestBodies[0]?.layers).toEqual(["L1"]);
      expect(requestBodies[0]?.limit).toBe(20);
      expect(requestBodies[0]?.verbose).toBe(true);

      const beforePromptBuild = handlers.get("before_prompt_build");
      expect(beforePromptBuild).toBeDefined();
      const selectionResult = await beforePromptBuild?.({ prompt: "1", messages: [] }, {});
      expect(selectionResult?.prependContext).toContain("Episode id: episode_1");
      expect(selectionResult?.prependContext).toContain("Full episode body 1");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("strips OpenClaw inbound metadata before turn start", async () => {
    const { rootDirectory } = createFixture();
    const target = createOpenclawSkillTarget({ rootDirectory });
    await target.installPlugin?.("openclaw");

    const pluginPath = join(rootDirectory, "extensions", "memmy-memory", "index.mjs");
    const pluginModule = await import(`${pathToFileURL(pluginPath).href}?t=${Date.now()}`) as {
      default: {
        register(api: {
          pluginConfig: Record<string, unknown>;
          logger: { warn: (message: string) => void; info: (message: string) => void };
          registerTool: () => void;
          registerMemoryCapability: () => void;
          on: (name: string, handler: HookHandler) => void;
        }): void;
      };
    };
    const handlers = new Map<string, HookHandler>();
    const requestBodies: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const targetUrl = url instanceof URL ? url : new URL(String(url));
      if (typeof init?.body === "string") {
        requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      if (targetUrl.pathname === "/api/v1/sessions/open") {
        return jsonResponse({ sessionId: "session-opened" });
      }
      if (targetUrl.pathname === "/api/v1/turns/start") {
        return jsonResponse({ turnId: "turn-started", episodeId: "episode-started", injectedContext: { markdown: "memory context" } });
      }
      return jsonResponse({}, 404);
    }) as typeof fetch;

    try {
      pluginModule.default.register({
        pluginConfig: {
          endpoint: "http://memmy.test",
          memmyConfigPath: join(rootDirectory, "missing-memmy-config.yaml")
        },
        logger: { warn: vi.fn(), info: vi.fn() },
        registerTool: vi.fn(),
        registerMemoryCapability: vi.fn(),
        on(name, handler) {
          handlers.set(name, handler);
        }
      });

      const beforePromptBuild = handlers.get("before_prompt_build");
      expect(beforePromptBuild).toBeDefined();
      const result = await beforePromptBuild?.(
        {
          prompt: [
            "Sender (untrusted metadata):",
            "```json",
            "{\"label\":\"openclaw-control-ui\",\"id\":\"openclaw-control-ui\"}",
            "```",
            "",
            "[Wed 2026-06-24 20:50 GMT+8] 你好，我最近喜欢喝冰美式"
          ].join("\n"),
          messages: []
        },
        { runId: "run-1", sessionKey: "agent:main:openclaw-control-ui", agentId: "main" }
      );

      expect(result?.prependContext).toContain('<memmy_memory_context source="turn_start">');
      expect(result?.prependContext).toContain("memory context");
      expect(result?.prependContext).toContain("<current_user_request>\n你好，我最近喜欢喝冰美式\n</current_user_request>");
      expect(requestBodies.find((body) => body.query)?.query).toBe("你好，我最近喜欢喝冰美式");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("captures OpenClaw tool traces through the turn complete hook", async () => {
    const { rootDirectory } = createFixture();
    const target = createOpenclawSkillTarget({ rootDirectory });
    await target.installPlugin?.("openclaw");

    const pluginPath = join(rootDirectory, "extensions", "memmy-memory", "index.mjs");
    const pluginSource = readFileSync(pluginPath, "utf8").replace(
      'import { spawnSync } from "node:child_process";',
      "const spawnSync = globalThis.__memmySpawnSync;"
    );
    const spawnInputs: Record<string, unknown>[] = [];
    const fakeSpawnSync = vi.fn((_command: unknown, _args: unknown, options: { input?: string }) => {
      spawnInputs.push(JSON.parse(options.input ?? "{}") as Record<string, unknown>);
      return {
        status: 0,
        stdout: JSON.stringify({ ok: true, mode: "turn_complete" }),
        stderr: ""
      };
    });
    const globals = globalThis as typeof globalThis & { __memmySpawnSync?: typeof fakeSpawnSync };
    globals.__memmySpawnSync = fakeSpawnSync;

    try {
      const pluginModule = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(pluginSource)}#${Date.now()}`) as {
        default: {
          register(api: {
            pluginConfig: Record<string, unknown>;
            logger: { warn: (message: string) => void; info: (message: string) => void };
            registerTool: () => void;
            registerMemoryCapability: () => void;
            on: (name: string, handler: HookHandler) => void;
          }): void;
        };
      };
      const handlers = new Map<string, HookHandler>();
      pluginModule.default.register({
        pluginConfig: {
          endpoint: "http://memmy.test",
          memmyConfigPath: join(rootDirectory, "missing-memmy-config.yaml")
        },
        logger: { warn: vi.fn(), info: vi.fn() },
        registerTool: vi.fn(),
        registerMemoryCapability: vi.fn(),
        on(name, handler) {
          handlers.set(name, handler);
        }
      });

      const agentEnd = handlers.get("agent_end");
      expect(agentEnd).toBeDefined();
      agentEnd?.(
        {
          runId: "run-tools",
          success: true,
          messages: [
            { role: "user", content: "请读取 README 并搜索 TODO" },
            {
              role: "assistant",
              content: [
                { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
                { type: "tool_call", id: "call_2", name: "grep", arguments: { pattern: "TODO" } },
                { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } }
              ]
            },
            {
              role: "toolResult",
              toolCallId: "call_1",
              toolName: "read",
              content: [{ type: "text", text: "read ok" }],
              details: { text: "read ok detail" },
              isError: false
            },
            {
              role: "toolResult",
              toolCallId: "call_2",
              toolName: "grep",
              content: "grep ok",
              details: { matches: 1 },
              isError: false
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu_1", content: "pwd ok" }
              ]
            },
            { role: "assistant", content: "完成" }
          ]
        },
        { runId: "run-tools", sessionKey: "agent:main", agentId: "main" }
      );

      expect(fakeSpawnSync).toHaveBeenCalledTimes(1);
      expect(spawnInputs[0]).toMatchObject({
        turnId: "run-tools",
        query: "请读取 README 并搜索 TODO",
        answer: "完成",
        toolCalls: [
          { id: "call_1", name: "read", arguments: { path: "README.md" } },
          { id: "call_2", name: "grep", arguments: { pattern: "TODO" } },
          { id: "toolu_1", name: "Bash", arguments: { command: "pwd" } }
        ],
        toolResults: [
          { tool_call_id: "call_1", content: "read ok", output: { text: "read ok detail" } },
          { tool_call_id: "call_2", content: "grep ok", output: { matches: 1 } },
          { tool_call_id: "toolu_1", content: "pwd ok", output: "pwd ok" }
        ]
      });
    } finally {
      delete globals.__memmySpawnSync;
    }
  });

  it("detects non-Memmy memory plugin conflicts from openclaw.json", async () => {
    const { rootDirectory } = createFixture();
    const target = createOpenclawSkillTarget({ rootDirectory });

    writeFileSync(
      join(rootDirectory, "openclaw.json"),
      JSON.stringify({ plugins: { slots: { memory: "active-memory" } } }),
      "utf8"
    );
    await expect(target.detectMemoryPluginConflict?.()).resolves.toEqual({
      sourceId: "openclaw",
      displayName: "OpenClaw",
      configPath: join(rootDirectory, "openclaw.json"),
      installedPluginId: "active-memory"
    });

    writeFileSync(
      join(rootDirectory, "openclaw.json"),
      JSON.stringify({ plugins: { slots: { memory: "memmy-memory" } } }),
      "utf8"
    );
    await expect(target.detectMemoryPluginConflict?.()).resolves.toBeNull();

    writeFileSync(
      join(rootDirectory, "openclaw.json"),
      JSON.stringify({
        plugins: {
          entries: { "memos-local-plugin": { enabled: true } },
          installs: { "memos-local-plugin": { source: "registry" } }
        }
      }),
      "utf8"
    );
    await expect(target.detectMemoryPluginConflict?.()).resolves.toBeNull();
  });
});

type HookHandler = (event: unknown, ctx: Record<string, unknown>) => unknown | Promise<unknown>;
type CommandHandler = (ctx: { args?: string }) => Promise<{ text: string }>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function createResumeHits(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_value, index) => ({
    id: `trace_${index + 1}`,
    memoryLayer: "L1",
    title: `Memory ${index + 1}`,
    score: 1 - index * 0.1,
    summary: `Summary ${index + 1}`
  }));
}

function createResumeMemoryDetail(pathname: string): Record<string, unknown> | undefined {
  const id = decodeURIComponent(pathname.replace(/^\/api\/v1\/memory\//u, ""));
  const traceMatch = id.match(/^trace_(\d+)$/u);
  if (traceMatch) {
    return createResumeTraceDetail(Number(traceMatch[1]));
  }
  const episodeMatch = id.match(/^episode_(\d+)$/u);
  if (episodeMatch) {
    return createResumeEpisodeDetail(Number(episodeMatch[1]));
  }
  return undefined;
}

function createResumeTraceDetail(index: number): Record<string, unknown> {
  return {
    id: `trace_${index}`,
    memoryLayer: "L1",
    updatedAt: resumeEpisodeTimestamp(index),
    refs: {
      episode: {
        id: `episode_${index}`,
        title: `Episode ${index}`,
        summary: `Episode summary ${index}`,
        status: "closed",
        startedAt: resumeEpisodeTimestamp(index),
        endedAt: resumeEpisodeTimestamp(index),
        updatedAt: resumeEpisodeTimestamp(index)
      },
      rawTurn: {
        userText: `First query ${index}`
      }
    }
  };
}

function createResumeEpisodeDetail(index: number): Record<string, unknown> {
  return {
    id: `episode_${index}`,
    title: `Episode ${index}`,
    summary: `Episode summary ${index}`,
    updatedAt: resumeEpisodeTimestamp(index),
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

function resumeEpisodeTimestamp(index: number): string {
  return `2026-07-${String(8 - Math.min(index, 7)).padStart(2, "0")}T10:00:00.000Z`;
}

function createFixture(): { rootDirectory: string; manifest: SkillManifest } {
  tempDir = mkdtempSync(join(tmpdir(), "memmy-openclaw-skill-"));
  return {
    rootDirectory: tempDir,
    manifest: createManifest("openclaw")
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
  return readFileSync(join(rootDirectory, "workspace", "AGENTS.md"), "utf8");
}
