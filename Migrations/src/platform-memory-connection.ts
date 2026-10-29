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
  if (connection.inheritProviderDefaults === false) return false;
  if (!MODELS[capability] || connection.model !== MODELS[capability]) return false;
  const protocol = connection.protocol;
  const compatibleProtocol = capability === "embedding" ? "openai-embeddings" : "openai-chat-completions";
  if (protocol !== undefined && protocol !== "memmy-account" && protocol !== compatibleProtocol) return false;
  // Editing a projected platform connection can leave either source marker
  // behind. Only its effective connection, not that marker, proves identity.
  if (!["openai", "openai_compatible", "memmy_account"].includes(String(connection.provider))) return false;
  const account = record(record(config.providers).memmy_account);
  const activeUserId = record(config.app).userId;
  const activeOwner = typeof activeUserId === "string" ? activeUserId.trim() : "";
  const providerOwner = typeof account.ownerAccountId === "string" ? account.ownerAccountId.trim() : "";
  // Legacy files may omit ownership, but an explicit different owner must
  // never authorize discarding the current user's connection.
  if (activeOwner && providerOwner && activeOwner !== providerOwner) return false;
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
