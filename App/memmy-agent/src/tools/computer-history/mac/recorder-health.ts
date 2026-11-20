/** Health signals carry counters and times only, never captured user content. */
export const RECORDER_HEALTH_CODES = [
  "heartbeat", "observer_ready", "event_recorded", "observer_unavailable",
  "observer_notifications_unavailable", "ax_snapshot_budget_exceeded",
  "ax_snapshot_failed", "ax_snapshot_ready",
  "enrichment_backlog", "helper_parse_error", "event_processing_error",
  "input_monitoring_unavailable", "input_monitoring_ready",
] as const;
export type RecorderHealthCode = typeof RECORDER_HEALTH_CODES[number];
export interface RecorderHealthSignal {
  timestamp: string;
  code: RecorderHealthCode;
  count?: number;
}

export interface CaptureGapRecord {
  recordType: "capture_gap";
  timestamp: string;
  actionKind: string;
  reason: string;
  count: number;
  button?: "left" | "right" | "middle";
}
const gapActions = new Set(["mouse.click", "mouse.context_menu", "mouse.scroll", "keyboard.keydown"]);
const gapReasons = new Set(["worker_failed", "action_origin_unknown", "action_origin_expired", "action_origin_changed",
  "foreground_changed", "navigation_changed", "focus_changed"]);

/** Normalize native and persisted gaps without retaining an unverified scope or user content. */
export function captureGapRecord(value: unknown): CaptureGapRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const timestamp = source.type === "recorder.capture_gap" ? source.actionTimestamp
    : source.recordType === "capture_gap" ? source.timestamp : undefined;
  if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(timestamp) || !Number.isFinite(Date.parse(timestamp))
    || typeof source.actionKind !== "string" || !gapActions.has(source.actionKind)
    || typeof source.reason !== "string" || !gapReasons.has(source.reason)
    || (source.count !== undefined && (!Number.isSafeInteger(source.count) || Number(source.count) < 1 || Number(source.count) > 10000))) return null;
  const button = source.actionKind === "mouse.click" || source.actionKind === "mouse.context_menu" ? source.button : undefined;
  return { recordType: "capture_gap", timestamp: new Date(timestamp).toISOString(), actionKind: source.actionKind,
    reason: source.reason, count: source.count === undefined ? 1 : Number(source.count),
    ...(button === "left" || button === "right" || button === "middle" ? { button } : {}) };
}

const codes = new Set<string>(RECORDER_HEALTH_CODES);
const stateCodes = new Set<RecorderHealthCode>(["heartbeat", "observer_ready", "event_recorded", "input_monitoring_ready", "ax_snapshot_ready"]);

/** Project an untrusted helper envelope onto the content-free protocol. */
export function nativeRecorderDiagnostic(value: unknown): RecorderHealthSignal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (source.type !== "recorder.diagnostic" || typeof source.code !== "string"
    || !codes.has(source.code) || ["event_recorded", "helper_parse_error", "event_processing_error", "ax_snapshot_ready"].includes(source.code)
    || typeof source.timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(source.timestamp)
    || !Number.isFinite(Date.parse(source.timestamp))) return null;
  if (source.count !== undefined && (!Number.isSafeInteger(source.count) || Number(source.count) <= 0)) return null;
  return {
    timestamp: new Date(source.timestamp).toISOString(),
    code: source.code as RecorderHealthCode,
    ...(source.count !== undefined ? { count: Number(source.count) } : {}),
  };
}

/** First signal is immediate; batches retain the latest time and issue count. */
export function recorderHealthReporter(
  write: (line: string) => void = (line) => console.log(line),
  intervalMs = 10_000,
  now: () => number = Date.now,
) {
  const lastSent = new Map<RecorderHealthCode, number>();
  const pending = new Map<RecorderHealthCode, RecorderHealthSignal>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const send = (signal: RecorderHealthSignal) => {
    write("[recorder-health] " + JSON.stringify(signal));
    lastSent.set(signal.code, now());
    pending.delete(signal.code);
  };
  const schedule = () => {
    if (timer || !pending.size || closed) return;
    const delay = Math.max(0, Math.min(...[...pending.keys()].map((code) =>
      (lastSent.get(code) ?? 0) + intervalMs - now())));
    timer = setTimeout(() => {
      timer = null;
      for (const signal of pending.values()) {
        if (now() - (lastSent.get(signal.code) ?? 0) >= intervalMs) send(signal);
      }
      schedule();
    }, delay);
    timer.unref();
  };
  return {
    report(code: RecorderHealthCode, input: { timestamp?: string; count?: number } = {}) {
      if (closed || !codes.has(code)) return;
      const timestamp = input.timestamp && Number.isFinite(Date.parse(input.timestamp))
        ? new Date(input.timestamp).toISOString() : new Date(now()).toISOString();
      const previous = pending.get(code);
      const count = Number.isSafeInteger(input.count) && Number(input.count) > 0 ? Number(input.count) : 1;
      const signal: RecorderHealthSignal = {
        code, timestamp,
        ...(!stateCodes.has(code) ? { count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + count) } : {}),
      };
      pending.set(code, signal);
      if (!lastSent.has(code) || now() - lastSent.get(code)! >= intervalMs) send(signal);
      schedule();
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const signal of pending.values()) send(signal);
    },
  };
}
