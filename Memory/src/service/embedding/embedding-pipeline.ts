import type { MemoryRow } from "../../types.js";
import { attachMemoryVector } from "../../storage/memory-vector-state.js";
import type {
  EmbeddingRetryRecord,
  EmbeddingRetryTargetKind,
  EmbeddingRetryVectorField
} from "../../storage/repositories.js";
import {
  policyMetaFromMemory,
  skillMetaFromMemory,
  traceMetaFromMemory,
  worldModelMetaFromMemory
} from "../../algorithm/plugin-algorithms.js";
import { isRecord } from "../../utils/json.js";
import { clip } from "../../utils/text.js";

const EMBEDDING_RETRY_BASE_BACKOFF_MS = 60_000;
const EMBEDDING_RETRY_MAX_BACKOFF_MS = 60 * 60_000;

export interface EmbeddingRetryRunItem {
  id: string;
  status: EmbeddingRetryRecord["status"];
  targetKind: EmbeddingRetryTargetKind;
  targetMemoryId: string;
  vectorField: EmbeddingRetryVectorField;
  attempts: number;
  lastError?: string | null;
}

export function embeddingTextForMemory(memory: MemoryRow): string {
  const trace = traceMetaFromMemory(memory);
  if (trace) {
    return [trace.summary, trace.reflection ?? ""]
      .filter(Boolean)
      .join("\n");
  }
  const policy = policyMetaFromMemory(memory);
  if (policy) {
    return [policy.title, policy.trigger, policy.procedure, policy.verification, policy.boundary]
      .filter(Boolean)
      .join("\n");
  }
  const skill = skillMetaFromMemory(memory);
  if (skill) {
    return [skill.name, skill.invocationGuide].filter(Boolean).join("\n");
  }
  const world = worldModelMetaFromMemory(memory);
  if (world) {
    return [world.title, world.body, world.domainTags.join(" ")].filter(Boolean).join("\n");
  }
  return memory.memoryValue;
}

export function traceSummaryEmbeddingText(memory: MemoryRow): string | undefined {
  const trace = traceMetaFromMemory(memory);
  const summary = firstRealSummary(
    trace?.summary,
    stringFromRecord(memory.info, "summary"),
    stringFromRecord(memory.properties.internal_info, "summary")
  );
  if (!summary) return undefined;
  const originalExchange = trace
    ? clip([trace.userText, trace.agentText].filter(Boolean).join("\n"), 3_000)
    : "";
  return [
    `Summary: ${summary}`,
    ...(originalExchange ? [`Original exchange:\n${originalExchange}`] : [])
  ].join("\n\n");
}

export function embeddingRetryTargetKindForMemory(memory: MemoryRow): EmbeddingRetryTargetKind {
  if (memory.memoryLayer === "L1") return "trace";
  if (memory.memoryLayer === "L2") return "policy";
  if (memory.memoryLayer === "L3") return "world_model";
  return "skill";
}

export function embeddingRetryVectorFieldForMemory(memory: MemoryRow): EmbeddingRetryVectorField {
  return memory.memoryLayer === "L1" ? "vec_summary" : "vec";
}

export function embeddingRetryBackoffMs(attemptNo: number): number {
  return Math.min(
    EMBEDDING_RETRY_MAX_BACKOFF_MS,
    EMBEDDING_RETRY_BASE_BACKOFF_MS * 2 ** Math.max(0, attemptNo - 1)
  );
}

export function embeddingRetryToRunItem(retry: EmbeddingRetryRecord): EmbeddingRetryRunItem {
  return {
    id: retry.id,
    status: retry.status,
    targetKind: retry.targetKind,
    targetMemoryId: retry.targetId,
    vectorField: retry.vectorField,
    attempts: retry.attempts,
    lastError: retry.lastError
  };
}

export function updateMemoryVectorField(
  memory: MemoryRow,
  vectorField: EmbeddingRetryVectorField,
  vector: number[],
  input: { provider: string; model: string; updatedAt: string }
): MemoryRow {
  const internal = memory.properties.internal_info;
  const nextInternal: Record<string, unknown> = { ...internal };
  if (memory.memoryLayer === "L1" && isRecord(internal.trace)) {
    nextInternal.trace = { ...internal.trace };
  } else if (memory.memoryLayer === "L2" && isRecord(internal.policy)) {
    nextInternal.policy = { ...internal.policy };
  } else if (memory.memoryLayer === "L3" && isRecord(internal.world_model)) {
    nextInternal.world_model = { ...internal.world_model };
  } else if (memory.memoryLayer === "Skill" && isRecord(internal.skill)) {
    nextInternal.skill = { ...internal.skill };
  }

  const updated = {
    ...memory,
    properties: {
      ...memory.properties,
      internal_info: { ...memory.properties.internal_info, ...nextInternal }
    },
    updatedAt: input.updatedAt
  };
  return attachMemoryVector(updated, {
    vectorField,
    vector,
    embeddingProvider: input.provider,
    embeddingModel: input.model
  });
}

function firstRealSummary(...values: Array<string | undefined>): string | undefined {
  return values
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value && !isImportSummaryPlaceholder(value)));
}

function isImportSummaryPlaceholder(value: string | undefined): boolean {
  const first = value
    ?.split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim())
    .find(Boolean);
  return Boolean(first && /^(user|assistant|system|tool|developer|摘要排队中|摘要整理中)$/i.test(first));
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
