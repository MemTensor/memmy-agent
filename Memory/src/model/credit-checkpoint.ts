import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

interface Steps {
  read: (key: string) => unknown;
  save: (key: string, value: unknown) => void;
  occurrences: Map<string, number>;
}
const current = new AsyncLocalStorage<Steps>();

/** Scope completed model steps to one durable job; credentials and prompts are not keys. */
export function withCreditCheckpoints<T>(read: Steps["read"], save: Steps["save"], run: () => Promise<T>): Promise<T> {
  return current.run({ read, save, occurrences: new Map() }, run);
}
export function creditCheckpoint(operation: string | undefined, body: unknown): { read(): unknown; save(value: unknown): void } | undefined {
  const store = current.getStore();
  if (!store) return undefined;
  const identity = body && typeof body === "object" && !Array.isArray(body) ? { ...body } as Record<string, unknown> : body;
  if (identity && typeof identity === "object" && !Array.isArray(identity)) {
    for (const field of ["model", "callId", "resumeToken"]) delete (identity as Record<string, unknown>)[field];
  }
  const hash = createHash("sha256").update(JSON.stringify([operation, identity])).digest("hex");
  const occurrence = store.occurrences.get(hash) ?? 0;
  store.occurrences.set(hash, occurrence + 1);
  const key = `${hash}_${occurrence}`;
  return { read: () => store.read(key), save: (value) => store.save(key, value) };
}

export async function accountHasCredits(config: { endpoint?: string; apiKey?: string; extraHeaders?: Record<string, string> }): Promise<boolean> {
  if (!config.endpoint) return false;
  const url = new URL(config.endpoint);
  if (!/\/agentExternal(?:\/v1)?\/?$/.test(url.pathname)) return false;
  url.pathname = url.pathname.replace(/\/agentExternal(?:\/v1)?\/?$/, "/credits/v1/summary");
  url.search = ""; url.hash = "";
  try {
    const response = await fetch(url, { headers: { ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}), ...config.extraHeaders }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return false;
    const body = await response.json() as { code?: unknown; data?: { account?: { spendable?: unknown } } };
    const value = body.data?.account?.spendable;
    return body.code === 0 && typeof value === "string" && /^\d+(?:\.\d{1,2})?$/.test(value) && Number(value) > 0;
  } catch { return false; }
}
