import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setConfigPath } from "../../../../src/config/loader.js";
import {
  BROWSER_TOOL_CLASSES,
  BROWSER_TOOL_NAMES,
  BrowserNavigateTool,
  BrowserSessionManager,
  BrowserTakeScreenshotTool,
  type BrowserRuntimeLoader,
} from "../../../../src/core/agent-runtime/tools/browser.js";
import {
  RequestContext,
  ToolContext,
} from "../../../../src/core/agent-runtime/tools/context.js";
import type {
  BrowserPreparationState,
} from "../../../../src/core/agent-runtime/tools/browser-setup.js";
import {
  waitForBrowserPreparation,
} from "../../../../src/core/agent-runtime/tools/browser-preparation-wait.js";
import { ToolLoader } from "../../../../src/core/agent-runtime/tools/loader.js";
import { ToolRegistry } from "../../../../src/core/agent-runtime/tools/registry.js";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const READ_ONLY_TOOLS = new Set([
  "browser_snapshot",
  "browser_find",
  "browser_console_messages",
  "browser_network_requests",
  "browser_take_screenshot",
]);

type FakeRuntimeState = {
  launches: number;
  contexts: Array<{ id: number; close: ReturnType<typeof vi.fn> }>;
  connections: number;
  connectionConfigs: Array<Record<string, any>>;
  calls: Array<{ contextId: number; name: string; arguments: Record<string, any> }>;
  maxGlobalCalls: number;
  maxCallsByContext: Map<number, number>;
};

const roots: string[] = [];
const managers: BrowserSessionManager[] = [];
const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-browser-tool-"));
  roots.push(root);
  return root;
}

function browserToolDefinitions(): Array<Record<string, any>> {
  return BROWSER_TOOL_NAMES.map((name) => ({
    name,
    description: `${name} description`,
    annotations: { readOnlyHint: READ_ONLY_TOOLS.has(name) },
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        delay: { type: "integer" },
        fail: { type: "boolean" },
        filename: { type: "string" },
        nested: {
          type: "object",
          properties: { filename: { type: "string" }, value: { type: "string" } },
          required: ["filename", "value"],
        },
      },
      required: ["filename"],
    },
  }));
}

function fakeRuntime(
  root: string,
  { executableReady = true }: { executableReady?: boolean } = {},
): {
  runtimeLoader: BrowserRuntimeLoader;
  state: FakeRuntimeState;
} {
  const executablePath = path.join(root, "chromium");
  if (executableReady) fs.writeFileSync(executablePath, "fake", "utf8");
  const state: FakeRuntimeState = {
    launches: 0,
    contexts: [],
    connections: 0,
    connectionConfigs: [],
    calls: [],
    maxGlobalCalls: 0,
    maxCallsByContext: new Map(),
  };
  let nextContextId = 0;
  let activeGlobal = 0;
  const activeByContext = new Map<number, number>();

  const runtimeLoader: BrowserRuntimeLoader = async () => ({
    executablePath,
    chromium: {
      launch: vi.fn(async () => {
        state.launches += 1;
        let connected = true;
        let disconnected: (() => void) | null = null;
        return {
          isConnected: () => connected,
          newContext: vi.fn(async () => {
            const context = {
              id: ++nextContextId,
              close: vi.fn(async () => undefined),
            };
            state.contexts.push(context);
            return context;
          }),
          on: vi.fn((event: string, callback: () => void) => {
            if (event === "disconnected") disconnected = callback;
          }),
          close: vi.fn(async () => {
            if (!connected) return;
            connected = false;
            disconnected?.();
          }),
        } as any;
      }),
    } as any,
    createConnection: async (config, contextGetter) => {
      state.connections += 1;
      state.connectionConfigs.push(structuredClone(config ?? {}));
      let contextPromise: Promise<any> | null = null;
      const getContext = (): Promise<any> => {
        contextPromise ??= contextGetter!();
        return contextPromise;
      };
      const server = new Server(
        { name: "fake-playwright-mcp", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: browserToolDefinitions(),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const context = await getContext();
        const name = request.params.name;
        const args = (request.params.arguments ?? {}) as Record<string, any>;
        state.calls.push({ contextId: context.id, name, arguments: args });
        activeGlobal += 1;
        const contextActive = (activeByContext.get(context.id) ?? 0) + 1;
        activeByContext.set(context.id, contextActive);
        state.maxGlobalCalls = Math.max(state.maxGlobalCalls, activeGlobal);
        state.maxCallsByContext.set(
          context.id,
          Math.max(state.maxCallsByContext.get(context.id) ?? 0, contextActive),
        );
        try {
          if (args.delay) {
            await new Promise((resolve) => setTimeout(resolve, Number(args.delay)));
          }
          if (name === "browser_take_screenshot") {
            return {
              content: [
                { type: "text", text: `screenshot:${context.id}` },
                { type: "image", data: PNG_BASE64, mimeType: "image/png" },
              ],
            };
          }
          if (args.fail) {
            return {
              isError: true,
              content: [{ type: "text", text: `failed:${context.id}` }],
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `${name}:${context.id}:${JSON.stringify(args)}`,
              },
            ],
          };
        } finally {
          activeGlobal -= 1;
          activeByContext.set(context.id, (activeByContext.get(context.id) ?? 1) - 1);
        }
      });
      return server;
    },
  });
  return { runtimeLoader, state };
}

async function createManager(
  root: string,
  config: Record<string, any> = {},
): Promise<{ manager: BrowserSessionManager; state: FakeRuntimeState }> {
  const { runtimeLoader, state } = fakeRuntime(root);
  const manager = new BrowserSessionManager(
    { enabled: true, maxSessions: 4, idleTimeoutS: 900, ...config },
    {
      runtimeLoader,
      restrictLocalFiles: true,
    },
  );
  managers.push(manager);
  await expect(manager.initialize()).resolves.toBe("ready");
  return { manager, state };
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((manager) => manager.close()));
  vi.useRealTimers();
  setConfigPath(null);
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("BrowserSessionManager", () => {
  it("probes once and exposes only narrowed allowlisted schemas", async () => {
    const { manager, state } = await createManager(tmpRoot());

    expect(state.launches).toBe(1);
    expect(state.connections).toBe(1);
    await expect(manager.initialize()).resolves.toBe("ready");
    expect(state.launches).toBe(1);
    expect(BROWSER_TOOL_NAMES.every((name) => manager.definition(name))).toBe(true);
    const schema = manager.definition("browser_navigate")!.inputSchema;
    expect(manager.definition("browser_navigate")!.description).toContain(
      "local .html/.htm path",
    );
    expect(schema.properties.url.description).toContain("local .html/.htm path");
    expect(schema.properties).not.toHaveProperty("filename");
    expect(schema.properties.nested.properties).not.toHaveProperty("filename");
    expect(schema.properties.nested.required).toEqual(["value"]);
    expect(schema.required).toEqual([]);
    expect(state.connectionConfigs[0]).toMatchObject({
      browser: { browserName: "chromium", isolated: false },
      imageResponses: "allow",
      snapshot: { mode: "full" },
      timeouts: { action: 30_000, navigation: 60_000 },
      saveSession: false,
      allowUnrestrictedFileAccess: false,
      codegen: "none",
    });
  });

  it("keeps one context per physical chat and reuses one shared browser", async () => {
    const { manager, state } = await createManager(tmpRoot());
    const chatA = { sessionKey: "shared", channel: "websocket", chatId: "chat-a" };
    const chatB = { sessionKey: "shared", channel: "websocket", chatId: "chat-b" };

    const first = await manager.callTool(chatA, "browser_snapshot", {});
    const second = await manager.callTool(chatA, "browser_snapshot", {});
    const other = await manager.callTool(chatB, "browser_snapshot", {});

    expect(first).toEqual([{ type: "text", text: "browser_snapshot:2:{}" }]);
    expect(second).toEqual(first);
    expect(other).toEqual([{ type: "text", text: "browser_snapshot:3:{}" }]);
    expect(state.launches).toBe(2);
    expect(state.connections).toBe(3);
    expect(state.contexts).toHaveLength(3);
  });

  it("coalesces concurrent creation for the same physical chat", async () => {
    const { manager, state } = await createManager(tmpRoot());
    const chat = { sessionKey: "shared", channel: "websocket", chatId: "chat" };

    await Promise.all([
      manager.callTool(chat, "browser_snapshot", {}),
      manager.callTool(chat, "browser_snapshot", {}),
      manager.callTool(chat, "browser_snapshot", {}),
    ]);

    expect(state.launches).toBe(2);
    expect(state.connections).toBe(2);
    expect(state.contexts).toHaveLength(2);
    expect(new Set(state.calls.map((call) => call.contextId))).toEqual(new Set([2]));
  });

  it("serializes calls within a chat while allowing different chats to run in parallel", async () => {
    const { manager, state } = await createManager(tmpRoot());
    const chatA = { sessionKey: "a", channel: "websocket", chatId: "a" };
    const chatB = { sessionKey: "b", channel: "websocket", chatId: "b" };
    await Promise.all([
      manager.callTool(chatA, "browser_snapshot", {}),
      manager.callTool(chatB, "browser_snapshot", {}),
    ]);
    state.maxGlobalCalls = 0;
    state.maxCallsByContext.clear();

    await Promise.all([
      manager.callTool(chatA, "browser_wait_for", { delay: 25 }),
      manager.callTool(chatA, "browser_wait_for", { delay: 25 }),
      manager.callTool(chatB, "browser_wait_for", { delay: 25 }),
    ]);

    expect(state.maxGlobalCalls).toBe(2);
    expect([...state.maxCallsByContext.values()]).toEqual([1, 1]);
  });

  it("does not evict a session while a call is being acquired or executed", async () => {
    const { manager } = await createManager(tmpRoot(), { maxSessions: 1 });
    const chatA = { sessionKey: "a", channel: "websocket", chatId: "a" };
    const chatB = { sessionKey: "b", channel: "websocket", chatId: "b" };
    await manager.callTool(chatA, "browser_snapshot", {});

    const active = manager.callTool(chatA, "browser_wait_for", { delay: 25 });
    await expect(
      manager.callTool(chatB, "browser_snapshot", {}),
    ).rejects.toThrow("browser session limit reached");
    await expect(active).resolves.toEqual([
      {
        type: "text",
        text: 'browser_wait_for:2:{"delay":25}',
      },
    ]);
  });

  it("closes one chat without disturbing another chat", async () => {
    const { manager, state } = await createManager(tmpRoot());
    const chatA = { sessionKey: "a", channel: "websocket", chatId: "a" };
    const chatB = { sessionKey: "b", channel: "websocket", chatId: "b" };
    await manager.callTool(chatA, "browser_snapshot", {});
    await manager.callTool(chatB, "browser_snapshot", {});
    const contextA = state.contexts[1];
    const contextB = state.contexts[2];

    await manager.closeChat("websocket", "a");
    await manager.callTool(chatB, "browser_snapshot", {});

    expect(contextA.close).toHaveBeenCalled();
    expect(contextB.close).not.toHaveBeenCalled();
    expect(state.contexts).toHaveLength(3);
  });

  it("drops a browser session when its in-memory MCP transport closes", async () => {
    const { manager, state } = await createManager(tmpRoot());
    const chat = { sessionKey: "a", channel: "websocket", chatId: "a" };
    await manager.callTool(chat, "browser_snapshot", {});
    const session = [...(manager as any).sessions.values()][0];

    await session.connection.clientTransport.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect(state.contexts[1].close).toHaveBeenCalled();
    expect((manager as any).sessions.size).toBe(0);
    await manager.callTool(chat, "browser_snapshot", {});
    expect(state.contexts).toHaveLength(3);
  });

  it("invalidates all sessions when the shared browser disconnects", async () => {
    const { manager, state } = await createManager(tmpRoot());
    const chatA = { sessionKey: "a", channel: "websocket", chatId: "a" };
    const chatB = { sessionKey: "b", channel: "websocket", chatId: "b" };
    await manager.callTool(chatA, "browser_snapshot", {});
    await manager.callTool(chatB, "browser_snapshot", {});

    await (manager as any).browser.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect((manager as any).sessions.size).toBe(0);
    expect(state.contexts[1].close).toHaveBeenCalled();
    expect(state.contexts[2].close).toHaveBeenCalled();
    await manager.callTool(chatA, "browser_snapshot", {});
    expect(state.launches).toBe(3);
    expect(state.contexts).toHaveLength(4);
  });

  it("closes the affected session when a browser call is aborted", async () => {
    const { manager, state } = await createManager(tmpRoot());
    const chat = { sessionKey: "a", channel: "websocket", chatId: "a" };
    const controller = new AbortController();
    const pending = manager.callTool(
      chat,
      "browser_wait_for",
      { delay: 100 },
      controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));

    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(state.contexts[1].close).toHaveBeenCalled();
    expect((manager as any).sessions.size).toBe(0);
  });

  it("routes local HTML through a preview and closes it after HTTP navigation", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "index.html"), "<h1>Preview</h1>", "utf8");
    const { manager, state } = await createManager(root);
    const chat = { sessionKey: "a", channel: "websocket", chatId: "a" };

    await manager.callTool(
      chat,
      "browser_navigate",
      { url: "index.html" },
      null,
      { workspace: root, readonlyRoots: [] },
    );
    const previewCall = state.calls.at(-1)!;
    const previewUrl = String(previewCall.arguments.url);
    const session = [...(manager as any).sessions.values()][0];
    const preview = session.preview;
    const close = vi.spyOn(preview, "close");

    expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
    expect(previewUrl).not.toContain(root);
    expect((await fetch(previewUrl)).status).toBe(200);

    await manager.callTool(chat, "browser_navigate", {
      url: "https://example.com",
    });

    expect(state.calls.at(-1)!.arguments.url).toBe("https://example.com");
    expect(session.preview).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    await expect(fetch(previewUrl)).rejects.toThrow();
  });

  it("keeps the active preview when a replacement navigation fails", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "first.html"), "<h1>First</h1>", "utf8");
    fs.writeFileSync(path.join(root, "second.html"), "<h1>Second</h1>", "utf8");
    const { manager, state } = await createManager(root);
    const chat = { sessionKey: "a", channel: "websocket", chatId: "a" };

    await manager.callTool(
      chat,
      "browser_navigate",
      { url: "first.html" },
      null,
      { workspace: root, readonlyRoots: [] },
    );
    const session = [...(manager as any).sessions.values()][0];
    const first = session.preview;
    const closeFirst = vi.spyOn(first, "close");

    await manager.callTool(
      chat,
      "browser_navigate",
      {
        url: "second.html",
        fail: true,
      },
      null,
      { workspace: root, readonlyRoots: [] },
    );
    const failedPreviewUrl = String(state.calls.at(-1)!.arguments.url);
    expect(session.preview).toBe(first);
    expect(closeFirst).not.toHaveBeenCalled();
    await expect(fetch(failedPreviewUrl)).rejects.toThrow();

    await manager.callTool(chat, "browser_navigate", {
      url: "https://example.com",
      fail: true,
    });
    expect(session.preview).toBe(first);
    expect(closeFirst).not.toHaveBeenCalled();

    await manager.closeSession(chat);
    expect(closeFirst).toHaveBeenCalledOnce();
  });

  it("also closes a newly created session for a pre-aborted call", async () => {
    const { manager, state } = await createManager(tmpRoot());
    const controller = new AbortController();
    controller.abort();

    await expect(
      manager.callTool(
        { sessionKey: "a", channel: "websocket", chatId: "a" },
        "browser_snapshot",
        {},
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");

    expect(state.contexts[1].close).toHaveBeenCalled();
    expect((manager as any).sessions.size).toBe(0);
  });

  it("expires idle sessions and evicts the least recently used non-busy session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T00:00:00.000Z"));
    const { manager, state } = await createManager(tmpRoot(), {
      maxSessions: 2,
      idleTimeoutS: 60,
    });
    const chatA = { sessionKey: "a", channel: "websocket", chatId: "a" };
    const chatB = { sessionKey: "b", channel: "websocket", chatId: "b" };
    const chatC = { sessionKey: "c", channel: "websocket", chatId: "c" };
    await manager.callTool(chatA, "browser_snapshot", {});
    vi.setSystemTime(new Date("2026-07-25T00:00:01.000Z"));
    await manager.callTool(chatB, "browser_snapshot", {});
    vi.setSystemTime(new Date("2026-07-25T00:00:02.000Z"));
    await manager.callTool(chatB, "browser_snapshot", {});
    await manager.callTool(chatC, "browser_snapshot", {});

    expect(state.contexts[1].close).toHaveBeenCalled();
    expect(state.contexts[2].close).not.toHaveBeenCalled();
    expect((manager as any).sessions.size).toBe(2);

    vi.setSystemTime(new Date("2026-07-25T00:02:00.000Z"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect((manager as any).sessions.size).toBe(0);
  });

  it("does not initialize a disabled capability", async () => {
    const { runtimeLoader, state } = fakeRuntime(tmpRoot());
    const manager = new BrowserSessionManager({ enabled: false }, { runtimeLoader });
    managers.push(manager);

    await expect(manager.initialize()).resolves.toBe("disabled");
    expect(state.launches).toBe(0);
    expect(manager.definition("browser_navigate")).toBeNull();
  });

  it("keeps browser tools unregistered when the managed executable is unavailable", async () => {
    const launch = vi.fn();
    const manager = new BrowserSessionManager(
      { enabled: true },
      {
        runtimeLoader: async () => ({
          executablePath: path.join(tmpRoot(), "missing-chromium"),
          chromium: { launch } as any,
          createConnection: vi.fn(),
        }),
      },
    );
    managers.push(manager);

    await expect(manager.initialize()).resolves.toBe("unavailable");
    expect(launch).not.toHaveBeenCalled();
    const registry = new ToolRegistry();
    new ToolLoader({ testClasses: [...BROWSER_TOOL_CLASSES] as any }).load(
      new ToolContext({ browserSessionManager: manager }),
      registry,
    );
    expect(registry.toolNames).toEqual([]);
  });

  it("waits in the original tool call and continues after Chromium becomes ready", async () => {
    const root = tmpRoot();
    const executablePath = path.join(root, "chromium");
    const { runtimeLoader, state } = fakeRuntime(root, { executableReady: false });
    const preparationStartedAt = new Date().toISOString();
    let preparationState: BrowserPreparationState = {
      status: "preparing",
      updatedAt: preparationStartedAt,
      startedAt: preparationStartedAt,
      lastProgressAt: preparationStartedAt,
      progressPercent: 0,
    };
    const manager = new BrowserSessionManager(
      { enabled: true },
      {
        runtimeLoader,
        preparationStateLoader: () => preparationState,
      },
    );
    managers.push(manager);

    await expect(manager.initialize()).resolves.toBe("preparing");
    expect(state.launches).toBe(0);
    const registry = new ToolRegistry();
    new ToolLoader({ testClasses: [...BROWSER_TOOL_CLASSES] as any }).load(
      new ToolContext({ browserSessionManager: manager }),
      registry,
    );
    expect(registry.toolNames).toEqual([...BROWSER_TOOL_NAMES].sort());
    const tool = registry.get("browser_navigate") as BrowserNavigateTool;
    tool.setContext(new RequestContext({
      sessionKey: "session",
      channel: "websocket",
      chatId: "chat",
      workspace: root,
    }));

    let settled = false;
    const controller = new AbortController();
    const cancelledExecution = tool.execute(
      { url: "https://cancelled.example.com" },
      { abortSignal: controller.signal },
    );
    const execution = tool.execute({ url: "https://example.com" }).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    controller.abort();
    await expect(cancelledExecution).rejects.toMatchObject({ name: "AbortError" });

    fs.writeFileSync(executablePath, "fake", "utf8");
    preparationState = {
      status: "ready",
      updatedAt: new Date().toISOString(),
      executablePath,
    };
    await expect(execution).resolves.toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("browser_navigate"),
      }),
    ]);
    expect(manager.capability).toBe("ready");
    expect(state.launches).toBe(2);
  });

  it("fails preparation waiting with the recorded unavailable reason", async () => {
    await expect(waitForBrowserPreparation({
      loadState: () => ({
        status: "unavailable",
        updatedAt: "2026-07-28T00:00:00.000Z",
        error: "download failed",
      }),
      isExecutableReady: () => false,
    })).rejects.toThrow("浏览器组件准备失败：download failed");
  });

  it("bounds preparation waiting by inactivity and total duration", async () => {
    let now = Date.parse("2026-07-28T00:02:01.000Z");
    const sleep = vi.fn(async () => undefined);
    await expect(waitForBrowserPreparation({
      loadState: () => ({
        status: "preparing",
        updatedAt: "2026-07-28T00:00:00.000Z",
        startedAt: "2026-07-28T00:00:00.000Z",
        lastProgressAt: "2026-07-28T00:00:00.000Z",
        progressPercent: 0,
      }),
      isExecutableReady: () => false,
      now: () => now,
      sleep,
    })).rejects.toThrow("浏览器组件下载无进度，准备失败");

    now = Date.parse("2026-07-28T00:15:01.000Z");
    await expect(waitForBrowserPreparation({
      loadState: () => ({
        status: "preparing",
        updatedAt: "2026-07-28T00:14:30.000Z",
        startedAt: "2026-07-28T00:00:00.000Z",
        lastProgressAt: "2026-07-28T00:14:30.000Z",
        progressPercent: 90,
      }),
      isExecutableReady: () => false,
      now: () => now,
      sleep,
    })).rejects.toThrow("浏览器组件下载超时，准备失败");
  });

  it("cancels only the waiting browser tool caller", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitForBrowserPreparation({
      loadState: () => ({
        status: "preparing",
        updatedAt: new Date().toISOString(),
      }),
      isExecutableReady: () => false,
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ignores a stale unavailable state from a previous desktop attempt", async () => {
    const root = tmpRoot();
    const executablePath = path.join(root, "chromium");
    const { runtimeLoader } = fakeRuntime(root, { executableReady: false });
    let preparationState: BrowserPreparationState = {
      status: "unavailable",
      attemptId: "previous-attempt",
      updatedAt: "2026-07-27T00:00:00.000Z",
      error: "previous download failed",
    };
    const manager = new BrowserSessionManager(
      { enabled: true },
      {
        runtimeLoader,
        desktopManaged: true,
        preparationAttemptId: "current-attempt",
        preparationStateLoader: () => preparationState,
      },
    );
    managers.push(manager);

    await expect(manager.initialize()).resolves.toBe("preparing");
    const registry = new ToolRegistry();
    new ToolLoader({ testClasses: [...BROWSER_TOOL_CLASSES] as any }).load(
      new ToolContext({ browserSessionManager: manager }),
      registry,
    );
    expect(registry.toolNames).toEqual([...BROWSER_TOOL_NAMES].sort());
    const tool = registry.get("browser_navigate") as BrowserNavigateTool;
    tool.setContext(new RequestContext({
      sessionKey: "session",
      channel: "websocket",
      chatId: "chat",
      workspace: root,
    }));
    const execution = tool.execute({ url: "https://example.com" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(executablePath, "fake", "utf8");
    preparationState = {
      status: "ready",
      attemptId: "current-attempt",
      updatedAt: new Date().toISOString(),
      executablePath,
    };
    await expect(execution).resolves.toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("browser_navigate"),
      }),
    ]);
  });
});

describe("browser tool wrappers", () => {
  it("registers all browser tools only when the capability is ready", async () => {
    const { manager } = await createManager(tmpRoot());
    const registry = new ToolRegistry();
    const loader = new ToolLoader({
      testClasses: [...BROWSER_TOOL_CLASSES] as any,
    });

    loader.load(new ToolContext({ browserSessionManager: manager }), registry);

    expect(registry.toolNames).toEqual([...BROWSER_TOOL_NAMES].sort());

    const subagentRegistry = new ToolRegistry();
    loader.load(
      new ToolContext({ browserSessionManager: manager }),
      subagentRegistry,
      { scope: "subagent" },
    );
    expect(subagentRegistry.toolNames).toEqual([]);
  });

  it("requires trusted runtime context and rejects non-HTTP navigation", async () => {
    const { manager } = await createManager(tmpRoot());
    const tool = BrowserNavigateTool.create({
      browserSessionManager: manager,
    }) as BrowserNavigateTool;

    await expect(tool.execute({ url: "https://example.com" })).rejects.toThrow(
      "trusted chat context",
    );
    tool.setContext(
      new RequestContext({
        sessionKey: "session",
        channel: "websocket",
        chatId: "chat",
        workspace: process.cwd(),
      }),
    );
    await expect(tool.execute({ url: "file:///tmp/page.html" })).rejects.toThrow(
      "invalid browser URL",
    );
    expect((manager as any).sessions.size).toBe(0);
    await expect(tool.execute({ url: "https://example.com" })).resolves.toEqual([
      {
        type: "text",
        text: 'browser_navigate:2:{"url":"https://example.com"}',
      },
    ]);
  });

  it("stores screenshot blocks and returns them as model-visible image_url content", async () => {
    const root = tmpRoot();
    process.env.MEMMY_AGENT_DATA_DIR = root;
    setConfigPath(path.join(root, "config.yaml"));
    const { manager } = await createManager(root);
    const tool = BrowserTakeScreenshotTool.create({
      browserSessionManager: manager,
    }) as BrowserTakeScreenshotTool;
    tool.setContext(
      new RequestContext({
        sessionKey: "session",
        channel: "websocket",
        chatId: "chat",
        workspace: process.cwd(),
      }),
    );

    const result = await tool.execute({});

    expect(result[0]).toEqual({ type: "text", text: "screenshot:2" });
    expect(result[1]).toMatchObject({
      type: "image_url",
      image_url: {
        url: expect.stringMatching(/^data:image\/png;base64,/),
        detail: "auto",
      },
      meta: { path: expect.any(String) },
    });
    expect(fs.existsSync((result[1] as any).meta.path)).toBe(true);
    expect((result[1] as any).meta.path).toContain(
      path.join("media", "tool-results"),
    );
    const storedPath = (result[1] as any).meta.path;
    await manager.closeSession({
      sessionKey: "session",
      channel: "websocket",
      chatId: "chat",
    });
    expect(fs.existsSync(storedPath)).toBe(true);
  });
});
