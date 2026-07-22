export type MemoryLogLevel = "error" | "warn" | "info" | "debug";

export type MemoryLogFields = Record<string, unknown>;

export interface MemoryLogger {
  error(event: string, fields?: MemoryLogFields): void;
  warn(event: string, fields?: MemoryLogFields): void;
  info(event: string, fields?: MemoryLogFields): void;
  debug(event: string, fields?: MemoryLogFields): void;
}

const LEVEL_PRIORITY: Record<MemoryLogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const MAX_STRING_LENGTH = 4_000;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;
const MAX_DEPTH = 4;
const SENSITIVE_KEYS = new Set([
  "apikey",
  "authorization",
  "token",
  "accesstoken",
  "refreshtoken",
  "password",
  "secret",
  "prompt",
  "messages",
  "content",
  "input",
  "output",
  "body",
  "request",
  "response",
  "requestbody",
  "responsebody",
  "rawinput",
  "rawoutput"
]);

/**
 * Creates a structured JSON-lines logger for the Memory process.
 * Packaged desktop builds capture stdout/stderr into memory.log.
 */
export function createMemoryLogger(component: string): MemoryLogger {
  return {
    error: (event, fields) => writeMemoryLog("error", component, event, fields),
    warn: (event, fields) => writeMemoryLog("warn", component, event, fields),
    info: (event, fields) => writeMemoryLog("info", component, event, fields),
    debug: (event, fields) => writeMemoryLog("debug", component, event, fields)
  };
}

/**
 * Converts an unknown thrown value into safe structured fields.
 */
export function memoryErrorFields(error: unknown): MemoryLogFields {
  if (error instanceof Error) {
    return {
      errorType: error.name,
      errorMessage: error.message
    };
  }
  return { errorType: typeof error, errorMessage: String(error) };
}

function writeMemoryLog(
  level: MemoryLogLevel,
  component: string,
  event: string,
  fields: MemoryLogFields = {}
): void {
  if (!shouldLog(level)) return;
  try {
    const sanitized = sanitizeRecord(fields);
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message: formatMessage(component, event, sanitized)
    });
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  } catch {
    // Logging must never interrupt memory capture or worker processing.
  }
}

function shouldLog(level: MemoryLogLevel): boolean {
  const configured = configuredLogLevel();
  return configured !== "silent" && LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[configured];
}

function configuredLogLevel(): MemoryLogLevel | "silent" {
  const raw = process.env.MEMMY_LOG_LEVEL?.trim().toLowerCase();
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") {
    return raw;
  }
  if (process.env.NODE_ENV === "test") return "silent";
  return "info";
}

function sanitizeRecord(fields: MemoryLogFields): MemoryLogFields {
  const value = sanitizeValue(fields, new WeakSet<object>(), 0);
  return isRecord(value) ? value : {};
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number, key?: string): unknown {
  if (key && isSensitiveKey(key)) return "[redacted]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return clip(redactSecrets(value), MAX_STRING_LENGTH);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return undefined;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeValue(memoryErrorFields(value), seen, depth, key);
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return "[max-depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, seen, depth + 1));
  }
  const out: MemoryLogFields = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    const sanitized = sanitizeValue(childValue, seen, depth + 1, childKey);
    if (sanitized !== undefined) out[childKey] = sanitized;
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/([?&](?:key|api_key|access_token)=)[^&\s]+/gi, "$1[redacted]");
}

function formatMessage(component: string, event: string, fields: MemoryLogFields): string {
  const tag = moduleTag(component, fields);
  const message = messageForEvent(component, event, fields);
  return clip(redactSecrets(`[${tag}] ${message}`), MAX_STRING_LENGTH);
}

function moduleTag(component: string, fields: MemoryLogFields): string {
  const operation = textField(fields, "operation");
  if (operation) return safeTag(operation);
  const stage = textField(fields, "stage");
  if (stage) return safeTag(jobTypeTag(stage));
  const jobType = textField(fields, "jobType");
  if (jobType) return safeTag(jobTypeTag(jobType));
  return safeTag(component);
}

function messageForEvent(component: string, event: string, fields: MemoryLogFields): string {
  switch (event) {
    case "request.started":
      return component === "embedding"
        ? `开始生成向量${details(fields, ["provider", "model", "role", "batchSize"])}`
        : `开始调用模型${details(fields, ["provider", "model", "maxTokens", "timeoutMs"])}`;
    case "request.succeeded":
      if (component === "http") {
        return `HTTP 请求成功${details(fields, ["method", "path", "status", "durationMs", "requestId"])}`;
      }
      if (component === "embedding") {
        return `向量生成成功${details(fields, ["provider", "model", "role", "batchSize", "durationMs"])}`;
      }
      return `模型调用成功${details(fields, ["provider", "model", "maxTokens", "finishReason", "outputChars", "durationMs"])}`;
    case "request.retry_scheduled":
      return `模型 HTTP 请求失败，将在 ${valueOr(fields.delayMs, "?")}ms 后重试${details(fields, ["provider", "model", "attempt", "maxAttempts", "errorMessage"])}`;
    case "request.rejected":
      if (component === "http") {
        return `HTTP 请求被拒绝${details(fields, ["method", "path", "status", "errorCode", "errorMessage", "requestId"])}`;
      }
      return `模型调用被拒绝${details(fields, ["provider", "model", "errorMessage"])}`;
    case "request.failed":
      if (component === "http") {
        return `HTTP 请求失败${details(fields, ["method", "path", "status", "durationMs", "errorMessage", "requestId"])}`;
      }
      if (component === "embedding") {
        return `向量生成失败${details(fields, ["provider", "model", "role", "batchSize", "durationMs", "errorMessage"])}`;
      }
      if (component === "model-http") {
        return `模型 HTTP 请求最终失败${details(fields, ["provider", "model", "attempt", "maxAttempts", "errorMessage"])}`;
      }
      return `模型调用失败${details(fields, ["provider", "model", "maxTokens", "durationMs", "errorMessage"])}`;
    case "json.truncated_retry":
      return `模型输出被截断，将 maxTokens 从 ${valueOr(fields.previousMaxTokens, "?")} 提升到 ${valueOr(fields.nextMaxTokens, "?")} 后重试`;
    case "json.malformed_retry":
      return `模型输出不是有效 JSON，将使用 maxTokens=${valueOr(fields.maxTokens, "?")} 重试${details(fields, ["attempt", "retriesRemaining", "errorMessage"])}`;
    case "json.recovered":
      return `模型 JSON 在第 ${valueOr(fields.attempt, "?")} 次尝试后解析成功，maxTokens=${valueOr(fields.maxTokens, "?")}`;
    case "json.failed":
      return `模型 JSON 解析失败${details(fields, ["attempt", "maxTokens", "finishReason", "errorMessage"])}`;
    case "job.started":
      return `任务开始${details(fields, ["jobId", "attempt", "maxAttempts", "sessionId", "episodeId", "targetMemoryId"])}`;
    case "job.succeeded":
      return `任务成功${details(fields, ["jobId", "attempt", "maxAttempts", "targetMemoryId"])}`;
    case "job.failed":
      return `任务失败${details(fields, ["jobId", "attempt", "maxAttempts", "terminal", "targetMemoryId", "errorMessage"])}`;
    case "embedding_retry.succeeded":
      return `向量重试成功${details(fields, ["retryId", "targetMemoryId", "vectorField", "attempt", "maxAttempts"])}`;
    case "embedding_retry.retry_scheduled":
      return `向量生成失败，已安排重试${details(fields, ["retryId", "targetMemoryId", "vectorField", "attempt", "maxAttempts", "nextAttemptAt", "errorMessage"])}`;
    case "embedding_retry.failed":
      return `向量重试最终失败${details(fields, ["retryId", "targetMemoryId", "vectorField", "attempt", "maxAttempts", "errorMessage"])}`;
    case "drain.completed":
      return `Worker 本轮执行完成${details(fields, ["leased", "succeeded", "failed", "embeddingRetriesLeased", "embeddingRetriesSucceeded", "embeddingRetriesFailed"])}`;
    case "drain.failed":
      return `Worker 执行失败${details(fields, ["errorMessage"])}`;
    case "startup.reconciliation_failed":
      return `Worker 启动恢复失败${details(fields, ["errorMessage"])}`;
    case "generation.skipped":
      return `生成被跳过${details(fields, ["reason", "jobId", "policyId", "sourceMemoryId", "evidenceCount", "counterExampleCount", "policyCount", "verdict"])}`;
    case "gate.skipped":
      return `门控未通过${details(fields, ["reason", "jobId", "policyId", "sourceMemoryId", "evidenceCount", "distinctEpisodeCount", "requiredEpisodes", "policyCount", "filteredPolicyCount", "minPolicies", "minPolicyGain", "minPolicySupport", "clusterMinSimilarity"])}`;
    case "fallback.used":
      return `已使用降级策略${details(fields, ["fallback", "pipeline", "reason", "candidateCount", "selectedCount", "feedbackId", "sourceMemoryId", "errorMessage"])}`;
    case "summary.fallback_started":
      return `总结模型失败，切换到进化模型${details(fields, ["sourceMemoryId", "episodeId", "primaryModel", "fallbackModel", "errorMessage"])}`;
    case "summary.fallback_succeeded":
      return `进化模型已完成总结降级${details(fields, ["sourceMemoryId", "episodeId", "primaryModel", "fallbackModel"])}`;
    case "summary.fallback_failed":
      return `总结模型与进化模型均失败${details(fields, ["sourceMemoryId", "episodeId", "primaryModel", "fallbackModel", "primaryErrorMessage", "fallbackErrorMessage"])}`;
    case "batch_window.failed":
      return `批量反思窗口处理失败${details(fields, ["episodeId", "windowStart", "windowEnd", "attempt", "maxAttempts", "errorMessage"])}`;
    case "initialized":
      return `记忆服务初始化完成${configDetails(fields)}`;
    case "config.reloaded":
      return `配置已重新加载${details(fields, ["changed", "requiresRestart", "restartFailedProcessing"])}${configDetails(fields)}`;
    case "service.starting":
      return `记忆服务正在启动${details(fields, ["host", "port", "mode", "storageBackend", "sqlitePath", "configPath"])}`;
    case "service.listening":
      return `记忆服务已启动${details(fields, ["url", "mode", "storageBackend"])}`;
    case "service.fatal":
      return `记忆服务发生致命错误${details(fields, ["errorMessage"])}`;
    case "config.endpoint_write_failed":
      return `写入当前服务地址失败${details(fields, ["configPath", "endpoint", "errorMessage"])}`;
    default:
      return `${event}${details(fields, Object.keys(fields).filter((key) => key !== "operation" && key !== "stage" && key !== "jobType"))}`;
  }
}

function configDetails(fields: MemoryLogFields): string {
  const parts = [
    pair("activeProfile", fields.activeProfile),
    pair("memoryAddEnabled", fields.memoryAddEnabled),
    pair("memorySearchEnabled", fields.memorySearchEnabled),
    compactObject("summaryModel", fields.summaryModel),
    compactObject("evolutionModel", fields.evolutionModel),
    compactObject("embeddingModel", fields.embeddingModel),
    compactObject("evolutionGates", fields.evolutionGates)
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? `，${parts.join("，")}` : "";
}

function details(fields: MemoryLogFields, keys: string[]): string {
  const parts = keys
    .map((key) => pair(key, fields[key]))
    .filter((value): value is string => Boolean(value));
  return parts.length > 0 ? `，${parts.join("，")}` : "";
}

function pair(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return `${key}=${compactValue(value)}`;
}

function compactObject(name: string, value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const pairs = Object.entries(value)
    .map(([key, child]) => pair(key, child))
    .filter((item): item is string => Boolean(item));
  return pairs.length > 0 ? `${name}(${pairs.join(",")})` : undefined;
}

function compactValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(compactValue).join("|");
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, child]) => `${key}:${compactValue(child)}`)
      .join("|");
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function valueOr(value: unknown, fallback: string): string {
  return value === undefined || value === null || value === "" ? fallback : compactValue(value);
}

function textField(fields: MemoryLogFields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeTag(value: string): string {
  return value.replace(/[\[\]\r\n]/g, "-").trim() || "memory";
}

function jobTypeTag(value: string): string {
  const tags: Record<string, string> = {
    skill_crystallization: "skill.crystallize",
    l3_abstraction: "l3.abstraction",
    l2_induction: "l2.induction",
    trace_summary: "memory.summary",
    import_summary: "memory.import_summary",
    episode_idle_close: "episode.close",
    skill_trial_resolve: "skill.trial_resolve",
    l2_association: "l2.association"
  };
  return tags[value] ?? value.replace(/_/g, ".");
}

function clip(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...[truncated]`;
}

function isRecord(value: unknown): value is MemoryLogFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
