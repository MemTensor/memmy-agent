import { stat } from "node:fs/promises";
import { canonicalTurnContent, sourceTurnFromMessages, type SourceTurn } from "@memmy/agent-source-core";
import { streamDeepseekHarnessSession, type RawDeepseekHarnessMessage } from "./session-reader.js";

type Messages = RawDeepseekHarnessMessage[];
interface Snapshot { messages: Messages; turn: SourceTurn | null }

/** Resolve complete snapshots before staging; never mix pieces of different copies. */
export function mergeDeepseekHistorySnapshots(files: readonly Messages[]): Messages {
  const byTurn = new Map<string, Snapshot[]>();
  for (const messages of files) {
    const local = new Map<string, Messages>();
    for (const message of messages) {
      const key = JSON.stringify([message.conversationId, message.rawMeta.sourceTurnId]);
      const rows = local.get(key) ?? [];
      rows.push(message);
      local.set(key, rows);
    }
    for (const [key, rows] of local) {
      const copies = byTurn.get(key) ?? [];
      copies.push({ messages: rows, turn: sourceTurnFromMessages(rows) });
      byTurn.set(key, copies);
    }
  }
  const result: Messages = [];
  for (const copies of byTurn.values()) {
    const complete = copies.filter(copy => copy.turn !== null);
    const chosen = complete[0];
    if (chosen?.turn) {
      const signature = canonicalTurnContent(chosen.turn);
      const conflict = complete.some(copy => canonicalTurnContent(copy.turn!) !== signature)
        || copies.some(copy => !copy.turn && !isPartialCopy(copy.messages, chosen));
      const selected = conflict ? markConflict(chosen.messages) : chosen.messages;
      // A resumed job may contain extra IDs from an earlier partial snapshot.
      // The canonical last message declares this snapshot's complete membership.
      result.push(...selected.map(message => message.rawMeta.sourceTurn ? {
        ...message, rawMeta: { ...message.rawMeta, dshSnapshotMessageIds: selected.map(row => row.messageId) }
      } : message));
    } else {
      // Keep one deterministic pending snapshot, not a synthetic combination.
      const pending = [...copies].sort((a, b) => b.messages.length - a.messages.length
        || JSON.stringify(a.messages).localeCompare(JSON.stringify(b.messages)))[0]!;
      result.push(...pending.messages);
    }
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt)
    || a.conversationId.localeCompare(b.conversationId) || a.ordinal - b.ordinal
    || a.messageId.localeCompare(b.messageId));
}

function isPartialCopy(messages: Messages, complete: Snapshot): boolean {
  return messages.every(message => {
    const state = message.rawMeta.sourceTurnState;
    if (state !== "turn_incomplete" && state !== "turn_content_incomplete") return false;
    // Canonical query/answer are already redacted; staged content is not yet.
    // Compare like-for-like snapshots so redaction cannot create a false conflict.
    if (message.role === "user" || message.role === "assistant") {
      return complete.messages.some(row => row.role === message.role && row.content.startsWith(message.content));
    }
    return complete.messages.some(row => row.role === message.role && row.content === message.content);
  });
}

function markConflict(messages: Messages): Messages {
  return messages.map(message => ({ ...message, rawMeta: {
    ...message.rawMeta, sourceTurn: undefined,
    sourceTurnState: "source_turn_content_conflict", sourceTurnReason: "source_turn_content_conflict"
  } }));
}

/** Bounded, process-local cache. Rotation/rewrites invalidate by stat; no user state is persisted. */
export function createDeepseekHistoryReader() {
  const cache = new Map<string, { signature: string; messages: Messages; bytes: number }>();
  const maxBytes = 16 * 1024 * 1024;
  let bytes = 0;
  return async (file: string, signal?: AbortSignal): Promise<Messages> => {
    signal?.throwIfAborted();
    const before = await stat(file);
    const signature = [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(":");
    const cached = cache.get(file);
    if (cached?.signature === signature) {
      cache.delete(file);
      cache.set(file, cached);
      return cached.messages;
    }
    if (cached) { bytes -= cached.bytes; cache.delete(file); }
    const messages: Messages = [];
    for await (const message of streamDeepseekHarnessSession(file, signal)) messages.push(message);
    signal?.throwIfAborted();
    const after = await stat(file);
    const unchanged = signature === [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(":");
    const size = Buffer.byteLength(JSON.stringify(messages));
    if (unchanged && size <= maxBytes) {
      while (cache.size && (bytes + size > maxBytes || cache.size >= 128)) {
        const key = cache.keys().next().value!;
        bytes -= cache.get(key)!.bytes;
        cache.delete(key);
      }
      cache.set(file, { signature, messages, bytes: size });
      bytes += size;
    }
    return messages;
  };
}
