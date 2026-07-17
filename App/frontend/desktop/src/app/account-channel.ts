/** Account channel module. */
import type { AccountChannel } from "@memmy/local-api-contracts";

export type DesktopDisplayLanguage = "zh-CN" | "en-US";

/** Handles resolve desktop account channel. */
export function resolveDesktopAccountChannel(rawChannel = import.meta.env.MEMMY_ACCOUNT_CHANNEL): AccountChannel {
  return rawChannel?.trim().toLowerCase() === "email" ? "email" : "phone";
}

/** Handles resolve desktop display language. */
export function resolveDesktopDisplayLanguage(
  configuredLanguage: string | undefined,
  rawChannel = import.meta.env.MEMMY_ACCOUNT_CHANNEL
): DesktopDisplayLanguage {
  if (configuredLanguage === "zh-CN" || configuredLanguage === "en-US") {
    return configuredLanguage;
  }

  return resolveDesktopAccountChannel(rawChannel) === "email" ? "en-US" : "zh-CN";
}
