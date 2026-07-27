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
});
