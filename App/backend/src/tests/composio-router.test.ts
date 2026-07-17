/** Composio router tests. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildComposioMcpServer, registerComposioMcpRoutes } from "../adapters/inbound/local-api/routes/composio-mcp.js";
import { patchMcpServerConfigInMemmyConfig } from "../infrastructure/memmy-config/index.js";
import { createIntegrationService } from "../services/integration-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memmy-mcp-config-"));
  tempDirs.push(dir);
  return join(dir, "config.yaml");
}

describe("Composio MCP 桥", () => {
  it("只暴露三个 meta 工具", async () => {
    const integrations = { executeRouterTool: vi.fn().mockResolvedValue({ data: {} }) };
    const client = await connectClient(integrations);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "composio_execute_tool",
      "composio_get_tool_schemas",
      "composio_search_tools"
    ]);
    await client.close();
  });

  it("search 工具派发到 COMPOSIO_SEARCH_TOOLS", async () => {
    const integrations = { executeRouterTool: vi.fn().mockResolvedValue({ data: { results: [] } }) };
    const client = await connectClient(integrations);

    await client.callTool({ name: "composio_search_tools", arguments: { use_case: "create an issue", toolkits: ["github"] } });

    expect(integrations.executeRouterTool).toHaveBeenCalledWith("COMPOSIO_SEARCH_TOOLS", {
      use_case: "create an issue",
      toolkits: ["github"]
    });
    await client.close();
  });

  it("execute 工具透传 app slug 与参数", async () => {
    const integrations = { executeRouterTool: vi.fn().mockResolvedValue({ data: { ok: true } }) };
    const client = await connectClient(integrations);

    await client.callTool({
      name: "composio_execute_tool",
      arguments: { tool_slug: "GITHUB_CREATE_AN_ISSUE", arguments: { repo: "demo", title: "hi" } }
    });

    expect(integrations.executeRouterTool).toHaveBeenCalledWith("GITHUB_CREATE_AN_ISSUE", { repo: "demo", title: "hi" });
    await client.close();
  });

  it("执行失败时返回 isError 而不是抛出", async () => {
    const integrations = { executeRouterTool: vi.fn().mockRejectedValue(new Error("工具连接服务暂时不可用")) };
    const client = await connectClient(integrations);

    const result = (await client.callTool({ name: "composio_search_tools", arguments: { use_case: "x" } })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("工具连接服务暂时不可用");
    await client.close();
  });
});

describe("集成服务 executeRouterTool", () => {
  it("带机器 token 转发到 cloud client 并返回解析结果", async () => {
    const executeIntegrationRouterTool = vi.fn().mockResolvedValue({ data: { results: [] }, successful: true });
    const service = createIntegrationService({
      cloudClient: { executeIntegrationRouterTool } as never,
      composioMachineTokenRepository: { getOrCreateToken: () => "mct_test" }
    });

    const result = await service.executeRouterTool("COMPOSIO_SEARCH_TOOLS", { use_case: "x" });

    expect(executeIntegrationRouterTool).toHaveBeenCalledWith({
      machineComposioToken: "mct_test",
      toolSlug: "COMPOSIO_SEARCH_TOOLS",
      arguments: { use_case: "x" }
    });
    expect(result.successful).toBe(true);
  });
});

describe("memmy-config patchMcpServerConfig", () => {
  it("幂等写入 tools.mcpServers.composio", async () => {
    const configPath = await tempConfigPath();

    await patchMcpServerConfigInMemmyConfig(
      "composio",
      { type: "streamableHttp", url: "http://127.0.0.1:1/mcp/composio", headers: { "x-memmy-mcp-token": "a" } },
      configPath
    );
    await patchMcpServerConfigInMemmyConfig(
      "composio",
      { type: "streamableHttp", url: "http://127.0.0.1:2/mcp/composio", headers: { "x-memmy-mcp-token": "b" } },
      configPath
    );

    const config = YAML.parse(await readFile(configPath, "utf8")) as {
      tools: { mcpServers: { composio: { url: string; headers: Record<string, string> } } };
    };
    expect(config.tools.mcpServers.composio.url).toBe("http://127.0.0.1:2/mcp/composio");
    expect(config.tools.mcpServers.composio.headers["x-memmy-mcp-token"]).toBe("b");
  });
});

describe("Composio MCP HTTP 路由", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("经 streamableHttp + token 头完成 list/call", async () => {
    const integrations = { executeRouterTool: vi.fn().mockResolvedValue({ data: { results: [] } }) };
    app = Fastify({ logger: false });
    registerComposioMcpRoutes(app, { integrations, mcpToken: "secret-token" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp/composio`);

    const client = new Client({ name: "http-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { "x-memmy-mcp-token": "secret-token" } } })
    );

    const tools = await client.listTools();
    expect(tools.tools.length).toBe(3);

    await client.callTool({ name: "composio_search_tools", arguments: { use_case: "x" } });
    expect(integrations.executeRouterTool).toHaveBeenCalledWith("COMPOSIO_SEARCH_TOOLS", { use_case: "x" });
    await client.close();
  });

  it("token 错误时拒绝连接", async () => {
    const integrations = { executeRouterTool: vi.fn() };
    app = Fastify({ logger: false });
    registerComposioMcpRoutes(app, { integrations, mcpToken: "secret-token" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp/composio`);

    const client = new Client({ name: "http-test-bad", version: "1.0.0" });
    await expect(
      client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { "x-memmy-mcp-token": "wrong" } } }))
    ).rejects.toThrow();
    expect(integrations.executeRouterTool).not.toHaveBeenCalled();
  });
});

async function connectClient(integrations: { executeRouterTool: ReturnType<typeof vi.fn> }): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildComposioMcpServer(integrations);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}
