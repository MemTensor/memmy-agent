import { createHash } from "node:crypto";

/** Only verified Chat exceptions are stored. Successful Responses requests need no entry. */
export class ChatExceptionCache {
  private entries = new Map<string, number>();
  constructor(private capacity = 4096, private ttlMs = 86_400_000, private now = () => performance.now()) {}

  has(key: string): boolean {
    const expires = this.entries.get(key);
    if (expires === undefined) return false;
    if (expires <= this.now()) { this.entries.delete(key); return false; }
    this.entries.delete(key);
    this.entries.set(key, expires);
    return true;
  }

  remember(key: string): void {
    if (this.has(key)) return;
    this.entries.set(key, this.now() + this.ttlMs);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
  }

  forget(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
}

export const chatExceptions = new ChatExceptionCache();

function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  }
  return value;
}

function shape(value: any, key = ""): any {
  if (Array.isArray(value)) return [...new Set(value.map(item => JSON.stringify(shape(item))))].sort();
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, shape(value[k], k)]));
  return key === "role" || key === "type" ? value : typeof value;
}

export function protocolScope(identity: unknown): string {
  return createHash("sha256").update(JSON.stringify(sorted(identity))).digest("hex");
}

export function protocolPreferenceKey(scope: string, request: Record<string, any>): string {
  return protocolScope({ scope, request: { ...request, messages: shape(request.messages) } });
}

export type ResponsesState = { version: 1; protocol: "responses"; scope: string; items: Record<string, any>[] };

export function responsesState(value: any, scope?: string): ResponsesState | null {
  return value?.version === 1 && value.protocol === "responses" && typeof value.scope === "string"
    && (scope === undefined || value.scope === scope) && Array.isArray(value.items) && value.items.length > 0
    && value.items.every((item: any) => item && typeof item === "object" && !Array.isArray(item))
    ? value : null;
}

export function rejectsProtocol(error: any, responses: boolean): boolean {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.response?.statusCode);
  if (![400, 404, 422].includes(status)) return false;
  let payload = error?.body ?? error?.error ?? error?.doc ?? error?.response?.text ?? error?.message ?? "";
  if (typeof payload === "string") { try { payload = JSON.parse(payload); } catch { /* Plain route errors. */ } }
  const message = String(payload?.error?.message ?? payload?.message ?? payload?.error ?? payload)
    .toLowerCase().replace(/[`"']/g, " ").replace(/\s+/g, " ");
  if (/do not use|don t use/.test(message)) return false;
  if (!responses) {
    return message.includes("/chat/completions") && /not supported|unsupported|not compatible/.test(message)
      && /\b(?:use|requires?|only supported (?:on|in)) (?:the )?(?:\/v1\/responses|\/responses|responses api)(?=[\s.,;:!?)]|$)/.test(message);
  }
  const endpoint = "(?:/v1/responses|/responses|responses (?:api|endpoint))(?=[\\s.,;:!?)]|$)";
  return new RegExp(endpoint + "\\s+(?:endpoint |api )?(?:is |are )?(?:currently )?(?:not supported|unsupported|not compatible|not available)(?=[\\s.,;:!?)]|$)").test(message)
    || new RegExp("\\b(?:unsupported|unrecognized|unknown) (?:api )?(?:endpoint|route)[: ]+" + endpoint).test(message)
    || new RegExp("\\bmodel\\b[^.;]*\\b(?:does not support|doesn t support|is not compatible with) (?:the )?" + endpoint).test(message)
    || new RegExp("\\bmodel\\b[^.;]*\\b(?:is )?not supported (?:on|in|by) (?:the )?" + endpoint).test(message)
    || /\bcannot post (?:\/[a-z0-9._~-]+)*\/responses(?=[\s.,;:!?)]|$)/.test(message);
}
