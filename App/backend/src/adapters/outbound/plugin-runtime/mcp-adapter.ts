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
import type { PluginAdapter, PluginRuntimeContext, PluginSession } from "./types.js";
import { buildPluginSandboxLaunch, resolvePluginEnvironment } from "./command-adapter.js";

const BLOCKED_STATIC_HEADERS = new Set(["authorization", "cookie", "host", "proxy-authorization"]);

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
  secretEnv: z.record(z.string(), z.string().min(1)).default({})
});
const McpRuntimeConfigSchema = z.discriminatedUnion("transport", [McpRemoteConfigSchema, McpStdioConfigSchema]);
type McpRuntimeConfig = z.infer<typeof McpRuntimeConfigSchema>;

interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
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
}

export interface CreateMcpPluginAdapterOptions {
  createClient?: () => McpClientLike;
  createTransport?: (
    config: McpRuntimeConfig,
    headers: Record<string, string>,
    context: PluginRuntimeContext
  ) => unknown | Promise<unknown>;
  platform?: NodeJS.Platform;
}

export function createMcpPluginAdapter(options: CreateMcpPluginAdapterOptions = {}): PluginAdapter {
  const createClient = options.createClient ?? (() => new Client({ name: "memmy-plugin-host", version: "1.0.0" }) as McpClientLike);
  const createTransport = options.createTransport ?? defaultTransport;
  const platform = options.platform ?? process.platform;

  return {
    id: "mcp",

    validate(runtime, rootPath) {
      validateMcpConfig(runtime, rootPath, platform);
    },

    async activate(context) {
      const config = validateMcpConfig(context.plugin.manifest.runtime, context.rootPath, platform);
      const headers = config.transport === "stdio" ? {} : resolveHeaders(config, context.secrets);
      if (config.transport === "stdio") {
        if (context.plugin.manifest.permissions.some((permission) => permission.type === "network")) {
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
      try {
        await client.connect(await createTransport(config, headers, context));
        const available = new Set((await client.listTools()).tools.map((tool) => tool.name));
        const capabilityTools = Object.fromEntries(context.plugin.manifest.capabilities.map((capability) => [
          capability.id,
          config.capabilityTools[capability.id] ?? capability.id
        ]));
        const missing = Object.values(capabilityTools).filter((tool) => !available.has(tool));
        if (missing.length) throw new Error(`MCP tools not found: ${missing.join(", ")}`);
        return {
          pluginId: context.plugin.id,
          client,
          config,
          capabilityTools,
          controllers: new Map()
        } satisfies McpPluginSession;
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
    },

    async *invoke(rawSession, call) {
      const session = asMcpSession(rawSession);
      const toolName = session.capabilityTools[call.capabilityId];
      if (!toolName) throw new Error(`MCP capability is not mapped: ${call.capabilityId}`);
      const controller = new AbortController();
      session.controllers.set(call.callId, controller);
      const progress: CapabilityEvent[] = [];
      let wake: (() => void) | null = null;
      let settled = false;
      let result: unknown;
      let failure: unknown;
      const request = session.client.callTool(
        { name: toolName, arguments: asArguments(call.input) },
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
      }
    },

    async cancel(rawSession, callId) {
      asMcpSession(rawSession).controllers.get(callId)?.abort(new Error("Plugin call cancelled"));
    },

    async deactivate(rawSession) {
      const session = asMcpSession(rawSession);
      for (const controller of session.controllers.values()) controller.abort(new Error("Plugin disabled"));
      session.controllers.clear();
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
    if (platform !== "darwin" && platform !== "linux") throw new Error(`Local MCP plugins are unsupported on ${platform}`);
  } else {
    for (const name of Object.keys(config.headers)) {
      if (BLOCKED_STATIC_HEADERS.has(name.toLowerCase())) {
        throw new Error(`Sensitive MCP header must use secretHeaders: ${name}`);
      }
    }
  }
  return config;
}

async function defaultTransport(
  config: McpRuntimeConfig,
  headers: Record<string, string>,
  context: PluginRuntimeContext
): Promise<unknown> {
  if (config.transport === "stdio") {
    const launch = await buildPluginSandboxLaunch(context, config);
    return new StdioClientTransport({
      ...launch,
      env: resolvePluginEnvironment(config.env, config.secretEnv, context.secrets),
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
  if (structured && typeof structured === "object" && Array.isArray((structured as { events?: unknown }).events)) {
    for (const event of (structured as { events: unknown[] }).events) yield CapabilityEventSchema.parse(event);
    return;
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

function resolveHeaders(
  config: z.infer<typeof McpRemoteConfigSchema>,
  secrets: Readonly<Record<string, string>>
): Record<string, string> {
  const headers = { ...config.headers };
  for (const [header, key] of Object.entries(config.secretHeaders)) {
    const value = secrets[key];
    if (!value) throw new Error(`Missing plugin secret for MCP header ${header}`);
    headers[header] = value;
  }
  return headers;
}

function assertAllowedProtocol(url: URL): void {
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Plugin MCP URL must use HTTPS or loopback HTTP");
  }
}

function assertNetworkPermission(context: PluginRuntimeContext, hostname: string): void {
  const allowed = context.plugin.manifest.permissions.some((permission) =>
    permission.type === "network" && permission.hosts.includes(hostname)
  );
  if (!allowed) throw Object.assign(new Error(`Plugin network permission does not allow ${hostname}`), {
    code: "plugin_permission_denied"
  });
}

function callTimeoutMs(configured: number, deadline: string | undefined): number {
  if (!deadline) return configured;
  return Math.max(1, Math.min(configured, Date.parse(deadline) - Date.now()));
}

function asMcpSession(session: PluginSession): McpPluginSession {
  if (!("client" in session)) throw new Error("Invalid MCP plugin session");
  return session as McpPluginSession;
}
