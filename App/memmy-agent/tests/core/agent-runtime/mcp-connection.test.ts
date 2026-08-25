import fs from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import {
  sanitizeName,
  connectMcpServers,
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

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

async function closeServers(...servers: Array<ReturnType<typeof createServer>>): Promise<void> {
  await Promise.all(servers.map((server) => {
    const closed = once(server, "close");
    server.close();
    return closed;
  }));
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

  it("registers tools from a real Streamable HTTP MCP server", async () => {
    const httpServer = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/mcp") {
        response.writeHead(405).end();
        return;
      }

      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const mcpServer = new McpServer(
          { name: "real-http-test", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{
            name: "search_tools",
            description: "Search tools",
            inputSchema: { type: "object", properties: {} },
          }],
        }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on("close", () => {
          void transport.close();
          void mcpServer.close();
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch (error) {
        if (!response.headersSent) response.writeHead(500);
        response.end(String(error));
      }
    });
    const port = await listen(httpServer);
    const registry = new ToolRegistry();
    let stacks: Awaited<ReturnType<typeof connectMcpServers>> = {};

    try {
      stacks = await connectMcpServers({
        composio: { type: "streamableHttp", url: `http://127.0.0.1:${port}/mcp` },
      }, registry);

      expect(stacks.composio).toBeTruthy();
      expect(registry.has("mcp_composio_search_tools")).toBe(true);
    } finally {
      await stacks.composio?.aclose();
      await closeServers(httpServer);
    }
  });

  it.each([
    { type: "streamableHttp", path: "/mcp" },
    { type: "sse", path: "/sse" },
  ])("fails closed without forwarding $type MCP headers across redirects", async ({ type, path: endpointPath }) => {
    let redirectedRequests = 0;
    let redirectedToken: string | undefined;
    const redirectedServer = createServer((request, response) => {
      redirectedRequests += 1;
      redirectedToken = request.headers["x-memmy-mcp-token"] as string | undefined;
      response.writeHead(401).end();
    });
    const redirectedPort = await listen(redirectedServer);

    let receivedToken: string | undefined;
    const redirectServer = createServer((request, response) => {
      receivedToken = request.headers["x-memmy-mcp-token"] as string | undefined;
      response.writeHead(302, { location: `http://127.0.0.1:${redirectedPort}${endpointPath}` }).end();
    });
    const redirectPort = await listen(redirectServer);
    const registry = new ToolRegistry();

    try {
      const stacks = await connectMcpServers({
        composio: {
          type,
          url: `http://127.0.0.1:${redirectPort}${endpointPath}`,
          headers: { "x-memmy-mcp-token": "secret-token" },
        },
      }, registry);

      expect(stacks.composio).toBeUndefined();
      expect(receivedToken).toBe("secret-token");
      expect(redirectedRequests).toBe(0);
      expect(redirectedToken).toBeUndefined();
      expect(registry.toolNames).toEqual([]);
    } finally {
      await closeServers(redirectServer, redirectedServer);
    }
  });

  it("times out stalled HTTP MCP initialization and closes its resources", async () => {
    const probeServer = createServer((_request, response) => response.end());
    const port = await listen(probeServer);
    const closeSession = vi.fn(async () => undefined);
    const destroyTransport = vi.fn(async () => undefined);
    let releaseInitialize = () => {};
    let markInitializeStarted = () => {};
    const initializeStarted = new Promise<void>((resolve) => {
      markInitializeStarted = resolve;
    });
    const registry = new ToolRegistry();
    setMcpRuntimeForTest({
      ...runtimeFor({}),
      ClientSession: class {
        async enter() {
          return this;
        }
        async close() {
          await closeSession();
        }
        async initialize() {
          markInitializeStarted();
          await new Promise<void>((resolve) => {
            releaseInitialize = resolve;
          });
        }
        async listTools() {
          return { tools: [] };
        }
        async listResources() {
          return { resources: [] };
        }
        async listPrompts() {
          return { prompts: [] };
        }
      },
      streamableHttpClient() {
        return [{}, {}, { destroy: destroyTransport }];
      },
    } as any);
    vi.useFakeTimers();
    const pending = connectMcpServers({
      stalled: { type: "streamableHttp", url: `http://127.0.0.1:${port}/mcp` },
    }, registry);
    let settled: Awaited<typeof pending> | undefined;
    void pending.then((result) => {
      settled = result;
    });

    try {
      await initializeStarted;
      await vi.advanceTimersByTimeAsync(15_000);

      expect.soft(settled).toEqual({});
      expect.soft(closeSession).toHaveBeenCalledOnce();
      expect.soft(destroyTransport).toHaveBeenCalledOnce();
      expect.soft(registry.toolNames).toEqual([]);
    } finally {
      releaseInitialize();
      const stacks = await pending;
      await stacks.stalled?.aclose();
      vi.useRealTimers();
      await closeServers(probeServer);
    }
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

    const running = loop.run();
    let result = await requestMcpReload(loop.bus, { timeout: 2 });

    expect(result).toMatchObject({ ok: true, added: ["browserbase"], requires_restart: false });
    expect(loop.tools.has("mcp_browserbase_navigate")).toBe(true);

    saveConfig(new Config({ tools: { mcpServers: {} } }));
    result = await requestMcpReload(loop.bus, { timeout: 2 });

    expect(result).toMatchObject({ ok: true, removed: ["browserbase"], requires_restart: false });
    expect(loop.tools.has("mcp_browserbase_navigate")).toBe(false);
    expect(closed).toEqual(["browserbase-mcp"]);

    saveConfig(new Config({ tools: { mcpServers: { browserbase: { command: "browserbase-mcp" } } } }));
    let releaseDirect = () => {};
    let markDirectStarted = () => {};
    const directStarted = new Promise<void>((resolve) => {
      markDirectStarted = resolve;
    });
    const directProcess = vi.spyOn(loop, "processMessageInternal").mockImplementation(async () => {
      markDirectStarted();
      await new Promise<void>((resolve) => {
        releaseDirect = resolve;
      });
      return null;
    });
    const direct = loop.processDirect("heartbeat", { sessionKey: "cron:heartbeat" });
    await directStarted;
    result = await requestMcpReload(loop.bus, { timeout: 2 });

    expect(result).toMatchObject({ ok: false, requires_restart: true });
    expect(loop.tools.has("mcp_browserbase_navigate")).toBe(false);
    releaseDirect();
    await direct;
    directProcess.mockRestore();

    let releaseReload = () => {};
    let markReloadStarted = () => {};
    const reloadStarted = new Promise<void>((resolve) => {
      markReloadStarted = resolve;
    });
    const stalledSession = fakeSession(["navigate"]);
    stalledSession.initialize = async () => {
      markReloadStarted();
      await new Promise<void>((resolve) => {
        releaseReload = resolve;
      });
    };
    setMcpRuntimeForTest(runtimeFor({ "browserbase-mcp": stalledSession }, { closed }) as any);
    const pendingReload = requestMcpReload(loop.bus, { timeout: 2 });
    await reloadStarted;
    const processDuringReload = vi.spyOn(loop, "processMessageInternal").mockResolvedValue(null);
    const directDuringReload = loop.processDirect("heartbeat", { sessionKey: "cron:during-reload" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processDuringReload).not.toHaveBeenCalled();
    releaseReload();
    await expect(pendingReload).resolves.toMatchObject({ ok: true, requires_restart: false });
    await directDuringReload;
    expect(processDuringReload).toHaveBeenCalledOnce();

    let releaseInitialization = () => {};
    let markInitializationStarted = () => {};
    const initializationStarted = new Promise<void>((resolve) => {
      markInitializationStarted = resolve;
    });
    vi.spyOn(loop, "initializeRuntimeTools").mockImplementation(async () => {
      markInitializationStarted();
      await new Promise<void>((resolve) => {
        releaseInitialization = resolve;
      });
    });
    const directDuringInitialization = loop.processDirect("heartbeat", { sessionKey: "cron:during-init" });
    await initializationStarted;
    const reloadDuringInitialization = await requestMcpReload(loop.bus, { timeout: 2 });

    expect(reloadDuringInitialization).toMatchObject({ ok: false, requires_restart: true });
    releaseInitialization();
    await directDuringInitialization;
    loop.stop();
    await running;
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
