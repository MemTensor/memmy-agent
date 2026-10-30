/** Remote MCP plugin runtime adapter. */
import {
  CapabilityEventSchema,
  type CapabilityCall,
  type CapabilityEvent,
  type PluginRuntime
} from "@memmy/local-api-contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertNetworkPermission,
  assertSafeStaticHeaders,
  callTimeoutMs,
  resolveSecretHeaders
} from "./shared.js";
import type { PluginAdapter, PluginRuntimeContext, PluginSession, PluginHostServiceInvoker } from "./types.js";
import { buildDirectLaunch, buildPluginSandboxLaunch, resolvePluginEnvironment } from "./command-adapter.js";

const HostRequestSchema = z.object({ method: z.literal("memmy/host-service"),
  params: z.object({ service: z.string().min(1), input: z.unknown(), callId: z.string().optional() }) });

const McpSharedConfigSchema = z.object({
  capabilityTools: z.record(z.string(), z.string().min(1)).default({}),
  timeoutMs: z.number().int().positive().max(3_600_000).default(300_000)
});
const McpRemoteConfigSchema = McpSharedConfigSchema.extend({
  transport: z.enum(["sse", "streamableHttp"]),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  secretHeaders: z.record(z.string(), z.string().min(1)).default({})
});
const McpStdioConfigSchema = McpSharedConfigSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default("."),
  env: z.record(z.string(), z.string()).default({}),
  secretEnv: z.record(z.string(), z.string().min(1)).default({}),
  interpreter: z.enum(["direct", "node"]).default("direct"),
  sandbox: z.enum(["required", "none"]).default("required"),
  shutdownTool: z.string().min(1).optional()
});
const McpRuntimeConfigSchema = z.discriminatedUnion("transport", [McpRemoteConfigSchema, McpStdioConfigSchema]);
type McpRuntimeConfig = z.infer<typeof McpRuntimeConfigSchema>;

interface McpClientLike {
  onclose?: () => void;
  setRequestHandler?(schema: typeof HostRequestSchema,
    handler: (request: z.infer<typeof HostRequestSchema>) => Promise<{ result: unknown }>): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown>; _meta?: Record<string, unknown> },
    resultSchema?: undefined,
    options?: { signal?: AbortSignal; timeout?: number; onprogress?: (progress: McpProgress) => void }
  ): Promise<unknown>;
}

interface McpProgress {
  progress: number;
  total?: number;
  message?: string;
}

interface McpPluginSession extends PluginSession {
  client: McpClientLike;
  config: McpRuntimeConfig;
  capabilityTools: Record<string, string>;
  controllers: Map<string, AbortController>;
  calls: Map<string, CapabilityCall>;
  closing: boolean;
}

export interface CreateMcpPluginAdapterOptions {
  createClient?: () => McpClientLike;
  createTransport?: (
    config: McpRuntimeConfig,
    headers: Record<string, string>,
    context: PluginRuntimeContext
  ) => unknown | Promise<unknown>;
  platform?: NodeJS.Platform;
  pluginDataRoot?: string;
  /** Host policy, separate from registry claims and manifest permissions. */
  trustedNativeOrigins?: readonly string[];
  hostServices?: PluginHostServiceInvoker;
  onExit?: (pluginId: string, expected: boolean) => void;
}

export function createMcpPluginAdapter(options: CreateMcpPluginAdapterOptions = {}): PluginAdapter {
  const createClient = options.createClient ?? (() => new Client({ name: "memmy-plugin-host", version: "1.0.0" }) as McpClientLike);
  const platform = options.platform ?? process.platform;

  return {
    id: "mcp",

    validate(runtime, rootPath) {
      validateMcpConfig(runtime, rootPath, platform);
    },

    async activate(context) {
      const config = validateMcpConfig(context.plugin.manifest.runtime, context.rootPath, platform);
      const native = config.transport === "stdio" && config.sandbox === "none";
      if (native && !nativeApproved(context, options.trustedNativeOrigins ?? [])) throw Object.assign(new Error("Native execution requires a trusted official release and approved native-execution permission"), { code: "plugin_permission_denied" });
      const headers = config.transport === "stdio"
        ? {}
        : resolveSecretHeaders(config.headers, config.secretHeaders, context.secrets, "MCP");
      if (config.transport === "stdio") {
        if (!native && context.plugin.manifest.permissions.some((permission) => permission.type === "network")) {
          throw Object.assign(new Error("Local MCP plugins cannot request network access; use remote MCP"), {
            code: "plugin_permission_denied"
          });
        }
      } else {
        const url = new URL(config.url);
        assertAllowedProtocol(url);
        assertNetworkPermission(context, url.hostname);
      }
      const client = createClient();
      const session: McpPluginSession = { pluginId: context.plugin.id, client, config, capabilityTools: {}, controllers: new Map(), calls: new Map(), closing: false };
      const approved = new Set(context.plugin.approvedPermissions.flatMap(p => p.type === "host-service" ? p.services : []));
      const hostControllers = new Set<AbortController>();
      const abortActivation = () => {
        session.closing = true;
        for (const controller of hostControllers) controller.abort();
        void client.close().catch(() => undefined);
      };
      context.signal?.throwIfAborted();
      context.signal?.addEventListener("abort", abortActivation, { once: true });
      client.setRequestHandler?.(HostRequestSchema, async request => {
        if (!approved.has(request.params.service) || !options.hostServices) throw new Error("Host service permission denied");
        const controller = new AbortController(); hostControllers.add(controller);
        const parentCall = request.params.callId ? session.calls.get(request.params.callId) : undefined;
        if (request.params.service === "event-sessions" && (request.params.input as { action?: unknown })?.action !== "configuration" && !parentCall) {
          hostControllers.delete(controller); throw new Error("Event sessions require an active conversation capability call");
        }
        const parentSignal = parentCall ? session.controllers.get(parentCall.callId)?.signal : undefined;
        const abort = () => controller.abort(parentSignal?.reason);
        if (parentSignal?.aborted) abort(); else parentSignal?.addEventListener("abort", abort, { once: true });
        try {
          return { result: await options.hostServices.invoke({ pluginId: context.plugin.id,
            callId: parentCall?.callId ?? "plugin-lifecycle", conversationId: parentCall?.conversationId ?? `plugin:${context.plugin.id}`,
            ...(parentCall?.modelPreset ? { modelPreset: parentCall.modelPreset } : {}),
            service: request.params.service, input: request.params.input, signal: controller.signal }) };
        } finally { parentSignal?.removeEventListener("abort", abort); hostControllers.delete(controller); }
      });
      client.onclose = () => {
        for (const c of hostControllers) c.abort();
        for (const c of session.controllers.values()) c.abort();
        options.onExit?.(context.plugin.id, session.closing);
      };
      try {
        await client.connect(await (options.createTransport
          ? options.createTransport(config, headers, context)
          : defaultTransport(config, headers, context, options.pluginDataRoot, options.trustedNativeOrigins ?? [])));
        const available = new Set((await client.listTools()).tools.map((tool) => tool.name));
        const capabilityTools = Object.fromEntries(context.plugin.manifest.capabilities.map((capability) => [
          capability.id,
          config.capabilityTools[capability.id] ?? capability.id
        ]));
        const missing = Object.values(capabilityTools).filter((tool) => !available.has(tool));
        if (missing.length) throw new Error(`MCP tools not found: ${missing.join(", ")}`);
        session.capabilityTools = capabilityTools;
        context.signal?.throwIfAborted();
        return session;
      } catch (error) {
        session.closing = true;
        await client.close().catch(() => undefined);
        throw error;
      } finally {
        context.signal?.removeEventListener("abort", abortActivation);
      }
    },

    async *invoke(rawSession, call) {
      const session = asMcpSession(rawSession);
      const toolName = session.capabilityTools[call.capabilityId];
      if (!toolName) throw new Error(`MCP capability is not mapped: ${call.capabilityId}`);
      const controller = new AbortController();
      session.controllers.set(call.callId, controller);
      session.calls.set(call.callId, call);
      const progress: CapabilityEvent[] = [];
      let wake: (() => void) | null = null;
      let settled = false;
      let result: unknown;
      let failure: unknown;
      const request = session.client.callTool(
        { name: toolName, arguments: asArguments(call.input), ...(options.hostServices ? { _meta: { "memmy/call-id": call.callId, "memmy/conversation-id": call.conversationId } } : {}) },
        undefined,
        {
          signal: controller.signal,
          timeout: callTimeoutMs(session.config.timeoutMs, call.deadline),
          onprogress(update) {
            progress.push({
              type: "progress",
              current: update.progress,
              ...(update.total === undefined ? {} : { total: update.total }),
              ...(update.message === undefined ? {} : { message: update.message })
            });
            wake?.();
            wake = null;
          }
        }
      ).then((value) => {
        result = value;
      }, (error) => {
        failure = error;
      }).finally(() => {
        settled = true;
        wake?.();
        wake = null;
      });

      try {
        while (!settled || progress.length) {
          const event = progress.shift();
          if (event) {
            yield event;
          } else {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
        await request;
        if (failure) throw failure;
        yield* mcpResultEvents(result);
      } finally {
        session.controllers.delete(call.callId);
        session.calls.delete(call.callId);
      }
    },

    async cancel(rawSession, callId) {
      asMcpSession(rawSession).controllers.get(callId)?.abort(new Error("Plugin call cancelled"));
    },

    async deactivate(rawSession) {
      const session = asMcpSession(rawSession);
      session.closing = true;
      for (const controller of session.controllers.values()) controller.abort(new Error("Plugin disabled"));
      session.controllers.clear();
      if (session.config.transport === "stdio" && session.config.shutdownTool) {
        await session.client.callTool({ name: session.config.shutdownTool, arguments: {} }, undefined, { timeout: 15_000 }).catch(() => undefined);
      }
      await session.client.close();
    }
  };
}

function validateMcpConfig(
  runtime: PluginRuntime,
  rootPath: string | null,
  platform: NodeJS.Platform
): McpRuntimeConfig {
  if (runtime.adapter !== "mcp") throw new Error(`Expected mcp runtime, got ${runtime.adapter}`);
  const config = McpRuntimeConfigSchema.parse(runtime.config ?? {});
  if (config.transport === "stdio") {
    if (!rootPath) throw new Error("Local MCP plugin requires an installed artifact");
    if (config.sandbox !== "none" && platform !== "darwin" && platform !== "linux") throw new Error(`Sandboxed local MCP plugins are unsupported on ${platform}`);
  } else {
    assertSafeStaticHeaders(config.headers, "MCP");
  }
  return config;
}

async function defaultTransport(
  config: McpRuntimeConfig,
  headers: Record<string, string>,
  context: PluginRuntimeContext,
  pluginDataRoot?: string, trustedNativeOrigins: readonly string[] = []
): Promise<unknown> {
  if (config.transport === "stdio") {
    const launch = config.sandbox === "none" ? await buildDirectLaunch(context, config) : await buildPluginSandboxLaunch(context, config);
    const env = resolvePluginEnvironment(config.env, config.secretEnv, context.secrets);
    if (config.interpreter === "node") env.ELECTRON_RUN_AS_NODE = "1";
    if (nativeApproved(context, trustedNativeOrigins)) {
      // Only platform paths are inherited. Tokens, API keys and the Host's
      // general-purpose local API credentials never enter the plugin process.
      for (const name of ["SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)"]) {
        if (process.env[name]) env[name] = process.env[name]!;
      }
    }
    env.MEMMY_PLUGIN_ID = context.plugin.id;
    if (pluginDataRoot && context.plugin.approvedPermissions.some(p => p.type === "host-service" && p.services.includes("plugin-data"))) {
      env.MEMMY_PLUGIN_DATA_DIR = join(pluginDataRoot, context.plugin.id);
      await mkdir(env.MEMMY_PLUGIN_DATA_DIR, { recursive: true, mode: 0o700 });
    }
    return new StdioClientTransport({
      ...launch,
      env,
      stderr: "ignore"
    });
  }
  const url = new URL(config.url);
  const rejectRedirects = (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, { ...init, redirect: "error" });
  const requestInit = { headers };
  if (config.transport === "sse") {
    return new SSEClientTransport(url, {
      requestInit,
      eventSourceInit: { fetch: rejectRedirects }
    });
  }
  return new StreamableHTTPClientTransport(url, { requestInit, fetch: rejectRedirects });
}

function nativeApproved(context: PluginRuntimeContext, trustedOrigins: readonly string[] = []): boolean {
  return context.plugin.nativeExecutionAllowed === true && !!context.plugin.registryOrigin && trustedOrigins.includes(context.plugin.registryOrigin)
    && /^[a-f0-9]{64}$/i.test(context.plugin.artifactHash ?? "")
    && context.plugin.approvedPermissions.some(p => p.type === "host-service" && p.services.includes("native-execution"));
}

async function* mcpResultEvents(value: unknown): AsyncIterable<CapabilityEvent> {
  const result = value as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (result?.isError) {
    yield { type: "error", code: "plugin_runtime_error", message: contentText(result.content) || "MCP tool failed", retryable: false };
    return;
  }
  const structured = result?.structuredContent;
  if (structured && typeof structured === "object") {
    const output = structured as { schema?: unknown; events?: unknown };
    if (Array.isArray(output.events) && (output.schema === "memmy.capability-events/v1"
      || (output.events.length > 0 && output.events.every(event => CapabilityEventSchema.safeParse(event).success)))) {
      for (const event of output.events) yield CapabilityEventSchema.parse(event);
      return;
    }
  }
  if (structured !== undefined) {
    yield { type: "result", output: structured };
    return;
  }
  const text = contentText(result?.content);
  try {
    yield { type: "result", output: JSON.parse(text) };
  } catch {
    yield { type: "result", output: text };
  }
}

function contentText(content: Array<{ type?: string; text?: string }> | undefined): string {
  return (content ?? []).filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

function asArguments(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { input };
  return input as Record<string, unknown>;
}

function assertAllowedProtocol(url: URL): void {
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Plugin MCP URL must use HTTPS or loopback HTTP");
  }
}

function asMcpSession(session: PluginSession): McpPluginSession {
  if (!("client" in session)) throw new Error("Invalid MCP plugin session");
  return session as McpPluginSession;
}
