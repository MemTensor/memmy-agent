import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import {
  sanitizeName,
  connectMcpServers,
  handleRuntimeControl,
  reloadServers,
  requestMcpReload,
  setMcpRuntimeForTest,
} from "../../../src/core/agent-runtime/tools/mcp.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { Config } from "../../../src/config/schema.js";
import { saveConfig, setConfigPath } from "../../../src/config/loader.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-mcp-connection-"));
  roots.push(root);
  return root;
}

function provider() {
  return {
    getDefaultModel: () => "test-model",
    generation: { maxTokens: 4096 },
  };
}

function makeLoop(root: string, mcpServers: Record<string, any> = {}) {
  return new AgentLoop({
    bus: new MessageBus(),
    provider: provider(),
    workspace: root,
    model: "test-model",
    mcpServers,
  });
}

function fakeSession(toolNames: string[]) {
  return {
    async initialize() {},
    async listTools() {
      return {
        tools: toolNames.map((name) => ({
          name,
          description: `${name} tool`,
          inputSchema: { type: "object", properties: {} },
        })),
      };
    },
    async listResources() {
      return { resources: [] };
    },
    async listPrompts() {
      return { prompts: [] };
    },
    async callTool() {
      return { content: [{ text: "ok" }] };
    },
  };
}

function runtimeFor(
  sessions: Record<string, any>,
  { closed = [], onStdio = null }: { closed?: string[]; onStdio?: ((command: string) => void) | null } = {},
) {
  return {
    ClientSession: class {
      constructor(read: any) {
        return read;
      }
    },
    StdioServerParameters: class {
      command: string;
      constructor(init: any) {
        Object.assign(this, init);
        this.command = init.command;
      }
    },
    stdioClient(params: any) {
      onStdio?.(params.command);
      const session = sessions[params.command];
      if (!session) throw new Error(`cannot connect ${params.command}`);
      return {
        async enter() {
          return [session, {}];
        },
        async close() {
          closed.push(params.command);
        },
      };
    },
    sseClient() {
      throw new Error("sse not used");
    },
    streamableHttpClient() {
      throw new Error("http not used");
    },
  };
}

afterEach(() => {
  setMcpRuntimeForTest(null);
  setConfigPath(path.join(os.tmpdir(), "memmy-agent-empty-config.yaml"));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MCP connection helpers", () => {
  it("sanitizes tool names and safely noops when MCP runtime is unavailable", async () => {
    expect(sanitizeName("mcp/fs.read-file")).toBe("mcp_fs_read-file");
    await expect(connectMcpServers({}, new ToolRegistry())).resolves.toEqual({});
  });

  it("retries MCP connection when no configured server connects", async () => {
    let attempts = 0;
    setMcpRuntimeForTest(runtimeFor({}, { onStdio: () => { attempts += 1; } }) as any);
    const loop = makeLoop(tempRoot(), { test: { command: "missing-mcp" } });

    await loop.connectMcp();
    await loop.connectMcp();

    expect(attempts).toBe(2);
    expect((loop as any).mcpConnected).toBe(false);
    expect((loop as any).mcpStacks).toEqual({});
  });

  it("closes extra transport resources returned by the MCP runtime", async () => {
    const closed: string[] = [];
    setMcpRuntimeForTest({
      ...runtimeFor({ test: fakeSession(["demo"]) }),
      stdioClient() {
        return [fakeSession(["demo"]), {}, { close: async () => closed.push("extra") }];
      },
    } as any);

    const stacks = await connectMcpServers({ test: { command: "test" } }, new ToolRegistry());
    await stacks.test.aclose();

    expect(closed).toEqual(["extra"]);
  });

  it("continues closing MCP resources after a session close failure", async () => {
    const closed: string[] = [];
    setMcpRuntimeForTest({
      ...runtimeFor({}),
      ClientSession: class {
        async enter() {
          return this;
        }
        async close() {
          closed.push("session");
          throw new Error("close failed");
        }
        async initialize() {}
        async listTools() {
          return { tools: [{ name: "demo", description: "demo tool", inputSchema: { type: "object", properties: {} } }] };
        }
        async listResources() {
          return { resources: [] };
        }
        async listPrompts() {
          return { prompts: [] };
        }
      },
      stdioClient() {
        return [{}, {}, { destroy: async () => closed.push("extra") }];
      },
    } as any);

    const stacks = await connectMcpServers({ test: { command: "test" } }, new ToolRegistry());
    await stacks.test.aclose();

    expect(closed).toEqual(["session", "extra"]);
  });

  it("AgentLoop.closeMcp closes connected MCP stacks", async () => {
    const loop = makeLoop(tempRoot(), {});
    const close = vi.fn(async () => undefined);
    (loop as any).mcpStacks = { composio: { aclose: close } };
    (loop as any).mcpConnected = true;

    await loop.closeMcp();

    expect(close).toHaveBeenCalledTimes(1);
    expect((loop as any).mcpStacks).toEqual({});
    expect((loop as any).mcpConnected).toBe(false);
  });

  it("reloads MCP servers by adding and removing tools without restart", async () => {
    const root = tempRoot();
    setConfigPath(path.join(root, "config.yaml"));
    saveConfig(new Config({ tools: { mcpServers: { browserbase: { command: "browserbase-mcp" } } } }));
    const closed: string[] = [];
    setMcpRuntimeForTest(runtimeFor({ "browserbase-mcp": fakeSession(["navigate"]) }, { closed }) as any);
    const loop = makeLoop(root, {});

    const added = await reloadServers(loop as any, loop.tools);

    expect(added).toMatchObject({ ok: true, added: ["browserbase"] });
    expect(loop.tools.has("mcp_browserbase_navigate")).toBe(true);
    expect((loop as any).mcpStacks.browserbase).toBeTruthy();

    saveConfig(new Config({ tools: { mcpServers: {} } }));
    const removed = await reloadServers(loop as any, loop.tools);

    expect(removed).toMatchObject({ ok: true, removed: ["browserbase"] });
    expect(loop.tools.has("mcp_browserbase_navigate")).toBe(false);
    expect((loop as any).mcpStacks.browserbase).toBeUndefined();
    expect(closed).toEqual(["browserbase-mcp"]);
  });

  it("routes MCP reload requests through runtime control without restart", async () => {
    const root = tempRoot();
    setConfigPath(path.join(root, "config.yaml"));
    saveConfig(new Config({ tools: { mcpServers: { browserbase: { command: "browserbase-mcp" } } } }));
    const closed: string[] = [];
    setMcpRuntimeForTest(runtimeFor({ "browserbase-mcp": fakeSession(["navigate"]) }, { closed }) as any);
    const loop = makeLoop(root, {});

    const consumeOnce = async () => {
      const msg = await loop.bus.consumeInbound();
      expect(await handleRuntimeControl(loop as any, msg, loop.tools)).toBe(true);
    };
    let consumer = consumeOnce();
    let result = await requestMcpReload(loop.bus, { timeout: 2 });
    await consumer;

    expect(result).toMatchObject({ ok: true, added: ["browserbase"], requires_restart: false });
    expect(loop.tools.has("mcp_browserbase_navigate")).toBe(true);

    saveConfig(new Config({ tools: { mcpServers: {} } }));
    consumer = consumeOnce();
    result = await requestMcpReload(loop.bus, { timeout: 2 });
    await consumer;

    expect(result).toMatchObject({ ok: true, removed: ["browserbase"], requires_restart: false });
    expect(loop.tools.has("mcp_browserbase_navigate")).toBe(false);
    expect(closed).toEqual(["browserbase-mcp"]);
  });

  it("retries configured MCP servers that have no live stack", async () => {
    const root = tempRoot();
    setConfigPath(path.join(root, "config.yaml"));
    saveConfig(new Config({ tools: { mcpServers: { browserbase: { command: "browserbase-mcp" } } } }));
    setMcpRuntimeForTest(runtimeFor({ "browserbase-mcp": fakeSession(["navigate"]) }) as any);
    const loop = makeLoop(root, { browserbase: { command: "browserbase-mcp" } });

    const result = await reloadServers(loop as any, loop.tools);

    expect(result).toMatchObject({
      ok: true,
      added: [],
      changed: [],
      retried: ["browserbase"],
    });
    expect(loop.tools.has("mcp_browserbase_navigate")).toBe(true);
    await loop.closeMcp();
  });

  it("connects MCP before processing direct CLI messages", async () => {
    const loop = makeLoop(tempRoot(), { browserbase: { command: "browserbase-mcp" } });
    const connect = vi.spyOn(loop, "connectMcp").mockResolvedValue(undefined);
    const processMessage = vi.spyOn(loop, "processMessageInternal").mockResolvedValue(null);

    await loop.processDirect("hello");

    expect(connect).toHaveBeenCalledOnce();
    expect(processMessage).toHaveBeenCalledOnce();
    expect(connect.mock.invocationCallOrder[0]).toBeLessThan(processMessage.mock.invocationCallOrder[0]);
  });

  it("connects MCP when the inbound run loop starts", async () => {
    const loop = makeLoop(tempRoot(), { browserbase: { command: "browserbase-mcp" } });
    const connect = vi.spyOn(loop, "connectMcp").mockResolvedValue(undefined);

    const task = loop.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    loop.stop();
    await task;

    expect(connect).toHaveBeenCalledOnce();
  });
});
