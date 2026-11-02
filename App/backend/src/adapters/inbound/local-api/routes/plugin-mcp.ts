import { SkillRefSchema, type PluginSkillContentService } from "../../../../services/plugin-skill-content-service.js";
/** MCP bridge exposing active plugin capabilities to Memmy Agent. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CapabilityCall, CapabilityEvent, InstalledPlugin, JsonSchema, PluginArtifactRef } from "@memmy/local-api-contracts";
import type { PluginService } from "../../../../services/plugin-service.js";
import type { ProgressBus } from "../../../../services/progress-bus.js";

const MCP_TOKEN_HEADER = "x-memmy-mcp-token";
const MCP_ROUTE_PATH = "/mcp/plugins";
const PLUGIN_MCP_KEEPALIVE_MS = 30_000;

export type PluginMcpService = Pick<PluginService, "list" | "invoke" | "cancel"> & Partial<Pick<PluginService, "openArtifact">>;

export interface RegisterPluginMcpRoutesOptions {
  plugins: PluginMcpService;
  progressBus: ProgressBus;
  mcpToken: string;
  skillContent?: PluginSkillContentService;
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
  keepaliveIntervalMs = PLUGIN_MCP_KEEPALIVE_MS,
  skillContent?: PluginSkillContentService
): Server {
  const server = new Server({ name: "memmy-plugins", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = capabilityTools(plugins);
    const hasActiveCloudSkill = tools.some(({ plugin }) => plugin.manifest.skills?.some((skill) => skill.cloud));
    return { tools: [...(skillContent && hasActiveCloudSkill ? [{
      name: "read_plugin_skill",
      description: "Activate private plugin instructions for this conversation. Returns only a version reference; the runtime loads instructions in memory before the next model request. Requires a cloud-skill-aware Memmy client.",
      inputSchema: { type: "object", properties: { pluginId: { type: "string" }, skillId: { type: "string" } }, required: ["pluginId", "skillId"], additionalProperties: false }
    }] : []), ...tools.map(({ name, plugin, capability, wrapsInput }) => ({
      name,
      description: `[${plugin.manifest.name}] ${capability.description}${
        capability.examples?.length ? `\nExamples: ${capability.examples.join("; ")}` : ""
      }`,
      inputSchema: mcpInputSchema(capability.inputSchema, wrapsInput)
    }))] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name === "read_plugin_skill" || request.params.name === "resolve_plugin_skill_context") {
      if (!skillContent || extra._meta?.["memmy.dev/cloud-skills"] !== "1") return toolError("plugin_skill_client_upgrade_required");
      try {
        if (request.params.name === "read_plugin_skill") {
          const args = request.params.arguments ?? {};
          if (typeof args.pluginId !== "string" || typeof args.skillId !== "string") return toolError("plugin_skill_invalid");
          const ref = skillContent.reference(args.pluginId, args.skillId);
          // Verify authorization and availability now, but never return instructions as tool content.
          await skillContent.resolve(ref, extra.signal);
          return toolResult({ kind: "memmy_plugin_skill_ref_v1", ref });
        }
        const ref = SkillRefSchema.parse(request.params.arguments?.ref);
        const current = skillContent.reference(ref.pluginId, ref.skillId);
        if (JSON.stringify(current) !== JSON.stringify(ref)) {
          return { content: [], _meta: { "memmy.dev/private-skill-context": { ref: current, reloadRequired: true } } };
        }
        const instructions = await skillContent.resolve(ref, extra.signal);
        // Not listed as a model tool. The runtime consumes this transient envelope directly.
        return { content: [], _meta: { "memmy.dev/private-skill-context": { ref, instructions } } };
      } catch { return toolError("plugin_skill_load_failed: sign in, check connectivity and installed plugin version, then retry"); }
    }
    const tool = capabilityTools(plugins).find((candidate) => candidate.name === request.params.name);
    if (!tool) return toolError(`Plugin capability is not active: ${request.params.name}`);
    if (tool.plugin.manifest.skills?.some(skill => skill.cloud) && extra._meta?.["memmy.dev/cloud-skills"] !== "1") return toolError("plugin_skill_client_upgrade_required");
    if (tool.plugin.manifest.skills?.some(skill => skill.cloud)) {
      try {
        const ready = JSON.parse(metaString(extra._meta, "memmy.dev/private-skills-ready") ?? "[]");
        for (const skill of tool.plugin.manifest.skills.filter(skill => skill.cloud)) {
          const current = skillContent?.reference(tool.plugin.id, skill.id);
          if (!current || !Array.isArray(ready) || !ready.some(item => {
            const parsed = SkillRefSchema.safeParse(item);
            return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(current);
          })) return toolError("plugin_skill_not_loaded: activate the Skill and wait for the next model request");
        }
      } catch { return toolError("plugin_skill_not_loaded"); }
    }
    const callId = randomUUID();
    const conversationId = metaString(extra._meta, "memmy.dev/session-key") ?? `mcp:${callId}`;
    const modelPreset = metaString(extra._meta, "memmy.dev/model-preset");
    const input = tool.wrapsInput ? request.params.arguments?.input : (request.params.arguments ?? {});
    const call: CapabilityCall = {
      callId,
      pluginId: tool.plugin.id,
      capabilityId: tool.capability.id,
      conversationId,
      ...(modelPreset ? { modelPreset } : {}),
      input
    };
    const provenance = {
      ...(metaString(extra._meta, "memmy.dev/tool-call-id") ? { agentToolCallId: metaString(extra._meta, "memmy.dev/tool-call-id")! } : {}),
      ...(metaString(extra._meta, "memmy.dev/turn-id") ? { turnId: metaString(extra._meta, "memmy.dev/turn-id")! } : {}),
    };
    let terminal = false;
    let retired = false;
    let publishedEvent = false;
    const publishedFiles: Array<{ name: string; path: string; mediaType: string }> = [];
    const retire = (cancelled: boolean) => {
      if (terminal || retired) return;
      retired = true;
      if (!publishedEvent) return;
      progressBus.emit("plugin.capability_event", {
        pluginId: tool.plugin.id, capabilityId: tool.capability.id, callId, conversationId, origin: "agent", ...provenance,
        event: { type: "error", code: cancelled ? "plugin_call_cancelled" : "plugin_runtime_error",
          message: cancelled ? "Plugin call was cancelled" : "Plugin call ended unexpectedly", retryable: false },
      });
    };
    const cancel = () => {
      retire(true);
      void plugins.cancel(tool.plugin.id, callId).catch(() => undefined);
    };
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
    const artifacts: PluginArtifactRef[] = [];
    try {
      for await (const event of plugins.invoke(call)) {
        if (extra.signal.aborted) break;
        publishedEvent = true;
        progressBus.emit("plugin.capability_event", {
          pluginId: tool.plugin.id,
          capabilityId: tool.capability.id,
          callId,
          conversationId,
          // This route is the Agent's own way into a capability, so its cards
          // are part of a turn and closing one has to answer rather than
          // silently leave the turn waiting.
          origin: "agent",
          ...provenance,
          event
        });
        if (event.type === "artifact" && event.artifact.role !== "setup" && event.artifact.path) {
          const file = { name: event.artifact.name, path: event.artifact.path, mediaType: event.artifact.mediaType };
          if (!publishedFiles.some((item) => item.path === file.path)) publishedFiles.push(file);
        }
        await sendTransportProgress(
          event.type === "progress" ? event.message ?? "Plugin progress" : `Plugin ${event.type}`,
          event.type === "progress" ? event.current : undefined,
          event.type === "progress" ? event.total : undefined
        );
        if (event.type === "artifact") artifacts.push(event.artifact);
        if (event.type === "result") {
          terminal = true;
          const visible = modelVisiblePluginResult(event.output, publishedFiles);
          const output = artifacts.length
            ? visible && typeof visible === "object" && !Array.isArray(visible)
              ? { ...visible as Record<string, unknown>, artifacts } : { output: visible, artifacts }
            : visible;
          const result = toolResult(output);
          // QA pages must reach the model as pixels, not merely a download URL.
          // Resolve only Host-issued artifact tokens; never fetch plugin URLs.
          const images: Array<{ type: "image"; mimeType: string; data: string }> = [];
          let imageBytes = 0;
          if (plugins.openArtifact) for (const artifact of artifacts) {
            if (artifact.role !== "setup" || artifact.mediaType !== "image/png") continue;
            const token = artifact.uri.match(/^\/api\/v1\/plugins\/[^/]+\/artifacts\/([a-f0-9-]+)\/preview$/)?.[1];
            if (!token) continue;
            const hosted = await plugins.openArtifact(tool.plugin.id, token);
            const info = await stat(hosted.path);
            if (info.size > 8 * 1024 * 1024 - imageBytes || images.length >= 4) return toolError("Too many QA images in one call; request one page at a time");
            const bytes = await readFile(hosted.path);
            if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return toolError("QA artifact is not a valid PNG image");
            imageBytes += bytes.byteLength;
            if (images.length >= 4 || imageBytes > 8 * 1024 * 1024) return toolError("Too many QA images in one call; request one page at a time");
            images.push({ type: "image", mimeType: "image/png", data: bytes.toString("base64") });
          }
          return { ...result, content: [...result.content, ...images] };
        }
        if (event.type === "error") { terminal = true; return toolError(`${event.code}: ${event.message}`); }
      }
      return toolError("Plugin ended without a terminal event");
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(keepalive);
      extra.signal.removeEventListener("abort", cancel);
      retire(extra.signal.aborted);
    }
  });

  return server;
}

/** Preserve the plugin result while exposing its produced files to the main Agent. */
function modelVisiblePluginResult(
  output: unknown,
  publishedFiles: Array<{ name: string; path: string; mediaType: string }>
): unknown {
  if (!publishedFiles.length) return output;
  const value: Record<string, unknown> = output && typeof output === "object" && !Array.isArray(output)
    ? { ...output as Record<string, unknown> }
    : { output };
  return { ...value, publishedFiles };
}

export function registerPluginMcpRoutes(app: FastifyInstance, options: RegisterPluginMcpRoutesOptions): void {
  // SDK cancellation is a separate HTTP notification. It must reach the same
  // Server that owns the in-flight tools/call, rather than a fresh stateless
  // Server whose request-controller map is empty.
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport; active: number; lastUsed: number }>();
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) {
      if (session.active === 0 && Date.now() - session.lastUsed > 30 * 60_000) {
        sessions.delete(id);
        void session.server.close();
      }
    }
  }, 60_000);
  cleanup.unref();
  app.addHook("preClose", async () => {
    clearInterval(cleanup);
    await Promise.all([...sessions.values()].map(session => session.server.close()));
    sessions.clear();
  });
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (singleHeader(request.headers[MCP_TOKEN_HEADER]) !== options.mcpToken) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }

    const sessionId = singleHeader(request.headers["mcp-session-id"]);
    if (sessionId && !sessions.has(sessionId)) {
      await reply.code(404).send({ error: "MCP session not found" });
      return;
    }
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session && request.method === "POST" && isInitializeRequest(request.body)) {
      const id = randomUUID();
      const server = buildPluginMcpServer(options.plugins, options.progressBus, PLUGIN_MCP_KEEPALIVE_MS, options.skillContent);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => id });
      session = { server, transport, active: 0, lastUsed: Date.now() };
      transport.onclose = () => { sessions.delete(id); };
      await server.connect(transport);
      sessions.set(id, session);
    }
    if (session) {
      const current = session;
      current.active += 1;
      reply.hijack();
      reply.raw.once("close", () => { current.active -= 1; current.lastUsed = Date.now(); });
      await current.transport.handleRequest(request.raw, reply.raw, request.body);
      return;
    }
    // Preserve one-shot raw callers that do not initialize an MCP session.
    const server = buildPluginMcpServer(options.plugins, options.progressBus, PLUGIN_MCP_KEEPALIVE_MS, options.skillContent);
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
    .filter((plugin) => plugin.state === "active" && plugin.eligibility?.canUse !== false)
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
