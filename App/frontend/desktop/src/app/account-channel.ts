/** Account channel module. */
import { resolveMemoryLanguage, type AccountChannel } from "@memmy/local-api-contracts";

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
  // Output language tags may grow independently; display language must have an
  // App message catalog before it can be selected as the current UI language.
  if (configuredLanguage === "zh-CN" || configuredLanguage === "en-US") return configuredLanguage;
  const resolvedDefault = resolveMemoryLanguage(undefined, resolveDesktopAccountChannel(rawChannel));
  return resolvedDefault === "en-US" ? "en-US" : "zh-CN";
}
