import fs from "node:fs";
import path from "node:path";
import * as mcpTools from "../../core/agent-runtime/tools/mcp.js";
import { ToolRegistry } from "../../core/agent-runtime/tools/registry.js";
import { appManifest, compactDict } from "./app-manifest.js";
import { loadConfig, resolveConfigEnvVars, saveConfig } from "../../config/loader.js";
import { getRuntimeSubdir } from "../../config/paths.js";
import { MCPServerConfig } from "../../config/schema.js";

type QueryParams = Record<string, string[]>;
type TargetKind = "env" | "url_param" | "arg" | "header";

export class McpPresetError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

class McpPresetField {
  constructor(
    public name: string,
    public label: string,
    public target: [TargetKind, string],
    public secret = true,
    public required = true,
    public envVar: string | null = null,
    public placeholder = "",
  ) {}
}

class McpPreset {
  constructor(
    public name: string,
    public displayName: string,
    public category: string,
    public description: string,
    public docsUrl: string,
    public transport: string,
    public installSupported: boolean,
    public brandDomain: string,
    public brandColor: string,
    public server: Record<string, any> | null = null,
    public fields: McpPresetField[] = [],
    public requires = "",
    public note = "",
  ) {}
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SECRET_RE = /([?&](?:[^=&]*(?:api[_-]?key|token|secret|password|bearer)[^=&]*)=)[^&#\s]+/gi;
const SECRET_ASSIGNMENT_RE = /((?:api[_-]?key|token|secret|password|bearer)(?:[=:]|\s+))[^,\s'"&]+/gi;
const ATTACHMENT_KEYS = ["name", "display_name", "category", "transport", "logo_url", "brand_color", "status", "configured"];
const MAX_TEST_TOOLS = 16;
const DEFAULT_TEST_TIMEOUT = 20;
const DEFAULT_CUSTOM_TIMEOUT = 30;
const CUSTOM_ACTIONS = new Set(["custom", "import", "import-cursor", "tools"]);

class McpPresetTestTimeoutError extends Error {}

function favicon(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}

export const MCP_PRESETS = [
  new McpPreset(
    "browserbase",
    "Browserbase",
    "browser",
    "Cloud browser automation through Browserbase's hosted MCP server.",
    "https://docs.browserbase.com/integrations/mcp/setup",
    "streamableHttp",
    true,
    "browserbase.com",
    "#111827",
    { type: "streamableHttp", url: "https://mcp.browserbase.com/mcp", tool_timeout: 60 },
    [new McpPresetField("browserbase_api_key", "Browserbase API key", ["url_param", "browserbaseApiKey"], true, true, "BROWSERBASE_API_KEY", "bb_live_...")],
    "Browserbase API key",
  ),
  new McpPreset(
    "playwright",
    "Playwright",
    "browser",
    "Local browser inspection and automation with the official Playwright MCP server.",
    "https://playwright.dev/docs/getting-started-mcp",
    "stdio",
    true,
    "playwright.dev",
    "#2EAD33",
    { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], tool_timeout: 60 },
    [],
    "Node.js and npx",
  ),
  new McpPreset(
    "context7",
    "Context7",
    "docs",
    "Fetch current library docs and code examples while the agent works.",
    "https://context7.com/docs/resources/all-clients",
    "stdio",
    true,
    "context7.com",
    "#111827",
    { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], tool_timeout: 45 },
    [new McpPresetField("context7_api_key", "Context7 API key", ["arg", "--api-key"], true, false, "CONTEXT7_API_KEY", "ctx7_...")],
    "Node.js and npx; API key optional",
    "Works without a key for basic public docs; add a key for higher limits or private docs.",
  ),
  new McpPreset(
    "firecrawl",
    "Firecrawl",
    "web",
    "Scrape, crawl, search, and extract web pages through Firecrawl's MCP server.",
    "https://docs.firecrawl.dev/use-cases/developers-mcp",
    "stdio",
    true,
    "firecrawl.dev",
    "#EB5E28",
    { type: "stdio", command: "npx", args: ["-y", "firecrawl-mcp"], tool_timeout: 60 },
    [new McpPresetField("firecrawl_api_key", "Firecrawl API key", ["env", "FIRECRAWL_API_KEY"], true, true, "FIRECRAWL_API_KEY", "fc-...")],
    "Node.js, npx, and Firecrawl API key",
  ),
  new McpPreset(
    "exa",
    "Exa",
    "web",
    "Search the web and fetch clean page content through Exa's hosted MCP server.",
    "https://exa.ai/mcp",
    "streamableHttp",
    true,
    "exa.ai",
    "#101010",
    { type: "streamableHttp", url: "https://mcp.exa.ai/mcp", tool_timeout: 45 },
    [],
    "Network access",
    "Hosted Exa MCP endpoint currently does not require an API key.",
  ),
  new McpPreset(
    "microsoft-learn",
    "Microsoft Learn",
    "docs",
    "Search and fetch official Microsoft Learn documentation through Microsoft's hosted MCP server.",
    "https://learn.microsoft.com/en-us/training/support/mcp",
    "streamableHttp",
    true,
    "learn.microsoft.com",
    "#0078D4",
    { type: "streamableHttp", url: "https://learn.microsoft.com/api/mcp", tool_timeout: 45 },
    [],
    "Network access",
    "Public documentation only; no authentication required.",
  ),
  new McpPreset(
    "aws-docs",
    "AWS Documentation",
    "docs",
    "Search AWS documentation and service guidance through AWS Labs' documentation MCP server.",
    "https://awslabs.github.io/mcp/servers/aws-documentation-mcp-server/",
    "stdio",
    true,
    "aws.amazon.com",
    "#FF9900",
    {
      type: "stdio",
      command: "uvx",
      args: ["awslabs.aws-documentation-mcp-server@latest"],
      env: { FASTMCP_LOG_LEVEL: "ERROR", AWS_DOCUMENTATION_PARTITION: "aws" },
      tool_timeout: 60,
    },
    [],
    "uvx",
  ),
  new McpPreset(
    "brave-search",
    "Brave Search",
    "web",
    "Run web, news, image, video, and local search through Brave Search.",
    "https://www.npmjs.com/package/@brave/brave-search-mcp-server",
    "stdio",
    true,
    "brave.com",
    "#FB542B",
    { type: "stdio", command: "npx", args: ["-y", "@brave/brave-search-mcp-server@latest", "--transport", "stdio"], tool_timeout: 45 },
    [new McpPresetField("brave_api_key", "Brave Search API key", ["env", "BRAVE_API_KEY"], true, true, "BRAVE_API_KEY", "BSA...")],
    "Node.js, npx, and Brave Search API key",
  ),
  new McpPreset(
    "postman",
    "Postman",
    "api",
    "Inspect and manage Postman APIs, collections, and workspaces through the local MCP server.",
    "https://learning.postman.com/docs/developer/postman-api/postman-mcp-server/postman-mcp-local-server",
    "stdio",
    true,
    "postman.com",
    "#FF6C37",
    { type: "stdio", command: "npx", args: ["-y", "@postman/postman-mcp-server@latest", "--full"], tool_timeout: 60 },
    [new McpPresetField("postman_api_key", "Postman API key", ["env", "POSTMAN_API_KEY"], true, true, "POSTMAN_API_KEY", "PMAK-...")],
    "Node.js, npx, and Postman API key",
  ),
  new McpPreset(
    "figma",
    "Figma",
    "design",
    "Read design context from Figma using the official local Dev Mode MCP server.",
    "https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server",
    "streamableHttp",
    true,
    "figma.com",
    "#F24E1E",
    { type: "streamableHttp", url: "http://127.0.0.1:3845/mcp", tool_timeout: 45 },
    [],
    "Figma desktop app with MCP enabled",
    "Requires Figma Desktop Dev Mode MCP to be running locally.",
  ),
  new McpPreset(
    "github",
    "GitHub",
    "code",
    "Repository, issue, and pull request workflows via GitHub's official MCP server.",
    "https://github.com/github/github-mcp-server",
    "stdio",
    true,
    "github.com",
    "#24292F",
    {
      type: "stdio",
      command: "docker",
      args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      tool_timeout: 60,
    },
    [new McpPresetField("github_token", "GitHub token", ["env", "GITHUB_PERSONAL_ACCESS_TOKEN"], true, true, "GITHUB_PERSONAL_ACCESS_TOKEN", "ghp_...")],
    "Docker and GitHub token",
  ),
  new McpPreset(
    "supabase",
    "Supabase",
    "database",
    "Inspect and manage Supabase projects through the Supabase MCP server.",
    "https://supabase.com/docs/guides/ai-tools/mcp",
    "stdio",
    true,
    "supabase.com",
    "#3ECF8E",
    { type: "stdio", command: "npx", args: ["-y", "@supabase/mcp-server-supabase@latest", "--read-only"], tool_timeout: 60 },
    [new McpPresetField("supabase_access_token", "Supabase access token", ["env", "SUPABASE_ACCESS_TOKEN"], true, true, "SUPABASE_ACCESS_TOKEN", "sbp_...")],
    "Node.js, npx, and Supabase access token",
    "MVP config starts read-only by default.",
  ),
];

function queryFirst(query: QueryParams, key: string): string | null {
  return query[key]?.[0] ?? null;
}

function queryValue(query: QueryParams, key: string): string | null {
  const raw = queryFirst(query, key);
  if (raw == null) return null;
  const value = raw.trim();
  return value || null;
}

function presetByName(name: string): McpPreset {
  const normalized = name.trim().toLowerCase();
  if (!normalized || !NAME_RE.test(normalized)) throw new McpPresetError("invalid MCP preset name");
  const preset = MCP_PRESETS.find((row) => row.name === normalized);
  if (!preset) throw new McpPresetError("unknown MCP preset", 404);
  return preset;
}

function presetByNameOptional(name: string): McpPreset | null {
  try {
    return presetByName(name);
  } catch {
    return null;
  }
}

function knownPresetNames(): Set<string> {
  return new Set(MCP_PRESETS.map((preset) => preset.name));
}

function knownMcpNames(): Set<string> {
  const names = knownPresetNames();
  try {
    for (const name of Object.keys(loadConfig().tools.mcpServers)) names.add(name);
  } catch {}
  return names;
}

function clipWsString(value: any, limit = 240): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, limit) : null;
}

function cloneServer(server: Record<string, any> | null): MCPServerConfig {
  return new MCPServerConfig(structuredClone(server ?? {}));
}

function withManagedCwd(name: string, cfg: MCPServerConfig): MCPServerConfig {
  const transport = (cfg as any).type ?? cfg.transport;
  if (!cfg.command || (transport && transport !== "stdio")) return cfg;
  if ((cfg as any).cwd) return cfg;
  const cwd = path.join(getRuntimeSubdir("mcp"), name);
  fs.mkdirSync(cwd, { recursive: true });
  (cfg as any).cwd = cwd;
  return cfg;
}

function removeManagedCwd(name: string, cfg: MCPServerConfig | undefined): boolean {
  const cwd = (cfg as any)?.cwd;
  if (!cwd) return false;
  const managedRoot = path.join(getRuntimeSubdir("mcp"), name);
  if (path.resolve(cwd) !== path.resolve(managedRoot) || !fs.existsSync(cwd)) return false;
  fs.rmSync(cwd, { recursive: true, force: true });
  return true;
}

function urlWithParam(url: string, key: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

function argValue(args: string[], flag: string): string | null {
  const prefix = `${flag}=`;
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === flag && index + 1 < args.length) return args[index + 1] ?? null;
    if (item.startsWith(prefix)) return item.slice(prefix.length);
  }
  return null;
}

function withArgValue(args: string[], flag: string, value: string): string[] {
  const out: string[] = [];
  let skipNext = false;
  const prefix = `${flag}=`;
  for (const item of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (item === flag) {
      skipNext = true;
      continue;
    }
    if (item.startsWith(prefix)) continue;
    out.push(item);
  }
  out.push(flag, value);
  return out;
}

function fieldValueFromConfig(field: McpPresetField, cfg: MCPServerConfig | undefined | null): string | null {
  if (!cfg) return null;
  const [kind, key] = field.target;
  if (kind === "env") return cfg.env?.[key] || null;
  if (kind === "header") return (cfg as any).headers?.[key] || null;
  if (kind === "arg") return argValue(cfg.args ?? [], key);
  if (kind === "url_param" && cfg.url) {
    try {
      return new URL(cfg.url).searchParams.get(key);
    } catch {
      return null;
    }
  }
  return null;
}

function fieldConfigured(field: McpPresetField, cfg: MCPServerConfig | undefined | null): boolean {
  return Boolean(fieldValueFromConfig(field, cfg) || (field.envVar && process.env[field.envVar]));
}

function resolveFieldValue(field: McpPresetField, query: QueryParams, existing: MCPServerConfig | undefined | null): string | null {
  const provided = queryValue(query, field.name);
  if (provided) return provided;
  const current = fieldValueFromConfig(field, existing);
  if (current) return current;
  if (field.envVar && process.env[field.envVar]) return `\${${field.envVar}}`;
  return null;
}

function materializeServer(preset: McpPreset, query: QueryParams, existing?: MCPServerConfig | null): MCPServerConfig {
  if (!preset.server || !preset.installSupported) throw new McpPresetError(`${preset.displayName} is not supported yet`, 409);
  const cfg = cloneServer(preset.server);
  cfg.args = [...(cfg.args ?? [])];
  cfg.env = { ...(cfg.env ?? {}) };
  (cfg as any).headers = { ...((cfg as any).headers ?? {}) };
  for (const field of preset.fields) {
    const value = resolveFieldValue(field, query, existing);
    if (!value) {
      if (field.required) throw new McpPresetError(`missing ${field.label}`);
      continue;
    }
    const [kind, key] = field.target;
    if (kind === "env") cfg.env[key] = value;
    else if (kind === "header") (cfg as any).headers[key] = value;
    else if (kind === "url_param") cfg.url = urlWithParam(cfg.url ?? "", key, value);
    else if (kind === "arg") cfg.args = withArgValue(cfg.args ?? [], key, value);
  }
  return withManagedCwd(preset.name, cfg);
}

function scrub(value: any): any {
  if (typeof value === "string") return value.replace(SECRET_RE, "$1***");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /key|token|secret|password|bearer/i.test(k) ? "***" : scrub(v)]));
  return value;
}

function scrubTestError(text: string): string {
  const scrubbed = text.trim().replace(SECRET_RE, "$1<redacted>").replace(SECRET_ASSIGNMENT_RE, "$1<redacted>");
  return scrubbed ? scrubbed.slice(0, 400) : "Connection failed.";
}

function checkedAt(): string {
  return new Date().toISOString();
}

function testTimeout(cfg: MCPServerConfig): number {
  const raw = Number((cfg as any).tool_timeout ?? (cfg as any).toolTimeout ?? DEFAULT_TEST_TIMEOUT);
  return Math.max(5, Math.min(Number.isFinite(raw) ? raw : DEFAULT_TEST_TIMEOUT, DEFAULT_TEST_TIMEOUT));
}

function manifest(preset: McpPreset, logoUrl: string): Record<string, any> {
  const server = preset.server;
  const managedPaths = managedMcpPath(preset.name, server ? new MCPServerConfig(server) : undefined);
  const fields = preset.fields.map((field) => compactDict({
    name: field.name,
    target: field.target[0],
    required: field.required,
    secret: field.secret,
    env_var: field.envVar,
  }));
  const capabilities = [
    compactDict({
      type: "mcp",
      transport: preset.transport,
      command: server?.command,
      args: server?.command ? [...(server.args ?? [])] : null,
      url: server?.url ? customConnectionSummary(new MCPServerConfig(server)) : null,
      fields,
    }),
  ];
  return appManifest({
    appId: preset.name,
    displayName: preset.displayName,
    description: preset.description,
    category: preset.category,
    source: "mcp-preset",
    docsUrl: preset.docsUrl,
    logoUrl,
    brandColor: preset.brandColor,
    capabilities,
    install: compactDict({
      supported: preset.installSupported,
      strategy: "config",
      managed_paths: managedPaths,
      verification: ["config_present", "dependency_available"],
    }),
    remove: compactDict({
      supported: true,
      strategy: "config",
      managed_paths: managedPaths,
      verification: managedPaths.length ? ["config_absent", "managed_paths_absent"] : ["config_absent"],
    }),
    trust: {
      registry: "mcp-presets",
      level: "builtin",
      review_status: "builtin_preset",
    },
  });
}

function customManifest(name: string, cfg: MCPServerConfig): Record<string, any> {
  const transport = cfg.transport ?? (cfg as any).type ?? (cfg.command ? "stdio" : "streamableHttp");
  const managedPaths: string[] = [];
  return appManifest({
    appId: name,
    displayName: name,
    description: "Custom MCP server from memmy-agent config.",
    category: "custom",
    source: "mcp-custom",
    brandColor: "#64748B",
    capabilities: [
      compactDict({
        type: "mcp",
        transport,
        command: cfg.command || null,
        url: cfg.url ? customConnectionSummary(cfg) : null,
      }),
    ],
    install: compactDict({
      supported: true,
      strategy: "config",
      managed_paths: managedPaths,
      verification: ["config_present", "dependency_available"],
    }),
    remove: compactDict({
      supported: true,
      strategy: "config",
      managed_paths: managedPaths,
      verification: managedPaths.length ? ["config_absent", "managed_paths_absent"] : ["config_absent"],
    }),
    trust: {
      registry: "user-config",
      level: "user",
      review_status: "user_managed",
    },
  });
}

function customConnectionSummary(cfg: MCPServerConfig): string {
  if (cfg.command) return [cfg.command, ...(cfg.args ?? [])].join(" ").trim();
  if (cfg.url) {
    try {
      const parsed = new URL(cfg.url);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return String(scrub(cfg.url));
    }
  }
  return JSON.stringify(scrub(cfg.toObject?.() ?? cfg));
}

function fieldPayload(field: McpPresetField, cfg: MCPServerConfig | undefined): Record<string, any> {
  return {
    name: field.name,
    label: field.label,
    secret: field.secret,
    required: field.required,
    env_var: field.envVar,
    placeholder: field.placeholder,
    configured: fieldConfigured(field, cfg),
  };
}

function fieldConfiguredValue(field: McpPresetField, cfg: MCPServerConfig | undefined): string | null {
  return fieldValueFromConfig(field, cfg);
}

function connectionSummary(preset: McpPreset, cfg: MCPServerConfig | undefined): string {
  let summary = customConnectionSummary(cfg ?? new MCPServerConfig({}));
  for (const field of preset.fields) {
    if (!field.secret) continue;
    const value = fieldConfiguredValue(field, cfg);
    if (value) summary = summary.split(value).join("***");
  }
  return summary;
}

function configAvailable(cfg: MCPServerConfig | undefined | null): boolean {
  if (!cfg) return false;
  if (cfg.command) return commandAvailable(cfg.command);
  return Boolean(cfg.url);
}

function statusFor(preset: McpPreset, cfg: MCPServerConfig | undefined): string {
  if (!cfg) return preset.installSupported ? "not_installed" : "coming_soon";
  if (preset.fields.some((field) => field.required && !fieldConfigured(field, cfg))) return "missing_credentials";
  if (cfg.command && !commandAvailable(cfg.command)) return "missing_dependency";
  return "configured";
}

function toolAllowlist(cfg: MCPServerConfig | undefined | null): string[] {
  return (cfg as any)?.enabled_tools ?? (cfg as any)?.enabledTools ?? ["*"];
}

function managedMcpPath(name: string, cfg: MCPServerConfig | undefined | null): string[] {
  return cfg?.command ? [`runtime:mcp/${name}`] : [];
}

function presetPayload(preset: McpPreset, configuredServers: Record<string, MCPServerConfig>): Record<string, any> {
  const cfg = configuredServers[preset.name];
  const status = statusFor(preset, cfg);
  const installed = Boolean(cfg);
  const logoUrl = favicon(preset.brandDomain);
  return {
    name: preset.name,
    display_name: preset.displayName,
    category: preset.category,
    description: preset.description,
    docs_url: preset.docsUrl,
    transport: preset.transport,
    install_supported: preset.installSupported,
    installed,
    configured: installed && status !== "missing_credentials",
    available: installed && configAvailable(cfg),
    status,
    logo_url: logoUrl,
    brand_color: preset.brandColor,
    requires: preset.requires,
    note: preset.note,
    required_fields: preset.fields.map((field) => fieldPayload(field, cfg)),
    connection_summary: connectionSummary(preset, cfg),
    enabled_tools: toolAllowlist(cfg),
    source: "preset",
    manifest: manifest(preset, logoUrl),
  };
}

function customPayload(name: string, cfg: MCPServerConfig, toolNames: string[] = []): Record<string, any> {
  const transport = cfg.transport ?? (cfg as any).type ?? (cfg.command ? "stdio" : cfg.url?.endsWith("/sse") ? "sse" : "streamableHttp");
  const status = cfg.command && !commandAvailable(cfg.command) ? "missing_dependency" : "configured";
  return {
    name,
    display_name: name,
    source: "custom",
    category: "custom",
    description: "Custom MCP server from memmy-agent config.",
    docs_url: "",
    transport,
    requires: "",
    note: "",
    install_supported: true,
    installed: true,
    configured: true,
    available: configAvailable(cfg),
    status,
    logo_url: null,
    brand_color: "#64748B",
    required_fields: [],
    enabled_tools: toolAllowlist(cfg),
    tool_names: toolNames,
    custom: true,
    connection_summary: customConnectionSummary(cfg),
    manifest: customManifest(name, cfg),
  };
}

export function mcpPresetsPayload(extra: Record<string, any> = {}): Record<string, any> {
  const config = loadConfig();
  const servers = config.tools.mcpServers;
  const presets = MCP_PRESETS.map((preset) => presetPayload(preset, servers));
  const builtinNames = new Set(MCP_PRESETS.map((preset) => preset.name));
  for (const [name, cfg] of Object.entries(servers)) {
    if (builtinNames.has(name)) continue;
    presets.push(customPayload(name, cfg, extra.tool_preview?.[name] ?? []));
  }
  return { presets, installed_count: Object.keys(servers).length, requires_restart: Boolean(extra.requires_restart), ...extra };
}

function displayNameFor(name: string, preset: McpPreset | null = null): string {
  return preset?.displayName ?? name;
}

function actionMessage(action: string, preset: McpPreset, ok = true): Record<string, any> {
  const verb = { enable: "Enabled", remove: "Removed", test: "Checked" }[action] ?? "Updated";
  const payload: Record<string, any> = { ok, message: `${verb} MCP preset for ${preset.displayName}.` };
  if (action === "enable") {
    payload.installed = true;
    payload.verification = ["config_present"];
  } else if (action === "remove") {
    payload.removed = true;
    payload.verification = ["config_absent"];
  }
  return payload;
}

function serverActionMessage(action: string, name: string, ok = true): Record<string, any> {
  const verb = { custom: "Saved", import: "Imported", "import-cursor": "Imported", tools: "Updated tools for", remove: "Removed" }[action] ?? "Updated";
  const payload: Record<string, any> = { ok, message: `${verb} MCP server ${name}.` };
  if (["custom", "import", "import-cursor"].includes(action)) {
    payload.installed = true;
    payload.verification = ["config_present"];
  } else if (action === "remove") {
    payload.removed = true;
    payload.verification = ["config_absent"];
  }
  return payload;
}

export function mcpPresetsAction(action: string, query: QueryParams): Record<string, any> {
  const name = (queryFirst(query, "name") ?? "").trim().toLowerCase();
  if (!name) throw new McpPresetError("missing MCP preset name");
  const preset = presetByNameOptional(name);
  const config = loadConfig();
  if (action === "remove") {
    if (!preset && !(name in config.tools.mcpServers)) throw new McpPresetError("unknown MCP server", 404);
    const cfg = config.tools.mcpServers[name];
    let removedRuntimeFiles = false;
    let cleanupError = "";
    try {
      removedRuntimeFiles = removeManagedCwd(name, cfg);
    } catch (error) {
      cleanupError = (error as Error).message;
    }
    delete config.tools.mcpServers[name];
    saveConfig(config);
    const lastAction = preset ? actionMessage(action, preset) : serverActionMessage(action, name);
    if (removedRuntimeFiles) {
      lastAction.message = `${lastAction.message} Removed managed runtime files.`;
      lastAction.managed_paths_removed = [`runtime:mcp/${name}`];
      lastAction.verification = ["config_absent", "managed_paths_absent"];
    }
    if (cleanupError) {
      lastAction.ok = false;
      lastAction.message = `${lastAction.message} Could not remove managed runtime files: ${cleanupError}`;
      lastAction.verification_failed = ["managed_paths_absent"];
    }
    return mcpPresetsPayload({
      requires_restart: true,
      last_action: lastAction,
    });
  }
  if (action === "test") throw new McpPresetError("MCP preset test must run through the async test action", 500);
  if (action !== "enable") throw new McpPresetError(`unknown MCP preset action '${action}'`, 404);
  if (!preset) throw new McpPresetError("unknown MCP preset", 404);
  const server = materializeServer(preset, query, config.tools.mcpServers[preset.name]);
  config.tools.mcpServers[preset.name] = server;
  saveConfig(config);
  return mcpPresetsPayload({
    requires_restart: true,
    last_action: actionMessage(action, preset),
  });
}

function withConnectionTimeout<T>(promise: Promise<T>, timeoutSeconds: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new McpPresetTestTimeoutError());
    }, timeoutSeconds * 1000);
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

export async function mcpPresetsTestAction(query: QueryParams): Promise<Record<string, any>> {
  const name = (queryFirst(query, "name") ?? "").trim().toLowerCase();
  if (!name) throw new McpPresetError("missing MCP preset name");
  if (!NAME_RE.test(name)) throw new McpPresetError("invalid MCP server name");
  const preset = presetByNameOptional(name);
  const displayName = displayNameFor(name, preset);
  let config;
  try {
    config = resolveConfigEnvVars(loadConfig());
  } catch (error) {
    const message = scrubTestError((error as Error).message ?? String(error));
    return mcpPresetsPayload({
      last_action: {
        ok: false,
        message,
        error: message,
        tool_count: 0,
        tool_names: [],
        checked_at: checkedAt(),
      },
    });
  }
  const cfg = config.tools.mcpServers[name];
  if (!cfg) throw new McpPresetError(`${displayName} is not enabled`, 404);
  if (preset && statusFor(preset, cfg) === "missing_credentials") {
    return mcpPresetsPayload({
      last_action: {
        ok: false,
        message: `${displayName} is missing required credentials.`,
        error: "missing credentials",
        tool_count: 0,
        tool_names: [],
        checked_at: checkedAt(),
      },
    });
  }
  if (cfg.command && !commandAvailable(cfg.command)) {
    return mcpPresetsPayload({
      last_action: {
        ok: false,
        message: `${displayName} requires '${cfg.command}' on PATH.`,
        error: "missing dependency",
        tool_count: 0,
        tool_names: [],
        checked_at: checkedAt(),
      },
    });
  }
  const registry = new ToolRegistry();
  let stacks: Record<string, any> = {};
  let timedOut = false;
  try {
    const connectPromise = mcpTools.connectMcpServers({ [name]: cfg }, registry);
    connectPromise.then(async (connectedStacks) => {
      if (timedOut) await closeMcpStacks(connectedStacks);
    }, () => undefined);
    stacks = await withConnectionTimeout(connectPromise, testTimeout(cfg), () => {
      timedOut = true;
    });
    const toolPrefix = `mcp_${name}_`;
    const toolNames = registry.toolNames.filter((toolName) => toolName.startsWith(toolPrefix)).sort();
    const ok = name in stacks;
    return mcpPresetsPayload({
      last_action: {
        ok,
        message: ok
          ? toolNames.length
            ? `${displayName} connected with ${toolNames.length} tools.`
            : `${displayName} connected, but reported no tools.`
          : `${displayName} did not complete an MCP handshake.`,
        ...(ok ? {} : { error: "MCP handshake failed" }),
        tool_count: ok ? toolNames.length : 0,
        tool_names: ok ? toolNames.slice(0, MAX_TEST_TOOLS) : [],
        checked_at: checkedAt(),
      },
      tool_preview: ok && toolNames.length ? { [name]: toolNames.slice(0, MAX_TEST_TOOLS) } : undefined,
    });
  } catch (error) {
    if (error instanceof McpPresetTestTimeoutError) {
      return mcpPresetsPayload({
        last_action: {
          ok: false,
          message: `${displayName} test timed out.`,
          error: "timeout",
          tool_count: 0,
          tool_names: [],
          checked_at: checkedAt(),
        },
      });
    }
    return mcpPresetsPayload({
      last_action: {
        ok: false,
        message: `${displayName} could not connect.`,
        error: scrubTestError((error as Error).message ?? String(error)),
        tool_count: 0,
        tool_names: [],
        checked_at: checkedAt(),
      },
    });
  } finally {
    await closeMcpStacks(stacks);
  }
}

function commandAvailable(command: string): boolean {
  if (command.includes(path.sep)) return fs.existsSync(command);
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, command))) return true;
  }
  return false;
}

function parseJsonValue(raw: string | null, fallback: any): any {
  if (raw == null || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new McpPresetError(`invalid JSON: ${(error as Error).message}`);
  }
}

function parseStringList(raw: string | null): string[] {
  if (raw == null || !raw.trim()) return [];
  const parsed = parseJsonValue(raw, null);
  if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed.filter((item) => item.trim());
  if (typeof parsed === "string") return parsed.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((item) => item.replace(/^"|"$/g, "")) ?? [];
  throw new McpPresetError("expected a JSON string array");
}

function parseStringMap(raw: string | null): Record<string, string> {
  const parsed = parseJsonValue(raw, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new McpPresetError("expected a JSON object");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== "string" || typeof value !== "string") throw new McpPresetError("JSON object values must be strings");
    if (key.trim()) out[key.trim()] = value;
  }
  return out;
}

function parseEnabledTools(raw: string | null): string[] {
  if (raw == null || !raw.trim()) return ["*"];
  const values = parseStringList(raw);
  return values.includes("*") ? ["*"] : values;
}

function normalizeTransport(value: string | null, { command = "", url = "" }: { command?: string; url?: string } = {}): "stdio" | "sse" | "streamableHttp" {
  const raw = (value ?? "").trim();
  if (!raw) {
    if (command) return "stdio";
    if (url.replace(/\/$/, "").endsWith("/sse")) return "sse";
    return "streamableHttp";
  }
  const aliases: Record<string, "stdio" | "sse" | "streamableHttp"> = {
    stdio: "stdio",
    sse: "sse",
    streamableHttp: "streamableHttp",
    "streamable-http": "streamableHttp",
    streamable_http: "streamableHttp",
    http: "streamableHttp",
  };
  const normalized = aliases[raw];
  if (!normalized) throw new McpPresetError("unsupported MCP transport");
  return normalized;
}

function validatedServerName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized || !NAME_RE.test(normalized)) throw new McpPresetError("invalid MCP server name");
  return normalized;
}

function customServerFromQuery(query: QueryParams): [string, MCPServerConfig] {
  const name = validatedServerName(queryFirst(query, "name") ?? "");
  const command = (queryFirst(query, "command") ?? "").trim();
  const url = (queryFirst(query, "url") ?? "").trim();
  const transport = normalizeTransport(queryFirst(query, "transport"), { command, url });
  if (transport === "stdio" && !command) throw new McpPresetError("stdio MCP servers require a command");
  if ((transport === "sse" || transport === "streamableHttp") && !url) throw new McpPresetError("remote MCP servers require a URL");
  const rawTimeout = (queryFirst(query, "tool_timeout") ?? "").trim();
  let toolTimeout = DEFAULT_CUSTOM_TIMEOUT;
  if (rawTimeout) {
    const parsed = Number.parseInt(rawTimeout, 10);
    if (!Number.isFinite(parsed)) throw new McpPresetError("tool_timeout must be an integer");
    toolTimeout = Math.max(5, Math.min(parsed, 600));
  }
  const cfg = new MCPServerConfig({
    transport,
    type: transport,
    command: transport === "stdio" ? command : "",
    args: parseStringList(queryFirst(query, "args")),
    env: parseStringMap(queryFirst(query, "env")),
    cwd: transport === "stdio" ? (queryFirst(query, "cwd") ?? "").trim() : "",
    url: transport === "stdio" ? "" : url,
    headers: parseStringMap(queryFirst(query, "headers")),
    tool_timeout: toolTimeout,
    toolTimeout,
    enabled_tools: parseEnabledTools(queryFirst(query, "enabled_tools")),
    enabledTools: parseEnabledTools(queryFirst(query, "enabled_tools")),
  });
  return [name, cfg];
}

function mcpServerConfig(name: string, raw: any): [string, MCPServerConfig] {
  const serverName = validatedServerName(name);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new McpPresetError(`MCP server '${serverName}' must be an object`);
  const command = String(raw.command ?? "").trim();
  const url = String(raw.url ?? "").trim();
  const transport = normalizeTransport(String(raw.type ?? raw.transport ?? ""), { command, url });
  if (transport === "stdio" && !command) throw new McpPresetError(`MCP server '${serverName}' stdio transport requires a command`);
  if ((transport === "sse" || transport === "streamableHttp") && !url) throw new McpPresetError(`MCP server '${serverName}' remote transport requires a URL`);
  const args = raw.args ?? [];
  const env = raw.env ?? {};
  const headers = raw.headers ?? {};
  const enabledTools = raw.enabledTools ?? raw.enabled_tools ?? ["*"];
  if (!Array.isArray(args) || !args.every((item) => typeof item === "string")) throw new McpPresetError(`MCP server '${serverName}' args must be a string array`);
  if (!env || typeof env !== "object" || Array.isArray(env) || !Object.entries(env).every(([k, v]) => typeof k === "string" && typeof v === "string")) throw new McpPresetError(`MCP server '${serverName}' env must be a string object`);
  if (!headers || typeof headers !== "object" || Array.isArray(headers) || !Object.entries(headers).every(([k, v]) => typeof k === "string" && typeof v === "string")) throw new McpPresetError(`MCP server '${serverName}' headers must be a string object`);
  const timeoutRaw = raw.toolTimeout ?? raw.tool_timeout ?? DEFAULT_CUSTOM_TIMEOUT;
  const timeoutInt = Math.max(5, Math.min(Number.isFinite(Number(timeoutRaw)) ? Number(timeoutRaw) : DEFAULT_CUSTOM_TIMEOUT, 600));
  const allowedTools = Array.isArray(enabledTools) && enabledTools.every((item) => typeof item === "string") ? enabledTools : ["*"];
  return [
    serverName,
    new MCPServerConfig({
      transport,
      type: transport,
      command: transport === "stdio" ? command : "",
      args,
      env: { ...env },
      cwd: transport === "stdio" ? String(raw.cwd ?? "").trim() : "",
      url: transport === "stdio" ? "" : url,
      headers: { ...headers },
      tool_timeout: timeoutInt,
      toolTimeout: timeoutInt,
      enabled_tools: allowedTools,
      enabledTools: allowedTools,
    }),
  ];
}

function importMcpServers(rawJson: string | null): Record<string, MCPServerConfig> {
  const parsed = parseJsonValue(rawJson, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new McpPresetError("MCP config must be a JSON object");
  const servers = parsed.mcpServers ?? parsed.mcp_servers ?? parsed;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new McpPresetError("MCP config must contain mcpServers");
  const out: Record<string, MCPServerConfig> = {};
  for (const [name, raw] of Object.entries(servers)) {
    const [serverName, cfg] = mcpServerConfig(name, raw);
    out[serverName] = cfg;
  }
  if (!Object.keys(out).length) throw new McpPresetError("MCP config contains no servers");
  return out;
}

function closeMcpStacks(stacks: Record<string, any>): Promise<void> {
  return Promise.all(Object.values(stacks).map(async (stack) => {
    try {
      if (typeof stack?.aclose === "function") await stack.aclose();
      else if (typeof stack?.close === "function") await stack.close();
    } catch {}
  })).then(() => undefined);
}

export function customMcpAction(action: string, query: QueryParams): Record<string, any> {
  if (action === "import" || action === "import-cursor") {
    const servers = importMcpServers(queryFirst(query, "config"));
    const config = loadConfig();
    for (const [name, cfg] of Object.entries(servers)) {
      config.tools.mcpServers[name] = cfg;
    }
    saveConfig(config);
    return mcpPresetsPayload({
      requires_restart: true,
      last_action: { ok: true, message: `Imported ${Object.keys(servers).length} MCP server(s).` },
    });
  }

  if (action === "tools") {
    const name = validatedServerName(queryFirst(query, "name") ?? "");
    const enabledTools = parseEnabledTools(queryFirst(query, "enabled_tools"));
    const config = loadConfig();
    const cfg = config.tools.mcpServers[name];
    if (!cfg) throw new McpPresetError("unknown MCP server", 404);
    (cfg as any).enabledTools = enabledTools;
    (cfg as any).enabled_tools = enabledTools;
    saveConfig(config);
    return mcpPresetsPayload({
      requires_restart: true,
      last_action: serverActionMessage(action, name),
    });
  }

  if (action !== "custom") throw new McpPresetError(`unknown custom MCP action '${action}'`, 404);
  const [name, cfg] = customServerFromQuery(query);
  const config = loadConfig();
  config.tools.mcpServers[name] = cfg;
  saveConfig(config);
  return mcpPresetsPayload({ requires_restart: true, last_action: serverActionMessage(action, name) });
}

export function normalizeMcpPresetMentions(raw: any): Array<Record<string, any>> {
  if (!Array.isArray(raw)) return [];
  const known = knownMcpNames();
  const out: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const name = clipWsString(item.name, 64)?.toLowerCase() ?? "";
    if (!NAME_RE.test(name) || !known.has(name) || seen.has(name)) continue;
    seen.add(name);
    const row: Record<string, any> = { name };
    for (const key of ATTACHMENT_KEYS.slice(1)) {
      const value = item[key];
      const text = clipWsString(value, key === "logo_url" ? 512 : 160);
      if (text) row[key] = text;
      else if (typeof value === "boolean") row[key] = value;
    }
    out.push(row);
  }
  return out;
}

export function attachMcpHotReloadResult(payload: Record<string, any>, result: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...payload, hot_reload: result, requires_restart: Boolean(result.requires_restart) };
  const lastAction = { ...(merged.last_action ?? {}) };
  const baseMessage = String(lastAction.message ?? "").trim();
  const reloadMessage = String(result.message ?? "").trim();
  if (reloadMessage) lastAction.message = baseMessage ? `${baseMessage} ${reloadMessage}` : reloadMessage;
  if (!("ok" in lastAction)) lastAction.ok = Boolean(result.ok);
  merged.last_action = lastAction;
  return merged;
}

export async function mcpPresetsSettingsAction(
  action: string | null,
  query: QueryParams,
  { reloadMcp = null }: { reloadMcp?: (() => Promise<Record<string, any>>) | null } = {},
): Promise<Record<string, any>> {
  if (action == null) return mcpPresetsPayload();
  if (action === "test") return mcpPresetsTestAction(query);
  const payload = CUSTOM_ACTIONS.has(action) ? customMcpAction(action, query) : mcpPresetsAction(action, query);
  return reloadMcp ? attachMcpHotReloadResult(payload, await reloadMcp()) : payload;
}
