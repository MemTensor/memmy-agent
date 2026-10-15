import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const timing = new AsyncLocalStorage<{ traceId: string; started: number; seen: Set<string> }>();

/** Timing fields only: never serialize prompts, credentials, URLs or errors. */
export function requestTiming(stage: string, once = false): void {
  const context = timing.getStore();
  if (!context || (once && context.seen.has(stage))) return;
  context.seen.add(stage);
  process.stderr.write(`[memmy-timing] ${JSON.stringify({
    traceId: context.traceId, stage, elapsedMs: Math.round(performance.now() - context.started),
    at: new Date().toISOString(), pid: process.pid,
  })}\n`);
}

export function withRequestTiming<T>(traceId: string | null, fn: () => T): T {
  if (process.env.MEMMY_TIMING_LOG !== "1") return fn();
  const safeId = traceId && /^[a-zA-Z0-9_-]{1,96}$/.test(traceId) ? traceId : randomUUID();
  return timing.run({ traceId: safeId, started: performance.now(), seen: new Set() }, () => {
    requestTiming("api.received");
    return fn();
  });
}
