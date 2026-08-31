import type { CapabilityEvent } from "@memmy/local-api-contracts";
import type { PluginRuntimeContext } from "./types.js";

const BLOCKED_STATIC_HEADERS = new Set(["authorization", "cookie", "host", "proxy-authorization"]);

export function assertSafeStaticHeaders(headers: Readonly<Record<string, string>>, adapter: string): void {
  const blocked = Object.keys(headers).find((name) => BLOCKED_STATIC_HEADERS.has(name.toLowerCase()));
  if (blocked) throw new Error(`Sensitive ${adapter} header must use secretHeaders: ${blocked}`);
}

export function assertNetworkPermission(context: PluginRuntimeContext, hostname: string): void {
  const allowed = context.plugin.manifest.permissions.some((permission) =>
    permission.type === "network" && permission.hosts.includes(hostname)
  );
  if (!allowed) throw Object.assign(new Error(`Plugin network permission does not allow ${hostname}`), {
    code: "plugin_permission_denied"
  });
}

export function resolveSecretHeaders(
  headers: Readonly<Record<string, string>>,
  secretHeaders: Readonly<Record<string, string>>,
  secrets: Readonly<Record<string, string>>,
  adapter: string
): Record<string, string> {
  const resolved = { ...headers };
  for (const [header, key] of Object.entries(secretHeaders)) {
    const value = secrets[key];
    if (!value) throw new Error(`Missing plugin secret for ${adapter} header ${header}`);
    resolved[header] = value;
  }
  return resolved;
}

export function callTimeoutMs(configured: number, deadline: string | undefined): number {
  return deadline ? Math.max(1, Math.min(configured, Date.parse(deadline) - Date.now())) : configured;
}

export function isCapabilityEvent(value: unknown): value is CapabilityEvent {
  return Boolean(value && typeof value === "object" && "type" in value);
}
