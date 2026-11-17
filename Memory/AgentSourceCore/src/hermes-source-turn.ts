import {
  compact,
  isRecord,
  pairSourceToolCalls,
  redactCall,
  redactResult,
  renderTool,
  selectSourceTurn,
  stageSourceTurnMessages,
  text,
  type RawSourceMessage,
  type SourceToolCall,
  type SourceToolResult,
  type SourceTurn
} from "./source-turn.js";
import { redactSecrets } from "./secret-redactor.js";

export const HERMES_SOURCE_ID = "hermes";

/**
 * Row access to a Hermes `state.db`. The plugin and the scan run on different SQLite
 * drivers, so the queries are injected and only the turn logic below is shared.
 */
export interface HermesSource {
  /** Rows from `sessions`. */
  sessions(): Iterable<{ id: string; cwd: string | null }>;
  /**
   * Every `messages` row of one session ordered by `id`, including `active = 0`.
   * Compaction archives the originals and replays copies, and a compacted turn can lose
   * its replayed user row, so an active-only view would silently drop whole turns.
   */
  messages(sessionId: string): Iterable<HermesRow>;
}

export interface HermesRow {
  id: number;
  role: string;
  content: string | null;
  toolCallId: string | null;
  toolCalls: string | null;
  toolName: string | null;
  timestamp: number | null;
  finishReason: string | null;
  compressedSummary: number | null;
  active: number | null;
  compacted: number | null;
}

/** The prefix Hermes puts on the hand-off summary it writes for the model, not for a person. */
const COMPRESSED_SUMMARY_PREFIX = "[PRIOR CONTEXT";

interface HermesTurn {
  turnId: number;
  rows: HermesRow[];
}

/**
 * Streams one Hermes session as staged native turns. Hermes has no turn column, so a turn
 * is identified by the earliest row of the user message that opened it: compaction copies
 * a user row under a new id, and both copies must resolve to the same turn.
 */
export async function* readHermesSession(
  source: HermesSource,
  session: { id: string; cwd: string | null },
  signal?: AbortSignal
): AsyncIterable<RawSourceMessage> {
  const rows = [...source.messages(session.id)];
  // Compaction replays whole stretches of the conversation under new ids. Only the earliest
  // copy of each row takes part in the turn split; otherwise a replayed assistant row would
  // be attributed to whichever user message happened to precede it.
  const originals = rows.filter((row) => firstCopyId(rows, row) === row.id && !isCompressedSummary(row));
  const turns: HermesTurn[] = [];
  let current: HermesTurn | undefined;

  for (const row of originals) {
    signal?.throwIfAborted();
    if (row.role === "user") {
      current = { turnId: row.id, rows: [] };
      turns.push(current);
    }
    if (!current) continue;
    current.rows.push(row);
  }

  for (const turn of turns) {
    signal?.throwIfAborted();
    // `/undo` leaves the retracted rows inactive with no replayed copy. That turn was taken
    // back by the user, so it never becomes a memory.
    if (isRetracted(rows, turn.rows[0]!)) continue;
    yield* stageTurn(session, turn, turn.rows);
  }
}

/** Streams every session of a Hermes database as staged native turns. */
export async function* readHermesSessions(source: HermesSource, signal?: AbortSignal): AsyncIterable<RawSourceMessage> {
  for (const session of source.sessions()) {
    signal?.throwIfAborted();
    yield* readHermesSession(source, session, signal);
  }
}

/**
 * Plugin path: reads the same rows the scan reads. `sync_turn` only knows the session and
 * the user's text, so the turn is located by that text and then reported under the durable
 * `{session}:{row}` identity.
 */
export async function readHermesSourceTurn(
  source: HermesSource,
  expected: { conversationId: string; userContent?: string; turnId?: string }
): Promise<{ turn: SourceTurn | null; reason?: string }> {
  const session = [...source.sessions()].find((candidate) => candidate.id === expected.conversationId);
  if (!session) return { turn: null, reason: "source_session_missing" };
  const turnId = expected.turnId ?? resolveHermesTurnId(source, session.id, expected.userContent ?? "");
  if (!turnId) return { turn: null, reason: "identity_unresolved" };
  return selectSourceTurn(readHermesSession(source, session), { conversationId: session.id, turnId });
}

/**
 * Finds the turn a user sentence belongs to. The same sentence can be sent more than once,
 * so the most recent group wins, and its earliest row is the durable identity.
 */
export function resolveHermesTurnId(source: HermesSource, sessionId: string, userContent: string): string | undefined {
  const needle = userContent.trim();
  if (!needle) return undefined;
  const rows = [...source.messages(sessionId)];
  const matches = rows.filter((row) => row.role === "user" && (row.content ?? "").trim() === needle);
  if (matches.length === 0) return undefined;
  const latestTimestamp = Math.max(...matches.map((row) => row.timestamp ?? 0));
  const group = matches.filter((row) => (row.timestamp ?? 0) === latestTimestamp);
  return `${sessionId}:${Math.min(...group.map((row) => firstCopyId(rows, row)))}`;
}

/** The lowest id among the rows that carry identical content: the pre-compaction original. */
function firstCopyId(rows: readonly HermesRow[], row: HermesRow): number {
  const key = rowIdentity(row);
  let earliest = row.id;
  for (const candidate of rows) {
    if (candidate.id < earliest && rowIdentity(candidate) === key) earliest = candidate.id;
  }
  return earliest;
}

function rowIdentity(row: HermesRow): string {
  return [row.role, row.timestamp ?? "", row.content ?? "", row.toolCallId ?? "", row.toolCalls ?? ""].join("\u0000");
}

/**
 * An inactive row that compaction did not archive and that has no active copy was retracted
 * by `/undo`. A compacted original stays valid: its content is still the conversation.
 */
function isRetracted(rows: readonly HermesRow[], row: HermesRow): boolean {
  if (row.active !== 0 || row.compacted === 1) return false;
  const key = rowIdentity(row);
  return !rows.some((candidate) => candidate.active === 1 && rowIdentity(candidate) === key);
}

function* stageTurn(
  session: { id: string; cwd: string | null },
  turn: HermesTurn,
  rows: readonly HermesRow[]
): Generator<RawSourceMessage> {
  const turnId = `${session.id}:${turn.turnId}`;
  const userRows = rows.filter((row) => row.role === "user");
  const query = userRows.map((row) => (row.content ?? "").trim()).filter(Boolean).join("\n\n");
  const answerRows = rows.filter((row) =>
    row.role === "assistant" && (row.content ?? "").trim() && !isCompressedSummary(row));
  const answer = answerRows.map((row) => (row.content ?? "").trim()).join("\n\n");
  const closing = [...answerRows].reverse().find((row) => row.finishReason === "stop");
  const startedAt = epochIso(userRows[0]?.timestamp);
  const completedAt = epochIso(closing?.timestamp);
  const toolCalls: SourceToolCall[] = [];
  const toolResults: SourceToolResult[] = [];
  for (const row of rows) {
    if (row.role === "assistant") toolCalls.push(...parseToolCalls(row.toolCalls));
    else if (row.role === "tool") {
      toolResults.push(compact({
        id: row.toolCallId ?? undefined, output: row.content ?? undefined, status: "completed", success: true
      }) as SourceToolResult);
    }
  }

  let reason = "";
  if (!query.trim()) reason = "turn_content_incomplete";
  else if (!closing) reason = "turn_incomplete";
  else if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(completedAt))) reason = "timestamp_unresolved";
  const sourceTurn: SourceTurn | undefined = reason ? undefined : {
    source: HERMES_SOURCE_ID, conversationId: session.id, turnId, profileId: "default",
    startedAt, completedAt, sequence: turn.turnId,
    completionEvidence: `assistant_stop:${closing!.id}`,
    query: redactSecrets(query), answer: redactSecrets(answer), status: "succeeded",
    toolCalls: pairSourceToolCalls(toolCalls, toolResults).map(redactCall), toolResults: toolResults.map(redactResult),
    ...(session.cwd ? { workspacePath: session.cwd } : {})
  };
  yield* stageSourceTurnMessages(toStagedMessages(session.id, rows, turn.turnId), {
    turnId, sequence: turn.turnId, startedAt, reason, turn: sourceTurn
  });
}

function isCompressedSummary(row: HermesRow): boolean {
  return row.compressedSummary === 1 || (row.content ?? "").trimStart().startsWith(COMPRESSED_SUMMARY_PREFIX);
}

function parseToolCalls(value: string | null): SourceToolCall[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecord).map((entry) => {
    const fn = isRecord(entry.function) ? entry.function : undefined;
    return compact({
      id: text(entry.call_id) || text(entry.id) || undefined,
      name: text(fn?.name) || text(entry.name) || "tool",
      input: fn?.arguments ?? entry.arguments ?? entry.input
    }) as unknown as SourceToolCall;
  });
}

function epochIso(value: number | null | undefined): string {
  const seconds = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(seconds) ? new Date(Math.round(seconds * 1000)).toISOString() : "";
}

function toStagedMessages(sessionId: string, rows: readonly HermesRow[], sequence: number): RawSourceMessage[] {
  const messages: RawSourceMessage[] = [];
  for (const row of rows) {
    const content = (row.content ?? "").trim();
    const base = {
      messageId: `${sessionId}:${row.id}`,
      conversationId: sessionId,
      createdAt: epochIso(row.timestamp),
      ordinal: row.id
    };
    if (row.role === "user" && content) {
      messages.push({ ...base, role: "user", content, rawMeta: { hermesRowId: row.id, hermesTurnSequence: sequence } });
      continue;
    }
    if (row.role === "tool") {
      messages.push({
        ...base, role: "tool", content: renderTool({ name: row.toolName ?? "tool", id: row.toolCallId ?? undefined, output: content }),
        rawMeta: { hermesToolName: row.toolName ?? undefined, hermesToolCallId: row.toolCallId ?? undefined }
      });
      continue;
    }
    if (row.role !== "assistant") continue;
    // An assistant row with no text is the intermediate state that only carries tool calls.
    for (const [index, call] of parseToolCalls(row.toolCalls).entries()) {
      messages.push({
        ...base, messageId: `${base.messageId}:call:${index}`, role: "tool", content: renderTool(call),
        rawMeta: { hermesToolName: call.name, hermesToolCallId: call.id }
      });
    }
    if (content && !isCompressedSummary(row)) {
      messages.push({ ...base, role: "assistant", content, rawMeta: { hermesRowId: row.id } });
    }
  }
  return messages;
}
