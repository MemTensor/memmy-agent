/** Composio mcp module. */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IntegrationService } from "../../../../services/integration-service.js";

const MCP_TOKEN_HEADER = "x-memmy-mcp-token";
const MCP_ROUTE_PATH = "/mcp/composio";

/** Type definition for composio mcp integrations. */
export type ComposioMcpIntegrations = Pick<IntegrationService, "executeRouterTool">;

/** Contract for register composio mcp routes options. */
export interface RegisterComposioMcpRoutesOptions {
  integrations: ComposioMcpIntegrations;
  mcpToken: string;
}

const SEARCH_TOOL = "composio_search_tools";
const SCHEMA_TOOL = "composio_get_tool_schemas";
const EXECUTE_TOOL = "composio_execute_tool";

const TOOL_DEFINITIONS = [
  {
    name: SEARCH_TOOL,
    description:
      "按用例语义搜索当前已连接 app 的可用工具,返回候选工具 slug 与执行建议。只覆盖已 OAuth 连接的 app;没连接的搜不到。",
    inputSchema: {
      type: "object",
      properties: {
        use_case: {
          type: "string",
          description: "要完成的任务的自然语言描述,例如 'create an issue on github'"
        },
        toolkits: {
          type: "array",
          items: { type: "string" },
          description: "可选,限定搜索的 app slug 列表,例如 ['github']"
        }
      },
      required: ["use_case"]
    }
  },
  {
    name: SCHEMA_TOOL,
    description: "获取一个或多个工具 slug 的输入参数 schema,用于在执行前正确组织参数。",
    inputSchema: {
      type: "object",
      properties: {
        tool_slugs: {
          type: "array",
          items: { type: "string" },
          description: "要取 schema 的工具 slug 列表,例如 ['GITHUB_CREATE_AN_ISSUE']"
        }
      },
      required: ["tool_slugs"]
    }
  },
  {
    name: EXECUTE_TOOL,
    description:
      "执行某个具体 app 工具(如 GITHUB_CREATE_AN_ISSUE)。建议先用 composio_search_tools 找到 slug、再用 composio_get_tool_schemas 取参数 schema,然后调用本工具。",
    inputSchema: {
      type: "object",
      properties: {
        tool_slug: { type: "string", description: "要执行的 app 工具 slug" },
        arguments: { type: "object", description: "工具入参对象,按工具 schema 组织", additionalProperties: true }
      },
      required: ["tool_slug"]
    }
  }
] as const;

/** Builds build composio mcp server. */
export function buildComposioMcpServer(integrations: ComposioMcpIntegrations): Server {
  const server = new Server({ name: "memmy-composio", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({ ...tool }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      const result = await dispatchComposioTool(integrations, toolName, args);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Composio 工具执行失败: ${message}` }], isError: true };
    }
  });

  return server;
}

/**
 * Dispatches the meta tools invoked by the agent to the Composio Tool Router.
 *
 * @param integrations Tool integration service.
 * @param toolName Name of the tool invoked by the agent.
 * @param args Tool input arguments.
 * @returns Tool Router execution result.
 */
async function dispatchComposioTool(
  integrations: ComposioMcpIntegrations,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case SEARCH_TOOL:
      return integrations.executeRouterTool("COMPOSIO_SEARCH_TOOLS", {
        use_case: args.use_case,
        ...(args.toolkits === undefined ? {} : { toolkits: args.toolkits })
      });
    case SCHEMA_TOOL:
      return integrations.executeRouterTool("COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: args.tool_slugs });
    case EXECUTE_TOOL:
      return integrations.executeRouterTool(
        String(args.tool_slug ?? ""),
        (args.arguments as Record<string, unknown> | undefined) ?? {}
      );
    default:
      throw new Error(`未知的 Composio 工具: ${toolName}`);
  }
}

/**
 * Registers the Composio MCP HTTP routes (stateless Streamable HTTP).
 *
 * @param app Fastify instance.
 * @param options Route dependencies.
 */
export function registerComposioMcpRoutes(app: FastifyInstance, options: RegisterComposioMcpRoutesOptions): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = singleHeader(request.headers[MCP_TOKEN_HEADER]);
    if (!token || token !== options.mcpToken) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    // Stateless mode: each request gets its own server+transport, cleaned up when the connection closes.
    const server = buildComposioMcpServer(options.integrations);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  };

  app.post(MCP_ROUTE_PATH, handler);
  app.get(MCP_ROUTE_PATH, handler);
  app.delete(MCP_ROUTE_PATH, handler);
}

function singleHeader(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}
