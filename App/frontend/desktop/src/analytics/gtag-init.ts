import { setDesktopAnalyticsClientId, setDesktopAnalyticsContext, trackCloudAnalyticsEvent } from "./cloud-analytics.js";
import {
  resolveAnalyticsAppEdition,
  resolveAnalyticsAppEnv,
  resolveGtagConfigOptions
} from "./gtag-config.js";

declare global {
  interface Window {
    dataLayer: IArguments[];
    gtag: (...args: unknown[]) => void;
  }
}

const MEASUREMENT_ID = (import.meta.env.MEMMY_GA4_MEASUREMENT_ID as string | undefined)?.trim();

let initialized = false;

export function initGtag(measurementId = MEASUREMENT_ID): void {
  if (initialized) return;
  void initializeDesktopAnalyticsContext();
  if (!measurementId) {
    console.log("[analytics] initGtag skipped: MEMMY_GA4_MEASUREMENT_ID not set");
    return;
  }
  initialized = true;
  console.log("[analytics] initGtag starting, MEASUREMENT_ID:", measurementId);

  window.dataLayer = window.dataLayer || [];
  // eslint-disable-next-line prefer-rest-params
  window.gtag = function gtag() { window.dataLayer.push(arguments); };

  window.gtag("js", new Date());
  const configOptions = resolveGtagConfigOptions();
  window.gtag("config", measurementId, configOptions);
  console.log("[analytics] gtag config:", configOptions);

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  document.head.appendChild(script);
  console.log("[analytics] gtag.js script injection started:", script.src);

  script.onerror = () => {
    console.error("[analytics] gtag.js script load failed:", script.src);
  };

  // After the script finishes loading, obtain the client_id and pass it to the main process for later use
  script.onload = () => {
    console.log("[analytics] gtag.js script loaded successfully");
    // This browser-side event opens the GA4 session and enables the automatic
    // session_start / first_visit events. Product app_launch goes through cloud.
    window.gtag("event", "app_init");
    console.log("[analytics] app_init sent via gtag");

    window.gtag("get", measurementId, "client_id", (clientId: unknown) => {
      if (typeof clientId === "string" && clientId) {
        // Memory gate for Desktop → cloud UI events (do not read shared file here).
        setDesktopAnalyticsClientId(clientId);
        window.memmy?.sendAnalyticsClientId({
          clientId,
          appEnv: resolveAnalyticsAppEnv(),
          appEdition: resolveAnalyticsAppEdition()
        });
      }
    });

    trackCloudAnalyticsEvent("app_launch");
  };
}

async function initializeDesktopAnalyticsContext(): Promise<void> {
  const memmy = window.memmy;
  if (!memmy) return;
  try {
    const [installationId, appInfo] = await Promise.all([
      memmy.getInstallationId(),
      memmy.getAppInfo(),
    ]);
    setDesktopAnalyticsContext({
      installationId,
      appVersion: appInfo.version,
      platform: appInfo.platform,
    });
  } catch (error) {
    console.warn("[analytics] failed to initialize desktop analytics context:", error);
  }
}

/**
 * Desktop UI events go through cloud `/api/analytics/events`.
 * Kept as `gtagEvent` for call-site compatibility; app_init is emitted directly during setup.
 */
export function gtagEvent(
  name: string,
  params?: Record<string, string | number | boolean>
): void {
  console.log("[analytics] gtagEvent → cloud:", name, params);
  trackCloudAnalyticsEvent(name, params);
}
