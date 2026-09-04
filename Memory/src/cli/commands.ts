import {
  hasOption,
  isRecord,
  optionBoolean,
  optionString,
  optionValues,
  parseArgs,
  parseStringArray,
  readBodyObject,
  requireValue,
  type JsonObject,
  type ParsedArgs
} from "./args.js";
import { sendRequest, type CliRequest, type CliRequestOptions } from "./http.js";
import { renderCliOutput } from "./render/index.js";
import {
  initMemoryCli,
  installMemoryCli,
  upgradeMemoryCli,
  type MemoryCliSetupOptions
} from "./setup.js";
import { DEFAULT_MEMORY_URL, loadCliMemoryConfig } from "./config.js";
import { PROJECT_VERSION } from "./project-version.js";
import {
  currentInstalledRuntime,
  startInstalledMemoryService,
  stopInstalledMemoryService
} from "./runtime-installer.js";

type Method = "GET" | "POST" | "DELETE";
const CLI_NAME = "memmy-memory";
const COMPACT_GET_TOOL_FIELD_CHARS = 1200;

export interface CommandContext {
  argv: string[];
  fetch?: typeof fetch;
  stopInstalledService?: (home: string) => Promise<Record<string, unknown>>;
}

export async function runCommand(context: CommandContext): Promise<unknown> {
  const parsed = parseArgs(context.argv);
  const options = parsed.options;
  const words = parsed.positionals;

  if (hasOption(options, "help") || hasOption(options, "h")) {
    return helpText();
  }
  if (words.length === 0 && (hasOption(options, "version") || hasOption(options, "v"))) {
    return PROJECT_VERSION;
  }
  if (words.length === 0 || words[0] === "help") {
    return helpText();
  }

  if (words[0] === "init") {
    return initMemoryCli(setupOptions(parsed));
  }

  if (words[0] === "install") {
    return installMemoryCli(setupOptions(parsed));
  }

  if (words[0] === "upgrade") {
    return upgradeMemoryCli(setupOptions(parsed));
  }

  if (words[0] === "stop") {
    const home = optionString(options, "home") ?? "~/.memmy";
    return (context.stopInstalledService ?? stopInstalledMemoryService)(home);
  }

  if (words[0] === "service") {
    const home = optionString(options, "home") ?? "~/.memmy";
    if (words[1] === "start") return startInstalledMemoryService(home);
    if (words[1] === "stop") return (context.stopInstalledService ?? stopInstalledMemoryService)(home);
    if (words[1] === "status") return { ok: true, runtime: await currentInstalledRuntime(home) ?? null };
    throw new Error("service requires start, stop, or status");
  }

  if (words[0] === "raw") {
    return runRaw(words.slice(1), parsed, requestOptions(parsed, context.fetch));
  }

  if (words[0] === "serve") {
    return serveMemory(parsed);
  }

  const getVerbose = words[0] === "get" && optionBoolean(options, "verbose") === true;
  const request = withSource(await mapTopLevelCommand(words, parsed), parsed);
  const result = await executeRequest(request, requestOptions(parsed, context.fetch));
  if (words[0] === "get" && !getVerbose) {
    return compactMemoryGetOutput(result) ?? result;
  }
  return result;
}

export function formatOutput(value: unknown): string {
  const rendered = renderCliOutput(value);
  if (rendered !== undefined) {
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  }
  if (typeof value === "string") {
    return value.endsWith("\n") ? value : `${value}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function mapTopLevelCommand(words: string[], parsed: ParsedArgs): Promise<CliRequest> {
  const [group] = words;
  switch (group) {
    case "health":
      return { method: "GET", path: "/health" };
    case "reload-config":
      return reloadConfigRequest(parsed);
    case "session":
      return sessionsRequest(words[1], words.slice(2), parsed);
    case "turn":
      return turnsRequest(words[1], words.slice(2), parsed);
    case "search":
      return buildMemorySearchRequest(words.slice(1), parsed);
    case "add":
      return addMemoryRequest(words.slice(1), parsed);
    case "get":
      return getMemoryRequest(words.slice(1), parsed);
    case "delete":
      return deleteMemoryRequest(words.slice(1), parsed);
    default:
      throw new Error(`unknown command: ${words.join(" ")}`);
  }
}

async function reloadConfigRequest(parsed: ParsedArgs): Promise<CliRequest> {
  return {
    method: "POST",
    path: "/admin/reload-config",
    body: await requestBody(parsed, {
      reason: optionString(parsed.options, "reason")
    })
  };
}

async function sessionsRequest(action: string | undefined, args: string[], parsed: ParsedArgs): Promise<CliRequest> {
  switch (action) {
    case "open":
      return {
        method: "POST",
        path: "/sessions/open",
        body: await requestBody(parsed, {
          sessionId: optionString(parsed.options, "session-id"),
          workspacePath: optionString(parsed.options, "workspace-path")
        })
      };
    case "close": {
      const sessionId = optionString(parsed.options, "session-id") ?? args[0];
      return {
        method: "POST",
        path: `/sessions/${encodeURIComponent(requireValue("sessionId", sessionId))}/close`
      };
    }
    default:
      throw new Error(`unknown sessions command: ${action ?? ""}`.trim());
  }
}

async function turnsRequest(action: string | undefined, args: string[], parsed: ParsedArgs): Promise<CliRequest> {
  switch (action) {
    case "start": {
      const query = optionString(parsed.options, "query") ?? args[0];
      return {
        method: "POST",
        path: "/turns/start",
        body: await requestBody(parsed, {
          sessionId: requireValue("sessionId", optionString(parsed.options, "session-id")),
          query: requireValue("query", query),
          turnId: optionString(parsed.options, "turn-id")
        })
      };
    }
    case "complete": {
      const turnId = optionString(parsed.options, "turn-id") ?? args[0];
      const query = optionString(parsed.options, "query");
      const answer = optionString(parsed.options, "answer") ?? args[1];
      return {
        method: "POST",
        path: `/turns/${encodeURIComponent(requireValue("turnId", turnId))}/complete`,
        body: await requestBody(parsed, {
          sessionId: requireValue("sessionId", optionString(parsed.options, "session-id")),
          query: requireValue("query", query),
          answer: requireValue("answer", answer),
          status: normalizeTurnStatus(optionString(parsed.options, "status"))
        })
      };
    }
    default:
      throw new Error(`unknown turns command: ${action ?? ""}`.trim());
  }
}

async function buildMemorySearchRequest(args: string[], parsed: ParsedArgs): Promise<CliRequest> {
  const query = optionString(parsed.options, "query") ?? args[0];
  return {
    method: "POST",
    path: "/memory/search",
    body: await requestBody(parsed, {
      query: requireValue("query", query),
      sessionId: optionString(parsed.options, "session-id"),
      layers: stringArrayOption(parsed, "layers"),
      verbose: optionBoolean(parsed.options, "verbose")
    })
  };
}

async function addMemoryRequest(args: string[], parsed: ParsedArgs): Promise<CliRequest> {
  const content = optionString(parsed.options, "content") ?? args[0];
  return {
    method: "POST",
    path: "/memory/add",
    body: await requestBody(parsed, {
      content: requireValue("content", content),
      layer: optionString(parsed.options, "layer"),
      title: optionString(parsed.options, "title"),
      tags: stringArrayOption(parsed, "tags"),
      source: optionString(parsed.options, "source"),
      sessionId: optionString(parsed.options, "session-id"),
      turnId: optionString(parsed.options, "turn-id")
    })
  };
}

function getMemoryRequest(args: string[], parsed: ParsedArgs): CliRequest {
  const id = optionString(parsed.options, "id") ?? args[0];
  return {
    method: "GET",
    path: `/memory/${encodeURIComponent(requireValue("id", id))}`
  };
}

async function deleteMemoryRequest(args: string[], parsed: ParsedArgs): Promise<CliRequest> {
  const id = optionString(parsed.options, "id") ?? args[0];
  return {
    method: "DELETE",
    path: `/memory/${encodeURIComponent(requireValue("id", id))}`
  };
}

async function runRaw(words: string[], parsed: ParsedArgs, options: CliRequestOptions): Promise<unknown> {
  const method = (words[0] ?? "").toUpperCase() as Method;
  const path = words[1];
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    throw new Error("raw requires method GET, POST, or DELETE");
  }
  if (!path) {
    throw new Error("raw requires endpoint path");
  }
  const body = method === "GET" ? undefined : await requestBody(parsed, {});
  return sendRequest(withSource({ method, path, body }, parsed), options);
}

async function serveMemory(parsed: ParsedArgs): Promise<unknown> {
  const configPath = optionString(parsed.options, "config");
  const url = optionString(parsed.options, "url") ??
    loadCliMemoryConfig(configPath).config.endpoint ??
    DEFAULT_MEMORY_URL;
  return [
    "memmy-memory serve is not bundled with this CLI package.",
    "Run the local Memory service separately, or point this CLI at a cloud Memory endpoint.",
    "",
    `Current target endpoint: ${url}`,
    "",
    "Examples:",
    "  memmy-memory health --url <memory-service-url>",
    "  memmy-memory search \"project decisions\" --url <memory-service-url>"
  ].join("\n");
}

async function executeRequest(request: CliRequest, options: CliRequestOptions): Promise<unknown> {
  return sendRequest(request, options);
}

function compactMemoryGetOutput(result: unknown): string | undefined {
  const detail = memoryDetailRecord(result);
  if (!detail) return undefined;

  const id = stringValue(detail.id);
  const kind = stringValue(detail.kind) || "memory";
  const layer = stringValue(detail.memoryLayer) || stringValue(detail.layer) || "memory";
  const title = stringValue(detail.title) || id;
  const summary = stringValue(detail.summary);
  const lines = [
    `id: ${id}`,
    `kind: ${kind}`,
    `layer: ${layer}`,
    `title: ${title}`
  ];
  const content = compactMemoryGetContent(result, detail);
  if (content) {
    lines.push("", content);
  } else if (summary && summary !== title) {
    lines.push("", summary);
  }
  return lines.join("\n");
}

function memoryDetailRecord(result: unknown): JsonObject | undefined {
  if (!isRecord(result)) return undefined;
  if (isMemoryDetailLike(result)) return result;
  const item = result.item;
  return isRecord(item) && isMemoryDetailLike(item) ? item : undefined;
}

function isMemoryDetailLike(value: JsonObject): boolean {
  return Boolean(stringValue(value.id) && (
    stringValue(value.body) ||
    stringValue(value.content) ||
    stringValue(value.summary) ||
    stringValue(value.title)
  ));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compactMemoryGetContent(result: unknown, detail: JsonObject): string {
  const rawTurn = rawTurnRecord(result);
  if (rawTurn) return compactRawTurnContent(rawTurn);
  return compactMemoryBody(stringValue(detail.body) || stringValue(detail.content));
}

function compactRawTurnContent(rawTurn: JsonObject): string {
  const parts: string[] = [];
  const userText = stringValue(rawTurn.userText);
  const assistantText = stringValue(rawTurn.assistantText);
  const toolDetails = compactRawTurnToolDetails(rawTurn);
  if (userText) parts.push(`User:\n${userText}`);
  if (toolDetails) parts.push(toolDetails);
  if (assistantText) parts.push(`Assistant:\n${assistantText}`);
  return parts.join("\n\n");
}

function compactMemoryBody(body: string): string {
  const hasConversation = /^\s*(User|Agent|Assistant|Tool calls):/im.test(body);
  return body
    .split(/\r?\n/)
    .filter((line) => !isInternalMemoryBodyLine(line, hasConversation))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isInternalMemoryBodyLine(line: string, hasConversation: boolean): boolean {
  if (/^\s*(RawTurn|TraceStep|Alpha|Value|Priority):/i.test(line)) return true;
  return hasConversation && /^\s*Summary:/i.test(line);
}

function compactRawTurnToolDetails(rawTurn: JsonObject): string | undefined {
  if (!rawTurn) return undefined;
  const toolCalls = arrayRecords(rawTurn.toolCalls);
  const toolResults = arrayRecords(rawTurn.toolResults);
  if (toolCalls.length === 0 && toolResults.length === 0) return undefined;

  const lines = ["Tool calls:"];
  const count = Math.max(toolCalls.length, toolResults.length);
  for (let index = 0; index < count; index += 1) {
    const call = toolCalls[index];
    const resultRecord = toolResultFor(call, toolResults, index);
    const name = toolName(call, resultRecord, index);
    lines.push(`- ${name}`);
    const input = toolInput(call);
    if (input) lines.push(...toolFieldLines("input", input));
    const output = toolOutput(call, resultRecord);
    if (output) lines.push(...toolFieldLines("output", output));
    const error = toolError(call, resultRecord);
    if (error) lines.push(...toolFieldLines("error", error));
  }
  return lines.join("\n");
}

function rawTurnRecord(result: unknown): JsonObject | undefined {
  const root = isRecord(result) ? result : undefined;
  const refs = root ? recordValue(root.refs) ?? recordValue(recordValue(root.metadata)?.refs) : undefined;
  const rawTurn = refs ? recordValue(refs.rawTurn) : undefined;
  if (rawTurn) return rawTurn;

  const item = root ? recordValue(root.item) : undefined;
  const itemRefs = item ? recordValue(item.refs) ?? recordValue(recordValue(item.metadata)?.refs) : undefined;
  return itemRefs ? recordValue(itemRefs.rawTurn) : undefined;
}

function arrayRecords(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordValue(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

function toolResultFor(call: JsonObject | undefined, results: JsonObject[], index: number): JsonObject | undefined {
  const callId = stringValue(call?.id);
  if (callId) {
    const matched = results.find((result) => stringValue(result.toolCallId) === callId || stringValue(result.id) === callId);
    if (matched) return matched;
  }
  return results[index];
}

function toolName(call: JsonObject | undefined, result: JsonObject | undefined, index: number): string {
  const fn = recordValue(call?.function);
  return stringValue(call?.name) ||
    stringValue(fn?.name) ||
    stringValue(result?.name) ||
    `tool_${index + 1}`;
}

function toolInput(call: JsonObject | undefined): string | undefined {
  if (!call) return undefined;
  const fn = recordValue(call.function);
  return compactToolValue(call.input) ??
    compactToolValue(call.arguments) ??
    compactToolValue(fn?.arguments);
}

function toolOutput(call: JsonObject | undefined, result: JsonObject | undefined): string | undefined {
  return compactToolValue(result?.output) ??
    compactToolValue(result?.result) ??
    compactToolValue(call?.output);
}

function toolError(call: JsonObject | undefined, result: JsonObject | undefined): string | undefined {
  return compactToolValue(result?.error) ??
    compactToolValue(call?.error);
}

function compactToolValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const text = typeof value === "string" ? value.trim() : JSON.stringify(value);
  if (!text) return undefined;
  return text.length <= COMPACT_GET_TOOL_FIELD_CHARS
    ? text
    : `${text.slice(0, COMPACT_GET_TOOL_FIELD_CHARS - 16)}\n...[truncated]`;
}

function toolFieldLines(label: string, value: string): string[] {
  return value.includes("\n")
    ? [`  ${label}:`, ...value.split("\n").map((line) => `    ${line}`)]
    : [`  ${label}: ${value}`];
}

async function requestBody(
  parsed: ParsedArgs,
  fields: JsonObject,
  normalize?: (body: JsonObject) => void
): Promise<JsonObject> {
  const body = await readBodyObject(parsed.options);
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      body[key] = value;
    }
  }
  normalize?.(body);
  removeUndefined(body);
  return body;
}

function requestOptions(parsed: ParsedArgs, fetchImpl?: typeof fetch): CliRequestOptions {
  const configPath = optionString(parsed.options, "config");
  const userId = userIdOption(parsed) ?? loadCliMemoryConfig(configPath).config.userId;
  const headers: Record<string, string> = {};
  if (userId) headers["x-memmy-user-id"] = userId;
  return {
    url: optionString(parsed.options, "url"),
    token: optionString(parsed.options, "token"),
    configPath,
    fetch: fetchImpl,
    headers
  };
}

function withSource(request: CliRequest, parsed: ParsedArgs): CliRequest {
  const source = optionString(parsed.options, "source");
  if (!source || request.method === "GET") {
    return request;
  }
  const body = isRecord(request.body) ? { ...request.body, source } : { source };
  return { ...request, body };
}

function setupOptions(parsed: ParsedArgs): MemoryCliSetupOptions {
  const agents = [
    ...optionValues(parsed.options, "agent"),
    ...optionValues(parsed.options, "agents")
  ];
  return {
    home: optionString(parsed.options, "home"),
    configPath: optionString(parsed.options, "config"),
    dbPath: optionString(parsed.options, "db") ?? optionString(parsed.options, "sqlite-path"),
    endpoint: optionString(parsed.options, "endpoint") ?? optionString(parsed.options, "url"),
    token: optionString(parsed.options, "token"),
    force: optionBoolean(parsed.options, "force"),
    dryRun: optionBoolean(parsed.options, "dry-run"),
    binPath: optionString(parsed.options, "bin") ?? optionString(parsed.options, "bin-path"),
    sourcePath: optionString(parsed.options, "source-path"),
    agents,
    agentRoot: optionString(parsed.options, "agent-root"),
    assetRoot: optionString(parsed.options, "asset-root"),
    skipAgentSkills: optionBoolean(parsed.options, "skip-agent-skills"),
    generateTokenIfMissing: optionBoolean(parsed.options, "generate-token-if-missing"),
    serviceOnly: optionBoolean(parsed.options, "service-only"),
    version: optionString(parsed.options, "version"),
    latest: optionBoolean(parsed.options, "latest"),
    runtimeAsset: optionString(parsed.options, "runtime-asset"),
    runtimeDirectory: optionString(parsed.options, "runtime-directory"),
    runtimeSha256: optionString(parsed.options, "runtime-sha256"),
    releaseManifest: optionString(parsed.options, "release-manifest"),
    releaseBaseUrl: optionString(parsed.options, "release-base-url"),
    nodeExecutable: optionString(parsed.options, "node-executable"),
    preferInstalledCompatible: optionBoolean(parsed.options, "use-compatible-installed"),
    skipServiceRegistration: optionBoolean(parsed.options, "skip-service-registration"),
    skipHealthCheck: optionBoolean(parsed.options, "skip-health-check"),
    healthCheckTimeoutMs: positiveIntegerOption(parsed, "health-check-timeout-ms"),
    configSource: legacyConfigSource(optionString(parsed.options, "config-source")),
    legacyRoot: optionString(parsed.options, "legacy-root"),
    nonInteractive: optionBoolean(parsed.options, "non-interactive"),
    skipLegacyMigration: optionBoolean(parsed.options, "skip-legacy-migration"),
    memmyConfigPreexisting: optionBoolean(parsed.options, "memmy-config-preexisting"),
    userHome: optionString(parsed.options, "user-home"),
    dshProfile: optionString(parsed.options, "dsh-profile")
  };
}

function userIdOption(parsed: ParsedArgs): string | undefined {
  return optionString(parsed.options, "user-id") ?? optionString(parsed.options, "user_id");
}

function legacyConfigSource(value: string | undefined): "openclaw" | "hermes" | undefined {
  if (value === undefined) return undefined;
  if (value === "openclaw" || value === "hermes") return value;
  throw new Error("--config-source must be openclaw or hermes");
}

function positiveIntegerOption(parsed: ParsedArgs, name: string): number | undefined {
  if (!hasOption(parsed.options, name)) return undefined;
  const value = optionString(parsed.options, name);
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`--${name} must be a positive integer`);
  }
  const parsedValue = Number(value);
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsedValue;
}

function stringArrayOption(parsed: ParsedArgs, name: string): string[] | undefined {
  const value = optionString(parsed.options, name);
  if (value === undefined) return undefined;
  return parseStringArray(value);
}

function normalizeTurnStatus(status: string | undefined): "succeeded" | "failed" | undefined {
  if (!status) return undefined;
  const normalized = status.toLowerCase();
  if (normalized === "ok" || normalized === "success" || normalized === "succeeded") return "succeeded";
  if (
    normalized === "error" ||
    normalized === "failed" ||
    normalized === "failure" ||
    normalized === "timeout" ||
    normalized === "killed"
  ) {
    return "failed";
  }
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "reset" || normalized === "deleted") {
    throw new Error("cancelled turns must not be persisted");
  }
  throw new Error(`unsupported turn status: ${status}`);
}

function removeUndefined(value: unknown): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) {
      delete value[key];
    } else {
      removeUndefined(child);
    }
  }
}

function helpText(): string {
  return [
    `${CLI_NAME} ${PROJECT_VERSION}`,
    "",
    "Usage:",
    `  ${CLI_NAME} <command> [options]`,
    "",
    "Commands:",
    "  init [--agent <agent>]       Initialize CLI config and install agent skills",
    "  install [--service-only]     Install and start the standalone Memory service",
    "  upgrade [--version <ver>]    Upgrade Memory and installed agent adapters",
    "  stop                         Stop the background Memory service",
    "  service start|stop|status    Control the installed user service",
    "  serve                        Explain how to connect to an external Memory service",
    "  health                       Check Memory service health",
    "  reload-config                Reload runtime model config from config.yaml",
    "  session open                 Open or resume a session",
    "  session close <sessionId>    Close a session",
    "  turn start                   Start a memory-aware turn",
    "  turn complete <turnId>       Complete a turn and persist the result",
    "  search <query>               Search memories",
    "  add <content>                Add a memory manually",
    "  get <id>                     Read one memory by id",
    "  delete <id>                  Delete one memory by id",
    "  raw <method> <path>          Call an exposed Memory API route directly",
    "",
    "Setup examples:",
    `  ${CLI_NAME} init`,
    `  ${CLI_NAME} init --skip-agent-skills`,
    `  ${CLI_NAME} init --agent codex`,
    `  ${CLI_NAME} init --agent codex,cursor,claude`,
    `  ${CLI_NAME} install --service-only`,
    `  ${CLI_NAME} install --agents openclaw,hermes`,
    `  ${CLI_NAME} upgrade`,
    "",
    "Memory examples:",
    `  ${CLI_NAME} health`,
    `  ${CLI_NAME} session open --workspace-path "$PWD"`,
    `  ${CLI_NAME} search "project decisions"`,
    `  ${CLI_NAME} search "project decisions" --verbose`,
    `  ${CLI_NAME} add "this project stores memory locally in sqlite" --layer L1`,
    `  ${CLI_NAME} get mem_123`,
    `  ${CLI_NAME} get mem_123 --verbose`,
    "",
    "Global options:",
    "  --url <url>                  Memory HTTP service URL",
    "  --token <token>              Memory HTTP bearer token",
    "  --user-id <id>               Memory namespace user id",
    "  --source <agent>             Calling agent/source id",
    "  --config <path>              Memmy config path",
    "  --health-check-timeout-ms <ms> Activation health timeout for Memory install",
    "  --skip-agent-skills          Initialize config without installing agent skills",
    "  --config-source <agent>      Select openclaw or hermes legacy config",
    "  --help, -h                   Show this help",
    "  --version, -v                Show CLI version",
    "",
    "Supported agents:",
    "  codex, cursor, claude, opencode, openclaw, hermes, dsh, workbuddy, pi, qwenwork",
    "",
    `Default URL: ${DEFAULT_MEMORY_URL}`
  ].join("\n");
}
