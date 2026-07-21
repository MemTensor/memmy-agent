import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Agent as UndiciAgent } from "undici";
import {
  INBOUND_META_RUNTIME_CONTROL,
  InboundMessage,
  RUNTIME_CONTROL_ACK,
  RUNTIME_CONTROL_MCP_RELOAD,
} from "../../runtime-messages/events.js";
import { loadConfig, resolveConfigEnvVars } from "../../../config/loader.js";
import { VERSION } from "../../../version.js";
import { Tool } from "./base.js";
import { ToolRegistry } from "./registry.js";

const TRANSIENT_EXC_NAMES = new Set([
  "ClosedResourceError",
  "BrokenResourceError",
  "EndOfStream",
  "BrokenPipeError",
  "ConnectionResetError",
  "ConnectionRefusedError",
  "ConnectionAbortedError",
  "ConnectionError",
]);

const WINDOWS_SHELL_LAUNCHERS = new Set(["npx", "npm", "pnpm", "yarn", "bunx"]);
const SANITIZE_RE = /_+/g;
const RELOAD_LOCKS = new WeakMap<object, Promise<void>>();

type Runtime = {
  ClientSession: new (read: any, write: any) => any;
  StdioServerParameters: new (init: any) => any;
  stdioClient: (params: any) => any;
  sseClient: (url: string, opts?: any) => any;
  streamableHttpClient: (url: string, opts?: any) => any;
};

let runtimeOverride: Runtime | null = null;

export function setMcpRuntimeForTest(runtime: Runtime | null): void {
  runtimeOverride = runtime;
}

class SdkStdioServerParameters {
  constructor(init: any) {
    Object.assign(this, init);
  }
}

class SdkClientSession {
  private client: Client;
  private transport: any;

  constructor(transport: any) {
    this.transport = transport;
    this.client = new Client({ name: "memmy-agent", version: VERSION });
  }

  async enter(): Promise<this> {
    return this;
  }

  async initialize(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async listTools(): Promise<any> {
    return this.client.listTools();
  }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    return this.client.callTool({ name, arguments: args });
  }

  async listResources(): Promise<any> {
    return this.client.listResources();
  }

  async readResource(uri: string): Promise<any> {
    return this.client.readResource({ uri });
  }

  async listPrompts(): Promise<any> {
    return this.client.listPrompts();
  }

  async getPrompt(name: string, args: Record<string, any>): Promise<any> {
    return this.client.getPrompt({ name, arguments: args });
  }
}

async function loadRuntime(): Promise<Runtime> {
  const httpTransportOptions = (opts: any = {}) => {
    const dispatcher = new UndiciAgent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });
    const controllers = new Set<AbortController>();
    const responses = new Set<Response>();
    const fetchWithDispatcher = async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? undefined);
      if (!headers.has("connection")) headers.set("connection", "close");
      const controller = new AbortController();
      const signal = init?.signal ?? null;
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", abort, { once: true });
      controllers.add(controller);
      try {
        const response = await fetch(url, { ...(init ?? {}), headers, signal: controller.signal, dispatcher } as any);
        responses.add(response);
        return response;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    };
    const transportResources = {
      async destroy() {
        for (const controller of controllers) controller.abort();
        await Promise.allSettled([...responses].map((response) => response.body?.cancel?.()));
        dispatcher.destroy();
      },
    };
    return [
      {
        requestInit: opts.headers ? { headers: opts.headers } : undefined,
        fetch: fetchWithDispatcher,
      },
      transportResources,
    ] as const;
  };
  if (runtimeOverride) return runtimeOverride;
  return {
    ClientSession: SdkClientSession as any,
    StdioServerParameters: SdkStdioServerParameters as any,
    stdioClient: (params: any) => [new StdioClientTransport(params), null],
    sseClient: (url: string, opts: any = {}) => {
      const [transportOptions, dispatcher] = httpTransportOptions(opts);
      return [
        new SSEClientTransport(new URL(url), transportOptions as any),
        null,
        dispatcher,
      ];
    },
    streamableHttpClient: (url: string, opts: any = {}) => {
      const [transportOptions, dispatcher] = httpTransportOptions(opts);
      return [
        new StreamableHTTPClientTransport(new URL(url), transportOptions as any),
        null,
        dispatcher,
      ];
    },
  };
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(SANITIZE_RE, "_");
}

export function isTransient(error: unknown): boolean {
  return TRANSIENT_EXC_NAMES.has((error as Error)?.name ?? (error as any)?.constructor?.name ?? "");
}

function timeoutPromise<T>(promise: Promise<T>, seconds: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), seconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function probeHttpUrl(url: string, timeout = 3): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname || "127.0.0.1";
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout * 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function windowsCommandBasename(command: string): string {
  return command.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
}

function whichFromPath(command: string, searchPath?: string): string | null {
  if (!searchPath) return null;
  for (const dir of searchPath.split(";")) {
    for (const ext of ["", ".cmd", ".bat", ".exe", ".com"]) {
      const candidate = path.win32.join(dir, `${command}${ext}`);
      if (candidate.toLowerCase().endsWith(".cmd") || candidate.toLowerCase().endsWith(".bat")) return candidate;
    }
  }
  return null;
}

export function normalizeWindowsStdioCommand(
  command: string,
  args: string[] | null = null,
  env: Record<string, string> | null = null,
  platform = os.platform() === "win32" ? "nt" : "posix",
): [string, string[], Record<string, string> | null] {
  const normalizedArgs = [...(args ?? [])];
  if (platform !== "nt") return [command, normalizedArgs, env];
  const basename = windowsCommandBasename(command);
  if (["cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(basename)) {
    return [command, normalizedArgs, env];
  }
  if (basename.endsWith(".exe") || basename.endsWith(".com")) return [command, normalizedArgs, env];
  const resolved = whichFromPath(command, env?.PATH) ?? command;
  const resolvedBase = windowsCommandBasename(resolved);
  const shouldWrap =
    WINDOWS_SHELL_LAUNCHERS.has(basename) || basename.endsWith(".cmd") || basename.endsWith(".bat") || resolvedBase.endsWith(".cmd") || resolvedBase.endsWith(".bat");
  if (!shouldWrap) return [command, normalizedArgs, env];
  const comspec = env?.COMSPEC ?? process.env.COMSPEC ?? "cmd.exe";
  return [comspec, ["/d", "/c", command, ...normalizedArgs], env];
}

function extractNullableBranch(options: any): [Record<string, any>, boolean] | null {
  if (!Array.isArray(options)) return null;
  const nonNull = [];
  let sawNull = false;
  for (const option of options) {
    if (!option || typeof option !== "object" || Array.isArray(option)) return null;
    if (option.type === "null") {
      sawNull = true;
      continue;
    }
    nonNull.push(option);
  }
  return sawNull && nonNull.length === 1 ? [nonNull[0], true] : null;
}

function normalizeSchemaForOpenAI(schema: any): Record<string, any> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {}, required: [] };
  let normalized: Record<string, any> = { ...schema };
  if (Array.isArray(normalized.type)) {
    const nonNull = normalized.type.filter((item: string) => item !== "null");
    if (normalized.type.includes("null") && nonNull.length === 1) {
      normalized.type = nonNull[0];
      normalized.nullable = true;
    }
  }
  for (const key of ["oneOf", "anyOf"]) {
    const nullable = extractNullableBranch(normalized[key]);
    if (nullable) {
      const [branch] = nullable;
      const rest = { ...normalized };
      delete rest[key];
      normalized = { ...rest, ...branch, nullable: true };
      break;
    }
  }
  if (normalized.properties && typeof normalized.properties === "object") {
    normalized.properties = Object.fromEntries(
      Object.entries(normalized.properties).map(([name, prop]) => [name, normalizeSchemaForOpenAI(prop)]),
    );
  }
  if (normalized.items && typeof normalized.items === "object") normalized.items = normalizeSchemaForOpenAI(normalized.items);
  if (normalized.type === "object") {
    normalized.properties ??= {};
    normalized.required ??= [];
  }
  return normalized;
}

function textFromContentBlock(block: any): string {
  if (block && typeof block === "object" && typeof block.text === "string") return block.text;
  return String(block);
}

export class MCPToolWrapper extends Tool {
  static pluginDiscoverable = false;
  private session: any;
  originalName: string;
  private toolName: string;
  private toolDescription: string;
  private toolParameters: Record<string, any>;
  private toolTimeout: number;

  constructor(session: any, serverName: string, toolDef: any, toolTimeout = 30) {
    super();
    this.session = session;
    this.originalName = toolDef.name;
    this.toolName = sanitizeName(`mcp_${serverName}_${toolDef.name}`);
    this.toolDescription = toolDef.description || toolDef.name;
    this.toolParameters = normalizeSchemaForOpenAI(toolDef.inputSchema ?? { type: "object", properties: {} });
    this.toolTimeout = toolTimeout;
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return this.toolDescription;
  }

  get parameters() {
    return this.toolParameters;
  }

  async execute(params: Record<string, any> = {}): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result: any = await timeoutPromise(
          this.session.callTool(this.originalName, params),
          this.toolTimeout,
          "timeout",
        );
        return (result.content ?? []).map(textFromContentBlock).join("\n") || "(no output)";
      } catch (error) {
        if ((error as Error).message === "timeout") return `(MCP tool call timed out after ${this.toolTimeout}s)`;
        if ((error as Error).name === "CancelledError") return "(MCP tool call was cancelled)";
        if (isTransient(error) && attempt === 0) continue;
        if (isTransient(error)) return `(MCP tool call failed after retry: ${(error as Error).name})`;
        return `(MCP tool call failed: ${(error as Error).name || "Error"})`;
      }
    }
    return "(MCP tool call failed)";
  }
}

export class MCPResourceWrapper extends Tool {
  static pluginDiscoverable = false;
  private session: any;
  private uri: string;
  private toolName: string;
  private toolDescription: string;
  private resourceTimeout: number;

  constructor(session: any, serverName: string, resourceDef: any, resourceTimeout = 30) {
    super();
    this.session = session;
    this.uri = resourceDef.uri;
    this.toolName = sanitizeName(`mcp_${serverName}_resource_${resourceDef.name}`);
    this.toolDescription = `[MCP Resource] ${resourceDef.description || resourceDef.name}\nURI: ${this.uri}`;
    this.resourceTimeout = resourceTimeout;
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return this.toolDescription;
  }

  get parameters() {
    return { type: "object", properties: {}, required: [] };
  }

  override get readOnly(): boolean {
    return true;
  }

  async execute(): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result: any = await timeoutPromise(this.session.readResource(this.uri), this.resourceTimeout, "timeout");
        return (result.contents ?? [])
          .map((block: any) => {
            if (block && typeof block.text === "string") return block.text;
            if (block && block.blob != null) return `[Binary resource: ${Buffer.from(block.blob).length} bytes]`;
            return String(block);
          })
          .join("\n") || "(no output)";
      } catch (error) {
        if ((error as Error).message === "timeout") return `(MCP resource read timed out after ${this.resourceTimeout}s)`;
        if ((error as Error).name === "CancelledError") return "(MCP resource read was cancelled)";
        if (isTransient(error) && attempt === 0) continue;
        if (isTransient(error)) return `(MCP resource read failed after retry: ${(error as Error).name})`;
        return `(MCP resource read failed: ${(error as Error).name || "Error"})`;
      }
    }
    return "(MCP resource read failed)";
  }
}

export class MCPPromptWrapper extends Tool {
  static pluginDiscoverable = false;
  private session: any;
  private promptName: string;
  private toolName: string;
  private toolDescription: string;
  private toolParameters: Record<string, any>;
  private promptTimeout: number;

  constructor(session: any, serverName: string, promptDef: any, promptTimeout = 30) {
    super();
    this.session = session;
    this.promptName = promptDef.name;
    this.toolName = sanitizeName(`mcp_${serverName}_prompt_${promptDef.name}`);
    this.toolDescription = `[MCP Prompt] ${promptDef.description || promptDef.name}\nReturns a filled prompt template that can be used as a workflow guide.`;
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const arg of promptDef.arguments ?? []) {
      properties[arg.name] = { type: "string", ...(arg.description ? { description: arg.description } : {}) };
      if (arg.required) required.push(arg.name);
    }
    this.toolParameters = { type: "object", properties, required };
    this.promptTimeout = promptTimeout;
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return this.toolDescription;
  }

  get parameters() {
    return this.toolParameters;
  }

  override get readOnly(): boolean {
    return true;
  }

  async execute(params: Record<string, any> = {}): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result: any = await timeoutPromise(this.session.getPrompt(this.promptName, params), this.promptTimeout, "timeout");
        return (result.messages ?? [])
          .flatMap((message: any) => (Array.isArray(message.content) ? message.content : [message.content]))
          .map(textFromContentBlock)
          .join("\n") || "(no output)";
      } catch (error) {
        if ((error as Error).message === "timeout") return `(MCP prompt call timed out after ${this.promptTimeout}s)`;
        if ((error as Error).name === "CancelledError") return "(MCP prompt call was cancelled)";
        if ((error as any).error?.message) {
          return `(MCP prompt call failed: ${(error as any).error.message} [code ${(error as any).error.code}])`;
        }
        if (isTransient(error) && attempt === 0) continue;
        if (isTransient(error)) return `(MCP prompt call failed after retry: ${(error as Error).name})`;
        const name = (error as Error).name || "Error";
        return `(MCP prompt call failed: ${name})`;
      }
    }
    return "(MCP prompt call failed)";
  }
}

type Stack = { close?: () => Promise<void>; aclose: () => Promise<void> };

async function enterMaybe(context: any, stack: Array<() => Promise<void>>): Promise<any> {
  const value = await context;
  if (Array.isArray(value)) {
    for (const item of value.slice(2)) {
      if (item && typeof item.destroy === "function") stack.push(() => Promise.resolve(item.destroy()));
      else if (item && typeof item.close === "function") stack.push(() => Promise.resolve(item.close()));
    }
    return value;
  }
  if (value && typeof value.enter === "function") {
    const entered = await value.enter();
    if (typeof value.close === "function") stack.push(() => Promise.resolve(value.close()));
    return entered;
  }
  if (value && typeof value[Symbol.asyncDispose] === "function") {
    stack.push(() => value[Symbol.asyncDispose]());
    return value;
  }
  return value;
}

function cfgValue(cfg: any, ...names: string[]): any {
  for (const name of names) {
    if (cfg?.[name] !== undefined) return cfg[name];
  }
  return undefined;
}

export async function connectMcpServers(
  servers: Record<string, any>,
  registry: ToolRegistry,
): Promise<Record<string, Stack>> {
  let runtime: Runtime;
  try {
    runtime = await loadRuntime();
  } catch (error) {
    console.error(`MCP runtime unavailable: ${(error as Error).message}`);
    return {};
  }
  const stacks: Record<string, Stack> = {};

  for (const [name, cfg] of Object.entries(servers)) {
    const closers: Array<() => Promise<void>> = [];
    try {
      let transport = cfgValue(cfg, "type", "transport");
      const command = cfgValue(cfg, "command");
      const url = cfgValue(cfg, "url");
      if (!transport) transport = command ? "stdio" : url?.replace(/\/+$/g, "").endsWith("/sse") ? "sse" : "streamableHttp";
      let read: any;
      let write: any;
      if (transport === "stdio") {
        const [normalizedCommand, args, env] = normalizeWindowsStdioCommand(
          command,
          cfgValue(cfg, "args") ?? [],
          cfgValue(cfg, "env") ?? null,
          cfgValue(cfg, "platform"),
        );
        const params = new runtime.StdioServerParameters({
          command: normalizedCommand,
          args,
          env,
          cwd: cfgValue(cfg, "cwd") ?? null,
        });
        [read, write] = await enterMaybe(runtime.stdioClient(params), closers);
      } else if (transport === "sse" || transport === "streamableHttp") {
        if (!url || !(await probeHttpUrl(url))) continue;
        if (transport === "sse") {
          [read, write] = await enterMaybe(runtime.sseClient(url, { headers: cfgValue(cfg, "headers") ?? null }), closers);
        } else {
          const entered = await enterMaybe(runtime.streamableHttpClient(url, { headers: cfgValue(cfg, "headers") ?? null }), closers);
          [read, write] = entered;
        }
      } else {
        continue;
      }

      const session = new runtime.ClientSession(read, write);
      const liveSession = typeof session.enter === "function" ? await enterMaybe(session, closers) : session;
      await liveSession.initialize?.();
      const tools = await liveSession.listTools?.();
      const enabledTools = new Set(cfgValue(cfg, "enabled_tools", "enabledTools") ?? ["*"]);
      const allowAll = enabledTools.has("*");
      const matched = new Set<string>();
      const availableRaw = (tools?.tools ?? []).map((tool: any) => tool.name);
      const availableWrapped = (tools?.tools ?? []).map((tool: any) => sanitizeName(`mcp_${name}_${tool.name}`));
      for (const toolDef of tools?.tools ?? []) {
        const wrapped = sanitizeName(`mcp_${name}_${toolDef.name}`);
        if (!allowAll && !enabledTools.has(toolDef.name) && !enabledTools.has(wrapped)) continue;
        registry.register(new MCPToolWrapper(liveSession, name, toolDef, cfgValue(cfg, "tool_timeout", "toolTimeout") ?? 30));
        if (enabledTools.has(toolDef.name)) matched.add(toolDef.name);
        if (enabledTools.has(wrapped)) matched.add(wrapped);
      }
      if (enabledTools.size && !allowAll) {
        const unknown = [...enabledTools].map(String).filter((entry) => !matched.has(entry));
        if (unknown.length) {
          console.warn(
            `MCP server '${name}': enabledTools entries not found: ${unknown.join(", ")}. ` +
              `Available raw names: ${availableRaw.join(", ") || "(none)"}. ` +
              `Available wrapped names: ${availableWrapped.join(", ") || "(none)"}`,
          );
        }
      }
      try {
        const resources = await liveSession.listResources?.();
        for (const resource of resources?.resources ?? []) {
          registry.register(new MCPResourceWrapper(liveSession, name, resource, cfgValue(cfg, "tool_timeout", "toolTimeout") ?? 30));
        }
      } catch {
        // Resource discovery is optional for MCP servers that do not implement it.
      }
      try {
        const prompts = await liveSession.listPrompts?.();
        for (const prompt of prompts?.prompts ?? []) {
          registry.register(new MCPPromptWrapper(liveSession, name, prompt, cfgValue(cfg, "tool_timeout", "toolTimeout") ?? 30));
        }
      } catch {
        // Prompt discovery is optional for MCP servers that do not implement it.
      }
      stacks[name] = {
        close: async () => {
          for (const close of closers.reverse()) await close().catch(() => undefined);
        },
        aclose: async () => {
          for (const close of closers.reverse()) await close().catch(() => undefined);
        },
      };
    } catch (error) {
      const text = String((error as Error).message ?? error).toLowerCase();
      if (["parse error", "invalid json", "unexpected token", "jsonrpc", "content-length"].some((marker) => text.includes(marker))) {
        console.error(
          `MCP server '${name}': failed to connect. Hint: this looks like stdio protocol pollution. ` +
            "Make sure the MCP server writes only JSON-RPC to stdout and sends logs/debug output to stderr instead.",
        );
      }
      for (const close of closers.reverse()) await close().catch(() => undefined);
    }
  }

  return stacks;
}

type McpState = {
  mcpServers?: Record<string, any>;
  mcpStacks?: Record<string, Stack>;
  mcpConnected?: boolean;
  mcpConnecting?: boolean;
};

function asNameSet(value: Iterable<string> | null | undefined): Set<string> | null {
  if (value == null) return null;
  return value instanceof Set ? new Set(value) : new Set([...value].map(String));
}

function metadataOf(message: any): Record<string, any> | null {
  const metadata = message?.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : null;
}

export function sessionExtra(metadata: Record<string, any> | null | undefined): Record<string, any> {
  const presets = metadata && typeof metadata === "object" ? metadata.mcp_presets : null;
  return Array.isArray(presets) && presets.length ? { mcp_presets: presets } : {};
}

export function runtimeLines(
  message: any,
  {
    availableServerNames = null,
    configuredServerNames = undefined,
    connectedServerNames = undefined,
    skip = false,
  }: {
    availableServerNames?: Iterable<string> | null;
    configuredServerNames?: Iterable<string> | null | undefined;
    connectedServerNames?: Iterable<string> | null | undefined;
    skip?: boolean;
  } = {},
): string[] {
  if (skip) return [];
  const available = asNameSet(availableServerNames);
  const configured = configuredServerNames === undefined ? available : asNameSet(configuredServerNames);
  const connected = connectedServerNames === undefined ? available : asNameSet(connectedServerNames);
  const structured = metadataOf(message)?.mcp_presets;
  if (!Array.isArray(structured)) return [];

  const lines: string[] = [];
  for (const item of structured.slice(0, 8)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rawName = String(item.name ?? "").trim().toLowerCase();
    if (!rawName) continue;
    const display = String(item.display_name ?? rawName).trim() || rawName;
    const transport = String(item.transport ?? "mcp").trim() || "mcp";
    const prefix = `mcp_${rawName}_`;
    if (configured && !configured.has(rawName)) {
      lines.push(
        `MCP Preset Attachment: @${rawName} (${display}; transport=${transport}) is configured in WebUI Settings, ` +
          "but this gateway has not loaded the latest MCP settings yet. " +
          `Tools with prefix \`${prefix}\` may not be available yet; if they are missing, tell the user to restart memmy.`,
      );
      continue;
    }
    if (connected && !connected.has(rawName)) {
      lines.push(
        `MCP Preset Attachment: @${rawName} (${display}; transport=${transport}) is configured, ` +
          "but its MCP connection is not currently live. " +
          `Tools with prefix \`${prefix}\` may be unavailable; tell the user to open Settings, ` +
          "run the preset test, and restart memmy only if hot reload is unavailable.",
      );
      continue;
    }
    lines.push(
      `MCP Preset Attachment: @${rawName} (${display}; transport=${transport}; tool_prefix=${prefix}). ` +
        `Prefer available tools whose names start with \`${prefix}\` for this request; ` +
        "do not substitute shell commands for this MCP integration unless the user asks.",
    );
  }
  return lines;
}

export async function connectMissingServers(state: McpState, registry: ToolRegistry): Promise<void> {
  state.mcpServers ??= {};
  state.mcpStacks ??= {};
  const missing = Object.fromEntries(
    Object.entries(state.mcpServers).filter(([name]) => !(name in (state.mcpStacks ?? {}))),
  );
  if (state.mcpConnecting || !Object.keys(missing).length) return;
  state.mcpConnecting = true;
  try {
    const connected = await connectMcpServers(missing, registry);
    Object.assign(state.mcpStacks, connected);
    state.mcpConnected = Object.keys(state.mcpStacks).length > 0;
  } catch {
    state.mcpConnected = Object.keys(state.mcpStacks).length > 0;
  } finally {
    state.mcpConnecting = false;
  }
}

async function withReloadLock<T>(state: object, fn: () => Promise<T>): Promise<T> {
  const previous = RELOAD_LOCKS.get(state) ?? Promise.resolve();
  let release = () => {};
  const current = previous.then(() => new Promise<void>((resolve) => {
    release = resolve;
  }));
  RELOAD_LOCKS.set(state, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (RELOAD_LOCKS.get(state) === current) RELOAD_LOCKS.delete(state);
  }
}

export function reloadLock(state: object): Promise<void> {
  return RELOAD_LOCKS.get(state) ?? Promise.resolve();
}

function stableValue(value: any): any {
  if (value && typeof value.toObject === "function") return stableValue(value.toObject());
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .flatMap((key) => {
          const current = value[key];
          if (current === undefined) return [];
          if (key === "args" && Array.isArray(current) && current.length === 0) return [];
          if ((key === "command" || key === "cwd" || key === "url") && current === "") return [];
          if ((key === "toolTimeout" || key === "tool_timeout") && current === 30) return [];
          if (
            (key === "enabledTools" || key === "enabled_tools") &&
            Array.isArray(current) &&
            current.length === 1 &&
            current[0] === "*"
          ) return [];
          if ((key === "env" || key === "headers") && current && typeof current === "object" && !Array.isArray(current) && Object.keys(current).length === 0) return [];
          return [[key, stableValue(current)]];
        }),
    );
  }
  return value;
}

export function serverSignature(cfg: any): string {
  return JSON.stringify(stableValue(cfg));
}

export function toolPrefix(serverName: string): string {
  return sanitizeName(`mcp_${serverName}_`);
}

export function unregisterServerTools(state: McpState, registry: ToolRegistry, serverName: string): number {
  const prefix = toolPrefix(serverName);
  let removed = 0;
  for (const toolName of [...registry.toolNames]) {
    if (toolName.startsWith(prefix)) {
      registry.unregister(toolName);
      removed += 1;
    }
  }
  return removed;
}

export async function closeServer(state: McpState, serverName: string): Promise<void> {
  const stack = state.mcpStacks?.[serverName];
  if (!stack) return;
  delete state.mcpStacks![serverName];
  try {
    if (typeof stack.aclose === "function") await stack.aclose();
    else if (typeof stack.close === "function") await stack.close();
  } catch {
    // MCP SDK cleanup can surface transport cancellation errors after a server is already gone.
  }
}

export async function reloadServers(state: McpState, registry: ToolRegistry): Promise<Record<string, any>> {
  return withReloadLock(state as object, async () => {
    let nextServers: Record<string, any>;
    try {
      const config = resolveConfigEnvVars(loadConfig());
      nextServers = { ...config.tools.mcpServers };
    } catch (error) {
      return {
        ok: false,
        message: "Could not reload MCP config. Restart memmy to pick up changes.",
        requires_restart: true,
        error: String((error as Error).message ?? error),
      };
    }

    state.mcpServers ??= {};
    state.mcpStacks ??= {};
    const currentServers = { ...state.mcpServers };
    const currentNames = new Set(Object.keys(currentServers));
    const nextNames = new Set(Object.keys(nextServers));
    const removed = [...currentNames].filter((name) => !nextNames.has(name)).sort();
    const added = [...nextNames].filter((name) => !currentNames.has(name)).sort();
    const changed = [...currentNames]
      .filter((name) => nextNames.has(name) && serverSignature(currentServers[name]) !== serverSignature(nextServers[name]))
      .sort();

    let toolsRemoved = 0;
    for (const name of [...removed, ...changed]) {
      toolsRemoved += unregisterServerTools(state, registry, name);
      await closeServer(state, name);
    }

    state.mcpServers = nextServers;
    const changedOrAdded = new Set([...added, ...changed]);
    const retryMissing = [...nextNames]
      .filter((name) => !(name in (state.mcpStacks ?? {})) && !changedOrAdded.has(name))
      .sort();
    const toConnectNames = [...new Set([...added, ...changed, ...retryMissing])].sort();
    const toConnect = Object.fromEntries(toConnectNames.map((name) => [name, nextServers[name]]));
    const connected = toConnectNames.length ? await connectMcpServers(toConnect, registry) : {};
    Object.assign(state.mcpStacks, connected);
    state.mcpConnected = Object.keys(state.mcpStacks).length > 0;

    const failed = toConnectNames.filter((name) => !(name in connected)).sort();
    const unchanged = !removed.length && !added.length && !changed.length && !retryMissing.length;
    let message: string;
    if (failed.length) message = `MCP config reloaded, but some servers did not connect: ${failed.join(", ")}`;
    else if (unchanged) message = "MCP config is already live.";
    else if (retryMissing.length && !added.length && !changed.length && !removed.length) message = "MCP connections refreshed without restarting memmy.";
    else message = "MCP config reloaded without restarting memmy.";

    return {
      ok: failed.length === 0,
      message,
      added,
      changed,
      removed,
      retried: retryMissing,
      connected: Object.keys(state.mcpStacks).sort(),
      configured: Object.keys(state.mcpServers).sort(),
      failed,
      tools_removed: toolsRemoved,
      requires_restart: false,
    };
  });
}

function createAck(): { promise: Promise<Record<string, any>>; resolve: (value: Record<string, any>) => void; done: boolean } {
  let resolveFn!: (value: Record<string, any>) => void;
  const ack = {
    done: false,
    promise: new Promise<Record<string, any>>((resolve) => {
      resolveFn = resolve;
    }),
    resolve(value: Record<string, any>) {
      if (ack.done) return;
      ack.done = true;
      resolveFn(value);
    },
  };
  return ack;
}

export async function requestMcpReload(bus: any, { timeout = 15 }: { timeout?: number } = {}): Promise<Record<string, any>> {
  const ack = createAck();
  const publish = bus?.publishInbound;
  if (typeof publish !== "function") {
    return {
      ok: false,
      message: "MCP hot reload is unavailable. Restart memmy to pick up changes.",
      requires_restart: true,
    };
  }
  await publish.call(bus, new InboundMessage({
    channel: "system",
    senderId: "webui-settings",
    chatId: "runtime",
    content: RUNTIME_CONTROL_MCP_RELOAD,
    metadata: {
      [INBOUND_META_RUNTIME_CONTROL]: RUNTIME_CONTROL_MCP_RELOAD,
      [RUNTIME_CONTROL_ACK]: ack,
    },
  }));
  const timeoutMs = timeout * 1000;
  return Promise.race([
    ack.promise.then((result) => result && typeof result === "object" && !Array.isArray(result)
      ? result
      : {
          ok: false,
          message: "MCP hot reload returned an unexpected response.",
          requires_restart: true,
        }),
    new Promise<Record<string, any>>((resolve) => setTimeout(() => resolve({
      ok: false,
      message: "MCP hot reload timed out. Restart memmy to pick up changes.",
      requires_restart: true,
    }), timeoutMs)),
  ]);
}

function resolveAck(ack: any, result: Record<string, any>): void {
  if (!ack) return;
  if (typeof ack === "function") ack(result);
  else if (typeof ack.resolve === "function") ack.resolve(result);
}

export async function handleRuntimeControl(state: McpState, msg: InboundMessage, registry: ToolRegistry): Promise<boolean> {
  const metadata = msg?.metadata && typeof msg.metadata === "object" ? msg.metadata : {};
  const control = metadata[INBOUND_META_RUNTIME_CONTROL];
  if (control !== RUNTIME_CONTROL_MCP_RELOAD) return false;

  let result: Record<string, any>;
  try {
    result = await reloadServers(state, registry);
  } catch (error) {
    result = {
      ok: false,
      message: "MCP hot reload failed. Restart memmy to pick up changes.",
      requires_restart: true,
      error: String((error as Error).message ?? error),
    };
  }
  resolveAck(metadata[RUNTIME_CONTROL_ACK], result);
  return true;
}

export class MCPTool extends MCPToolWrapper {}

export class MCPConnectionManager {
  async close(): Promise<void> {}
}
