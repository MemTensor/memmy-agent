/** MCP bridge exposing active plugin capabilities to Memmy Agent. */
import { createHash, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CapabilityCall, CapabilityEvent, InstalledPlugin, JsonSchema } from "@memmy/local-api-contracts";
import type { PluginService } from "../../../../services/plugin-service.js";
import type { ProgressBus } from "../../../../services/progress-bus.js";

const MCP_TOKEN_HEADER = "x-memmy-mcp-token";
const MCP_ROUTE_PATH = "/mcp/plugins";
const PLUGIN_MCP_KEEPALIVE_MS = 30_000;

export type PluginMcpService = Pick<PluginService, "list" | "invoke" | "cancel">;

export interface RegisterPluginMcpRoutesOptions {
  plugins: PluginMcpService;
  progressBus: ProgressBus;
  mcpToken: string;
}

interface CapabilityTool {
  name: string;
  plugin: InstalledPlugin;
  capability: InstalledPlugin["manifest"]["capabilities"][number];
  wrapsInput: boolean;
}

export function buildPluginMcpServer(
  plugins: PluginMcpService,
  progressBus: ProgressBus,
  keepaliveIntervalMs = PLUGIN_MCP_KEEPALIVE_MS
): Server {
  const server = new Server({ name: "memmy-plugins", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: capabilityTools(plugins).map(({ name, plugin, capability, wrapsInput }) => ({
      name,
      description: `[${plugin.manifest.name}] ${capability.description}${
        capability.examples?.length ? `\nExamples: ${capability.examples.join("; ")}` : ""
      }`,
      inputSchema: mcpInputSchema(capability.inputSchema, wrapsInput)
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = capabilityTools(plugins).find((candidate) => candidate.name === request.params.name);
    if (!tool) return toolError(`Plugin capability is not active: ${request.params.name}`);
    const callId = randomUUID();
    const conversationId = metaString(extra._meta, "memmy.dev/session-key") ?? `mcp:${callId}`;
    const input = tool.wrapsInput ? request.params.arguments?.input : (request.params.arguments ?? {});
    const call: CapabilityCall = {
      callId,
      pluginId: tool.plugin.id,
      capabilityId: tool.capability.id,
      conversationId,
      input
    };
    const cancel = () => void plugins.cancel(tool.plugin.id, callId).catch(() => undefined);
    const progressToken = extra._meta?.progressToken;
    let progressSequence = 0;
    const sendTransportProgress = (message: string, current?: number, total?: number) => {
      if (progressToken === undefined) return Promise.resolve();
      progressSequence += 1;
      return extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: current ?? progressSequence,
          ...(total === undefined ? {} : { total }),
          message
        }
      }).catch(() => undefined);
    };
    const keepalive = setInterval(() => {
      void sendTransportProgress("Waiting for plugin interaction");
    }, keepaliveIntervalMs);
    keepalive.unref?.();
    extra.signal.addEventListener("abort", cancel, { once: true });
    try {
      for await (const event of plugins.invoke(call)) {
        progressBus.emit("plugin.capability_event", {
          pluginId: tool.plugin.id,
          capabilityId: tool.capability.id,
          callId,
          conversationId,
          event
        });
        await sendTransportProgress(
          event.type === "progress" ? event.message ?? "Plugin progress" : `Plugin ${event.type}`,
          event.type === "progress" ? event.current : undefined,
          event.type === "progress" ? event.total : undefined
        );
        if (event.type === "result") return toolResult(event.output);
        if (event.type === "error") return toolError(`${event.code}: ${event.message}`);
      }
      return toolError("Plugin ended without a terminal event");
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(keepalive);
      extra.signal.removeEventListener("abort", cancel);
    }
  });

  return server;
}

export function registerPluginMcpRoutes(app: FastifyInstance, options: RegisterPluginMcpRoutesOptions): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (singleHeader(request.headers[MCP_TOKEN_HEADER]) !== options.mcpToken) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const server = buildPluginMcpServer(options.plugins, options.progressBus);
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

function capabilityTools(plugins: PluginMcpService): CapabilityTool[] {
  return plugins.list()
    .filter((plugin) => plugin.state === "active")
    .flatMap((plugin) => plugin.manifest.capabilities.map((capability) => ({
      name: capabilityToolName(plugin.id, capability.id),
      plugin,
      capability,
      wrapsInput: capability.inputSchema.type !== "object"
    })));
}

export function capabilityToolName(pluginId: string, capabilityId: string): string {
  // The Agent prefixes MCP names with `mcp_plugins_` and caps them at 64
  // characters. Keep this raw name within 52 characters so the capability ID
  // remains readable instead of collapsing several tools to `review_update__*`.
  const digest = createHash("sha256").update(`${pluginId}\0${capabilityId}`).digest("hex").slice(0, 8);
  const readable = capabilityId.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  const maxReadableLength = 52 - "plugin__".length - digest.length;
  return `plugin_${readable.slice(0, maxReadableLength)}_${digest}`;
}

function mcpInputSchema(schema: JsonSchema, wrapsInput: boolean): Record<string, unknown> {
  return wrapsInput
    ? { type: "object", properties: { input: schema }, required: ["input"], additionalProperties: false }
    : { ...schema, type: "object" };
}

function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === "string" && value.length ? value : undefined;
}

function toolResult(output: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) ?? "null" }],
    ...(output && typeof output === "object" && !Array.isArray(output)
      ? { structuredContent: output as Record<string, unknown> }
      : {})
  };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function singleHeader(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}
