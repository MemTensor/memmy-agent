/** Bounded, cancellable web operations. Never expose arbitrary transport messages or URLs. */
export class WebFailure extends Error {
  constructor(
    public category: string,
    message: string,
    public phase = "unknown",
    public code?: string,
    public retryAfterMs = 0,
    options?: ErrorOptions,
  ) { super(message, options); this.name = "WebFailure"; }
}

export function webFailure(error: unknown, phase = "unknown"): WebFailure {
  if (error instanceof WebFailure) return error;
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 5) return;
    seen.add(value);
    const e = value as { code?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof e.code === "string" && /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+|CERT_[A-Z0-9_]+|DEPTH_[A-Z0-9_]+)$/.test(e.code)) codes.push(e.code);
    visit(e.cause, depth + 1);
    if (Array.isArray(e.errors)) e.errors.slice(0, 5).forEach((child) => visit(child, depth + 1));
  };
  visit(error, 0);
  const code = [...new Set(codes)].join(",") || undefined;
  if (codes.some((c) => ["ENOTFOUND", "EAI_AGAIN"].includes(c))) phase = "dns";
  else if (codes.some((c) => /CERT|TLS|SSL/.test(c))) phase = "tls";
  else if (codes.some((c) => /CONNECT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH/.test(c))) phase = "connect";
  return new WebFailure("network", "Network request failed", phase, code, 0, { cause: error });
}

export function formatWebFailure(provider: string, error: unknown): string {
  const e = webFailure(error);
  const wait = e.retryAfterMs > 0 ? ` Retry after ${Math.ceil(e.retryAfterMs / 1000)}s.` : "";
  return `Error: ${provider} ${e.category}: ${e.message} (phase=${e.phase}${e.code ? `; code=${e.code}` : ""}).${wait} This is not an empty search result. Do not retry this service with different keywords while unavailable.`;
}

export async function withWebDeadline<T>(seconds: number, parent: AbortSignal | null | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new WebFailure("cancelled", "Request cancelled by user", "cancel"));
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) cancel();
  const duration = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30_000;
  const timer = setTimeout(() => controller.abort(new WebFailure("timeout", "Request timeout; network operation cancelled", "deadline")), duration);
  let onAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([run(controller.signal), aborted]);
  } finally {
    // The operation owns its requests even when it returns before the deadline.
    // Keep an existing timeout/user-cancellation reason intact.
    controller.abort(new WebFailure("cancelled", "Web operation finished", "cleanup"));
    clearTimeout(timer);
    parent?.removeEventListener("abort", cancel);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

export async function webRequest(url: string, init: RequestInit = {}): Promise<Response> {
  init.signal?.throwIfAborted();
  try { return await fetch(url, init); }
  catch (error) {
    if (init.signal?.aborted) throw init.signal.reason;
    throw webFailure(error, "request");
  }
}

export async function readWebBody<T>(response: Response, kind: "text" | "arrayBuffer", signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  try { return await response[kind]() as T; }
  catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw webFailure(error, "body");
  }
}

export function checkWebStatus(response: Response): void {
  if (response.ok) return;
  const retry = response.headers.get("retry-after");
  const delay = retry == null ? 0 : /^\d+(?:\.\d+)?$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
  const category = response.status === 429 ? "rate_limited" : [401, 403].includes(response.status) ? "authentication" : "http";
  throw new WebFailure(category, `HTTP ${response.status}`, "response", `HTTP_${response.status}`, Number.isFinite(delay) ? Math.max(0, delay) : 0);
}

type Health = { failures: number; until: number; probing: boolean };
/** Per-tool, per-configuration state; queries deliberately do not participate in the key. */
export class SearchHealth {
  private states = new Map<string, Health>();
  async run<T>(key: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let state = this.states.get(key);
    if (state && (state.probing || state.until > Date.now())) {
      throw new WebFailure("cooldown", "Search service temporarily unavailable; recovery probe pending", "service", undefined, Math.max(1000, state.until - Date.now()));
    }
    if (state) state.probing = true;
    try {
      const result = await task();
      signal.throwIfAborted();
      this.states.delete(key);
      return result;
    } catch (error) {
      const e = webFailure(signal.aborted ? signal.reason : error);
      if (e.category !== "cancelled" && e.category !== "configuration") {
        state ??= { failures: 0, until: 0, probing: false };
        state.failures += 1;
        const delay = Math.max(e.retryAfterMs, e.category === "authentication" ? 60_000 : Math.min(60_000, 5000 * 2 ** Math.min(state.failures - 1, 4)));
        state.until = Date.now() + delay;
        e.retryAfterMs = delay;
        this.states.set(key, state);
        // Bound memory when users repeatedly change endpoints or credentials.
        if (this.states.size > 100) this.states.delete(this.states.keys().next().value!);
      }
      throw e;
    } finally { if (state) state.probing = false; }
  }
}
