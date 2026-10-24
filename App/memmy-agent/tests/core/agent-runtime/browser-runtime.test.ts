import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../../src/config/schema.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Tool } from "../../../src/core/agent-runtime/tools/base.js";
import {
  BROWSER_TOOL_NAMES,
  type BrowserToolName,
} from "../../../src/core/agent-runtime/tools/browser.js";

const roots: string[] = [];

class ExistingMcpTool extends Tool {
  get name(): string {
    return "mcp_docs_search";
  }

  get description(): string {
    return "Existing connected MCP tool.";
  }

  get parameters(): Record<string, any> {
    return { type: "object", properties: {} };
  }

  execute(): string {
    return "ok";
  }
}

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-browser-runtime-"));
  roots.push(value);
  return value;
}

function fakeBrowserManager(): any {
  return {
    capability: "unknown",
    supportsEmbeddedTabs: vi.fn(() => false),
    supportsCdpTabs: vi.fn(() => false),
    supportsTabListing: vi.fn(() => false),
    initialize: vi.fn(async function (this: any) {
      this.capability = "ready";
      return "ready";
    }),
    definition: vi.fn((name: BrowserToolName) => ({
      name,
      description: `${name} description`,
      inputSchema: { type: "object", properties: {}, required: [] },
    })),
    close: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined),
    closeChat: vi.fn(async () => undefined),
    callTool: vi.fn(async () => [{ type: "text", text: "ok" }]),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const value of roots.splice(0)) {
    fs.rmSync(value, { recursive: true, force: true });
  }
});

describe("AgentLoop browser runtime registration", () => {
  it("keeps the workspace turn-scoped while preserving file restriction state", () => {
    const workspace = root();
    const loop = new AgentLoop({
      config: new Config({
        tools: {
          restrictToWorkspace: true,
          browser: { enabled: true },
        },
      }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace,
    });

    expect((loop.browserSessionManager as any).workspace).toBeUndefined();
    expect((loop.browserSessionManager as any).restrictLocalFiles).toBe(true);
  });

  it("probes at runtime initialization and preserves already connected MCP tools", async () => {
    const loop = new AgentLoop({
      config: new Config({ tools: { browser: { enabled: true } } }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: root(),
    });
    const browser = fakeBrowserManager();
    loop.browserSessionManager = browser;
    loop.tools.register(new ExistingMcpTool());
    const connectMcp = vi.spyOn(loop, "connectMcp").mockResolvedValue();

    expect(loop.toolNames).not.toEqual(
      expect.arrayContaining([...BROWSER_TOOL_NAMES]),
    );
    await loop.initializeRuntimeTools();

    expect(browser.initialize).toHaveBeenCalledOnce();
    expect(connectMcp).toHaveBeenCalledOnce();
    expect(loop.toolNames).toEqual(
      expect.arrayContaining([
        ...BROWSER_TOOL_NAMES,
        "mcp_docs_search",
      ]),
    );
  });

  it("keeps browser capability cached while ordinary MCP refresh remains callable", async () => {
    const loop = new AgentLoop({
      config: new Config({ tools: { browser: { enabled: true } } }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: root(),
    });
    const browser = fakeBrowserManager();
    loop.browserSessionManager = browser;
    const connectMcp = vi.spyOn(loop, "connectMcp").mockResolvedValue();

    await loop.initializeRuntimeTools();
    const registered = loop.tools.get("browser_snapshot");
    await loop.initializeRuntimeTools();

    expect(browser.initialize).toHaveBeenCalledTimes(2);
    expect(connectMcp).toHaveBeenCalledTimes(2);
    expect(loop.tools.get("browser_snapshot")).toBe(registered);
  });

  it("shares startup initialization with a direct scheduled turn before processing it", async () => {
    const loop = new AgentLoop({
      config: new Config({ tools: { browser: { enabled: true } } }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: root(),
    });
    const browser = fakeBrowserManager();
    loop.browserSessionManager = browser;
    let finishConnection!: () => void;
    const connection = new Promise<void>((resolve) => { finishConnection = resolve; });
    const connectMcp = vi.spyOn(loop, "connectMcp").mockImplementation(() => connection);
    const processMessage = vi.spyOn(loop, "processMessageInternal").mockResolvedValue(null);
    const running = loop.run();
    let direct: Promise<unknown> | undefined;

    try {
      await vi.waitFor(() => expect(connectMcp).toHaveBeenCalledOnce());
      direct = loop.processDirect("scheduled task", { sessionKey: "cron:startup" });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(connectMcp).toHaveBeenCalledOnce();
      expect(browser.initialize).not.toHaveBeenCalled();
      expect(processMessage).not.toHaveBeenCalled();

      finishConnection();
      await direct;
      expect(browser.initialize).toHaveBeenCalledOnce();
      expect(processMessage).toHaveBeenCalledOnce();
      expect(loop.toolNames).toEqual(expect.arrayContaining([...BROWSER_TOOL_NAMES]));
    } finally {
      loop.stop();
      finishConnection();
      await Promise.allSettled([running, direct]);
    }
  });

  it("shares a failed initialization attempt and retries after it settles", async () => {
    const loop = new AgentLoop({
      config: new Config({ tools: { browser: { enabled: true } } }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: root(),
    });
    const browser = fakeBrowserManager();
    browser.initialize.mockRejectedValueOnce(new Error("probe failed"));
    loop.browserSessionManager = browser;
    const connectMcp = vi.spyOn(loop, "connectMcp").mockResolvedValue();
    const first = loop.initializeRuntimeTools();
    const concurrent = loop.initializeRuntimeTools();

    expect(concurrent).toBe(first);
    await expect(Promise.all([first, concurrent])).rejects.toThrow("probe failed");
    expect(connectMcp).toHaveBeenCalledOnce();
    expect(browser.initialize).toHaveBeenCalledOnce();

    await loop.initializeRuntimeTools();
    expect(connectMcp).toHaveBeenCalledTimes(2);
    expect(browser.initialize).toHaveBeenCalledTimes(2);
    expect(loop.toolNames).toEqual(expect.arrayContaining([...BROWSER_TOOL_NAMES]));
  });

  it.each(["ready", "failed"] as const)("waits for %s startup initialization before closing resources and prevents reopening them", async (outcome) => {
    const loop = new AgentLoop({
      config: new Config({ tools: { browser: { enabled: true } } }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: root(),
    });
    const browser = fakeBrowserManager();
    loop.browserSessionManager = browser;
    const events: string[] = [];
    let finishConnection!: () => void;
    let finishBrowser!: () => void;
    const connection = new Promise<void>((resolve) => { finishConnection = resolve; });
    const browserInitialization = new Promise<void>((resolve) => { finishBrowser = resolve; });
    vi.spyOn(loop, "connectMcp").mockImplementation(async () => {
      events.push("mcp-start");
      await connection;
      events.push("mcp-ready");
    });
    browser.initialize.mockImplementation(async () => {
      events.push("browser-start");
      await browserInitialization;
      events.push(`browser-${outcome}`);
      if (outcome === "failed") throw new Error("probe failed");
      browser.capability = "ready";
      return "ready";
    });
    browser.close.mockImplementation(async () => { events.push("browser-close"); });
    vi.spyOn(loop, "closeMcp").mockImplementation(async () => { events.push("mcp-close"); });
    const initialization = loop.initializeRuntimeTools();
    const initializationResult = initialization.catch((error: unknown) => error);
    const closing = loop.closeRuntimeTools();

    try {
      await vi.waitFor(() => expect(events).toEqual(["mcp-start"]));
      await expect(loop.initializeRuntimeTools()).rejects.toThrow("Agent runtime tools are closed");
      expect(browser.close).not.toHaveBeenCalled();

      finishConnection();
      await vi.waitFor(() => expect(browser.initialize).toHaveBeenCalledOnce());
      expect(browser.close).not.toHaveBeenCalled();
      finishBrowser();
      await Promise.all([initializationResult, closing]);

      expect(events).toEqual(["mcp-start", "mcp-ready", "browser-start", `browser-${outcome}`, "browser-close", "mcp-close"]);
      await expect(loop.initializeRuntimeTools()).rejects.toThrow("Agent runtime tools are closed");
      expect(browser.initialize).toHaveBeenCalledOnce();
    } finally {
      finishConnection();
      finishBrowser();
      await Promise.allSettled([initializationResult, closing]);
    }
  });

  it("routes reset, chat deletion, and runtime shutdown to browser cleanup", async () => {
    const loop = new AgentLoop({
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: root(),
    });
    const browser = fakeBrowserManager();
    loop.browserSessionManager = browser;
    vi.spyOn(loop, "closeMcp").mockResolvedValue();

    await loop.closeBrowserSession("session", "websocket", "chat");
    await loop.closeBrowserChat("websocket", "chat");
    await loop.closeRuntimeTools();

    expect(browser.closeSession).toHaveBeenCalledWith({
      sessionKey: "session",
      channel: "websocket",
      chatId: "chat",
    });
    expect(browser.closeChat).toHaveBeenCalledWith("websocket", "chat");
    expect(browser.close).toHaveBeenCalledOnce();
    expect(loop.closeMcp).toHaveBeenCalledOnce();
  });

  it("uses one canonical browser scope for IM and GUI projected routes", async () => {
    const loop = new AgentLoop({
      config: new Config({ tools: { browser: { enabled: true } } }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: root(),
    });
    const browser = fakeBrowserManager();
    loop.browserSessionManager = browser;
    vi.spyOn(loop, "connectMcp").mockResolvedValue();
    await loop.initializeRuntimeTools();

    loop.setToolContext(
      "telegram",
      "chat",
      null,
      { webui: true },
      "telegram:chat",
    );
    await loop.tools.get("browser_snapshot")!.execute({});

    loop.setToolContext(
      "websocket",
      "ext_dGVsZWdyYW06Y2hhdA",
      null,
      { webui: true },
      "telegram:chat",
    );
    await loop.tools.get("browser_snapshot")!.execute({});

    expect(browser.callTool.mock.calls.map((call: any[]) => call[0])).toEqual([
      {
        sessionKey: "telegram:chat",
        channel: "projected-session",
        chatId: "telegram:chat",
      },
      {
        sessionKey: "telegram:chat",
        channel: "projected-session",
        chatId: "telegram:chat",
      },
    ]);
  });
});
