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

export interface TurnPart extends ImportedTurn {
  parentTurnId: string;
  partIndex: number;
  partCount: number;
  content: string;
  contentHash: string;
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
      if (isCompleteTurn(current)) yield { sourceId: current[0]!.sourceId, conversationId, turnIndex, messages: current };
      current = [];
      conversationId = message.conversationId;
      turnIndex = 0;
    }
    if (message.role === "user" && current.length > 0) {
      if (isCompleteTurn(current)) yield { sourceId: current[0]!.sourceId, conversationId, turnIndex, messages: current };
      turnIndex += 1;
      current = [];
    }
    current.push(message);
  }
  if (isCompleteTurn(current)) yield { sourceId: current[0]!.sourceId, conversationId, turnIndex, messages: current };
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

export function splitTurn(turn: ImportedTurn, maxTokens = 4000, maxBytes = 1024 * 1024): TurnPart[] {
  const chunks: ConversationMessage[][] = [];
  let current: ConversationMessage[] = [];
  const fits = (candidate: readonly ConversationMessage[]) => {
    const content = renderTurn(candidate);
    return estimateTokens(content) <= maxTokens && Buffer.byteLength(content) <= maxBytes;
  };
  for (const message of turn.messages) {
    if (fits([...current, message])) {
      current.push(message);
      continue;
    }
    if (current.length > 0) { chunks.push(current); current = []; }
    const pieces = splitMessage(message, maxTokens, maxBytes);
    if (current.length === 0 && chunks.length > 0) {
      // A user prefix followed by an oversized assistant/tool message should
      // remain one logical part whenever the prefix can share any content.
      const previous = chunks[chunks.length - 1];
      if (previous && !isCompleteTurn(previous)) {
        const combined = combinePrefix(previous, pieces[0]!, maxTokens, maxBytes);
        if (combined) {
          chunks[chunks.length - 1] = combined.messages;
          if (combined.remainder) chunks.push(...splitMessage(combined.remainder, maxTokens, maxBytes).map((piece) => [piece]));
          for (const piece of pieces.slice(1)) chunks.push([piece]);
          continue;
        }
      }
    }
    for (const piece of pieces) chunks.push([piece]);
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) chunks.push([...turn.messages]);
  const parentTurnId = createHash("sha256").update(stableTurnIdentity(turn)).digest("hex").slice(0, 24);
  return chunks.map((messages, partIndex) => {
    const content = renderTurn(messages);
    return {
      ...turn,
      messages,
      parentTurnId,
      partIndex,
      partCount: chunks.length,
      content,
      contentHash: createHash("sha256").update(content).digest("hex")
    };
  });
}

function combinePrefix(
  prefix: readonly ConversationMessage[],
  piece: ConversationMessage,
  maxTokens: number,
  maxBytes: number
): { messages: ConversationMessage[]; remainder?: ConversationMessage } | null {
  const fits = (content: string) => {
    const candidate = [...prefix, { ...piece, content }];
    const rendered = renderTurn(candidate);
    return estimateTokens(rendered) <= maxTokens && Buffer.byteLength(rendered) <= maxBytes;
  };
  if (fits(piece.content)) return { messages: [...prefix, piece] };
  const characters = Array.from(piece.content);
  let low = 0;
  let high = characters.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(characters.slice(0, middle).join(""))) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best === 0) return null;
  const content = characters.slice(0, best).join("");
  const remainder = characters.slice(best).join("");
  return {
    messages: [...prefix, { ...piece, content }],
    ...(remainder ? { remainder: { ...piece, content: remainder } } : {})
  };
}

function splitMessage(message: ConversationMessage, maxTokens: number, maxBytes: number): ConversationMessage[] {
  const emptyRendered = renderTurn([{ ...message, content: "" }]);
  const bodyTokenLimit = Math.max(1, maxTokens - estimateTokens(emptyRendered));
  const bodyByteLimit = Math.max(1, maxBytes - Buffer.byteLength(emptyRendered));
  const fitsContent = (content: string) => {
    const rendered = renderTurn([{ ...message, content }]);
    return estimateTokens(rendered) <= maxTokens && Buffer.byteLength(rendered) <= maxBytes;
  };
  if (fitsContent(message.content)) return [message];
  const pieces: string[] = [];
  for (const paragraph of message.content.split(/\n\s*\n/)) {
    if (!paragraph) continue;
    if (paragraph && estimateTokens(paragraph) <= bodyTokenLimit && Buffer.byteLength(paragraph) <= bodyByteLimit && fitsContent(paragraph)) {
      pieces.push(paragraph);
    } else {
      pieces.push(...splitText(paragraph, bodyTokenLimit, bodyByteLimit));
    }
  }
  return (pieces.length > 0 ? pieces : [""]).map((content) => ({ ...message, content }));
}

function splitText(value: string, maxTokens: number, maxBytes: number): string[] {
  const maxChars = Math.max(1, maxTokens * 4);
  const chunks: string[] = [];
  let current = "";
  for (const line of value.split(/\r?\n/u)) {
    const candidate = current ? `${current}\n${line}` : line;
    if (current && (estimateTokens(candidate) > maxTokens || Buffer.byteLength(candidate) > maxBytes)) {
      chunks.push(...splitUtf8(current, maxBytes));
      current = "";
    }
    if (line.length > maxChars || Buffer.byteLength(line) > maxBytes) {
      if (current) { chunks.push(...splitUtf8(current, maxBytes)); current = ""; }
      let part = "";
      for (const character of line) {
        if (part && (part.length >= maxChars || Buffer.byteLength(part + character) > maxBytes)) {
          chunks.push(part);
          part = "";
        }
        part += character;
      }
      if (part) chunks.push(part);
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(...splitUtf8(current, maxBytes));
  return chunks.length > 0 ? chunks : [""];
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const parts: string[] = [];
  let current = "";
  for (const character of value) {
    const candidate = current + character;
    if (current && Buffer.byteLength(candidate) > maxBytes) {
      parts.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [""];
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
