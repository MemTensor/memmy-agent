/** Ga4 client module. */
import { ProxyAgent } from "undici";

const GA4_ENDPOINT = "https://www.google-analytics.com/mp/collect";

function createProxyDispatcher(proxyUrl: string): ProxyAgent {
  const url = new URL(proxyUrl);
  if (url.protocol === "socks5:" || url.protocol === "socks5h:") {
    throw new Error("MEMMY_GA4_PROXY only supports http:// or https:// proxy URLs");
  }
  return new ProxyAgent(proxyUrl);
}

let proxyDispatcher: ProxyAgent | undefined;
let proxyResolved = false;

function getProxyDispatcher(): ProxyAgent | undefined {
  if (proxyResolved) return proxyDispatcher;
  proxyResolved = true;
  const proxyUrl = process.env.MEMMY_PROXY_SERVER ?? process.env.MEMMY_GA4_PROXY;
  if (proxyUrl) {
    console.log("[analytics] using GA4 proxy:", proxyUrl);
    proxyDispatcher = createProxyDispatcher(proxyUrl);
  }
  return proxyDispatcher;
}

export interface Ga4Config {
  measurementId: string;
  apiSecret: string;
}

export interface Ga4Event {
  name: string;
  params?: Record<string, string | number | boolean>;
}

export interface SendGa4EventsOptions {
  config: Ga4Config;
  /** Client id. */
  clientId: string;
  events: Ga4Event[];
  appEnv?: "dev" | "prod";
}

export async function sendGa4Events(opts: SendGa4EventsOptions): Promise<void> {
  const { config, clientId, events, appEnv } = opts;
  const url = `${GA4_ENDPOINT}?measurement_id=${config.measurementId}&api_secret=${config.apiSecret}`;
  const timeoutMs = Number.parseInt(process.env.MEMMY_GA4_TIMEOUT_MS ?? "5000", 10);
  const dispatcher = getProxyDispatcher();
  const debugMode = Boolean(process.env.MEMMY_GA4_DEBUG);

  const enrichedEvents = events.map((event, index) => ({
    name: event.name,
    params: {
      ...event.params,
      engagement_time_msec: index === 0 ? 100 : 1,
      ...(appEnv ? { app_env: appEnv } : {}),
      ...(debugMode ? { debug_mode: 1 } : {})
    }
  }));

  const payload = {
    client_id: clientId,
    non_personalized_ads: true,
    events: enrichedEvents
  };

  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "connection": "close" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
    ...(dispatcher ? { dispatcher } : {})
  });
}

export function resolveGa4Config(): Ga4Config | undefined {
  const measurementId = process.env.MEMMY_GA4_MEASUREMENT_ID;
  const apiSecret = process.env.MEMMY_GA4_API_SECRET;
  if (!measurementId || !apiSecret) return undefined;
  return { measurementId, apiSecret };
}
