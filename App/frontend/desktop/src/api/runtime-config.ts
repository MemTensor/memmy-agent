import { RuntimeConfigSchema, type RuntimeConfig } from "@memmy/local-api-contracts";

export const MISSING_RUNTIME_CONFIG_MESSAGE =
  "Memmy runtime config is unavailable: Electron preload bridge is missing and Vite env config is incomplete.";

export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  const electronBridge = typeof window === "undefined" ? undefined : window.memmy;

  if (electronBridge?.getRuntimeConfig) {
    return RuntimeConfigSchema.parse(await electronBridge.getRuntimeConfig());
  }

  const viteEnvConfig = {
    baseUrl: import.meta.env.VITE_MEMMY_LOCAL_API_URL,
    localToken: import.meta.env.VITE_MEMMY_LOCAL_TOKEN
  };
  const parsedConfig = RuntimeConfigSchema.safeParse(viteEnvConfig);

  if (!parsedConfig.success) {
    const browserDebugConfig = await readBrowserDebugRuntimeConfig();
    if (browserDebugConfig) {
      return browserDebugConfig;
    }

    throw new Error(MISSING_RUNTIME_CONFIG_MESSAGE, { cause: parsedConfig.error });
  }

  return parsedConfig.data;
}

async function readBrowserDebugRuntimeConfig(): Promise<RuntimeConfig | null> {
  const location = typeof window === "undefined" ? undefined : window.location;
  if (!location || !isLocalDebugOrigin(location) || typeof fetch !== "function") {
    return null;
  }

  try {
    const response = await fetch("/__memmy_runtime_config", { cache: "no-store" });
    if (!response.ok) {
      return null;
    }

    return RuntimeConfigSchema.parse(await response.json());
  } catch {
    return null;
  }
}

function isLocalDebugOrigin(location: Location): boolean {
  if (location.protocol !== "http:" && location.protocol !== "https:") {
    return false;
  }

  return location.hostname === "127.0.0.1" || location.hostname === "localhost" || location.hostname === "::1";
}
