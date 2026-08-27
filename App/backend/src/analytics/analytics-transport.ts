import { randomUUID } from "node:crypto";
import {
  existsSync as nodeExistsSync,
  mkdirSync as nodeMkdirSync,
  readFileSync as nodeReadFileSyncFs,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { homedir as nodeHomedir } from "node:os";
import { join as nodeJoin } from "node:path";
import { MEMMY_VERSION } from "../project-version.js";

export type AnalyticsAppEnv = "dev" | "prod";
export type AnalyticsAppEdition = "cn" | "intl";
export type AnalyticsUserMode = "account" | "account_byok" | "byok";
export type AnalyticsParams = Record<string, string | number | boolean>;

type AnalyticsEventInput = {
  eventName: string;
  params?: AnalyticsParams;
  eventTimeMillis?: number;
  source?: string;
};

type PostAnalyticsEventsInput = {
  events: AnalyticsEventInput[];
  installationId?: string | null;
  clientId?: string | null;
  userId?: string | null;
  /** account | account_byok | byok; unset/unknown omitted. */
  userMode?: string | null;
  appEnv?: AnalyticsAppEnv | null;
  appEdition?: AnalyticsAppEdition | null;
  debugMode?: boolean | null;
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

export type QueuedAnalytics = {
  track: (eventName: string, params?: AnalyticsParams) => void;
  trackAwait: (eventName: string, params?: AnalyticsParams) => Promise<void>;
  flush: () => Promise<void>;
};

const DEFAULT_ENGAGEMENT_TIME_MSEC = 100;
const ANALYTICS_PATH = "/api/analytics/events";
const CLIENT_ID_FILENAME = "analytics-client-id";
const INSTALLATION_ID_FILENAME = "installation-id";

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

/** MEMMY_APP_EDITION=intl → intl, otherwise cn (matches desktop gtag / legal-links). */
export function resolveAnalyticsAppEdition(
  env: NodeJS.ProcessEnv = process.env,
): AnalyticsAppEdition {
  return env.MEMMY_APP_EDITION?.trim().toLowerCase() === "intl" ? "intl" : "cn";
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
  appEdition?: AnalyticsAppEdition | null;
  debugMode?: boolean | null;
} = {}): AnalyticsParams {
  const env = options.env ?? process.env;
  const appEnv =
    options.appEnv === "dev" || options.appEnv === "prod"
      ? options.appEnv
      : resolveAnalyticsAppEnv(env);
  const appEdition =
    options.appEdition === "cn" || options.appEdition === "intl"
      ? options.appEdition
      : resolveAnalyticsAppEdition(env);
  const debugMode =
    typeof options.debugMode === "boolean"
      ? options.debugMode
      : resolveAnalyticsDebugMode(env, appEnv);
  return {
    app_env: appEnv,
    app_edition: appEdition,
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

export function getOrCreateInstallationId(options: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
} = {}): string {
  const homeDir = options.homeDir ?? nodeHomedir();
  const memmyHome = (options.env?.MEMMY_HOME?.trim() || nodeJoin(homeDir, ".memmy")).replace(
    /^~(?=$|[/\\])/,
    homeDir,
  );
  const filePath = nodeJoin(memmyHome, INSTALLATION_ID_FILENAME);
  try {
    if (nodeExistsSync(filePath)) {
      const existing = nodeReadFileSyncFs(filePath, "utf8").trim();
      if (existing) return existing;
    }
  } catch {
    // Recreate an unreadable or empty identifier below.
  }
  const installationId = randomUUID();
  nodeMkdirSync(memmyHome, { recursive: true });
  nodeWriteFileSync(filePath, `${installationId}\n`, "utf8");
  return installationId;
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

export function normalizeAnalyticsUserId(userId: string | null | undefined): string | null {
  const trimmed = userId?.trim() || null;
  if (!trimmed || trimmed === "local-user") return null;
  return trimmed;
}

export function resolveAnalyticsUserMode(
  mode: string | null | undefined,
): AnalyticsUserMode | null {
  return mode === "account" || mode === "account_byok" || mode === "byok" ? mode : null;
}

export function resolveAnalyticsUserModeParams(
  mode: string | null | undefined,
  userId?: string | null,
): AnalyticsParams {
  const resolved = resolveAnalyticsUserMode(mode);
  if (!userId) return { user_mode: "byok" };
  return { user_mode: resolved === "byok" || resolved === "account_byok" ? "account_byok" : "account" };
}

function toTimestampMicros(eventTimeMillis: number): number {
  return Math.max(0, Math.trunc(eventTimeMillis)) * 1000;
}

export function postAnalyticsEvents(input: PostAnalyticsEventsInput): Promise<void> {
  const clientId = input.clientId?.trim() || null;
  const installationId = input.installationId?.trim() || getOrCreateInstallationId({ env: input.env });
  const userId = normalizeAnalyticsUserId(input.userId);
  const userModeParams = resolveAnalyticsUserModeParams(input.userMode, userId);
  const env = input.env ?? process.env;
  const resolvedBase =
    input.baseUrl !== undefined ? input.baseUrl : resolveAnalyticsBaseUrl(env);
  const baseUrl = resolvedBase?.replace(/\/+$/, "") || null;
  const events = Array.isArray(input.events) ? input.events : [];
  if (!baseUrl || !installationId || events.length === 0) {
    return Promise.resolve();
  }

  const envParams = resolveAnalyticsEnvParams({
    env,
    appEnv: input.appEnv,
    appEdition: input.appEdition,
    debugMode: input.debugMode,
  });

  const body = {
    ...(clientId ? { clientId } : {}),
    ...(userId ? { userId } : {}),
    installationId,
    events: events.map((event) => {
      const eventTimeMillis = event.eventTimeMillis ?? Date.now();
      return {
        eventName: event.eventName,
        params: compactAnalyticsParams({
          engagement_time_msec: DEFAULT_ENGAGEMENT_TIME_MSEC,
          source: event.source ?? "memmy-backend",
          ...userModeParams,
          ...(event.params ?? {}),
          ...(userId ? { user_id: userId } : {}),
          ...envParams,
          app_version: MEMMY_VERSION,
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

export function trackAnalyticsEvent(input: {
  eventName: string;
  params?: AnalyticsParams;
  clientId?: string | null;
  installationId?: string | null;
  userId?: string | null;
  userMode?: string | null;
  appEnv?: AnalyticsAppEnv | null;
  appEdition?: AnalyticsAppEdition | null;
  debugMode?: boolean | null;
  eventTimeMillis?: number;
  baseUrl?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  return postAnalyticsEvents({
    events: [
      {
        eventName: input.eventName,
        params: input.params,
        eventTimeMillis: input.eventTimeMillis,
      },
    ],
    clientId: input.clientId,
    installationId: input.installationId,
    userId: input.userId,
    userMode: input.userMode,
    appEnv: input.appEnv,
    appEdition: input.appEdition,
    debugMode: input.debugMode,
    baseUrl: input.baseUrl,
    fetchImpl: input.fetchImpl,
  });
}

export function createQueuedAnalytics(options: {
  getClientId?: () => string | null | undefined;
  getInstallationId?: () => string | null | undefined;
  getUserId?: () => string | null | undefined;
  getUserMode?: () => string | null | undefined;
  source?: string;
  appEnv?: AnalyticsAppEnv | null;
  appEdition?: AnalyticsAppEdition | null;
  debugMode?: boolean | null;
  fetchImpl?: typeof fetch;
  baseUrl?: string | null;
  env?: NodeJS.ProcessEnv;
} = {}): QueuedAnalytics {
  const source = options.source;
  const getClientId = options.getClientId ?? (() => readAnalyticsClientId({ env: options.env }));
  const getInstallationId = options.getInstallationId ?? (() => getOrCreateInstallationId({ env: options.env }));
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
      params: { ...params },
      source,
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
        installationId: getInstallationId(),
        userId: getUserId(),
        userMode: getUserMode(),
        appEnv: options.appEnv,
        appEdition: options.appEdition,
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
