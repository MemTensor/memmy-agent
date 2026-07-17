import { Command } from "commander";
import fs from "node:fs";
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import path from "node:path";
import YAML from "yaml";
import { MessageBus } from "../../core/runtime-messages/queue.js";
import { InboundMessage, OutboundMessage } from "../../core/runtime-messages/events.js";
import { AgentLoop, UNIFIED_SESSION_KEY } from "../../core/agent-runtime/loop.js";
import { CronTool } from "../../core/agent-runtime/tools/cron.js";
import { MessageTool } from "../../core/agent-runtime/tools/message.js";
import { WebuiTitleService } from "../../core/session/webui-title.js";
import { WEBUI_LANGUAGE_METADATA_KEY } from "../../core/session/webui-turns.js";
import {
  API_MAX_BODY_BYTES,
  RequestBodyTooLarge,
  createApp,
  errorJson,
} from "../openai-like-api/server.js";
import { ChannelManager } from "../../integrations/channels/manager.js";
import { discoverAll, discoverChannelNames } from "../../integrations/channels/registry.js";
import {
  WebSocketChannel,
  publishRuntimeModelUpdate,
} from "../../integrations/channels/websocket.js";
import { createByokTokenUsageRecorder } from "../../integrations/byok-token-usage/index.js";
import {
  loadConfig,
  saveConfig,
  resolveConfigEnvVars,
  setConfigPath,
  getConfigPath,
} from "../../config/loader.js";
import { Config } from "../../config/schema.js";
import { getCliHistoryPath, getDataDir, getWorkspacePath } from "../../config/paths.js";
import { CronService } from "../../cron/service.js";
import { CronJob, CronPayload } from "../../cron/types.js";
import { HeartbeatService } from "../../heartbeat/service.js";
import {
  getOpenAICodexToken,
  loginOpenAICodexInteractive,
} from "../../providers/openai-codex-oauth.js";
import { PROVIDERS } from "../../providers/registry.js";
import { evaluateResponse } from "../../utils/evaluator.js";
import { installConsoleLevelGate } from "../../runtime-log-level.js";
import { syncWorkspaceTemplates } from "../../utils/helpers.js";
import { withProgressCapabilities } from "../../utils/progress-events.js";
import {
  consumeRestartNoticeFromEnv,
  formatRestartCompletedMessage,
  shouldShowCliRestartNotice,
} from "../../utils/restart.js";
import { createChannelAdmin } from "../frontend-bridge/channels-api.js";
import { getQuestionary, runOnboard } from "./onboard.js";
import { StreamRenderer, ThinkingSpinner } from "./stream.js";

export const CLI_VERSION = "0.0.1-beta.1";
export const app = new Command("memmy");

export type GatewayRuntime = {
  bus: MessageBus;
  loop: AgentLoop;
  manager: ChannelManager;
  heartbeat: HeartbeatService;
  cron: CronService;
  healthServer: http.Server;
  stop: () => Promise<void>;
};

let cliRuntimeLogs = false;

export function setCliRuntimeLogs(enabled: boolean): void {
  cliRuntimeLogs = enabled;
}

export function cliRuntimeLogsEnabled(): boolean {
  return cliRuntimeLogs;
}

export function sanitizeSurrogates(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i += 1;
      } else {
        out += "\ufffd";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += "\ufffd";
      continue;
    }
    out += text[i];
  }
  return out;
}

export class SafeFileHistory {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
  storeString(value: string): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.appendFileSync(this.path, `${sanitizeSurrogates(value)}\n`, "utf8");
  }
  loadHistoryStrings(): string[] {
    if (!fs.existsSync(this.path)) return [];
    return fs
      .readFileSync(this.path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
  }
}

export function isExitCommand(command: string): boolean {
  return ["/exit", "/quit", "exit", "quit", ":q"].includes(command.trim().toLowerCase());
}

export function loadRuntimeConfig(config?: string | null, workspace?: string | null): Config {
  let configPath: string | null = null;
  if (config) {
    configPath = path.resolve(config.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
    if (!fs.existsSync(configPath)) throw new Error(`Config file not found: ${configPath}`);
    setConfigPath(configPath);
  }
  const loaded = resolveConfigEnvVars(loadConfig(configPath));
  warnDeprecatedConfigKeys(configPath ?? getConfigPath());
  if (workspace) loaded.agents.defaults.workspace = workspace;
  return loaded;
}
export function mergeMissingDefaults(existing: any, defaults: any): any {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return existing;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) return existing;
  const merged: Record<string, any> = { ...existing };
  for (const [key, value] of Object.entries(defaults)) {
    merged[key] = key in merged ? mergeMissingDefaults(merged[key], value) : value;
  }
  return merged;
}

export function onboardPlugins(configPath: string): void {
  if (!fs.existsSync(configPath)) return;
  const raw = fs.readFileSync(configPath, "utf8");
  let data: any = {};
  try {
    data = YAML.parse(raw || "{}");
  } catch {
    data = {};
  }
  const channels = (data.channels ??= {});
  for (const [name, cls] of Object.entries(discoverAll())) {
    const defaults = (cls as any).defaultConfig?.() ?? { enabled: false };
    channels[name] = name in channels ? mergeMissingDefaults(channels[name], defaults) : defaults;
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(data), "utf8");
}

export function modelDisplay(config: Config): [string, string] {
  const resolved = config.resolvePreset();
  const name = config.agents.defaults.modelPreset;
  return [resolved.model, name ? ` (preset: ${name})` : ""];
}

export function syncRuntimeWorkspaceTemplates(config: Config): string {
  const workspacePath = getWorkspacePath(config.agents.defaults.workspace);
  fs.mkdirSync(workspacePath, { recursive: true });
  syncWorkspaceTemplates(workspacePath);
  return workspacePath;
}

export function isRootVersionRequest(argv: string[] = process.argv): boolean {
  const arg = argv[2];
  return arg === "-V" || arg === "--version";
}

export function isRootInteractiveRequest(argv: string[] = process.argv): boolean {
  return argv.length <= 2;
}

type RootInteractiveRunner = () => Promise<unknown>;

let rootInteractiveRunnerForTest: RootInteractiveRunner | null = null;

export function setRootInteractiveRunnerForTest(runner: RootInteractiveRunner | null): void {
  rootInteractiveRunnerForTest = runner;
}

export async function runRootInteractiveAgent(): Promise<unknown> {
  if (rootInteractiveRunnerForTest) return rootInteractiveRunnerForTest();
  const loaded = loadRuntimeConfig(null, null);
  syncRuntimeWorkspaceTemplates(loaded);
  printCliRestartNoticeIfNeeded("cli:direct", true);
  const { runInkInteractiveAgent } = await import("./tui.js");
  return runInkInteractiveAgent(loaded, "cli:direct", CLI_VERSION);
}

export async function main(argv: string[] = process.argv): Promise<void> {
  if (isRootVersionRequest(argv)) {
    versionCallback(true);
    return;
  }
  if (isRootInteractiveRequest(argv)) {
    await runRootInteractiveAgent();
    return;
  }

  app
    .command("onboard")
    .description("Initialize memmy configuration and workspace.")
    .option("-w, --workspace <dir>", "Workspace directory")
    .option("-c, --config <path>", "Path to config file")
    .option("--wizard", "Use interactive wizard", false)
    .action(async (opts) => {
      await onboard(opts);
    });

  app
    .command("serve")
    .description("Start the OpenAI-compatible API server.")
    .option("-p, --port <port>", "API server port")
    .option("-H, --host <host>", "Bind address")
    .option("-t, --timeout <seconds>", "Per-request timeout")
    .option("-w, --workspace <dir>", "Workspace directory")
    .option("-c, --config <path>", "Path to config file")
    .option("-v, --verbose", "Enable verbose runtime logs", false)
    .action(async (opts) => {
      await serve(opts);
    });

  app
    .command("gateway")
    .description("Start configured chat channel gateway.")
    .option("-p, --port <port>", "Gateway health server port")
    .option("-H, --host <host>", "Gateway health server bind address")
    .option("-w, --workspace <dir>", "Workspace directory")
    .option("-c, --config <path>", "Path to config file")
    .option("-v, --verbose", "Enable verbose runtime logs", false)
    .action(async (opts) => {
      await gateway(opts);
    });

  app
    .command("agent")
    .description("Run a direct CLI chat turn.")
    .option("-m, --message <message>", "Message to send")
    .option("-s, --session <sessionId>", "Session ID", "cli:direct")
    .option("-w, --workspace <dir>", "Workspace directory")
    .option("-c, --config <path>", "Path to config file")
    .option("--markdown", "Render final responses as markdown", true)
    .option("--no-markdown", "Render final responses as plain text")
    .option("--logs", "Enable runtime logs", false)
    .option("--no-logs", "Disable runtime logs")
    .action(async (opts) => {
      await agent({ ...opts, sessionId: opts.session });
    });

  app
    .command("status")
    .description("Show memmy status.")
    .option("-w, --workspace <dir>", "Workspace directory")
    .option("-c, --config <path>", "Path to config file")
    .action((opts) => {
      console.log(status(opts));
    });

  const configCommand = app.command("config").description("Manage memmy configuration.");
  configCommand
    .command("set <key> <value>")
    .description("Set a supported configuration value.")
    .option("-c, --config <path>", "Path to config file")
    .action((key, value, opts) => {
      const result = setConfigValue(key, value, { config: opts.config });
      console.log(`Config saved at ${result.configPath}`);
      console.log(`${result.key}: ${result.value}`);
    });

  const channelsCommand = app.command("channels").description("Manage channels.");
  channelsCommand
    .command("status")
    .option("-c, --config <path>", "Path to config file")
    .action((opts) => {
      for (const line of channelsStatus({ config: opts.config })) console.log(line);
    });
  channelsCommand
    .command("login <channelName>")
    .option("-f, --force", "Force re-authentication", false)
    .option("-c, --config <path>", "Path to config file")
    .action(async (channelName, opts) => {
      const ok = await channelsLogin(channelName, {
        force: Boolean(opts.force),
        config: opts.config,
      });
      if (!ok) process.exitCode = 1;
    });

  const pluginsCommand = app.command("plugins").description("Manage channel plugins.");
  pluginsCommand.action(() => {
    for (const line of pluginsList()) console.log(line);
  });
  pluginsCommand
    .command("list")
    .description("List channel plugins.")
    .action(() => {
      for (const line of pluginsList()) console.log(line);
    });

  const providerCommand = app.command("provider").description("Manage providers.");
  providerCommand
    .command("login <provider>")
    .description("Authenticate with an OAuth provider.")
    .action(async (provider) => {
      await providerLogin(provider);
    });
  providerCommand
    .command("logout <provider>")
    .description("Log out from an OAuth provider.")
    .action(async (provider) => {
      await providerLogout(provider);
    });

  await app.parseAsync(argv);
}

export async function onboard({
  workspace = null,
  config = null,
  wizard = false,
}: { workspace?: string | null; config?: string | null; wizard?: boolean } = {}): Promise<Config> {
  const configPath = config
    ? path.resolve(config.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"))
    : getConfigPath();
  if (config) setConfigPath(configPath);
  let loaded: Config;
  if (fs.existsSync(configPath)) {
    if (wizard) {
      loaded = loadConfig(configPath);
    } else if (
      process.stdin.isTTY &&
      (await getQuestionary()
        .confirm(`Config already exists at ${configPath}. Overwrite with defaults?`, {
          default: false,
        })
        .ask())
    ) {
      loaded = new Config();
      if (workspace) loaded.agents.defaults.workspace = workspace;
      saveConfig(loaded, configPath);
      console.log(`Config reset to defaults at ${configPath}`);
    } else {
      loaded = loadConfig(configPath);
      if (workspace) loaded.agents.defaults.workspace = workspace;
      saveConfig(loaded, configPath);
      console.log(`Config refreshed at ${configPath}`);
    }
  } else {
    loaded = new Config();
    if (workspace) loaded.agents.defaults.workspace = workspace;
    if (!wizard) {
      saveConfig(loaded, configPath);
      console.log(`Created config at ${configPath}`);
    }
  }
  if (workspace) loaded.agents.defaults.workspace = workspace;
  if (wizard) {
    const result = await runOnboard(loaded);
    loaded = result.config;
    if (!result.shouldSave) {
      console.log("Configuration discarded. No changes were saved.");
      return loaded;
    }
    saveConfig(loaded, configPath);
    console.log(`Config saved at ${configPath}`);
  } else if (!fs.existsSync(configPath)) {
    saveConfig(loaded, configPath);
  }
  onboardPlugins(configPath);
  const workspacePath = getWorkspacePath(loaded.agents.defaults.workspace);
  fs.mkdirSync(workspacePath, { recursive: true });
  syncWorkspaceTemplates(workspacePath);
  console.log(`memmy is ready`);
  console.log(`Config: ${configPath}`);
  console.log(`Workspace: ${workspacePath}`);
  return loaded;
}

export function setConfigValue(
  key: string,
  value: string,
  { config = null }: { config?: string | null } = {},
): { config: Config; configPath: string; key: string; value: string } {
  const configPath = config
    ? path.resolve(config.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"))
    : getConfigPath();
  if (config) setConfigPath(configPath);
  const loaded = loadConfig(configPath);
  switch (key) {
    case "app.userId": {
      const next = value.trim();
      if (!next) throw new Error("app.userId must be a non-empty string");
      loaded.app.userId = next;
      loaded.memmyMemory.userId = next;
      saveConfig(loaded, configPath);
      return { config: loaded, configPath, key: "app.userId", value: next };
    }
    default:
      throw new Error(`unsupported config key: ${key}`);
  }
}

async function requestFromIncoming(
  req: http.IncomingMessage,
  maxBodyBytes = API_MAX_BODY_BYTES,
): Promise<Request> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBodyBytes) throw new RequestBodyTooLarge();
    chunks.push(buffer);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) headers.set(key, value.join(", "));
    else if (value != null) headers.set(key, value);
  }
  const host = headers.get("host") ?? "127.0.0.1";
  const url = `http://${host}${req.url ?? "/"}`;
  return new Request(url, {
    method: req.method,
    headers,
    body:
      chunks.length && req.method !== "GET" && req.method !== "HEAD"
        ? Buffer.concat(chunks)
        : undefined,
  });
}

async function writeNodeResponse(res: http.ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  const nodeStream = Readable.fromWeb(response.body as any);
  nodeStream.pipe(res);
}

export async function serve({
  port = null,
  host = null,
  timeout = null,
  workspace = null,
  config = null,
  verbose = false,
}: {
  port?: string | number | null;
  host?: string | null;
  timeout?: string | number | null;
  workspace?: string | null;
  config?: string | null;
  verbose?: boolean;
} = {}): Promise<http.Server> {
  const loaded = loadRuntimeConfig(config, workspace);
  syncRuntimeWorkspaceTemplates(loaded);
  setCliRuntimeLogs(Boolean(verbose));
  const loop = AgentLoop.fromConfig(loaded);
  await loop.connectMcp();
  const resolved = loaded.resolvePreset();
  const appServer = createApp(
    loop,
    resolved.model,
    timeout == null ? loaded.api.timeout : Number(timeout),
  );
  const bindHost = host ?? loaded.api.host;
  const bindPort = port == null ? loaded.api.port : Number(port);
  let cleanupPromise: Promise<void> | null = null;
  const closeMcpOnce = (): Promise<void> => {
    cleanupPromise ??= Promise.resolve(loop.closeMcp()).catch(() => undefined);
    return cleanupPromise;
  };
  const server = http.createServer(async (req, res) => {
    try {
      await writeNodeResponse(res, await appServer.fetch(await requestFromIncoming(req)));
    } catch (error) {
      if (error instanceof RequestBodyTooLarge) {
        await writeNodeResponse(res, errorJson(413, error.message));
        return;
      }
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ error: { message: (error as Error).message, type: "server_error" } }),
      );
    }
  });
  server.on("close", () => {
    void closeMcpOnce();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.listen(bindPort, bindHost, onListening);
    });
  } catch (error) {
    await closeMcpOnce();
    throw error;
  }
  console.log(`memmy API listening on http://${bindHost}:${bindPort}`);
  return server;
}

export async function startGatewayHealthServer(host: string, port: number): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.split("?", 1)[0] === "/health") {
      const body = JSON.stringify({ status: "ok" });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    const body = "Not Found";
    res.writeHead(404, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return server;
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function channelSessionKey(loop: AgentLoop, channel: string, chatId: string): string {
  return loop.unifiedSession ? UNIFIED_SESSION_KEY : `${channel}:${chatId}`;
}

function pickHeartbeatTarget(manager: ChannelManager, loop: AgentLoop): [string, string] {
  const enabled = new Set(manager.enabledChannels);
  const sessions =
    typeof loop.sessions?.listSessions === "function" ? loop.sessions.listSessions() : [];
  for (const item of sessions) {
    const key = String(item?.key ?? "");
    if (!key.includes(":")) continue;
    const [channel, chatId] = key.split(/:(.*)/s).filter(Boolean).slice(0, 2);
    if (!channel || !chatId) continue;
    if (channel === "cli" || channel === "system") continue;
    if (enabled.has(channel)) return [channel, chatId];
  }
  return ["cli", "direct"];
}

function stripDeliveryMetadata(metadata: Record<string, any>): [Record<string, any>, boolean] {
  const next = { ...(metadata ?? {}) };
  const record = Boolean(next.recordChannelDelivery);
  delete next.recordChannelDelivery;
  return [next, record];
}

type CronDeliveryContext = {
  jobId: string;
  channel: string;
  chatId: string;
  targetSessionKey: string;
  scheduledForMs: number;
  createdFromMetadata: Record<string, any>;
  busyAtDue: boolean;
  goalActiveAtDue: boolean;
};

const cronDeliveryContext = new AsyncLocalStorage<CronDeliveryContext>();
const WEBUI_CRON_TRANSIENT_METADATA_KEYS = [
  "turn_id",
  "turnId",
  "message_id",
  "messageId",
  "wantsStream",
  "streamId",
  "streamDelta",
  "streamEnd",
  "turnEnd",
  "agentProgress",
  "toolHint",
  "toolEvents",
  "fileEditEvents",
  "retryWait",
  "goalStatus",
  "goalStatusEvent",
  "goalState",
  "goalStateSync",
] as const;

function sanitizeCronDeliveryMetadata(
  channel: string,
  metadata: Record<string, any> = {},
): Record<string, any> {
  const next = { ...(metadata ?? {}) };
  if (channel !== "websocket") return next;
  for (const key of WEBUI_CRON_TRANSIENT_METADATA_KEYS) delete next[key];
  return next;
}

function usesChineseCronLanguage(metadata: Record<string, any>): boolean {
  return String(metadata?.[WEBUI_LANGUAGE_METADATA_KEY] ?? "")
    .toLowerCase()
    .startsWith("zh");
}

function formatCronDelaySeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

function prefixCronDelayNotice({
  content,
  metadata,
  delayedByMs,
  busyAtDue,
  goalActiveAtDue,
}: {
  content: string;
  metadata: Record<string, any>;
  delayedByMs: number;
  busyAtDue: boolean;
  goalActiveAtDue: boolean;
}): string {
  if (delayedByMs < 1000 || (!busyAtDue && !goalActiveAtDue)) return content;
  const seconds = formatCronDelaySeconds(delayedByMs);
  const chinese = usesChineseCronLanguage(metadata);
  let notice: string;
  if (goalActiveAtDue) {
    notice = chinese
      ? `由于这条定时任务到点时当前长期目标尚未完成，实际发送延迟了 ${seconds} 秒。`
      : `This scheduled task was delayed by ${seconds}s because the active goal in this chat had not finished when it was due.`;
  } else {
    notice = chinese
      ? `由于上一个任务仍在执行，这条定时任务延迟了 ${seconds} 秒发送。`
      : `This scheduled task was delayed by ${seconds}s because the previous task was still running.`;
  }
  const trimmed = content.trim();
  return trimmed ? `${notice}\n\n${trimmed}` : notice;
}

export async function gateway({
  port = null,
  host = null,
  workspace = null,
  config = null,
  verbose = false,
}: {
  port?: string | number | null;
  host?: string | null;
  workspace?: string | null;
  config?: string | null;
  verbose?: boolean;
} = {}): Promise<GatewayRuntime> {
  const loaded = loadRuntimeConfig(config, workspace);
  const workspacePath = syncRuntimeWorkspaceTemplates(loaded);
  setCliRuntimeLogs(Boolean(verbose));
  // Gateway daemon mode: filter console output by the MEMMY_LOG_LEVEL injected by the desktop app.
  installConsoleLevelGate();
  const bus = new MessageBus();
  const cron = new CronService(path.join(workspacePath, "cron", "jobs.json"));
  const loop = AgentLoop.fromConfig(loaded, bus, {
    cronService: cron,
    runtimeModelPublisher: (model, preset) => {
      if (model) publishRuntimeModelUpdate(bus, model, preset);
    },
  });
  const manager = new ChannelManager(loaded, bus, {
    sessionManager: loop.sessions,
    webuiRuntimeModelName: () => {
      loop.refreshProviderSnapshot();
      return loop.model ?? null;
    },
    cancelActiveTasks: (sessionKey) => loop.cancelActiveTasks(sessionKey),
  });
  const webuiChannel = manager.getChannel("websocket");
  if (webuiChannel instanceof WebSocketChannel) {
    webuiChannel.setChannelAdmin(createChannelAdmin(manager));
    webuiChannel.setWebuiTitleService(
      new WebuiTitleService({
        bus,
        sessions: loop.sessions,
        llmRuntime: () => loop.llmRuntime(),
        scheduleBackground: (promise) => loop.scheduleBackground(promise),
        tokenUsageRecorder: createByokTokenUsageRecorder(loaded),
      }),
    );
  }
  const bindHost = host ?? loaded.gateway.host;
  const bindPort = port == null ? loaded.gateway.port : Number(port);
  const healthServer = await startGatewayHealthServer(bindHost, bindPort);

  const deliverToChannelNow = async (
    msg: OutboundMessage,
    { record = false, sessionKey = null }: { record?: boolean; sessionKey?: string | null } = {},
  ): Promise<void> => {
    const [metadata, metadataRecord] = stripDeliveryMetadata(msg.metadata);
    const outbound = new OutboundMessage({
      channel: msg.channel,
      chatId: msg.chatId,
      content: msg.content,
      media: msg.media,
      buttons: msg.buttons,
      metadata,
      messageType: msg.messageType,
    });
    const shouldRecord = record || metadataRecord;
    if (shouldRecord && outbound.channel !== "cli" && outbound.content.trim()) {
      const key = sessionKey ?? channelSessionKey(loop, outbound.channel, outbound.chatId);
      const session = loop.sessions.getOrCreate(key);
      const extra: Record<string, any> = { channelDelivery: true };
      if (outbound.media.length) extra.media = [...outbound.media];
      session.addMessage("assistant", outbound.content, extra);
      loop.sessions.save(session);
    }
    await bus.publishOutbound(outbound);
  };

  const deliverToChannel = async (
    msg: OutboundMessage,
    options: { record?: boolean; sessionKey?: string | null } = {},
  ): Promise<void> => {
    const cronContext = cronDeliveryContext.getStore();
    const targetSessionKey = options.sessionKey ?? channelSessionKey(loop, msg.channel, msg.chatId);
    const sameWebuiCronTarget = Boolean(
      cronContext &&
      msg.channel === "websocket" &&
      msg.chatId === cronContext.chatId &&
      targetSessionKey === cronContext.targetSessionKey,
    );

    if (!sameWebuiCronTarget || !cronContext) {
      await deliverToChannelNow(msg, options);
      return;
    }

    const metadata = sanitizeCronDeliveryMetadata(msg.channel, {
      ...cronContext.createdFromMetadata,
      ...(msg.metadata ?? {}),
    });
    await loop.waitForCronTargetAvailable(msg.channel, targetSessionKey);
    const delayedByMs = Math.max(0, Date.now() - cronContext.scheduledForMs);
    metadata.proactiveDelivery = "cron";
    metadata.cronJobId = cronContext.jobId;
    metadata.scheduledForMs = cronContext.scheduledForMs;
    metadata.delayedByMs = delayedByMs;
    const content = prefixCronDelayNotice({
      content: msg.content,
      metadata,
      delayedByMs,
      busyAtDue: cronContext.busyAtDue,
      goalActiveAtDue: cronContext.goalActiveAtDue,
    });
    await deliverToChannelNow(
      new OutboundMessage({
        channel: msg.channel,
        chatId: msg.chatId,
        content,
        media: msg.media,
        buttons: msg.buttons,
        metadata,
        messageType: msg.messageType,
      }),
      { ...options, sessionKey: targetSessionKey },
    );
  };

  const messageTool = loop.tools.get("message");
  if (messageTool instanceof MessageTool)
    messageTool.setSendCallback((msg) => deliverToChannel(msg));

  cron.onJob = async (job: CronJob) => {
    if (job.payload.kind === "systemEvent") {
      if (job.name === "dream") {
        await loop.dream?.run?.();
        return "Dream completed.";
      }
      return null;
    }

    const message = (job.payload.message || job.payload.prompt || "").trim();
    if (!message) return null;
    const channel = job.payload.channel ?? "cli";
    const chatId = job.payload.to ?? job.payload.chatId ?? "direct";
    const targetSessionKey = job.payload.sessionKey ?? channelSessionKey(loop, channel, chatId);
    const scheduledForMs = job.state.nextRunAtMs ?? Date.now();
    const cronContext: CronDeliveryContext = {
      jobId: job.id,
      channel,
      chatId,
      targetSessionKey,
      scheduledForMs,
      createdFromMetadata: { ...(job.payload.channelMeta ?? {}) },
      busyAtDue: channel === "websocket" ? loop.isSessionBusy(targetSessionKey) : false,
      goalActiveAtDue: channel === "websocket" ? loop.isSessionGoalActive(targetSessionKey) : false,
    };
    const prompt =
      "The scheduled time has arrived. Deliver this reminder to the user now, " +
      "as a brief and natural message in their language. Speak directly to them - " +
      "do not narrate progress, summarize, include user IDs, or add status reports " +
      "like 'Done' or 'Reminded'.\n\n" +
      `Reminder: ${message}`;
    const cronTool = loop.tools.get("cron");
    const cronContextToken = cronTool instanceof CronTool ? cronTool.setCronContext(true) : null;
    const msgTool = loop.tools.get("message");
    const deliveryRecordToken =
      msgTool instanceof MessageTool ? msgTool.setRecordChannelDelivery(true) : null;
    let content = "";
    let sentInCronTarget = false;
    const messageSendCallback =
      channel === "websocket"
        ? async (msg: OutboundMessage) => {
            const msgSessionKey = channelSessionKey(loop, msg.channel, msg.chatId);
            const sameCronTarget =
              msg.channel === channel &&
              msg.chatId === chatId &&
              msgSessionKey === targetSessionKey;
            if (sameCronTarget) sentInCronTarget = true;
            await deliverToChannel(
              msg,
              sameCronTarget ? { record: true, sessionKey: targetSessionKey } : {},
            );
          }
        : null;

    return cronDeliveryContext.run(cronContext, async () => {
      try {
        const response = await loop.processDirect(prompt, {
          sessionKey: `cron:${job.id}`,
          channel,
          chatId,
          metadata: channel === "websocket" ? job.payload.channelMeta : {},
          onProgress: async () => undefined,
          messageSendCallback,
        });
        content = response?.content ?? "";
      } finally {
        if (cronTool instanceof CronTool && cronContextToken != null)
          cronTool.resetCronContext(cronContextToken);
        if (msgTool instanceof MessageTool && deliveryRecordToken != null)
          msgTool.resetRecordChannelDelivery(deliveryRecordToken);
      }

      if (job.payload.deliver && sentInCronTarget) return content;

      if (job.payload.deliver && content.trim()) {
        const shouldNotify = await evaluateResponse(
          content,
          message,
          loop.provider,
          loop.model ?? "",
        );
        if (shouldNotify) {
          await deliverToChannel(
            new OutboundMessage({
              channel,
              chatId,
              content,
              metadata: job.payload.channelMeta,
            }),
            { record: true, sessionKey: job.payload.sessionKey },
          );
        }
      }
      return content;
    });
  };

  const dreamConfig = loaded.agents.defaults.dream;
  if (loop.dream) {
    if (dreamConfig.modelOverride) loop.dream.setProvider(loop.provider, dreamConfig.modelOverride);
    loop.dream.maxBatchSize = dreamConfig.maxBatchSize;
    loop.dream.maxIterations = dreamConfig.maxIterations;
    loop.dream.annotateLineAges = dreamConfig.annotateLineAges;
  }
  cron.registerSystemJob(
    new CronJob({
      id: "dream",
      name: "dream",
      schedule: dreamConfig.buildSchedule(loaded.agents.defaults.timezone),
      payload: new CronPayload({ kind: "systemEvent", message: "Dream memory consolidation" }),
    }),
  );
  console.log(`Dream: ${dreamConfig.describeSchedule()}`);

  const hbCfg = loaded.gateway.heartbeat;
  const heartbeatPreamble =
    "[Your response will be delivered directly to the user's messaging app. " +
    "Output ONLY the final user-facing message. Never reference internal files, " +
    "your instructions, or your decision process. If nothing needs reporting, " +
    "respond with just 'All clear.' and nothing else.]\n\n";
  const heartbeat = new HeartbeatService({
    workspace: loop.workspace,
    llmRuntime: () => loop.llmRuntime(),
    intervalS: hbCfg.intervalS,
    enabled: hbCfg.enabled,
    timezone: loaded.agents.defaults.timezone,
    onExecute: async (tasks: string) => {
      const [channel, chatId] = pickHeartbeatTarget(manager, loop);
      const response = await loop.processDirect(heartbeatPreamble + tasks, {
        sessionKey: "heartbeat",
        channel,
        chatId,
        onProgress: async () => undefined,
      });
      const session = loop.sessions.getOrCreate("heartbeat");
      session.retainRecentLegalSuffix(hbCfg.keepRecentMessages);
      loop.sessions.save(session);
      return response?.content ?? "";
    },
    onNotify: async (response: string) => {
      const [channel, chatId] = pickHeartbeatTarget(manager, loop);
      if (channel === "cli") return;
      await deliverToChannel(new OutboundMessage({ channel, chatId, content: response }), {
        record: true,
      });
    },
  });

  await cron.start();
  void manager.startAll();
  await heartbeat.start();
  const inboundTask = loop.run();
  console.log(
    `memmy gateway started (${manager.enabledChannels.join(", ") || "no channels enabled"})`,
  );
  console.log(`Health endpoint: http://${bindHost}:${bindPort}/health`);
  return {
    bus,
    loop,
    manager,
    heartbeat,
    cron,
    healthServer,
    stop: async () => {
      heartbeat.stop();
      cron.stop();
      loop.stop();
      await Promise.allSettled([
        inboundTask,
        manager.stopAll(),
        loop.closeMcp(),
        (loop.sessions as any)?.flush?.(),
        closeServer(healthServer),
      ]);
    },
  };
}

export async function agent({
  message = null,
  sessionId = "cli:direct",
  workspace = null,
  config = null,
  markdown = true,
  logs = false,
}: {
  message?: string | null;
  sessionId?: string;
  workspace?: string | null;
  config?: string | null;
  markdown?: boolean;
  logs?: boolean;
} = {}): Promise<string | null> {
  const loaded = loadRuntimeConfig(config, workspace);
  syncRuntimeWorkspaceTemplates(loaded);
  setCliRuntimeLogs(Boolean(logs));
  const input = message ?? (process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8").trim());
  if (input) {
    const loop = AgentLoop.fromConfig(loaded);
    printCliRestartNoticeIfNeeded(sessionId, markdown);
    const renderer = new StreamRenderer({
      showSpinner: Boolean(process.stdout.isTTY),
      botName: loaded.agents.defaults.botName,
      botIcon: loaded.agents.defaults.botIcon,
      renderMarkdown: markdown,
    });
    const reasoningBuffer = new ReasoningBuffer();
    let rendererClosed = false;
    try {
      const response = await loop.processDirect(input, {
        sessionKey: sessionId,
        onProgress: withProgressCapabilities(
          async (content: string, opts: Record<string, any> = {}) => {
            await maybePrintInteractiveProgress(
              {
                content,
                metadata: { agentProgress: true, ...opts },
              },
              null,
              loaded.channels,
              { renderer, reasoningBuffer },
            );
          },
          { toolEvents: true, fileEditEvents: true, reasoning: true },
        ),
        onStream: async (delta: string) => {
          renderer.write(delta);
        },
        onStreamEnd: async ({ resuming = false }: { resuming?: boolean } = {}) => {
          await renderer.onEnd({ resuming });
        },
      });
      const text = response?.content ?? "";
      await renderer.close();
      rendererClosed = true;
      if (!renderer.text() && text)
        printAgentResponse(text, markdown, response?.metadata, !renderer.headerPrinted);
      return text || null;
    } finally {
      try {
        if (!rendererClosed) await renderer.close();
      } finally {
        loop.stop();
        await Promise.allSettled([loop.closeMcp(), Promise.resolve(loop.sessions.flushAll())]);
      }
    }
  }
  if (!process.stdin.isTTY) return null;
  printCliRestartNoticeIfNeeded(sessionId, markdown);
  return runInteractiveAgent(loaded, sessionId, { renderMarkdown: markdown });
}

export function printCliRestartNoticeIfNeeded(sessionId: string, renderMarkdown = true): boolean {
  const notice = consumeRestartNoticeFromEnv();
  if (!notice || !shouldShowCliRestartNotice(notice, sessionId)) return false;
  printAgentResponse(formatRestartCompletedMessage(notice.startedAtRaw), renderMarkdown, {
    renderAs: "text",
  });
  return true;
}

async function waitForOutbound(
  bus: MessageBus,
  running: () => boolean,
  intervalMs = 50,
): Promise<OutboundMessage | null> {
  while (running()) {
    const item = bus.outbound.getNowait();
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return bus.outbound.getNowait() ?? null;
}

export async function runInteractiveAgent(
  config: Config,
  sessionId = "cli:direct",
  { renderMarkdown = true }: { renderMarkdown?: boolean } = {},
): Promise<null> {
  const bus = new MessageBus();
  const loop = AgentLoop.fromConfig(config, bus);
  if (!promptSession) initPromptSession();
  const [model, presetTag] = modelDisplay(config);
  console.log(`memmy Interactive mode (${model})${presetTag} - type exit or Ctrl+C to quit\n`);

  const [cliChannel, cliChatId] = sessionId.includes(":")
    ? (sessionId.split(/:(.*)/s).filter(Boolean).slice(0, 2) as [string, string])
    : ["cli", sessionId];
  let active = true;
  const state: {
    renderer: StreamRenderer | null;
    turnDone: (() => void) | null;
  } = { renderer: null, turnDone: null };
  const turnResponses: Array<[string, Record<string, any>]> = [];
  const reasoningBuffer = new ReasoningBuffer();

  const runTask = loop.run();
  const outboundTask = (async () => {
    while (active) {
      const msg = await waitForOutbound(bus, () => active);
      if (!msg) continue;

      if (msg.metadata?.streamDelta) {
        state.renderer?.write(msg.content);
        continue;
      }
      if (msg.metadata?.streamEnd) {
        await state.renderer?.onEnd({ resuming: Boolean(msg.metadata.resuming) });
        continue;
      }

      if (
        await maybePrintInteractiveProgress(msg, null, config.channels, {
          renderer: state.renderer,
          reasoningBuffer,
        })
      ) {
        continue;
      }

      if (msg.content) {
        if (msg.metadata?.streamed) {
          state.turnDone?.();
          continue;
        }
        if (state.turnDone) {
          turnResponses.push([msg.content, msg.metadata ?? {}]);
          state.turnDone();
        } else {
          await printInteractiveResponse(msg.content, renderMarkdown, msg.metadata);
        }
        continue;
      }

      state.turnDone?.();
    }
  })();

  try {
    while (active) {
      flushPendingTtyInput();
      state.renderer?.stopForInput();
      let userInput: string;
      try {
        userInput = sanitizeSurrogates(await readInteractiveInputAsync());
      } catch (error) {
        if ((error as Error).name !== "KeyboardInterrupt") throw error;
        console.log("\nGoodbye!");
        break;
      }

      const command = userInput.trim();
      if (!command) continue;
      if (isExitCommand(command)) {
        console.log("\nGoodbye!");
        break;
      }

      reasoningBuffer.clear();
      turnResponses.length = 0;
      state.renderer = new StreamRenderer({
        botName: config.agents.defaults.botName,
        botIcon: config.agents.defaults.botIcon,
        renderMarkdown,
      });
      const donePromise = new Promise<void>((resolve) => {
        state.turnDone = resolve;
      });
      await bus.publishInbound(
        new InboundMessage({
          channel: cliChannel,
          chatId: cliChatId,
          senderId: "user",
          content: userInput,
          metadata: { wantsStream: true },
        }),
      );
      await donePromise;
      state.turnDone = null;

      const turnResponse = turnResponses.shift();
      if (turnResponse) {
        const [content, metadata] = turnResponse;
        await state.renderer.close();
        printAgentResponse(content, renderMarkdown, metadata, !state.renderer.headerPrinted);
      } else if (!state.renderer.text()) {
        await state.renderer.onEnd();
      }
    }
  } finally {
    active = false;
    loop.stop();
    restoreTerminal();
    await Promise.allSettled([runTask, outboundTask, loop.closeMcp()]);
  }
  return null;
}

function providerStatusLabel(name: string): string {
  return name.endsWith("API") ? name : `${name} API`;
}

function providerStatusLine(spec: (typeof PROVIDERS)[number], config: Config): string {
  const provider = (config.providers as any)[spec.name] ?? {};
  const label = spec.envKey ? providerStatusLabel(spec.label) : spec.label;
  if (spec.isOauth) return `${label}: OAuth`;
  if (spec.isLocal) {
    const base = provider.apiBase ?? spec.defaultApiBase;
    return `${label}: ${base || "not set"}`;
  }
  const apiKey = provider.apiKey;
  return `${label}: ${apiKey ? "set" : "not set"}`;
}

export function status({
  workspace = null,
  config = null,
}: { workspace?: string | null; config?: string | null } = {}): string {
  const configPath = config
    ? path.resolve(config.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"))
    : getConfigPath();
  const loaded = loadRuntimeConfig(config, workspace);
  const workspacePath = getWorkspacePath(loaded.agents.defaults.workspace);
  const [model, presetTag] = modelDisplay(loaded);
  const lines = [
    "memmy Status",
    "",
    `Config: ${configPath} ${fs.existsSync(configPath) ? "ok" : "missing"}`,
    `Workspace: ${workspacePath} ${fs.existsSync(workspacePath) ? "ok" : "missing"}`,
    `Model: ${model}${presetTag}`,
  ];
  for (const spec of PROVIDERS) lines.push(providerStatusLine(spec, loaded));
  return lines.join("\n");
}

export class Text {
  constructor(public text: string) {}
}

export class Markdown {
  constructor(public text: string) {}
}

export class ReasoningBuffer {
  buffer = "";
  private streamingOpen = false;
  private streamingNeedsLineBreak = false;

  push(delta: string): string | null {
    this.buffer += delta;
    if (/[.!?。！？]\s*$/.test(this.buffer)) return this.flush();
    return null;
  }

  flush(): string | null {
    const value = this.buffer;
    this.buffer = "";
    return value || null;
  }

  clear(): void {
    this.buffer = "";
    this.streamingOpen = false;
    this.streamingNeedsLineBreak = false;
  }

  startStreaming(): boolean {
    const wasOpen = this.streamingOpen;
    this.streamingOpen = true;
    return !wasOpen;
  }

  noteStreamingText(text: string): void {
    if (!this.streamingOpen || !text) return;
    this.streamingNeedsLineBreak = !text.endsWith("\n");
  }

  endStreaming(): boolean {
    const needsLineBreak = this.streamingOpen && this.streamingNeedsLineBreak;
    this.streamingOpen = false;
    this.streamingNeedsLineBreak = false;
    return needsLineBreak;
  }
}

export function formatCliReasoning(text: string): string {
  const content = text.trimEnd();
  if (!content.trim()) return "";
  return content
    .split(/\r?\n/)
    .map((line) => `thinking: ${line}`)
    .join("\n");
}

export function shouldStyleCliReasoning(file: any = process.stdout): boolean {
  const isTty = typeof file?.isatty === "function" ? Boolean(file.isatty()) : Boolean(file?.isTTY);
  return isTty && process.env.NO_COLOR == null;
}

export function styleCliReasoning(text: string, file: any = process.stdout): string {
  if (!shouldStyleCliReasoning(file)) return text;
  return `\x1b[90;3m${text}\x1b[0m`;
}

export function flushPendingTtyInput(): void {
  if (!process.stdin.isTTY) return;
  // Node keeps canonical line input in the terminal driver; there is no
  // prompt_toolkit-style pending buffer to drain here.
}

export function restoreTerminal(): void {
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(false);
    } catch {}
  }
}

export function initPromptSession(): SafeFileHistory {
  const history = new SafeFileHistory(getCliHistoryPath());
  fs.mkdirSync(path.dirname(history.path), { recursive: true });
  promptSession = {
    history,
    multiline: false,
    enableOpenInEditor: false,
    promptAsync: async (prompt = "> ") => readLineWithNode(promptToPlainText(prompt)),
  };
  return history;
}

export function makeConsole(): Console {
  return Object.assign(console, { forceTerminal: Boolean(process.stdout.isTTY) });
}

type Console = typeof console;

export let promptSession: any = null;

export function setPromptSessionForTest(session: any): void {
  promptSession = session;
}

export function renderInteractiveAnsi(renderFn: (target: Console) => void): string {
  const chunks: string[] = [];
  const target = {
    ...console,
    forceTerminal: Boolean(process.stdout.isTTY),
    log: (...args: any[]) => {
      chunks.push(args.map(String).join(" "));
    },
    print: (...args: any[]) => {
      chunks.push(args.map((arg) => arg?.text ?? String(arg)).join(" "));
    },
  } as Console & { print: (...args: any[]) => void };
  renderFn(target);
  return chunks.join("\n");
}

export function printAgentResponse(
  response: string,
  renderMarkdown = true,
  metadata: Record<string, any> | null = null,
  showHeader = true,
): void {
  if (showHeader) console.log("\nmemmy");
  const renderable = responseRenderable(response, renderMarkdown, metadata ?? {});
  console.log(renderable.text);
}

export async function printInteractiveLine(text: string): Promise<void> {
  process.stdout.write(`${text}\n`);
}

export async function printInteractiveResponse(
  response: string,
  renderMarkdown = true,
  metadata: Record<string, any> | null = null,
): Promise<void> {
  printAgentResponse(response, renderMarkdown, metadata, true);
}

export function printCliReasoning(
  text: string,
  thinking?: ThinkingSpinner | null,
  renderer?: StreamRenderer | null,
): void {
  const formatted = formatCliReasoning(text);
  if (!formatted) return;
  const output = styleCliReasoning(formatted, process.stdout);
  if (renderer) {
    renderer.ensureHeader();
    renderer.ensureLineBreak();
    const pause = renderer.pauseSpinner();
    try {
      process.stdout.write(`${output}\n`);
    } finally {
      pause[Symbol.dispose]();
    }
    return;
  }
  if (thinking) {
    const pause = thinking.pause();
    try {
      process.stdout.write(`${output}\n`);
    } finally {
      pause[Symbol.dispose]();
    }
    return;
  }
  process.stdout.write(`${output}\n`);
}

export function streamCliReasoning(
  text: string,
  reasoningBuffer: ReasoningBuffer,
  thinking?: ThinkingSpinner | null,
  renderer?: StreamRenderer | null,
): void {
  if (!text) return;
  const prefix = reasoningBuffer.startStreaming() ? "thinking: " : "";
  const output = styleCliReasoning(`${prefix}${text}`, process.stdout);
  if (renderer) {
    renderer.ensureHeader();
    renderer.ensureLineBreak();
    const pause = renderer.pauseSpinner();
    try {
      process.stdout.write(output);
    } finally {
      pause[Symbol.dispose]();
    }
    reasoningBuffer.noteStreamingText(text);
    return;
  }
  if (thinking) {
    const pause = thinking.pause();
    try {
      process.stdout.write(output);
    } finally {
      pause[Symbol.dispose]();
    }
    reasoningBuffer.noteStreamingText(text);
    return;
  }
  process.stdout.write(output);
  reasoningBuffer.noteStreamingText(text);
}

export function endCliReasoningStream(
  reasoningBuffer: ReasoningBuffer,
  thinking?: ThinkingSpinner | null,
  renderer?: StreamRenderer | null,
): void {
  if (!reasoningBuffer.endStreaming()) return;
  if (renderer) {
    renderer.ensureHeader();
    const pause = renderer.pauseSpinner();
    try {
      process.stdout.write("\n");
    } finally {
      pause[Symbol.dispose]();
    }
    return;
  }
  if (thinking) {
    const pause = thinking.pause();
    try {
      process.stdout.write("\n");
    } finally {
      pause[Symbol.dispose]();
    }
    return;
  }
  process.stdout.write("\n");
}

export function flushCliReasoning(
  reasoningBuffer: ReasoningBuffer,
  thinking?: ThinkingSpinner | null,
  renderer?: StreamRenderer | null,
): void {
  const text = reasoningBuffer.flush();
  if (text) printCliReasoning(text, thinking, renderer);
  endCliReasoningStream(reasoningBuffer, thinking, renderer);
}

async function readLineWithNode(prompt: string): Promise<string> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export function promptToPlainText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (!prompt || typeof prompt !== "object") return "> ";
  const value =
    "html" in prompt
      ? (prompt as { html?: unknown }).html
      : "text" in prompt
        ? (prompt as { text?: unknown }).text
        : null;
  if (typeof value === "string") return value.replace(/<[^>]+>/g, "");
  return "> ";
}

export async function readInteractiveInputAsync(prompt = "> "): Promise<string> {
  try {
    if (promptSession?.promptAsync) {
      return await promptSession.promptAsync({ html: "<b fg='ansiblue'>You:</b> " });
    }
    return await readLineWithNode(prompt);
  } catch (error) {
    if ((error as Error)?.name === "EOFError") {
      const interrupt = new Error("KeyboardInterrupt");
      interrupt.name = "KeyboardInterrupt";
      throw interrupt;
    }
    throw error;
  }
}

export function versionCallback(value: boolean): void {
  if (value) console.log(CLI_VERSION);
}

export function warnDeprecatedConfigKeys(configPath: string | null = null): string[] {
  const file = configPath ?? getConfigPath();
  const warnings: string[] = [];
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = YAML.parse(raw || "{}");
    if (data?.agents?.defaults?.memoryWindow != null) {
      warnings.push("`memoryWindow` in your config is no longer used and can be safely removed.");
    }
  } catch {
    return warnings;
  }
  for (const warning of warnings) console.warn(warning);
  return warnings;
}

export async function runGateway(
  config: Config,
  {
    port = null,
    openBrowserUrl = null,
  }: { port?: number | null; openBrowserUrl?: string | null } = {},
): Promise<{ bus: MessageBus; loop: AgentLoop; manager: ChannelManager }> {
  void port;
  void openBrowserUrl;
  return gateway({ workspace: config.agents.defaults.workspace });
}

export function printCliProgressLine(
  text: string,
  thinking?: ThinkingSpinner | null,
  renderer?: StreamRenderer | null,
): void {
  if (!text.trim()) return;
  if (renderer) {
    renderer.ensureHeader();
    renderer.ensureLineBreak();
    if (renderer.live?.stop) {
      renderer.live.stop();
      renderer.live = null;
    }
    const pause = renderer.pauseSpinner();
    try {
      renderer.console.print(text);
    } finally {
      pause[Symbol.dispose]();
    }
    return;
  }
  if (thinking) {
    const pause = thinking.pause();
    try {
      console.log(text);
    } finally {
      pause[Symbol.dispose]();
    }
    return;
  }
  console.log(text);
}

export async function printInteractiveProgressLine(
  text: string,
  thinking?: ThinkingSpinner | null,
  renderer?: StreamRenderer | null,
): Promise<void> {
  if (!text.trim()) return;
  if (thinking) {
    const pause = thinking.pause();
    try {
      await printInteractiveLine(text);
    } finally {
      pause[Symbol.dispose]();
    }
    return;
  }
  if (renderer) {
    renderer.ensureHeader();
    renderer.ensureLineBreak();
    const pause = renderer.pauseSpinner();
    try {
      await printInteractiveLine(text);
    } finally {
      pause[Symbol.dispose]();
    }
    return;
  }
  await printInteractiveLine(text);
}

export async function maybePrintInteractiveProgress(
  msg: { content?: string; metadata?: Record<string, any> },
  thinking?: ThinkingSpinner | null,
  channelsConfig: { sendProgress?: boolean; sendToolHints?: boolean; showReasoning?: boolean } = {},
  {
    renderer = null,
    reasoningBuffer = null,
  }: { renderer?: StreamRenderer | null; reasoningBuffer?: ReasoningBuffer | null } = {},
): Promise<boolean> {
  const metadata = msg.metadata ?? {};
  const text = msg.content ?? "";
  const showReasoning = channelsConfig.showReasoning ?? true;
  const sendProgress = channelsConfig.sendProgress ?? true;
  const sendToolHints = channelsConfig.sendToolHints ?? false;
  const buffer = reasoningBuffer;

  if (metadata.retryWait) {
    await printInteractiveProgressLine(text, thinking, renderer);
    return true;
  }
  if (metadata.reasoning || metadata.reasoningDelta || metadata.reasoningEnd) {
    if (showReasoning) {
      if (metadata.reasoning && buffer) {
        streamCliReasoning(text, buffer, thinking, renderer);
      } else if (metadata.reasoningDelta && buffer) {
        const ready = buffer.push(text);
        if (ready) printCliReasoning(ready, thinking, renderer);
      } else if (metadata.reasoningEnd && buffer) {
        const ready = buffer.flush();
        if (ready) printCliReasoning(ready, thinking, renderer);
        endCliReasoningStream(buffer, thinking, renderer);
      } else if (text) {
        printCliReasoning(text, thinking, renderer);
      }
    } else if (metadata.reasoningEnd && buffer) {
      buffer.clear();
    }
    return true;
  }
  if (metadata.agentProgress) {
    if (sendProgress && (sendToolHints || !metadata.toolHint))
      await printInteractiveProgressLine(text, thinking, renderer);
    return true;
  }
  return false;
}

export function responseRenderable(
  text: string,
  renderMarkdown = true,
  metadata: Record<string, any> = {},
): Text | Markdown {
  return renderMarkdown && metadata.renderAs !== "text" ? new Markdown(text) : new Text(text);
}

export function pluginsListRows(): Array<Record<string, any>> {
  const config = loadConfig();
  const builtinNames = new Set(discoverChannelNames());
  return Object.entries(discoverAll())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, cls]) => {
      const section = (config.channels as any)?.[name];
      const enabled = section && typeof section === "object" ? Boolean(section.enabled) : false;
      return {
        name,
        display_name: (cls as any).displayName ?? cls.name,
        source: builtinNames.has(name) ? "builtin" : "plugin",
        enabled,
      };
    });
}

export function pluginsList(): string[] {
  return pluginsListRows().map(
    (row) => `${row.name}\t${row.source}\t${row.enabled ? "yes" : "no"}`,
  );
}
export function channelsStatus({
  configPath = null,
  config = null,
}: { configPath?: string | null; config?: string | null } = {}): string[] {
  const loaded = loadRuntimeConfig(configPath ?? config, null);
  return Object.entries(discoverAll())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, cls]) => {
      const section = (loaded.channels as any)[name] ?? {};
      const enabled = section && typeof section === "object" ? Boolean(section.enabled) : false;
      const label = (cls as any).displayName ?? cls.name ?? name;
      return `${name}\t${label}\t${enabled ? "enabled" : "disabled"}`;
    });
}

export async function channelsLogin(
  channelName: string,
  { force = false, config = null }: { force?: boolean; config?: string | null } = {},
): Promise<boolean> {
  const loaded = loadRuntimeConfig(config, null);
  const cls = discoverAll()[channelName] ?? discoverAll()[channelName.replaceAll("-", "_")];
  if (!cls) throw new Error(`Unknown channel: ${channelName}`);
  const section = (loaded.channels as any)[channelName] ?? {};
  const channel = new cls(section, new MessageBus());
  return Boolean(await channel.login(force));
}

type OAuthHandler = () => void | Promise<void>;
const LOGIN_HANDLERS: Record<string, OAuthHandler> = {};
const LOGOUT_HANDLERS: Record<string, OAuthHandler> = {};
const PROVIDER_DISPLAY: Record<string, string> = {
  openai_codex: "OpenAI Codex",
  github_copilot: "GitHub Copilot",
};

export function registerLogin(
  name: string,
  handler?: OAuthHandler,
): (fn: OAuthHandler) => OAuthHandler {
  const key = name.replaceAll("-", "_");
  if (handler) LOGIN_HANDLERS[key] = handler;
  return (fn: OAuthHandler) => {
    LOGIN_HANDLERS[key] = fn;
    return fn;
  };
}

export function registerLogout(
  name: string,
  handler?: OAuthHandler,
): (fn: OAuthHandler) => OAuthHandler {
  const key = name.replaceAll("-", "_");
  if (handler) LOGOUT_HANDLERS[key] = handler;
  return (fn: OAuthHandler) => {
    LOGOUT_HANDLERS[key] = fn;
    return fn;
  };
}

export function resolveOauthProvider(provider: string): (typeof PROVIDERS)[number] {
  const key = provider.replaceAll("-", "_");
  const spec = PROVIDERS.find((item) => item.name === key && Boolean(item.isOauth || item.isOauth));
  if (!spec) {
    const names = PROVIDERS.filter((item) => item.isOauth || item.isOauth)
      .map((item) => item.name.replaceAll("_", "-"))
      .join(", ");
    throw new Error(`Unknown OAuth provider '${provider}'. Available: ${names}`);
  }
  return spec;
}

export async function providerLogin(provider: string): Promise<void> {
  const spec = resolveOauthProvider(provider);
  const handler = LOGIN_HANDLERS[spec.name];
  if (!handler) throw new Error(`No login handler registered for ${spec.name}`);
  await handler();
}

export async function providerLogout(provider: string): Promise<void> {
  const spec = resolveOauthProvider(provider);
  const handler = LOGOUT_HANDLERS[spec.name];
  if (!handler) throw new Error(`No logout handler registered for ${spec.name}`);
  await handler();
}

export function deleteOauthFiles(tokenPath: string, providerLabel: string): string[] {
  const removed: string[] = [];
  if (fs.existsSync(tokenPath)) {
    fs.rmSync(tokenPath, { force: true });
    removed.push(tokenPath);
  }
  const lockPath = path.join(
    path.dirname(tokenPath),
    `${path.basename(tokenPath, path.extname(tokenPath))}.lock`,
  );
  if (fs.existsSync(lockPath)) {
    fs.rmSync(lockPath, { force: true });
    removed.push(lockPath);
  }
  if (removed.length) {
    console.log(`Logged out from ${providerLabel}`);
    for (const removedPath of removed) console.log(`Removed: ${removedPath}`);
  } else {
    console.log(`No local OAuth credentials found for ${providerLabel}`);
  }
  return removed;
}

export async function loginOpenAICodex(): Promise<void> {
  const token =
    getOpenAICodexToken() ??
    (await loginOpenAICodexInteractive({ print: (text) => console.log(text) }));
  if (!token?.access) throw new Error("OpenAI Codex authentication failed.");
  const mod = await import("../../providers/openai-codex-provider.js");
  mod.getCodexStorage().save({ accountId: token.accountId, access: token.access });
  console.log(`Authenticated with ${PROVIDER_DISPLAY.openai_codex}: ${token.accountId}`);
}

export function logoutOpenAICodex(): void {
  for (const envName of [
    "OAUTH_CLI_KIT_TOKEN_PATH",
    "OPENAI_CODEX_TOKEN_PATH",
    "CHATGPT_TOKEN_PATH",
  ]) {
    const tokenPath = process.env[envName];
    if (tokenPath) {
      deleteOauthFiles(tokenPath, PROVIDER_DISPLAY.openai_codex);
      return;
    }
  }
  deleteOauthFiles(path.join(getDataDir(), "auth", "codex.json"), PROVIDER_DISPLAY.openai_codex);
}

export async function loginGitHubCopilot(): Promise<void> {
  const mod = await import("../../providers/github-copilot-provider.js");
  const storage = mod.getStorage();
  const access = process.env.GITHUB_COPILOT_ACCESS_TOKEN ?? process.env.GITHUB_TOKEN;
  if (access) storage.save({ access });
  else await mod.loginGitHubCopilotDeviceFlow();
  console.log(`Authenticated with ${PROVIDER_DISPLAY.github_copilot}.`);
}

export async function logoutGitHubCopilot(): Promise<void> {
  const mod = await import("../../providers/github-copilot-provider.js");
  deleteOauthFiles(mod.getStorage().getTokenPath(), PROVIDER_DISPLAY.github_copilot);
}

registerLogin("openai_codex", loginOpenAICodex);
registerLogout("openai_codex", logoutOpenAICodex);
registerLogin("github_copilot", loginGitHubCopilot);
registerLogout("github_copilot", logoutGitHubCopilot);
