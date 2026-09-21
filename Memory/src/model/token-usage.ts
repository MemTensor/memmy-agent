import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isBudgetedMemoryUsage } from "@memmy/agent-source-core";
import type { ActualModelContext } from "../contracts/index.js";
import { createMemoryLogger, memoryErrorFields } from "../logging/logger.js";

export type MemoryLlmModelRole = "memory_summary" | "memory_evolution";
export type MemoryTokenUsageKind = MemoryLlmModelRole | "embedding";

export interface MemoryModelUsageEvent {
  kind: MemoryTokenUsageKind;
  operation: string;
  provider: string;
  model?: string;
  endpoint?: string;
  actualModelContext?: ActualModelContext;
  usage: ModelTokenUsage;
  metadata?: Record<string, unknown>;
}

export interface ModelTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  rawUsage: Record<string, unknown>;
}

export interface RuntimeConfig {
  baseUrl: string;
  localToken: string;
}

export type MemoryTokenUsageRecordStatus = "skipped" | "recorded" | "persist_failed";

export interface MemoryTokenUsageSink {
  record(event: MemoryModelUsageEvent): MemoryTokenUsageRecordStatus;
}

export interface TokenUsageOutboxRecord {
  eventId: string;
  payloadJson: string;
}

export interface TokenUsageOutboxStore {
  enqueue(eventId: string, payloadJson: string): void;
  listNext(limit: number): TokenUsageOutboxRecord[];
  deleteByEventId(eventId: string): void;
  hasPending(): boolean;
}

export interface HttpByokTokenUsageRecorderOptions {
  runtimeConfig?: RuntimeConfig | null;
  runtimeConfigPath?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  onBudgetedUsage?: (event: MemoryModelUsageEvent) => void;
  outbox?: TokenUsageOutboxStore;
  transaction?: <T>(fn: () => T) => T;
  now?: () => Date;
  retryDelaysMs?: number[];
  continueDelayMs?: number;
  batchSize?: number;
  touchBudget?: () => void;
  onPersistRecovered?: () => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DELIVER_BATCH_SIZE = 32;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const PERSIST_PROBE_EVENT_ID = "token_usage_persist_probe";
const EVENT_PATH = "/api/app/byok-token-usage/events";
const MEMORY_PIPELINE_USAGE_PATH = "/api/app/byok-token-usage/memory-pipeline-usage";
const RUNTIME_TOKEN_HEADER = "x-memmy-local-token";
const logger = createMemoryLogger("token-usage");

export function resolveDefaultRuntimeConfigPath(): string {
  return join(homedir(), ".memmy", "runtime.json");
}

export function extractModelTokenUsage(response: unknown): ModelTokenUsage {
  const root = asRecord(response);
  const usage = firstRecord(root.usage, root.usageMetadata, root.usage_metadata);
  const promptDetails = firstRecord(
    usage.prompt_tokens_details,
    usage.promptTokensDetails,
    usage.input_tokens_details,
    usage.inputTokensDetails,
    usage.input_token_details,
    usage.inputTokenDetails
  );
  const inputTokens = nonNegativeInteger(
    firstNumber(
      usage.input_tokens,
      usage.inputTokens,
      usage.prompt_tokens,
      usage.promptTokens,
      usage.promptTokenCount,
      usage.inputTokenCount
    )
  );
  const outputTokens = nonNegativeInteger(
    firstNumber(
      usage.output_tokens,
      usage.outputTokens,
      usage.completion_tokens,
      usage.completionTokens,
      usage.candidatesTokenCount,
      usage.outputTokenCount
    )
  );
  const cachedInputTokens = nonNegativeInteger(
    firstNumber(
      usage.cache_read_input_tokens,
      usage.cacheReadInputTokens,
      usage.cached_input_tokens,
      usage.cachedInputTokens,
      usage.cachedContentTokenCount,
      promptDetails.cached_tokens,
      promptDetails.cachedTokens,
      promptDetails.cache_read_input_tokens,
      promptDetails.cacheReadInputTokens
    )
  );
  const cacheCreationInputTokens = nonNegativeInteger(
    firstNumber(
      usage.cache_creation_input_tokens,
      usage.cacheCreationInputTokens,
      usage.cache_write_input_tokens,
      usage.cacheWriteInputTokens,
      promptDetails.cache_creation_input_tokens,
      promptDetails.cacheCreationInputTokens,
      promptDetails.cache_write_input_tokens,
      promptDetails.cacheWriteInputTokens
    )
  );
  const totalTokens = nonNegativeInteger(
    firstNumber(
      usage.total_tokens,
      usage.totalTokens,
      usage.totalTokenCount,
      inputTokens + outputTokens
    )
  );

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    totalTokens,
    rawUsage: usage
  };
}

export class HttpByokTokenUsageRecorder implements MemoryTokenUsageSink {
  private readonly runtimeConfig: RuntimeConfig | null | undefined;
  private readonly runtimeConfigPath: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onBudgetedUsage?: (event: MemoryModelUsageEvent) => void;
  private readonly outbox?: TokenUsageOutboxStore;
  private readonly transaction?: <T>(fn: () => T) => T;
  private readonly now: () => Date;
  private readonly retryDelaysMs: number[];
  private readonly continueDelayMs: number;
  private readonly batchSize: number;
  private readonly touchBudget?: () => void;
  private readonly onPersistRecovered?: () => void;
  private started = false;
  private stopped = false;
  private sending = false;
  private requested = false;
  private failureCount = 0;
  private persistProbeFailureCount = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private persistProbeTimer?: ReturnType<typeof setTimeout>;
  private activeAbort?: AbortController;
  private persistUnreliable = false;

  constructor(options: HttpByokTokenUsageRecorderOptions = {}) {
    const env = options.env ?? process.env;
    this.runtimeConfig = options.runtimeConfig;
    this.runtimeConfigPath = options.runtimeConfigPath ?? env.MEMMY_RUNTIME_CONFIG_PATH ?? resolveDefaultRuntimeConfigPath();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.onBudgetedUsage = options.onBudgetedUsage;
    this.outbox = options.outbox;
    this.transaction = options.transaction;
    this.now = options.now ?? (() => new Date());
    this.retryDelaysMs = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
    this.continueDelayMs = Math.max(0, options.continueDelayMs ?? 0);
    this.batchSize = Math.max(1, options.batchSize ?? DELIVER_BATCH_SIZE);
    this.touchBudget = options.touchBudget;
    this.onPersistRecovered = options.onPersistRecovered;
  }

  record(event: MemoryModelUsageEvent): MemoryTokenUsageRecordStatus {
    const context = event.actualModelContext;
    if (!context || context.source !== "byok" || context.capability !== event.kind || isEmptyUsage(event.usage)) {
      return "skipped";
    }

    const payload = toByokTokenUsageEvent(event, this.now());
    if (this.outbox && this.transaction) {
      try {
        this.transaction(() => {
          this.outbox!.enqueue(String(payload.id), JSON.stringify(payload));
          this.onBudgetedUsage?.(event);
        });
      } catch (error) {
        this.persistUnreliable = true;
        logger.error("token_usage.persist_failed", {
          eventId: payload.id,
          ...memoryErrorFields(error)
        });
        this.schedulePersistProbe();
        return "persist_failed";
      }
      if (didWriteMemoryBudget(event)) {
        this.clearPersistUnreliable();
      }
      this.wake();
      return "recorded";
    }

    this.onBudgetedUsage?.(event);
    const runtime = this.resolveRuntime();
    if (!runtime) {
      return "recorded";
    }
    void this.postEvent(runtime, JSON.stringify(payload)).catch(() => undefined);
    return "recorded";
  }

  isPersistUnreliable(): boolean {
    return this.persistUnreliable;
  }

  start(): void {
    if (this.stopped || this.started) {
      return;
    }
    this.started = true;
    this.wake();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.requested = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (this.persistProbeTimer) {
      clearTimeout(this.persistProbeTimer);
      this.persistProbeTimer = undefined;
    }
    this.activeAbort?.abort();
    this.activeAbort = undefined;
  }

  private wake(): void {
    if (this.stopped || !this.started || !this.outbox) {
      return;
    }
    if (this.sending) {
      this.requested = true;
      return;
    }
    if (this.retryTimer) {
      return;
    }
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.sending || !this.outbox) {
      return;
    }
    this.sending = true;
    try {
      try {
        const batch = this.outbox.listNext(this.batchSize);
        if (batch.length === 0) {
          this.failureCount = 0;
          return;
        }
        for (const item of batch) {
          if (this.stopped) {
            return;
          }
          const delivered = await this.deliver(item);
          if (this.stopped) {
            return;
          }
          if (!delivered) {
            this.scheduleRetry();
            return;
          }
          try {
            this.outbox.deleteByEventId(item.eventId);
          } catch (error) {
            logger.error("token_usage.delete_failed", {
              eventId: item.eventId,
              ...memoryErrorFields(error)
            });
            this.scheduleRetry();
            return;
          }
          this.failureCount = 0;
        }
        if (this.outbox.hasPending()) {
          this.scheduleContinue();
        }
      } catch (error) {
        if (this.stopped) {
          return;
        }
        logger.error("token_usage.flush_failed", {
          ...memoryErrorFields(error),
          retryMs: this.nextRetryDelayMs()
        });
        this.scheduleRetry();
      }
    } finally {
      this.sending = false;
      if (this.requested && !this.stopped && !this.retryTimer) {
        this.requested = false;
        void this.flush();
      }
    }
  }

  private async deliver(item: TokenUsageOutboxRecord): Promise<boolean> {
    const runtime = this.resolveRuntime();
    if (!runtime) {
      logger.warn("token_usage.deliver_failed", {
        eventId: item.eventId,
        errorClass: "runtime_unavailable",
        retryMs: this.nextRetryDelayMs()
      });
      return false;
    }
    const controller = new AbortController();
    this.activeAbort = controller;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(EVENT_PATH, runtime.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [RUNTIME_TOKEN_HEADER]: runtime.localToken
        },
        body: item.payloadJson,
        signal: controller.signal
      });
      if (this.stopped) {
        return false;
      }
      const text = await response.text();
      if (this.stopped) {
        return false;
      }
      if (!response.ok) {
        logger.warn("token_usage.deliver_failed", {
          eventId: item.eventId,
          status: response.status,
          errorClass: "http_error",
          retryMs: this.nextRetryDelayMs()
        });
        return false;
      }
      if (!hasOkConfirmation(text)) {
        logger.warn("token_usage.deliver_failed", {
          eventId: item.eventId,
          status: response.status,
          errorClass: "invalid_ack",
          retryMs: this.nextRetryDelayMs()
        });
        return false;
      }
      return true;
    } catch (error) {
      if (this.stopped) {
        return false;
      }
      logger.warn("token_usage.deliver_failed", {
        eventId: item.eventId,
        errorClass: errorName(error),
        retryMs: this.nextRetryDelayMs()
      });
      return false;
    } finally {
      clearTimeout(timeout);
      if (this.activeAbort === controller) {
        this.activeAbort = undefined;
      }
    }
  }

  private async postEvent(runtime: RuntimeConfig, payloadJson: string): Promise<void> {
    const response = await this.fetchImpl(new URL(EVENT_PATH, runtime.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [RUNTIME_TOKEN_HEADER]: runtime.localToken
      },
      body: payloadJson,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      throw new Error(`BYOK token usage upload failed: ${response.status} ${response.statusText}`);
    }
  }

  private resolveRuntime(): RuntimeConfig | null {
    if (this.runtimeConfig !== undefined) {
      return this.runtimeConfig;
    }
    return readRuntimeConfig(this.runtimeConfigPath);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    const delayMs = this.nextRetryDelayMs();
    this.failureCount += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, delayMs);
  }

  private scheduleContinue(): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.flush();
    }, this.continueDelayMs);
  }

  private nextRetryDelayMs(): number {
    return this.delayForFailureCount(this.failureCount);
  }

  private schedulePersistProbe(): void {
    if (this.stopped || this.persistProbeTimer || !this.outbox || !this.transaction || !this.touchBudget) {
      return;
    }
    const delayMs = this.delayForFailureCount(this.persistProbeFailureCount);
    this.persistProbeFailureCount += 1;
    this.persistProbeTimer = setTimeout(() => {
      this.persistProbeTimer = undefined;
      this.runPersistProbe();
    }, delayMs);
  }

  private runPersistProbe(): void {
    if (this.stopped || !this.persistUnreliable || !this.outbox || !this.transaction || !this.touchBudget) {
      return;
    }
    try {
      this.transaction(() => {
        this.outbox!.enqueue(PERSIST_PROBE_EVENT_ID, `{"id":"${PERSIST_PROBE_EVENT_ID}"}`);
        this.outbox!.deleteByEventId(PERSIST_PROBE_EVENT_ID);
        this.touchBudget!();
      });
    } catch (error) {
      if (this.stopped) {
        return;
      }
      logger.error("token_usage.persist_probe_failed", {
        ...memoryErrorFields(error),
        retryMs: this.delayForFailureCount(this.persistProbeFailureCount)
      });
      this.schedulePersistProbe();
      return;
    }
    this.clearPersistUnreliable();
  }

  private clearPersistUnreliable(): void {
    const wasUnreliable = this.persistUnreliable;
    this.persistUnreliable = false;
    this.persistProbeFailureCount = 0;
    if (this.persistProbeTimer) {
      clearTimeout(this.persistProbeTimer);
      this.persistProbeTimer = undefined;
    }
    if (wasUnreliable) {
      this.onPersistRecovered?.();
    }
  }

  private delayForFailureCount(failureCount: number): number {
    const last = this.retryDelaysMs[this.retryDelaysMs.length - 1] ?? 30_000;
    return this.retryDelaysMs[Math.min(failureCount, this.retryDelaysMs.length - 1)] ?? last;
  }
}

function toByokTokenUsageEvent(event: MemoryModelUsageEvent, createdAt: Date = new Date()): Record<string, unknown> {
  const id = `byok_usage_${randomUUID()}`;
  return {
    id,
    kind: event.kind,
    source: "memory",
    operationId: `${event.operation}:${id}`,
    presetId: event.actualModelContext!.presetId,
    provider: event.actualModelContext!.provider,
    model: event.actualModelContext!.model,
    capability: event.actualModelContext!.capability,
    inputTokens: event.usage.inputTokens,
    outputTokens: event.usage.outputTokens,
    totalTokens: event.usage.totalTokens,
    cachedInputTokens: event.usage.cachedInputTokens,
    cacheCreationInputTokens: event.usage.cacheCreationInputTokens,
    metadata: {
      operation: event.operation,
      model: event.actualModelContext!.model,
      ...event.metadata,
      provider: event.actualModelContext!.provider
    },
    rawUsage: event.usage.rawUsage,
    createdAt: createdAt.toISOString()
  };
}

function hasOkConfirmation(text: string): boolean {
  if (!text.trim()) {
    return false;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) && parsed.ok === true;
  } catch {
    return false;
  }
}

function errorName(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "error";
}

export async function fetchAppMemoryBudget(
  options: HttpByokTokenUsageRecorderOptions = {}
): Promise<{ dailyUsed: number; lifetimeUsed: number } | null> {
  const env = options.env ?? process.env;
  const runtime = options.runtimeConfig
    ?? readRuntimeConfig(options.runtimeConfigPath ?? env.MEMMY_RUNTIME_CONFIG_PATH ?? resolveDefaultRuntimeConfigPath());
  if (!runtime) {
    return null;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const response = await fetchImpl(new URL(MEMORY_PIPELINE_USAGE_PATH, runtime.baseUrl), {
      method: "GET",
      headers: {
        [RUNTIME_TOKEN_HEADER]: runtime.localToken
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      return null;
    }
    const payload = asRecord(await response.json());
    if (!Number.isFinite(Number(payload.dailyUsed)) || !Number.isFinite(Number(payload.lifetimeUsed))) {
      return null;
    }
    return {
      dailyUsed: Math.max(0, Math.trunc(Number(payload.dailyUsed))),
      lifetimeUsed: Math.max(0, Math.trunc(Number(payload.lifetimeUsed)))
    };
  } catch {
    return null;
  }
}

function readRuntimeConfig(filePath: string): RuntimeConfig | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const baseUrl = optionalString(parsed.baseUrl);
    const localToken = optionalString(parsed.localToken);
    if (!baseUrl || !localToken) {
      return null;
    }

    return { baseUrl, localToken };
  } catch {
    return null;
  }
}

function didWriteMemoryBudget(event: MemoryModelUsageEvent): boolean {
  return isBudgetedMemoryUsage(event) && Math.max(0, Math.trunc(event.usage.totalTokens)) > 0;
}

function isEmptyUsage(usage: ModelTokenUsage): boolean {
  return usage.inputTokens + usage.outputTokens + usage.totalTokens + usage.cachedInputTokens + usage.cacheCreationInputTokens === 0;
}

function firstRecord(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    if (isRecord(value)) {
      return value;
    }
  }
  return {};
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function nonNegativeInteger(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
