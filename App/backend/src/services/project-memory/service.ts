import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { CloudClient } from "../../adapters/outbound/cloud-client/types.js";
import { ProjectMemoryScope } from "./scope.js";
import { record, records, type HistoryImport, type ProjectAdd, type ProjectSearch, type Session } from "./contracts.js";

type Data = Record<string, unknown>;
type Account = { id: string; credential: string };
const error = (code: string, message: string) => Object.assign(new Error(message), { code });
const codeOf = (e: unknown) => e instanceof Error && "code" in e ? String(e.code) : "memory_layer_unavailable";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rows = (value: unknown) => records.parse(value ?? []);
const conversationId = (s: Session) => s.conversation_id.startsWith(s.source + ":") ? s.conversation_id : s.source + ":" + s.conversation_id;
const segment = (id: string) => {
  if (id === "." || id === "..") throw error("invalid_argument", "Invalid resource ID");
  return encodeURIComponent(id);
};

function interleave(batches: { items: Data[] }[]) {
  return batches.flatMap(batch => batch.items.map((item, rank) => ({ item, rank })))
    .sort((a, b) => a.rank - b.rank).map(({ item }) => item);
}

function cleanMessage(text: string) {
  // Only host-visible dialogue is eligible. Also strip packets quoted by an assistant.
  return text.replace(/<(memmy_memory_context|memmy_memory_status|memos_context|memory_context|project_memory_context|memmy_project_quote|memmy_internal_prompt)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<memmy_(?:runtime_context|memory_ref)\b[^>]*\/?>/gi, "")
    .replace(/<\/?current_user_request\b[^>]*>/gi, "").trim();
}

export class ProjectMemoryService {
  readonly scope: ProjectMemoryScope;
  private readonly pending = new Map<string, Promise<Data>>();

  constructor(private db: DatabaseSync, private current: () => Account | null, private cloud: Pick<CloudClient, "projectMemory">, private localOnly = () => false) {
    this.scope = new ProjectMemoryScope(db);
  }

  account() {
    const account = this.current();
    if (!account) throw error("unauthorized", "Sign in to use project memory");
    return account;
  }

  private async request(account: Account, path: string, body?: Data) {
    if (this.localOnly()) throw error("forbidden", "Cloud memory is disabled in local-only mode");
    const active = this.current();
    if (active?.id !== account.id || active.credential !== account.credential) throw error("unauthorized", "Account changed");
    if (!this.cloud.projectMemory) throw error("memory_layer_unavailable", "Project memory gateway unavailable");
    const result = await this.cloud.projectMemory(account.credential, body ? "POST" : "GET", path, body);
    const after = this.current();
    if (this.localOnly() || after?.id !== account.id || after.credential !== account.credential) throw error("unauthorized", "Account changed");
    const parsed = record.safeParse(result);
    if (!parsed.success) throw error("memory_layer_unavailable", "Invalid project memory gateway response");
    return parsed.data;
  }

  async index(a: Account, s: Session, size: number, turn?: string) {
    this.scope.open(a.id, s);
    const projects = this.scope.projects(a.id, s, turn);
    const result = await this.readBatches(a, s, projects, "index", { size }, "projects", turn);
    return { projects: result.items, degraded: result.degraded };
  }

  private async readBatches(a: Account, s: Session, ids: string[], path: string, body: Data, field: string, turn?: string) {
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 20) batches.push(ids.slice(i, i + 20));
    const read = async (project_ids: string[]): Promise<{ items: Data[]; degraded: unknown[] }> => {
      try {
        const data = await this.request(a, path, { ...body, project_ids });
        const items = records.parse(data[field]).filter(row => project_ids.includes(String(row.project_id)));
        return { items, degraded: Array.isArray(data.degraded) ? data.degraded : [] };
      } catch (e) {
        const code = codeOf(e);
        if (project_ids.length > 1 && (code === "forbidden" || code === "not_found")) {
          const allowed = await Promise.all(project_ids.map(id => read([id])));
          return { items: interleave(allowed), degraded: allowed.flatMap(r => r.degraded) };
        }
        return { items: [], degraded: project_ids.map(project_id => ({ project_id, code })) };
      }
    };
    const results = await Promise.all(batches.map(read));
    const current = this.scope.projects(a.id, s, turn);
    if (this.current()?.id !== a.id) return { items: [], degraded: ["account_changed"] };
    // Preserve each gateway ranking and interleave separate batches by rank.
    const items = interleave(results).filter(row => current.includes(String(row.project_id)));
    return { items, degraded: results.flatMap(r => r.degraded) };
  }

  async search(a: Account, s: ProjectSearch) {
    this.scope.open(a.id, s, true);
    const ids = this.scope.projects(a.id, s, s.turn_id, true);
    const wantIndex = s.include_index && this.scope.needsIndex(a.id, s);
    const [found, index] = await Promise.all([
      this.readBatches(a, s, ids, "search", { conversation_id: conversationId(s), query: s.query, domains: s.domains, limit: s.limit },
        "project_item_list", s.turn_id),
      wantIndex ? this.index(a, s, 8, s.turn_id) : { projects: [], degraded: [] }
    ]);
    if (wantIndex && ids.length && !index.degraded.length) this.scope.markIndex(a.id, s, false);
    const current = this.scope.projects(a.id, s, s.turn_id);
    const visible = (list: Data[]) => list.filter(item => this.current()?.id === a.id && current.includes(String(item.project_id)));
    const items = visible(found.items).slice(0, s.limit);
    const remember = this.db.prepare(`INSERT OR IGNORE INTO project_memory_references
      (account,source,conversation,turn,project,memory,origin,kind) VALUES(?,?,?,?,?,?,?,?)`);
    for (const item of items) {
      if (typeof item.id !== "string" || typeof item.conversation_id !== "string") continue;
      const kind = Array.isArray(item.message_ids) ? "turn" : item.message_id ? "message" : "episode";
      const save = (id: string, type: string) => remember.run(a.id, s.source, s.conversation_id, s.turn_id,
        String(item.project_id), id, String(item.conversation_id), type);
      save(item.id, kind);
      if (Array.isArray(item.message_ids)) {
        for (const id of item.message_ids) {
          // Add may use the first member ID as the Turn ID. Its direct hit denotes the skeleton.
          if (typeof id === "string" && id !== item.id) save(id, "message");
        }
      }
    }
    return {
      project_item_list: items,
      ...(wantIndex ? { projects: visible(index.projects) } : {}), degraded: [...found.degraded, ...index.degraded]
    };
  }

  async importHistory(a: Account, s: HistoryImport) {
    const { get_encoding } = await import("tiktoken");
    const encoder = get_encoding("cl100k_base");
    const batches: HistoryImport["messages"][] = [];
    let size = 0;
    try {
      for (const m of [...s.messages].sort((x,y) => Date.parse(x.chat_time) - Date.parse(y.chat_time))) {
        const message = { ...m, content: cleanMessage(m.content) };
        if (!message.content && message.role !== "tool") continue;
        const n = encoder.encode(JSON.stringify(message), [], []).length + 2;
        if (n > 40000) throw error("invalid_argument", "A history message exceeds 40000 tokens");
        if (!batches.length || size + n > 40000) { batches.push([]); size = 0; }
        batches[batches.length - 1]!.push(message);
        size += n;
      }
    } finally { encoder.free(); }
    this.scope.open(a.id, s);
    const turn_id = "import:" + s.submission_id;
    this.scope.projects(a.id, s, turn_id, true);
    const submissions: Data[] = [];
    for (const [i, messages] of batches.entries()) {
      const result = await this.add(a, { ...s, messages, turn_id, submission_id: hash([s.submission_id, i]) }, s.project_ids);
      submissions.push(...result.submissions);
    }
    return { submissions };
  }

  async add(a: Account, s: ProjectAdd, selected?: string[]) {
    // A completion cannot acquire projects bound since this turn started.
    const ids = this.scope.projects(a.id, s, s.turn_id).filter(id => !selected || selected.includes(id));
    if (!ids.length) return { submissions: [] };
    const key = [a.id, s.source, s.conversation_id, s.turn_id];
    const times = this.db.prepare("UPDATE project_memory_turns SET completed=coalesce(completed,?) WHERE account=? AND source=? AND conversation=? AND turn=? RETURNING started,completed")
      .get(new Date().toISOString(), ...key)!;
    const messages = s.messages.map((m, i) => ({
      ...m, content: cleanMessage(m.content), chat_time: m.chat_time ?? String(m.role === "user" ? times.started : times.completed),
      message_id: m.message_id ?? hash([s.source, s.conversation_id, s.turn_id, i]), role_id: m.role_id, role_name: m.role_name
    })).filter(m => m.content || m.role === "tool");
    if (!messages.length) return { submissions: [] };
    const submissions = await Promise.all(ids.map(project_id => this.submit(a, s, project_id, {
      project_ids: [project_id], submission_id: hash([s.source, s.conversation_id, s.submission_id, project_id]),
      source: s.source, conversation_id: conversationId(s), messages, domains: s.domains
    })));
    if (this.current()?.id !== a.id) throw error("unauthorized", "Account changed");
    const visible = this.scope.projects(a.id, s, s.turn_id);
    return { submissions: submissions.filter(row => visible.includes(String(row.project_id))) };
  }

  async retryPending() {
    const a = this.current();
    if (!a || this.localOnly()) return;
    const due = this.db.prepare("SELECT submission,project,request FROM project_memory_submissions WHERE account=? AND retry_at<=? ORDER BY retry_at LIMIT 20").all(a.id, Date.now());
    for (const row of due) {
      if (!row.request || this.current()?.id !== a.id) continue;
      const { session, body } = JSON.parse(String(row.request)) as { session: Session & { turn_id: string }; body: Data };
      if (!this.scope.projects(a.id, session, session.turn_id).includes(String(row.project))) {
        this.db.prepare("UPDATE project_memory_submissions SET retry_at=NULL,request=NULL WHERE account=? AND submission=? AND project=?").run(a.id, String(row.submission), String(row.project));
        continue;
      }
      await this.submit(a, session, String(row.project), body).catch(() => {});
    }
  }

  private submit(a: Account, s: Session & { turn_id: string }, project: string, body: Data): Promise<Data> {
    const submission = String(body.submission_id);
    const key = [a.id, submission, project];
    const digest = hash(body);
    const stored = this.db.prepare("SELECT digest,result,attempts FROM project_memory_submissions WHERE account=? AND submission=? AND project=?").get(...key);
    const unknown = { project_id: project, submission_id: submission, status: "acceptance_unknown" };
    if (stored && stored.digest !== digest) throw error("conflict", "Submission ID already used with different messages");
    const pending = this.pending.get(JSON.stringify(key));
    if (pending) return pending;
    const previous: Data | undefined = stored ? JSON.parse(String(stored.result)) : undefined;
    if (previous?.task_id) return Promise.resolve(previous);
    const session = { source: s.source, conversation_id: s.conversation_id, turn_id: s.turn_id };
    this.db.prepare("INSERT INTO project_memory_submissions(account,submission,project,digest,result,request,retry_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account, submission, project) DO UPDATE SET request=excluded.request,retry_at=excluded.retry_at")
      .run(...key, digest, JSON.stringify(unknown), JSON.stringify({ session, body }), Date.now() + 30_000);
    const save = (result: Data) => {
      const row = { ...result, project_id: project, submission_id: submission };
      const retry = result.status === "acceptance_unknown" || result.error === "rate_limited";
      const delay = Math.min(300_000, 5_000 * 2 ** Math.min(6, Number(stored?.attempts ?? 0)));
      this.db.prepare("UPDATE project_memory_submissions SET result=?, attempts=attempts+1, retry_at=CASE WHEN request IS NULL THEN NULL ELSE ? END, request=CASE WHEN ? THEN request ELSE NULL END WHERE account=? AND submission=? AND project=?")
        .run(JSON.stringify(row), retry ? Date.now() + delay : null, Number(retry), ...key);
      return row;
    };
    const run = async () => {
      try {
        if (previous?.status === "acceptance_unknown") {
          const status = await this.request(a, "submissions/" + segment(submission) + "?project_id=" + segment(project));
          if (status.task_id) return save(status);
          if (status.status !== "not_accepted") return save(unknown);
        }
        if (!this.scope.projects(a.id, s, s.turn_id).includes(project)) return unknown;
        const result = await this.request(a, "add", body);
        return result.task_id ? save(result) : save(unknown);
      } catch (e) {
        const code = codeOf(e);
        if (code === "conflict") { save({ status: "failed", error: code }); throw e; }
        if (["invalid_argument", "unauthorized", "forbidden", "not_found", "rate_limited"].includes(code) && previous?.status !== "acceptance_unknown") {
          return save({ status: "failed", error: code });
        }
        return save(unknown);
      }
    };
    const promise = run().finally(() => this.pending.delete(JSON.stringify(key)));
    this.pending.set(JSON.stringify(key), promise);
    return promise;
  }

  async topics(a: Account, input: { project_id: string; page: number; size: number }) {
    const data = await this.request(a, "topics", input);
    const topics = rows(data.topics);
    if (topics.some(t => t.project_id !== input.project_id)) throw error("not_found", "Project mismatch");
    return { ...data, topics };
  }

  async detail(a: Account, type: "topics" | "status", id: string, project?: string) {
    const data = await this.request(a, type + "/" + segment(id) + (project ? "?project_id=" + segment(project) : ""));
    if (type === "topics" && (data.project_id !== project || (data.id ?? data.topic_id) !== id)) throw error("not_found", "Topic unavailable");
    if (type === "status" && data.task_id !== id) throw error("not_found", "Task unavailable");
    return data;
  }

  readTurnItem(a: Account, s: Session & { turn_id: string; project_id: string; memory_id: string }) {
    const refs = this.db.prepare(`SELECT origin,kind FROM project_memory_references
      WHERE account=? AND source=? AND conversation=? AND turn=? AND project=? AND memory=? LIMIT 2`)
      .all(a.id, s.source, s.conversation_id, s.turn_id, s.project_id, s.memory_id);
    if (refs.length > 1) throw error("conflict", "Ambiguous project reference; specify the source conversation and kind");
    const ref = refs[0];
    return this.item(a, s.project_id, s.memory_id, ref && String(ref.origin), ref && String(ref.kind));
  }

  async item(a: Account, project: string, id: string, origin?: string, kind?: string) {
    const key = [a.id, project, JSON.stringify([id, origin, kind])];
    const clear = () => this.db.prepare("DELETE FROM project_memory_cache WHERE account=? AND project=? AND memory=?").run(...key);
    const cached = this.db.prepare("SELECT data FROM project_memory_cache WHERE account=? AND project=? AND memory=?").get(...key);
    const fetchItem = async (view: string) => {
      const params = new URLSearchParams({ project_id: project, view });
      if (origin) params.set("source_conversation_id", origin);
      if (kind) params.set("kind", kind);
      const data = await this.request(a, "items/" + segment(id) + "?" + params);
      const content = record.safeParse(data.content);
      const source = data.conversation_id ?? (content.success ? content.data.conversation_id : undefined);
      if ((origin && source && origin !== source) || (kind && data.kind !== kind)) throw error("not_found", "Project evidence mismatch");
      if (data.memory_id !== id || data.project_id !== project) throw error("not_found", "Project memory item unavailable");
      return data;
    };
    const immutable = (v: Data) => v.cache_policy === "immutable" && v.revision == null && v.version == null && v.version_id == null && v.kind !== "entry_version" && v.kind !== "topic";
    try {
      if (cached) {
        const meta = await fetchItem("metadata");
        if (immutable(meta)) return { ...JSON.parse(String(cached.data)), read_from: "local_cache" };
        clear();
      }
      const data = await fetchItem("content");
      if (!("content" in data)) throw error("memory_layer_unavailable", "Missing project memory content");
      if (immutable(data)) this.db.prepare("INSERT OR REPLACE INTO project_memory_cache VALUES(?,?,?,?)").run(...key, JSON.stringify(data));
      return { ...data, read_from: "cloud" };
    } catch (e) {
      if (["not_found", "unauthorized", "forbidden"].includes(codeOf(e))) clear();
      throw e;
    }
  }
}
