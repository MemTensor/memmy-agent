import { resolveAnalyticsAppEnv, resolveGtagConfigOptions } from "./gtag-config.js";

declare global {
  interface Window {
    dataLayer: IArguments[];
    gtag: (...args: unknown[]) => void;
  }
}

const MEASUREMENT_ID = (import.meta.env.VITE_GA4_MEASUREMENT_ID as string | undefined)?.trim();

let initialized = false;

export function initGtag(): void {
  if (initialized) return;
  if (!MEASUREMENT_ID) {
    console.log("[analytics] initGtag skipped: VITE_GA4_MEASUREMENT_ID not set");
    return;
  }
  initialized = true;
  console.log("[analytics] initGtag starting, MEASUREMENT_ID:", MEASUREMENT_ID);

  window.dataLayer = window.dataLayer || [];
  // eslint-disable-next-line prefer-rest-params
  window.gtag = function gtag() { window.dataLayer.push(arguments); };

  window.gtag("js", new Date());
  const configOptions = resolveGtagConfigOptions();
  window.gtag("config", MEASUREMENT_ID, configOptions);
  console.log("[analytics] gtag config:", configOptions);

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
  document.head.appendChild(script);
  console.log("[analytics] gtag.js script injection started:", script.src);

  script.onerror = () => {
    console.error("[analytics] gtag.js script load failed:", script.src);
  };

  // After the script finishes loading, obtain the client_id and pass it to the main process for later use
  script.onload = () => {
    console.log("[analytics] gtag.js script loaded successfully");
    window.gtag("get", MEASUREMENT_ID, "client_id", (clientId: unknown) => {
      if (typeof clientId === "string" && clientId) {
        window.memmy?.sendAnalyticsClientId({
          clientId,
          appEnv: resolveAnalyticsAppEnv()
        });
        console.log("[analytics] gtag client_id ready:", clientId);
      }
    });

    // app_launch is reported directly by gtag (GA4's automatic session_start/first_visit collection is also triggered here)
    window.gtag("event", "app_launch");
    console.log("[analytics] app_launch sent via gtag");
  };
}

/** Sends a single GA4 event (wraps the gtag('event', ...) call). */
export function gtagEvent(
  name: string,
  params?: Record<string, string | number | boolean>
): void {
  if (!MEASUREMENT_ID || typeof window.gtag !== "function") {
    console.log("[analytics] gtagEvent skipped (gtag not ready):", name, params);
    return;
  }
  console.log("[analytics] gtagEvent:", name, params ?? {});
  window.gtag("event", name, params ?? {});
}
