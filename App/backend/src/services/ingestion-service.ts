/** Ingestion service module. */
import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ConversationMessage } from "../adapters/outbound/agent-source/types.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { AgentSourceRepository } from "../infrastructure/agent-source-store/index.js";

const INGESTION_TURN_YIELD_INTERVAL = 50;
export const MEMORY_ADD_REQUEST_MAX_BYTES = 2 * 1024 * 1024;

export interface IngestionWarning {
  code: "memory_add_request_too_large";
  sourceId: string;
  conversationId: string;
  turnId: string;
  bodyBytes: number;
  limitBytes: number;
}

/** Contract for ingestion service. */
export interface IngestionService {
  ingest(messages: AsyncIterable<ConversationMessage>, ctx: IngestionContext): Promise<IngestionStats>;
}

/** Contract for ingestion context. */
export interface IngestionContext {
  sourceId: string;
  memorySource?: string;
  signal?: AbortSignal;
  deferProcessing?: boolean;
  totalMessages?: number;
  onProgress?: (progress: IngestionProgress) => void;
}

export interface IngestionProgress {
  sourceId: string;
  current: number;
  total: number;
  message?: string;
}

/** Contract for ingestion stats. */
export interface IngestionStats {
  attempted: number;
  written: number;
  deduped: number;
  failed: number;
  writtenMemories: number;
  dedupedMemories: number;
  failedMemories: number;
  memoryIds: string[];
  conversations: number;
  completedConversationIds: string[];
  incompleteConversationIds: string[];
  failedConversationIds: string[];
  errors: Array<{ conversationId: string; reason: string }>;
}

/** Contract for create ingestion service options. */
export interface CreateIngestionServiceOptions {
  memoryClient: Pick<MemoryClient, "addMemory">;
  agentSourceRepository: Pick<AgentSourceRepository, "hasSeen" | "markSeen">;
  warn?: (warning: IngestionWarning) => void;
}

/** Implementation of ingestion assertion error. */
export class IngestionAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionAssertionError";
  }
}

/** Creates create ingestion service. */
export function createIngestionService(options: CreateIngestionServiceOptions): IngestionService {
  return {
    async ingest(messages, ctx) {
      const stats: IngestionStats = {
        attempted: 0,
        written: 0,
        deduped: 0,
        failed: 0,
        writtenMemories: 0,
        dedupedMemories: 0,
        failedMemories: 0,
        memoryIds: [],
        conversations: 0,
        completedConversationIds: [],
        incompleteConversationIds: [],
        failedConversationIds: [],
        errors: []
      };

      const conversations = groupByConversation(messages, stats)[Symbol.asyncIterator]();
      while (true) {
        if (ctx.signal?.aborted) {
          break;
        }

        const next = await conversations.next();
        if (next.done) {
          break;
        }

        stats.conversations += 1;
        await processConversation(options, next.value, ctx, stats);
      }

      return stats;
    }
  };
}

async function* groupByConversation(
  messages: AsyncIterable<ConversationMessage>,
  stats: IngestionStats
): AsyncIterable<ConversationMessage[]> {
  const completedConversationIds = new Set<string>();
  let currentConversationId: string | null = null;
  let current: ConversationMessage[] = [];

  for await (const message of messages) {
    stats.attempted += 1;

    if (!currentConversationId) {
      currentConversationId = message.conversationId;
    }

    if (message.conversationId !== currentConversationId) {
      completedConversationIds.add(currentConversationId);
      yield current;
      current = [];

      if (completedConversationIds.has(message.conversationId)) {
        throw new IngestionAssertionError("conversationId not contiguous");
      }

      currentConversationId = message.conversationId;
    }

    current.push(message);
  }

  if (current.length > 0) {
    yield current;
  }
}

/** Handles process conversation. */
async function processConversation(
  options: CreateIngestionServiceOptions,
  messages: readonly ConversationMessage[],
  ctx: IngestionContext,
  stats: IngestionStats
): Promise<void> {
  let processedTurns = 0;
  let incomplete = false;
  let failed = false;
  const memorySource = ctx.memorySource ?? ctx.sourceId;

  for (const turn of splitConversationIntoTurns(messages)) {
    processedTurns += 1;
    if (processedTurns % INGESTION_TURN_YIELD_INTERVAL === 0) {
      await yieldToEventLoop();
    }

    if (!isCompleteTurn(turn)) {
      incomplete = true;
      stats.deduped += turn.messages.length;
      emitIngestionProgress(ctx, stats);
      continue;
    }

    const request = {
      requestId: createTurnRequestId(ctx.sourceId, turn),
      adapterId: `agent-source:${ctx.sourceId}`,
      content: renderMessagesToMarkdown(turn.messages),
      layer: "L1",
      title: titleForTurn(memorySource, turn),
      tags: ["agent-source", memorySource],
      source: memorySource,
      turnId: createStableTurnId(ctx.sourceId, turn),
      createdAt: turnCreatedAt(turn),
      ...(ctx.deferProcessing ? { deferProcessing: true } : {})
    } satisfies Parameters<MemoryClient["addMemory"]>[0];
    const bodyBytes = Buffer.byteLength(JSON.stringify(request));
    if (bodyBytes > MEMORY_ADD_REQUEST_MAX_BYTES) {
      stats.deduped += turn.messages.length;
      (options.warn ?? warnToConsole)({
        code: "memory_add_request_too_large",
        sourceId: ctx.sourceId,
        conversationId: turn.conversationId,
        turnId: request.turnId,
        bodyBytes,
        limitBytes: MEMORY_ADD_REQUEST_MAX_BYTES
      });
      emitIngestionProgress(ctx, stats);
      continue;
    }

    const dedupKeys = turn.messages.map((message) => createDedupKey(ctx.sourceId, message.messageId));
    const allSeen = dedupKeys.every((dedupKey) => options.agentSourceRepository.hasSeen(dedupKey));

    try {
      const added = await options.memoryClient.addMemory(request);
      if (allSeen) {
        stats.deduped += turn.messages.length;
        stats.dedupedMemories += 1;
      } else {
        stats.written += turn.messages.length;
        stats.writtenMemories += 1;
      }
      stats.memoryIds.push(added.id);

      for (const dedupKey of dedupKeys) {
        options.agentSourceRepository.markSeen(dedupKey, ctx.sourceId);
      }
      emitIngestionProgress(ctx, stats);
    } catch (error) {
      failed = true;
      stats.failed += turn.messages.length;
      stats.failedMemories += 1;
      stats.errors.push({
        conversationId: turn.conversationId,
        reason: error instanceof Error ? error.message : "ingestion failed"
      });
      emitIngestionProgress(ctx, stats);
    }
  }

  const conversationId = messages[0]?.conversationId;
  if (!conversationId) return;
  if (failed) stats.failedConversationIds.push(conversationId);
  else if (incomplete) stats.incompleteConversationIds.push(conversationId);
  else stats.completedConversationIds.push(conversationId);
}

function emitIngestionProgress(ctx: IngestionContext, stats: IngestionStats): void {
  ctx.onProgress?.({
    sourceId: ctx.sourceId,
    current: stats.written + stats.deduped + stats.failed,
    total: ctx.totalMessages ?? 0
  });
}

/**
 * Renders conversation messages into a markdown summary.
 *
 * @param messages Conversation messages.
 * @returns A markdown string.
 */
function renderMessagesToMarkdown(messages: readonly ConversationMessage[]): string {
  return messages.map((message) => `## ${message.role}\n\n${renderMessageContent(message)}`).join("\n\n");
}

function renderMessageContent(message: ConversationMessage): string {
  if (message.role !== "tool" || /^Tool:\s*/im.test(message.content)) {
    return message.content;
  }

  const toolName = stringMeta(message.rawMeta, "toolName") ?? stringMeta(message.rawMeta, "hermesToolName");
  const callId = stringMeta(message.rawMeta, "toolCallId") ?? stringMeta(message.rawMeta, "hermesToolCallId");
  if (!toolName && !callId) {
    return message.content;
  }

  return [
    toolName ? `Tool: ${toolName}` : undefined,
    callId ? `Call ID: ${callId}` : undefined,
    message.content
  ].filter(Boolean).join("\n\n");
}

function stringMeta(meta: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface ImportedTurn {
  conversationId: string;
  turnIndex: number;
  messages: ConversationMessage[];
}

function splitConversationIntoTurns(messages: readonly ConversationMessage[]): ImportedTurn[] {
  const conversationId = messages[0]?.conversationId ?? "unknown";
  const turns: ImportedTurn[] = [];
  let current: ConversationMessage[] = [];

  for (const message of messages) {
    if (message.role === "user" && current.length > 0) {
      turns.push({ conversationId, turnIndex: turns.length, messages: current });
      current = [];
    }
    current.push(message);
  }

  if (current.length > 0) {
    turns.push({ conversationId, turnIndex: turns.length, messages: current });
  }

  return turns;
}

function turnCreatedAt(turn: ImportedTurn): string {
  return turn.messages[0]?.createdAt ?? new Date(0).toISOString();
}

function isCompleteTurn(turn: ImportedTurn): boolean {
  return (
    turn.messages.some((message) => message.role === "user") &&
    turn.messages.some((message) => message.role === "assistant")
  );
}

/**
 * Creates an ingestion dedup key.
 *
 * @param sourceId Source id.
 * @param messageId Source message id.
 * @returns sha256(sourceId + "::" + messageId).
 */
function createDedupKey(sourceId: string, messageId: string): string {
  return createHash("sha256").update(`${sourceId}::${messageId}`).digest("hex");
}

function createTurnRequestId(sourceId: string, turn: ImportedTurn): string {
  return createHash("sha256")
    .update([
      stableTurnIdentity(sourceId, turn),
      turnCreatedAt(turn),
      renderMessagesToMarkdown(turn.messages)
    ].join("\u0000"))
    .digest("hex");
}

function createStableTurnId(sourceId: string, turn: ImportedTurn): string {
  const hash = createHash("sha256").update(stableTurnIdentity(sourceId, turn)).digest("hex");
  return `${sourceId}:${hash.slice(0, 24)}`;
}

function stableTurnIdentity(sourceId: string, turn: ImportedTurn): string {
  const firstUserMessageId = turn.messages.find((message) => message.role === "user")?.messageId;
  if (!firstUserMessageId) {
    throw new IngestionAssertionError("complete turn is missing its first user message id");
  }
  return `${sourceId}::${turn.conversationId}::${firstUserMessageId}`;
}

function titleForTurn(sourceId: string, turn: ImportedTurn): string {
  const userLine = turn.messages
    .filter((message) => message.role === "user")
    .map((message) => firstReadableLine(message.content))
    .find((line): line is string => Boolean(line));

  return clipTitle(userLine ?? `${sourceId} turn ${turn.conversationId} #${turn.turnIndex + 1}`);
}

function firstReadableLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function clipTitle(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117)}...`;
}

function warnToConsole(warning: IngestionWarning): void {
  console.warn(
    `[agent-source] skipped oversized memory.add request: ${JSON.stringify(warning)}`
  );
}
