export * from "./codex-source-turn.js";
export * from "./secret-redactor.js";
export * from "./jsonl-lines.js";
import { createHash } from "node:crypto";

export interface ConversationMessage {
  messageId: string;
  sourceId: string;
  conversationId: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  createdAt: string;
  workspacePath: string | null;
  gitRoot: string | null;
  rawMeta: Readonly<Record<string, unknown>>;
  ordinal?: number;
}

export interface SourceDescriptor {
  sourceId: string;
  displayName: string;
  builtin: boolean;
  dataPath: string;
}

export interface ScanProgress {
  sourceId: string;
  phase: "discover" | "read" | "redact" | "emit" | "scan" | "prepare" | "add" | "summarize" | "done" | "stopped";
  current: number;
  total: number;
  message?: string;
}

export interface ScanOptions {
  since?: string;
  maxMessages?: number;
  maxScanTargets?: number;
  order?: "source_default" | "recent_first";
  signal?: AbortSignal;
  /** Production scanners set this to bypass legacy whole-window buffering. */
  fullHistory?: boolean;
  onProgress?: (progress: ScanProgress) => void;
}

export interface SourceAdapter {
  readonly descriptor: SourceDescriptor;
  detect(): Promise<boolean>;
  scan(options: ScanOptions): AsyncIterable<ConversationMessage>;
}

export interface ScanStore {
  stage(message: ConversationMessage): boolean;
  stageBatch(messages: readonly ConversationMessage[]): number;
  messages(sourceId: string, cursor?: MessageCursor, limit?: number): Iterable<ConversationMessage>;
  saveScanCursor(sourceId: string, cursor: MessageCursor): void;
  getScanCursor(sourceId: string): MessageCursor | null;
  saveSourceState(state: ScanSourceState): void;
  getSourceState(sourceId: string): ScanSourceState | null;
  sourceCount(): number;
  count(sourceId?: string): number;
  saveCheckpoint(checkpoint: ConversationCheckpoint): void;
  getCheckpoint(sourceId: string, conversationId: string): ConversationCheckpoint | null;
  saveConversationMeta(meta: PreparedConversation): void;
  getConversationMeta(sourceId: string, conversationId: string): PreparedConversation | null;
  selectAllConversations(sourceId: string): void;
  saveTurnMeta(meta: PreparedTurn): void;
  getTurnMeta(sourceId: string, conversationId: string, turnId: string): PreparedTurn | null;
  selectInitialTurns(sourceIds: readonly string[], globalLimit: number, absentSourceLimit: number): void;
  saveResult(result: ScanStoredResult): void;
  resultCount(sourceId?: string): number;
  results(sourceId?: string, cursor?: string, limit?: number): Iterable<ScanStoredResult>;
  close(): void;
  remove(): void;
}

export interface PreparedTurn {
  sourceId: string;
  conversationId: string;
  turnId: string;
  firstMessageId: string;
  firstCreatedAt: string;
  lastMessageId: string;
  lastCreatedAt: string;
  selected: boolean;
}

export interface PreparedConversation {
  sourceId: string;
  conversationId: string;
  lastMessageId: string;
  lastCreatedAt: string;
  contentHash: string;
  selected: boolean;
}

export interface MessageCursor {
  conversationId: string;
  createdAt: string;
  messageId: string;
  ordinal: number;
}

export interface ConversationCheckpoint {
  sourceId: string;
  conversationId: string;
  lastMessageId: string;
  lastCreatedAt: string;
  contentHash: string;
  updatedAt: string;
}

export interface ScanStoredResult {
  sourceId: string;
  conversationId: string;
  memoryId?: string;
  error?: string;
  /** Opaque keyset cursor populated when a result is read from a store. */
  cursor?: string;
}

export type ScanStage = "stage" | "prepare" | "ingest" | "summarize" | "done" | "failed" | "paused" | "canceled";

export interface ScanSourceState {
  sourceId: string;
  mode: string;
  phase: ScanStage;
  messageCount: number;
  resultCount: number;
  errorCount: number;
  scanStartedAt?: string;
  watermarkedSince?: string;
  updatedAt: string;
  error?: string;
}

export interface ImportedTurn {
  sourceId: string;
  conversationId: string;
  turnIndex: number;
  messages: ConversationMessage[];
}

export function compareMessageOrder(left: ConversationMessage, right: ConversationMessage): number {
  return left.conversationId.localeCompare(right.conversationId)
    || Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.messageId.localeCompare(right.messageId)
    || (left.ordinal ?? 0) - (right.ordinal ?? 0);
}

export function compareCursor(left: ConversationMessage, right: MessageCursor): number {
  return left.conversationId.localeCompare(right.conversationId)
    || Date.parse(left.createdAt) - Date.parse(right.createdAt)
    || left.messageId.localeCompare(right.messageId)
    || (left.ordinal ?? 0) - right.ordinal;
}

export async function* orderedTurns(messages: AsyncIterable<ConversationMessage>): AsyncIterable<ImportedTurn> {
  let current: ConversationMessage[] = [];
  let conversationId = "";
  let turnIndex = 0;
  for await (const message of messages) {
    if (message.conversationId !== conversationId) {
      if (shouldEmitTurn(current)) yield { sourceId: current[0]!.sourceId, conversationId, turnIndex, messages: current };
      current = [];
      conversationId = message.conversationId;
      turnIndex = 0;
    }
    if (current.length > 0 && beginsNextTurn(current, message)) {
      if (shouldEmitTurn(current)) yield { sourceId: current[0]!.sourceId, conversationId, turnIndex, messages: current };
      turnIndex += 1;
      current = [];
    }
    current.push(message);
  }
  if (shouldEmitTurn(current)) yield { sourceId: current[0]!.sourceId, conversationId, turnIndex, messages: current };
}

function shouldEmitTurn(messages: readonly ConversationMessage[]): boolean {
  return messages.length > 0 && (messages[0]!.sourceId === "codex" || isCompleteTurn(messages));
}

function beginsNextTurn(current: readonly ConversationMessage[], next: ConversationMessage): boolean {
  if (next.sourceId === "codex") {
    const currentId = current[0]!.rawMeta.sourceTurnId;
    const nextId = next.rawMeta.sourceTurnId;
    if (currentId || nextId) return currentId !== nextId;
  }
  return next.role === "user";
}

export function isCompleteTurn(messages: readonly ConversationMessage[]): boolean {
  const first = messages[0];
  const last = messages[messages.length - 1];
  return first?.role === "user" && Boolean(first.content.trim())
    && last?.role === "assistant" && Boolean(last.content.trim());
}

export function renderMessageContent(message: ConversationMessage): string {
  if (message.role !== "tool" || /^Tool:\s*/im.test(message.content)) return message.content;
  const toolName = stringMeta(message.rawMeta, "toolName") ?? stringMeta(message.rawMeta, "hermesToolName");
  const callId = stringMeta(message.rawMeta, "toolCallId") ?? stringMeta(message.rawMeta, "hermesToolCallId");
  return [toolName ? `Tool: ${toolName}` : undefined, callId ? `Call ID: ${callId}` : undefined, message.content]
    .filter(Boolean).join("\n\n");
}

export function renderTurn(messages: readonly ConversationMessage[]): string {
  return messages.map((message) => `## ${message.role}\n\n${renderMessageContent(message)}`).join("\n\n");
}

export function conversationContentHash(messages: Iterable<ConversationMessage>): string {
  const hash = createHash("sha256");
  hash.update("[");
  let first = true;
  for (const message of messages) {
    if (!first) hash.update(",");
    first = false;
    hash.update(JSON.stringify({
      messageId: message.messageId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      toolName: hashMetaString(message.rawMeta, "toolName") ?? hashMetaString(message.rawMeta, "hermesToolName"),
      toolCallId: hashMetaString(message.rawMeta, "toolCallId") ?? hashMetaString(message.rawMeta, "hermesToolCallId")
    }));
  }
  hash.update("]");
  return hash.digest("hex");
}

export function stableTurnIdentity(turn: ImportedTurn): string {
  const nativeId = turn.messages[0]?.rawMeta.sourceTurnId;
  if (turn.sourceId === "codex") {
    return `${turn.sourceId}::${turn.conversationId}::${typeof nativeId === "string" ? nativeId : turn.messages[0]?.messageId ?? "unresolved"}`;
  }
  const firstUser = turn.messages.find((message) => message.role === "user");
  if (!firstUser) throw new Error("turn is missing user message");
  return `${turn.sourceId}::${turn.conversationId}::${firstUser.messageId}`;
}

/** Preserves the pre-staging idempotency key for an unsplit turn. */
export function legacyTurnRequestId(turn: ImportedTurn): string {
  const first = turn.messages[0];
  if (!first) throw new Error("turn is empty");
  return createHash("sha256").update([stableTurnIdentity(turn), first.createdAt, renderTurn(turn.messages)].join("\u0000")).digest("hex");
}

/** Preserves the pre-staging stable turn id for an unsplit turn. */
export function legacyTurnId(turn: ImportedTurn): string {
  return `${turn.sourceId}:${createHash("sha256").update(stableTurnIdentity(turn)).digest("hex").slice(0, 24)}`;
}

/** Leaves ample room for JSON escaping and the add-memory envelope. */
export const TURN_CONTENT_MAX_BYTES = 512 * 1024;

/**
 * Renders a whole turn as one memory body. Agent-source scans deliberately keep
 * one turn == one memory: splitting an agentic turn fans a single exchange out
 * into hundreds of near-empty tool-call fragments. Oversized turns are clipped
 * on a UTF-8 boundary instead so the add-memory request stays under the wire
 * limit without inventing extra memories.
 */
export function renderTurnClipped(messages: readonly ConversationMessage[], maxBytes = TURN_CONTENT_MAX_BYTES): string {
  const content = renderTurn(messages);
  const bytes = Buffer.byteLength(content);
  if (bytes <= maxBytes) return content;
  const marker = `\n\n[... truncated ${bytes - maxBytes} bytes of tool output ...]`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  return `${clipUtf8(content, budget)}${marker}`;
}

function clipUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    bytes += characterBytes;
    end += character.length;
  }
  return value.slice(0, end);
}

export function estimateTokens(value: string): number { return Math.ceil(value.length / 4); }

function stringMeta(meta: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hashMetaString(meta: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" ? value : undefined;
}
