import { getAnalyticsUserId, mergeAnalyticsEventParams } from "./analytics-context.js";
import {
  resolveAnalyticsAppEdition,
  resolveAnalyticsAppEnv,
  resolveGtagDebugMode
} from "./gtag-config.js";

export type CloudAnalyticsParams = Record<string, string | number | boolean>;

type PendingCloudEvent = {
  eventName: string;
  params: CloudAnalyticsParams;
  eventTimeMillis: number;
};

const ANALYTICS_PATH = "/api/analytics/events";
const DEFAULT_ENGAGEMENT_TIME_MSEC = 100;
const DESKTOP_ANALYTICS_SOURCE = "memmy-desktop";

/** Session-scoped gtag client_id. Never read ~/.memmy/analytics-client-id here. */
let sessionClientId: string | null = null;
let installationId: string | null = null;
let appVersion: string | null = null;
let platform: string | null = null;
let pending: PendingCloudEvent[] = [];
let lastEventTimeMillis = 0;
let inflight: Promise<void> = Promise.resolve();
let flushScheduled = false;
let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

export function resolveDesktopAnalyticsBaseUrl(
  raw = import.meta.env.MEMMY_CLOUD_SERVICE as string | undefined
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

/**
 * Called when this session's gtag reports client_id.
 * Flushes any UI events queued before the id was ready.
 */
export function setDesktopAnalyticsClientId(clientId: string): void {
  const trimmed = clientId.trim();
  if (!trimmed) return;
  sessionClientId = trimmed;
  scheduleFlush();
}

export function getDesktopAnalyticsClientId(): string | null {
  return sessionClientId;
}

export function setDesktopAnalyticsContext(input: {
  installationId: string;
  appVersion?: string | null;
  platform?: string | null;
}): void {
  installationId = input.installationId.trim() || null;
  appVersion = input.appVersion?.trim() || null;
  platform = normalizePlatform(input.platform);
  if (installationId) scheduleFlush();
}

export function trackCloudAnalyticsEvent(
  eventName: string,
  params?: CloudAnalyticsParams
): void {
  const name = eventName.trim();
  if (!name) return;

  const eventTimeMillis = Math.max(Date.now(), lastEventTimeMillis + 1);
  lastEventTimeMillis = eventTimeMillis;
  pending.push({
    eventName: name,
    params: { ...(params ?? {}) },
    eventTimeMillis
  });

  if (sessionClientId) {
    scheduleFlush();
  }
}

export async function flushDesktopCloudAnalytics(): Promise<void> {
  return flushNow();
}

/** Test helper. */
export function resetDesktopCloudAnalyticsForTests(options?: {
  fetchImpl?: typeof fetch;
}): void {
  sessionClientId = null;
  installationId = null;
  appVersion = null;
  platform = null;
  pending = [];
  lastEventTimeMillis = 0;
  inflight = Promise.resolve();
  flushScheduled = false;
  fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    void flushNow();
  });
}

function flushNow(): Promise<void> {
  flushScheduled = false;
  const batch = pending;
  pending = [];
  if (batch.length === 0) return inflight;

  const currentInstallationId = installationId;
  const currentClientId = sessionClientId;
  const baseUrl = resolveDesktopAnalyticsBaseUrl();
  if (!currentInstallationId || !currentClientId || !baseUrl) {
    // Keep waiting for both analytics identifiers; drop only when the base URL is missing.
    if (!baseUrl) {
      console.log("[analytics] cloud flush dropped (MEMMY_CLOUD_SERVICE unset):", batch.length);
      return inflight;
    }
    pending = batch.concat(pending);
    return inflight;
  }

  const run = () => postCloudAnalyticsEvents({
    baseUrl,
    installationId: currentInstallationId,
    analyticsClientId: currentClientId,
    appVersion,
    platform,
    events: batch,
  });
  inflight = inflight.then(run, run).then(
    () => undefined,
    () => undefined
  );
  return inflight;
}

function compactParams(params: CloudAnalyticsParams): CloudAnalyticsParams {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")
  ) as CloudAnalyticsParams;
}

async function postCloudAnalyticsEvents(input: {
  baseUrl: string;
  installationId: string;
  analyticsClientId: string;
  appVersion: string | null;
  platform: string | null;
  events: PendingCloudEvent[];
}): Promise<void> {
  const appEnv = resolveAnalyticsAppEnv();
  const appEdition = resolveAnalyticsAppEdition();
  const debugMode = resolveGtagDebugMode();
  const userId = getAnalyticsUserId();

  const commonParams = mergeAnalyticsEventParams();
  const body = {
    clientId: input.analyticsClientId,
    ...(userId ? { userId } : {}),
    installationId: input.installationId,
    events: input.events.map((event) => ({
      eventName: event.eventName,
      params: compactParams({
        engagement_time_msec: DEFAULT_ENGAGEMENT_TIME_MSEC,
        source: DESKTOP_ANALYTICS_SOURCE,
        ...commonParams,
        ...event.params,
        ...(userId ? { user_id: userId } : {}),
        app_env: appEnv,
        app_edition: appEdition,
        ...(input.appVersion ? { app_version: input.appVersion } : {}),
        ...(debugMode ? { debug_mode: 1 } : {}),
        timestamp_micros: Math.max(0, Math.trunc(event.eventTimeMillis)) * 1000,
      })
    }))
  };

  console.log(
    "[analytics] cloud post:",
    input.events.map((event) => event.eventName),
    "installationId=",
    input.installationId
  );

  try {
    await fetchImpl(`${input.baseUrl}${ANALYTICS_PATH}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json;charset=UTF-8"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000)
    });
  } catch {
    // Match backend transport: swallow network errors.
  }
}

function normalizePlatform(value: string | null | undefined): string | null {
  if (value === "darwin" || value === "macos") return "macos";
  if (value === "win32" || value === "windows") return "windows";
  if (value === "linux") return "linux";
  return value?.trim() || null;
}
