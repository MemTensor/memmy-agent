import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSyncFs } from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { join as nodeJoin } from "node:path";
import { hasOption, optionString, parseArgs, type OptionValue } from "./args.js";
import { DEFAULT_MEMORY_URL, loadCliMemoryConfig } from "./config.js";
import { PROJECT_VERSION } from "./project-version.js";

export const CLI_ANALYTICS_EVENTS = {
  invoked: "memmy_cli_invoked",
  completed: "memmy_cli_completed",
  failed: "memmy_cli_failed",
} as const;

export type CliAnalyticsEventName =
  (typeof CLI_ANALYTICS_EVENTS)[keyof typeof CLI_ANALYTICS_EVENTS];

export type AnalyticsAppEnv = "dev" | "prod";
export type AnalyticsUserMode = "account" | "byok";
export type AnalyticsParams = Record<string, string | number | boolean>;
export type EndpointKind = "local" | "remote";
export type InstallChannel = "npm" | "desktop" | "dev" | "unknown" | string;

export type AnalyticsEventInput = {
  eventName: string;
  params?: AnalyticsParams;
  eventTimeMillis?: number;
};

export type PostAnalyticsEventsInput = {
  events: AnalyticsEventInput[];
  clientId?: string | null;
  userId?: string | null;
  /** account | byok; unset/unknown omitted from params. */
  userMode?: string | null;
  appEnv?: AnalyticsAppEnv | null;
  debugMode?: boolean | null;
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

export type TrackAnalyticsEventInput = AnalyticsEventInput &
  Omit<PostAnalyticsEventsInput, "events">;

export type QueuedAnalytics = {
  track: (eventName: string, params?: AnalyticsParams) => void;
  trackAwait: (eventName: string, params?: AnalyticsParams) => Promise<void>;
  flush: () => Promise<void>;
};

export type CliLifecycleAnalytics = QueuedAnalytics;

const DEFAULT_ENGAGEMENT_TIME_MSEC = 100;
const ANALYTICS_PATH = "/api/analytics/events";
const CLIENT_ID_FILENAME = "analytics-client-id";
const CLI_ANALYTICS_SOURCE = "memmy-memory";

export function resolveAnalyticsBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.MEMMY_CLOUD_SERVICE?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

export function resolveAnalyticsAppEnv(env: NodeJS.ProcessEnv = process.env): AnalyticsAppEnv {
  const explicit = env.MEMMY_APP_ENV?.trim().toLowerCase();
  if (explicit === "dev" || explicit === "prod") return explicit;
  return env.NODE_ENV === "production" ? "prod" : "dev";
}

export function resolveAnalyticsDebugMode(
  env: NodeJS.ProcessEnv = process.env,
  appEnv: AnalyticsAppEnv = resolveAnalyticsAppEnv(env),
): boolean {
  const explicit =
    env.MEMMY_GA4_DEBUG === "true" ||
    env.MEMMY_GA4_DEBUG === "1" ||
    env.VITE_GA4_DEBUG === "true";
  return appEnv === "dev" || explicit;
}

export function resolveAnalyticsEnvParams(options: {
  env?: NodeJS.ProcessEnv;
  appEnv?: AnalyticsAppEnv | null;
  debugMode?: boolean | null;
} = {}): AnalyticsParams {
  const env = options.env ?? process.env;
  const appEnv =
    options.appEnv === "dev" || options.appEnv === "prod"
      ? options.appEnv
      : resolveAnalyticsAppEnv(env);
  const debugMode =
    typeof options.debugMode === "boolean"
      ? options.debugMode
      : resolveAnalyticsDebugMode(env, appEnv);
  return {
    app_env: appEnv,
    ...(debugMode ? { debug_mode: 1 } : {}),
  };
}

export function compactAnalyticsParams(params: AnalyticsParams = {}): AnalyticsParams {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  ) as AnalyticsParams;
}

export function getAnalyticsClientIdPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = nodeHomedir(),
): string {
  const memmyHome = (env.MEMMY_HOME?.trim() || nodeJoin(homeDir, ".memmy")).replace(
    /^~(?=$|[/\\])/,
    homeDir,
  );
  return nodeJoin(memmyHome, CLIENT_ID_FILENAME);
}

export function readAnalyticsClientId(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readFileSync?: (path: string, encoding: "utf8") => string;
  existsSync?: (path: string) => boolean;
} = {}): string | null {
  const filePath = getAnalyticsClientIdPath(options.env, options.homeDir);
  const existsSync = options.existsSync ?? nodeExistsSync;
  const readFileSync = options.readFileSync ?? ((path, encoding) => nodeReadFileSyncFs(path, encoding));
  try {
    if (!existsSync(filePath)) return null;
    const existing = readFileSync(filePath, "utf8").trim();
    return existing || null;
  } catch {
    return null;
  }
}

export function normalizeAnalyticsUserId(userId: string | null | undefined): string | null {
  const trimmed = userId?.trim() || null;
  if (!trimmed || trimmed === "local-user") return null;
  return trimmed;
}

export function resolveAnalyticsUserMode(
  mode: string | null | undefined,
): AnalyticsUserMode | null {
  return mode === "account" || mode === "byok" ? mode : null;
}

export function resolveAnalyticsUserModeParams(
  mode: string | null | undefined,
): AnalyticsParams {
  const resolved = resolveAnalyticsUserMode(mode);
  return resolved ? { user_mode: resolved } : {};
}

export function toTimestampMicros(eventTimeMillis: number): number {
  return Math.max(0, Math.trunc(eventTimeMillis)) * 1000;
}

export function postAnalyticsEvents(input: PostAnalyticsEventsInput): Promise<void> {
  const clientId = input.clientId?.trim() || null;
  const userId = normalizeAnalyticsUserId(input.userId);
  const userModeParams = resolveAnalyticsUserModeParams(input.userMode);
  const env = input.env ?? process.env;
  const resolvedBase =
    input.baseUrl !== undefined ? input.baseUrl : resolveAnalyticsBaseUrl(env);
  const baseUrl = resolvedBase?.replace(/\/+$/, "") || null;
  const events = Array.isArray(input.events) ? input.events : [];
  if (!baseUrl || !clientId || events.length === 0) {
    return Promise.resolve();
  }

  const envParams = resolveAnalyticsEnvParams({
    env,
    appEnv: input.appEnv,
    debugMode: input.debugMode,
  });

  const body = {
    clientId,
    events: events.map((event) => {
      const eventTimeMillis = event.eventTimeMillis ?? Date.now();
      return {
        eventName: event.eventName,
        params: compactAnalyticsParams({
          engagement_time_msec: DEFAULT_ENGAGEMENT_TIME_MSEC,
          ...userModeParams,
          ...(event.params ?? {}),
          ...(userId ? { user_id: userId } : {}),
          ...envParams,
          timestamp_micros: toTimestampMicros(eventTimeMillis),
        }),
      };
    }),
  };

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  return fetchImpl(`${baseUrl}${ANALYTICS_PATH}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json;charset=UTF-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  })
    .then(() => undefined)
    .catch(() => undefined);
}

export function trackAnalyticsEvent(input: TrackAnalyticsEventInput): Promise<void> {
  const { eventName, params, eventTimeMillis, ...rest } = input;
  return postAnalyticsEvents({
    ...rest,
    events: [{ eventName, params, eventTimeMillis }],
  });
}

export function createQueuedAnalytics(options: {
  getClientId?: () => string | null | undefined;
  getUserId?: () => string | null | undefined;
  getUserMode?: () => string | null | undefined;
  source?: string;
  appEnv?: AnalyticsAppEnv | null;
  debugMode?: boolean | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string | null;
  env?: NodeJS.ProcessEnv;
} = {}): QueuedAnalytics {
  const source = options.source;
  const getClientId = options.getClientId ?? (() => readAnalyticsClientId({ env: options.env }));
  const getUserId = options.getUserId ?? (() => null);
  const getUserMode = options.getUserMode ?? (() => null);
  let pending: AnalyticsEventInput[] = [];
  let lastEventTimeMillis = 0;
  let inflight: Promise<void> = Promise.resolve();
  let flushScheduled = false;

  const append = (eventName: string, params: AnalyticsParams = {}): void => {
    const eventTimeMillis = Math.max(Date.now(), lastEventTimeMillis + 1);
    lastEventTimeMillis = eventTimeMillis;
    pending.push({
      eventName,
      params: source ? { source, ...params } : { ...params },
      eventTimeMillis,
    });
  };

  const flushNow = (): Promise<void> => {
    flushScheduled = false;
    const batch = pending;
    pending = [];
    if (batch.length === 0) return inflight;
    const run = () =>
      postAnalyticsEvents({
        events: batch,
        clientId: getClientId(),
        userId: getUserId(),
        userMode: getUserMode(),
        appEnv: options.appEnv,
        debugMode: options.debugMode,
        fetchImpl: options.fetchImpl,
        baseUrl: options.baseUrl,
        env: options.env,
      });
    inflight = inflight.then(run, run).then(
      () => undefined,
      () => undefined,
    );
    return inflight;
  };

  const scheduleFlush = (): void => {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      void flushNow();
    });
  };

  return {
    track(eventName, params = {}) {
      append(eventName, params);
      scheduleFlush();
    },
    trackAwait(eventName, params = {}) {
      append(eventName, params);
      return flushNow();
    },
    flush() {
      return flushNow();
    },
  };
}

export function createCliAnalytics(options: {
  getClientId?: () => string | null | undefined;
  getUserId?: () => string | null | undefined;
  getUserMode?: () => string | null | undefined;
  source?: string;
  appEnv?: AnalyticsAppEnv | null;
  debugMode?: boolean | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string | null;
} = {}): CliLifecycleAnalytics {
  return createQueuedAnalytics({
    ...options,
    source: options.source ?? CLI_ANALYTICS_SOURCE,
    getClientId: options.getClientId ?? (() => readAnalyticsClientId()),
  });
}

export function errorCodeFromUnknown(error: unknown): string {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isFinite(status)) return `http_${status}`;
  }
  if (error instanceof Error) {
    const name = error.name?.trim();
    if (name && name !== "Error") return name.slice(0, 64);
    const message = error.message?.trim();
    if (message) return message.slice(0, 64);
  }
  return "unknown";
}

export function elapsedMs(startedAt: number, endedAt = Date.now()): number {
  return Math.max(0, endedAt - startedAt);
}

export function resolveInstallChannel(
  env: NodeJS.ProcessEnv = process.env,
  argvPath = process.argv[1],
): InstallChannel {
  const explicit = env.MEMMY_INSTALL_CHANNEL?.trim();
  if (explicit) return explicit;

  const normalized = (argvPath ?? "").replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/node_modules/")) return "npm";
  if (
    normalized.includes("/resources/cli/") ||
    normalized.includes("/contents/resources/") ||
    normalized.includes("app.asar")
  ) {
    return "desktop";
  }
  if (
    normalized.includes("/memory/dist/") ||
    normalized.includes("/memory/src/cli/") ||
    normalized.endsWith("/memory/dist/src/cli/index.js")
  ) {
    return "dev";
  }
  return "unknown";
}

export function resolveMemoryEndpointUrl(argv: string[]): string {
  const parsed = parseArgs(argv);
  const url = optionString(parsed.options, "url");
  if (url) return url;
  const { config } = loadCliMemoryConfig(optionString(parsed.options, "config"));
  return config.endpoint ?? DEFAULT_MEMORY_URL;
}

export function resolveEndpointKind(url: string): EndpointKind {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]"
    ) {
      return "local";
    }
  } catch {
    // fall through
  }
  return "remote";
}

export function resolveCommandIdentity(argv: string[]): {
  command_group: string;
  command_action?: string;
  has_session_id: boolean;
  has_turn_id: boolean;
} {
  const parsed = parseArgs(argv);
  const words = parsed.positionals;
  const options = parsed.options;

  if (hasOption(options, "help") || hasOption(options, "h")) {
    return {
      command_group: "help",
      has_session_id: false,
      has_turn_id: false,
    };
  }
  if (hasOption(options, "version") || hasOption(options, "v")) {
    return {
      command_group: "version",
      has_session_id: false,
      has_turn_id: false,
    };
  }
  if (words.length === 0 || words[0] === "help") {
    return {
      command_group: "help",
      has_session_id: false,
      has_turn_id: false,
    };
  }

  const group = words[0] ?? "help";
  const action = words[1];
  const positionalId = words[2]?.trim() || "";

  const has_session_id =
    Boolean(optionString(options, "session-id")?.trim()) ||
    bodyHasStringField(options, "sessionId") ||
    (group === "session" && (action === "close" || action === "open") && Boolean(positionalId));

  const has_turn_id =
    Boolean(optionString(options, "turn-id")?.trim()) ||
    bodyHasStringField(options, "turnId") ||
    (group === "turn" && action === "complete" && Boolean(positionalId));

  return {
    command_group: group,
    ...(action ? { command_action: action } : {}),
    has_session_id,
    has_turn_id,
  };
}

export function resolveCliAgentSourceId(argv: string[]): string | undefined {
  const parsed = parseArgs(argv);
  const direct = optionString(parsed.options, "source")?.trim();
  if (direct) return direct;
  const fromBody = bodyStringField(parsed.options, "source");
  return fromBody || undefined;
}

function normalizeRawPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** Internal automation (npm worker:run, backend cron) — not user or agent CLI usage. */
export function isInfrastructureCliInvocation(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.MEMMY_CLI_ANALYTICS_SKIP === "1" || env.MEMMY_CLI_ANALYTICS_SKIP === "true") {
    return true;
  }

  const parsed = parseArgs(argv);
  const words = parsed.positionals;
  if (words[0] !== "raw") return false;

  const method = (words[1] ?? "").toUpperCase();
  const path = normalizeRawPath(words[2] ?? "");
  return method === "POST" && (path === "/worker/run" || path === "/api/v1/worker/run");
}

/** Track agent calls, manual terminal usage; skip startup/automation such as worker/run. */
export function shouldTrackCliAnalytics(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !isInfrastructureCliInvocation(argv, env);
}

export function createNoopCliAnalytics(): CliLifecycleAnalytics {
  return {
    track() {},
    trackAwait() {
      return Promise.resolve();
    },
    flush() {
      return Promise.resolve();
    },
  };
}

export function resolveCliAnalyticsParams(
  argv: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    argvPath?: string;
  } = {},
): AnalyticsParams {
  const env = options.env ?? process.env;
  const identity = resolveCommandIdentity(argv);
  const endpointUrl = resolveMemoryEndpointUrl(argv);
  const agentSourceId = resolveCliAgentSourceId(argv);
  return compactAnalyticsParams({
    command_group: identity.command_group,
    ...(identity.command_action ? { command_action: identity.command_action } : {}),
    ...(agentSourceId ? { source_id: agentSourceId } : {}),
    cli_version: PROJECT_VERSION,
    install_channel: resolveInstallChannel(env, options.argvPath ?? process.argv[1]),
    endpoint_kind: resolveEndpointKind(endpointUrl),
    has_session_id: identity.has_session_id,
    has_turn_id: identity.has_turn_id,
  });
}

function bodyStringField(options: Record<string, OptionValue>, field: string): string | undefined {
  const bodyText =
    optionString(options, "body") ?? optionString(options, "json") ?? optionString(options, "data");
  if (!bodyText) return undefined;
  const trimmed = bodyText.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[field];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

function bodyHasStringField(options: Record<string, OptionValue>, field: string): boolean {
  return Boolean(bodyStringField(options, field));
}
