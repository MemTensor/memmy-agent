import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { normalizeAnalyticsUserId } from "../cli/analytics.js";

export type DesktopAnalyticsIdentity = {
  userId: string | null;
  userMode: "account" | "byok" | null;
};

/** Desktop login projected into `~/.memmy/config.yaml`. Read on each report so a mode switch is visible without restarting. */
export function readDesktopAnalyticsIdentity(configPath?: string | null): DesktopAnalyticsIdentity {
  const empty: DesktopAnalyticsIdentity = { userId: null, userMode: null };
  if (!configPath) return empty;
  try {
    if (!existsSync(configPath)) return empty;
    const root = asRecord(parseYaml(readFileSync(configPath, "utf8")));
    const app = asRecord(root.app);
    const mode = optionalString(app.userMode);
    const userMode = mode === "account" || mode === "byok" ? mode : null;
    const cloudUuid = optionalString(app.cloudUuid);
    const userId = cloudUuid ? normalizeAnalyticsUserId(optionalString(app.userId)) : null;
    return { userId, userMode };
  } catch {
    return empty;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
