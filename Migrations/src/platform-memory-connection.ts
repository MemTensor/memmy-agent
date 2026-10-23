import type { RuntimeConfigDocument } from "./runtime-config-writer.js";

const MODELS: Readonly<Record<string, string>> = {
  memory_summary: "memory_summary",
  memory_evolution: "memory_evolution",
  embedding: "embedding",
};

export function record(value: unknown): RuntimeConfigDocument {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RuntimeConfigDocument : {};
}

function address(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Only identifies dedicated Memory connections, never an arbitrary same-named model. */
export function isPlatformMemoryConnection(
  config: RuntimeConfigDocument,
  capability: string,
  connection: RuntimeConfigDocument,
): boolean {
  if (!MODELS[capability] || connection.model !== MODELS[capability]) return false;
  if (connection.sourceProvider === "memmy_account" || connection.provider === "memmy_account") return true;
  if (!["openai", "openai_compatible"].includes(String(connection.provider))) return false;
  const account = record(record(config.providers).memmy_account);
  const key = connection.apiKey;
  if (typeof key !== "string" || !key.trim()) return false;
  const endpoints = Object.values(record(account.endpoints));
  // Older projections stored the address directly on the provider.
  if (account.apiBase) endpoints.push(account);
  return endpoints.some((raw) => {
    const endpoint = record(raw);
    if (!address(endpoint.apiBase) || address(connection.apiBase) !== address(endpoint.apiBase)) return false;
    if (key !== (endpoint.apiKey ?? account.apiKey)) return false;
    return ["extraHeaders", "extraBody"].every((field) =>
      stable(connection[field] ?? {}) === stable({ ...record(account[field]), ...record(endpoint[field]) }));
  });
}
