import type { OpencodeSource, OpencodeSession } from "./opencode-source-turn.js";

interface Database {
  prepare(sql: string): { all(...parameters: string[]): unknown[]; get(...parameters: string[]): unknown };
}
type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const parse = (value: unknown): Row => {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return {}; }
};

/** Adapt both native database generations to the same turn parser. Only one
 * session is materialised at a time; all callers open the database read-only. */
export function createOpencodeDatabaseSource(db: Database, conversationId?: string): OpencodeSource | null {
  const hasTable = (name: string) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const v2 = hasTable("session_v2") && hasTable("session_message");
  if (!v2 && !(hasTable("session") && hasTable("message") && hasTable("part"))) return null;
  const table = v2 ? "session_v2" : "session";
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => record(row).name));
  const sessions = db.prepare(`SELECT id, parent_id AS parentId, directory${columns.has("agent") ? ", agent" : ""}${columns.has("revert") ? ", revert" : ""} FROM ${table}${conversationId ? " WHERE id = ?" : ""} ORDER BY time_created ASC, id ASC`);
  const messages = db.prepare(v2
    ? "SELECT id, type, data, time_created FROM session_message WHERE session_id = ? ORDER BY seq ASC, id ASC"
    : "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC");
  const parts = v2 ? null : db.prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC");
  // Official V1 -> V2 migration retains the original tables. They are positive
  // provenance for migrated messages, whose completion/parent/tool identity must
  // remain identical to captures made before upgrading. Native V2 rows still
  // require their own durable idle boundary.
  const legacyMessages = v2 && hasTable("message") && hasTable("part")
    ? db.prepare("SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC") : null;
  const legacyParts = legacyMessages ? db.prepare("SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC, id ASC") : null;
  const currentParts = new Map<string, Array<{ id: string; data: unknown }>>();
  return {
    sessions: () => sessions.all(...(conversationId ? [conversationId] : [])).map(value => {
      const row = record(value);
      const revert = parse(row.revert);
      return {
        id: String(row.id), parentId: row.parentId == null ? null : String(row.parentId),
        directory: row.directory == null ? null : String(row.directory),
        agent: typeof row.agent === "string" ? row.agent : null,
        revertMessageId: typeof revert.messageID === "string" ? revert.messageID : null
      } satisfies OpencodeSession;
    }),
    messages(sessionId) {
      const rows = messages.all(sessionId).map(record);
      if (!v2) return rows.map(row => ({ id: String(row.id), data: parse(row.data) }));
      currentParts.clear();
      let parentID = "";
      let agent = "";
      let turnAssistants: Row[] = [];
      const result: Array<{ id: string; data: Row }> = [];
      const legacy = legacyMessages?.all(sessionId).map(record) || [];
      const migratedIds = new Set(rows.map(row => String(row.id)));
      const legacyIds = new Set<string>();
      if (legacy.some(row => migratedIds.has(String(row.id)))) {
        for (const row of legacy) {
          const id = String(row.id);
          legacyIds.add(id);
          const data = parse(row.data);
          const owner = data.role === "assistant" ? String(data.parentID || "") : id;
          // V2 may have removed/reverted a migrated user. Keep its ordinal slot
          // for existing source identities, but never resurrect deleted history.
          const visible = migratedIds.has(owner);
          result.push({ id, data: visible ? data : {} });
          if (!visible) continue;
          currentParts.set(id, legacyParts!.all(id).map(value => {
            const part = record(value); return { id: String(part.id), data: parse(part.data) };
          }));
        }
      }
      for (const row of rows) {
        const data = parse(row.data);
        const type = data.type || row.type;
        const id = String(row.id);
        if (legacyIds.has(id)) continue;
        if (type === "agent-switched") { agent = String(data.agent || ""); continue; }
        if (type === "user") {
          parentID = id;
          turnAssistants = [];
          result.push({ id, data: { role: "user", time: data.time || { created: row.time_created } } });
          currentParts.set(id, [{ id: id + ":text", data: { type: "text", text: data.text } }]);
        } else if (type === "assistant" && parentID) {
          const assistant = { ...data, nativeTurnPending: true, role: "assistant", parentID, agent: data.agent || agent };
          turnAssistants.push(assistant);
          result.push({ id, data: assistant });
          const content = Array.isArray(data.content) ? data.content.map(record) : [];
          currentParts.set(id, content.map((part, index) => {
            if (part.type !== "tool") return { id: `${id}:${index}`, data: part };
            const state = record(part.state);
            const output = Array.isArray(state.content)
              ? state.content.map(record).filter(item => item.type === "text").map(item => item.text).join("\n") : "";
            return { id: `${id}:${index}`, data: {
              type: "tool", callID: part.id, tool: part.name,
              metadata: { providerExecuted: part.executed === true },
              state: { ...state, output: state.status === "error" ? record(state.error).message || output : output, time: part.time }
            } };
          }));
        } else if (type === "idle") {
          // V2 persists an explicit terminal boundary, including tool-only and
          // interrupted turns. Do not infer completion from an intermediate step.
          // A final failed/empty assistant can be filtered by the shared parser.
          // Close all steps so the last useful text/tool still has the terminal status.
          for (const assistant of turnAssistants) {
            assistant.nativeTurnCompleted = true;
            assistant.nativeTurnPending = false;
            if (data.outcome === "failed" || data.outcome === "interrupted") assistant.nativeStatus = "failed";
            if (data.outcome === "interrupted") assistant.error = { name: "MessageAbortedError" };
            assistant.time = { ...record(assistant.time), completed: record(data.time).created || row.time_created };
          }
          // Freeze the completed turn. Synthetic continuations and independent
          // compactions are not new user turns and cannot reopen this parent.
          parentID = "";
          turnAssistants = [];
        }
      }
      return result;
    },
    parts: messageId => parts
      ? parts.all(messageId).map(value => { const row = record(value); return { id: String(row.id), data: parse(row.data) }; })
      : currentParts.get(messageId) || []
  };
}
