import { KnowledgeError, record } from "./types.js";

export interface KnowledgeLogEvent {
  hop: "ui" | "local-route" | "cloud";
  action: string;
  method?: string;
  path?: string;
  status?: number;
  code?: string | number;
  message?: string;
  kind?: string;
  name?: string;
  bytes?: number;
  bodyBytes?: number;
  ms?: number;
  reason?: string;
  ok?: boolean;
}

const ALLOWED = new Set<keyof KnowledgeLogEvent>([
  "hop",
  "action",
  "method",
  "path",
  "status",
  "code",
  "message",
  "kind",
  "name",
  "bytes",
  "bodyBytes",
  "ms",
  "reason",
  "ok",
]);

/** Local diagnostics only. Never include credentials, URLs with secrets, or file content. */
export function knowledgeLog(
  event: KnowledgeLogEvent,
  level: "info" | "warn" | "error" = "error",
): void {
  const line = ["[knowledge]", sanitizeKnowledgeLog(event)] as const;
  if (level === "info") console.info(...line);
  else if (level === "warn") console.warn(...line);
  else console.error(...line);
}

export function sanitizeKnowledgeLog(
  event: KnowledgeLogEvent,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ALLOWED) {
    const value = event[key];
    if (value === undefined) continue;
    if (key === "path" && typeof value === "string") {
      out.path = safePath(value);
      continue;
    }
    if (key === "message" && typeof value === "string") {
      out.message = value.slice(0, 300);
      continue;
    }
    if (key === "name" && typeof value === "string") {
      out.name = value.slice(0, 250);
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function describeKnowledgeRouteError(error: unknown): {
  status: number;
  message: string;
  kind: string;
} {
  if (error instanceof KnowledgeError)
    return {
      status: error.statusCode,
      message: error.message,
      kind: "knowledge",
    };
  const rec = record(error);
  if (isBodyTooLarge(rec))
    return {
      status: 413,
      message: "本地上传请求体过大",
      kind: "body-too-large",
    };
  return {
    status: Number(rec.statusCode) || 500,
    message: "知识库操作失败，请重试",
    kind: "local",
  };
}

export function isAbortLike(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && /abort/i.test(error.name + error.message))
  );
}

function isBodyTooLarge(error: Record<string, unknown>): boolean {
  return (
    error.code === "FST_ERR_CTP_BODY_TOO_LARGE" ||
    (Number(error.statusCode) === 413 &&
      /too large|body limit/i.test(String(error.message ?? error.code ?? "")))
  );
}

function safePath(path: string): string {
  try {
    if (path.includes("://")) return new URL(path).pathname;
  } catch {
    // Keep the raw path when it is not a URL.
  }
  return path.split("?")[0] ?? path;
}
