import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { discoverMemmyMemoryConnection, discoverMemmyMemoryUserId } from "../../memmy-memory/discovery.js";

export interface HistoryEvidence {
  id: string;
  title: string;
  content: string;
  revision: string;
  startedAt: string;
  endedAt: string;
  applications: string[];
  summaryWindow?: "10min" | "6h";
  parentSourceRecordIds?: string[];
}

export interface HistorySkillGroup {
  id: string;
  revision: string;
  sourceRecordIds: string[];
  actions: Array<{ sourceRecordId: string; text: string }>;
}

interface SyncState {
  /** The local namespace this machine's History evidence already uses. */
  namespaceUserId?: string;
  synced: Record<string, string>;
  /** Permanent source tombstones prevent stale directory scans from re-uploading. */
  deleted: Record<string, string>;
  deleteAck: Record<string, string>;
  memoryIds: Record<string, string>;
  skillGroups: Record<string, { revision: string; sourceRecordIds: string[]; skillId?: string }>;
  pendingSkillGroups: Record<string, HistorySkillGroup>;
}

type SyncPayload = {
  action: "upsert" | "delete";
  source: "computer_history";
  sourceRecordId: string;
  revision: string;
  title?: string;
  content?: string;
  startedAt?: string;
  endedAt?: string;
  provenance?: Record<string, unknown>;
  parentSourceRecordIds?: string[];
  namespace: { source: "memmy"; profileId: "default"; userId: string };
};

type StatusPayload = {
  source: "computer_history";
  sourceRecordIds: string[];
  skillIds: string[];
  namespace: SyncPayload["namespace"];
};
type StatusResult = {
  evidence: Array<{ sourceRecordId: string; id?: string; status: "activated" | "deleted" | "missing" }>;
  skills: Array<{ id: string; status: "activated" | "resolving" | "archived" | "deleted" | "missing" }>;
};

/** History text never leaves the machine through this adapter. */
async function postEvidence(payload: SyncPayload): Promise<{ id: string; status?: "activated" | "deleted" }> {
  const connection = discoverMemmyMemoryConnection();
  const url = new URL("/api/v1/evidence/sync", connection.baseUrl);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host)
    || url.username || url.password) {
    throw new Error("History evidence sync requires a local loopback Memory service");
  }
  const response = await fetch(url, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`local Memory evidence sync failed (${response.status})`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || typeof (result as { id?: unknown }).id !== "string") {
    throw new Error("local Memory evidence sync returned no memory ID");
  }
  return result as { id: string };
}

async function suggestSkill(payload: {
  source: "computer_history"; groupId: string; revision: string;
  sourceRecordIds: string[]; actions: HistorySkillGroup["actions"];
  namespace: SyncPayload["namespace"];
}): Promise<{ status: "candidate" | "skipped"; id?: string }> {
  const connection = discoverMemmyMemoryConnection();
  const url = new URL("/api/v1/evidence/skills/suggest", connection.baseUrl);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host)
    || url.username || url.password) {
    throw new Error("History Skill suggestion requires a local loopback Memory service");
  }
  const response = await fetch(url, { method: "POST", redirect: "error",
    headers: { "content-type": "application/json",
      ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}) },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`local Memory Skill suggestion failed (${response.status})`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !["candidate", "skipped"].includes((result as { status?: string }).status ?? "")) {
    throw new Error("local Memory Skill suggestion returned an invalid result");
  }
  return result as { status: "candidate" | "skipped"; id?: string };
}

async function fetchStatus(payload: StatusPayload): Promise<StatusResult> {
  const connection = discoverMemmyMemoryConnection();
  const url = new URL("/api/v1/evidence/status", connection.baseUrl);
  const host = url.hostname.replace(/^\[|\]$/gu, "");
  if (url.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host)
    || url.username || url.password) {
    throw new Error("History status reconciliation requires a local loopback Memory service");
  }
  const response = await fetch(url, { method: "POST", redirect: "error",
    headers: { "content-type": "application/json",
      ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}) },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`local Memory evidence status failed (${response.status})`);
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !Array.isArray((result as StatusResult).evidence)
    || !Array.isArray((result as StatusResult).skills)) {
    throw new Error("local Memory evidence status returned an invalid result");
  }
  return result as StatusResult;
}

/** Optional, durable bridge: no Memory call occurs until History sync is enabled. */
export class HistoryMemoryAdapter {
  private readonly stateFile: string;
  private readonly state: SyncState;
  private readonly timer: ReturnType<typeof setInterval>;
  private pending: Promise<void> | null = null;
  private reschedule = false;
  private closed = false;
  private stateCorrupt = false;
  private lastError: string | null = null;
  private lastSkillError: string | null = null;
  private lastSyncedAt: string | null = null;
  private statusCursor = 0;

  constructor(private readonly input: {
    historyDirectory: string;
    enabled(): boolean;
    listEvidence(): HistoryEvidence[];
    listSkillGroups?: () => HistorySkillGroup[];
    onSkillCandidate?: (group: HistorySkillGroup, skillId: string | null, previousSkillId?: string) => void;
    post?: (payload: SyncPayload) => Promise<void | { id: string; status?: "activated" | "deleted" }>;
    suggest?: typeof suggestSkill;
    status?: typeof fetchStatus;
    userId?: () => string;
  }) {
    this.stateFile = path.join(input.historyDirectory, "memory-sync-state.json");
    this.state = this.readState();
    this.timer = setInterval(() => this.schedule(), 60_000);
    this.timer.unref();
    if (input.enabled() || Object.keys(this.state.deleted).length) this.schedule();
  }

  schedule(): void {
    if (this.closed) return;
    if (this.pending) { this.reschedule = true; return; }
    this.pending = this.flush().catch((error) => {
      // History remains usable when Memory is absent, old or temporarily down.
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn(`[computer-history] Memory evidence sync deferred: ${this.lastError}`);
    }).finally(() => {
      this.pending = null;
      if (this.reschedule && !this.closed) {
        this.reschedule = false;
        queueMicrotask(() => this.schedule());
      }
    });
  }

  async flushNow(): Promise<void> {
    this.schedule();
    do {
      const active = this.pending;
      if (active) await active;
      await Promise.resolve();
    } while (this.pending || this.reschedule);
  }

  status(): { lastSyncedAt: string | null; error: string | null; skillError: string | null; pendingDeletionCount: number } {
    return { lastSyncedAt: this.lastSyncedAt, error: this.lastError, skillError: this.lastSkillError,
      pendingDeletionCount: Object.entries(this.state.deleted)
        .filter(([id, revision]) => this.state.deleteAck[id] !== revision).length };
  }

  memoryIdFor(historyId: string): string | undefined {
    return this.input.enabled() && !this.state.deleted[historyId]
      ? this.state.memoryIds[historyId] : undefined;
  }

  /** A deleted History must not be re-uploaded after a retry or restart. */
  remove(id: string): void {
    if (!id.endsWith("-10min-summary") && !id.endsWith("-6h-summary")) return;
    if (!this.input.enabled() && !this.state.synced[id]) return;
    this.state.deleted[id] = new Date().toISOString();
    delete this.state.memoryIds[id];
    for (const [groupId, group] of Object.entries(this.state.skillGroups)) {
      if (!group.sourceRecordIds.includes(id)) continue;
      this.input.onSkillCandidate?.({ id: groupId, revision: group.revision,
        sourceRecordIds: group.sourceRecordIds, actions: [] }, null, group.skillId);
      delete this.state.skillGroups[groupId];
    }
    for (const [groupId, group] of Object.entries(this.state.pendingSkillGroups)) {
      if (group.sourceRecordIds.includes(id)) delete this.state.pendingSkillGroups[groupId];
    }
    delete this.state.deleteAck[id];
    this.writeState();
    this.schedule();
  }

  /** Turning off sync retracts earlier evidence, even while recording stays on. */
  revokeAll(): void {
    for (const id of Object.keys(this.state.synced)) {
      this.state.deleted[id] ??= new Date().toISOString();
      delete this.state.memoryIds[id];
      delete this.state.deleteAck[id];
    }
    for (const [groupId, group] of Object.entries(this.state.skillGroups)) {
      this.input.onSkillCandidate?.({ id: groupId, revision: group.revision,
        sourceRecordIds: group.sourceRecordIds, actions: [] }, null, group.skillId);
    }
    this.state.skillGroups = {};
    this.state.pendingSkillGroups = {};
    this.writeState();
    this.schedule();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending;
  }

  private async flush(): Promise<void> {
    if (this.stateCorrupt) throw new Error("History Memory sync state is unreadable; refusing to re-upload evidence");
    const post = this.input.post ?? postEvidence;
    const discoveredUserId = this.input.userId?.() ?? discoverMemmyMemoryUserId();
    // Keep the namespace already used for this machine's History. A later
    // config user id must not fork new copies or miss the rows a clear deletes.
    if (!this.state.namespaceUserId && (this.input.enabled()
      || Object.keys(this.state.synced).length || Object.keys(this.state.deleted).length)) {
      this.state.namespaceUserId = discoveredUserId;
      this.writeState();
    }
    const userId = this.state.namespaceUserId || discoveredUserId;
    const namespace = { source: "memmy" as const, profileId: "default" as const, userId };
    if (!this.input.enabled() && (Object.keys(this.state.synced).some((id) => !this.state.deleted[id])
      || Object.keys(this.state.pendingSkillGroups).length
      || Object.keys(this.state.skillGroups).length)) this.revokeAll();
    const flushDeletes = async () => {
      for (const [id, revision] of Object.entries(this.state.deleted)) {
        if (this.state.deleteAck[id] === revision) continue;
        await post({ action: "delete", source: "computer_history", sourceRecordId: id, revision, namespace });
        this.lastError = null;
        this.lastSyncedAt = new Date().toISOString();
        this.state.deleteAck[id] = revision;
        delete this.state.synced[id];
        delete this.state.memoryIds[id];
        this.writeState();
      }
    };
    if (this.input.enabled()) {
      try {
        let staged = false;
        for (const group of this.input.listSkillGroups?.() ?? []) {
          if (this.state.skillGroups[group.id]?.revision === group.revision) continue;
          if (this.state.pendingSkillGroups[group.id]?.revision === group.revision) continue;
          if (!this.state.pendingSkillGroups[group.id]
            && Object.keys(this.state.pendingSkillGroups).length >= 256) {
            this.lastSkillError = "History Skill suggestion backlog reached its local limit";
            break;
          }
          this.state.pendingSkillGroups[group.id] = group;
          staged = true;
        }
        if (staged) this.writeState();
      } catch (error) {
        this.lastSkillError = error instanceof Error ? error.message : String(error);
      }
    }
    // Apply revocations before any new suggestion. A failed model call must
    // never keep already deleted observations available for retrieval.
    await flushDeletes();
    if (this.input.enabled()) {
      // Memory's own UI can delete observations or Skills. Check a bounded
      // rotating slice so the History shortcuts cannot remain stale forever.
      if (this.input.status || !this.input.post) {
        try {
          const ids = Object.keys(this.state.synced).filter((id) => !this.state.deleted[id]).reverse();
          const start = ids.length ? this.statusCursor % ids.length : 0;
          const sourceRecordIds = ids.length <= 200 ? ids : [
            ...ids.slice(start, start + 200), ...ids.slice(0, Math.max(0, start + 200 - ids.length))
          ];
          this.statusCursor = start + sourceRecordIds.length;
          const skillIds = [...new Set(Object.values(this.state.skillGroups)
            .flatMap((group) => group.skillId ? [group.skillId] : []))].slice(0, 200);
          if (sourceRecordIds.length || skillIds.length) {
            const result = await (this.input.status ?? fetchStatus)({
              source: "computer_history", sourceRecordIds, skillIds, namespace });
            const evidenceById = new Map(result.evidence.map((item) => [item.sourceRecordId, item]));
            for (const id of sourceRecordIds) {
              const item = evidenceById.get(id);
              if (!item || !["activated", "deleted", "missing"].includes(item.status)) {
                throw new Error("local Memory evidence status omitted a source");
              }
              if (item.status === "deleted") this.remove(id);
              else if (item.status === "missing") {
                delete this.state.synced[id];
                delete this.state.memoryIds[id];
                this.writeState();
              } else if (item.id && this.state.memoryIds[id] !== item.id) {
                this.state.memoryIds[id] = item.id;
                this.writeState();
              }
            }
            const skillsById = new Map(result.skills.map((item) => [item.id, item]));
            for (const [groupId, group] of Object.entries(this.state.skillGroups)) {
              if (!group.skillId || !skillIds.includes(group.skillId)) continue;
              const item = skillsById.get(group.skillId);
              if (!item || !["activated", "resolving", "archived", "deleted", "missing"].includes(item.status)) {
                throw new Error("local Memory evidence status omitted a Skill");
              }
              if (item.status !== "deleted" && item.status !== "missing") continue;
              this.input.onSkillCandidate?.({ id: groupId, revision: group.revision,
                sourceRecordIds: group.sourceRecordIds, actions: [] }, null, group.skillId);
              if (item.status === "missing") delete this.state.skillGroups[groupId];
              else delete group.skillId;
              this.writeState();
            }
          }
        } catch (error) {
          // An older or temporarily unavailable Memory service must not block
          // evidence uploads, revocations or the local History timeline.
          this.lastError = error instanceof Error ? error.message : String(error);
        }
      }
      for (const item of this.input.listEvidence()) {
        if (!this.input.enabled()) { this.revokeAll(); break; }
        // Older sync state did not retain the Memory ID. Replaying the same
        // revision is idempotent and recovers the direct History → Memory link.
        if (this.state.deleted[item.id] || (this.state.synced[item.id] >= item.revision
          && this.state.memoryIds[item.id])) continue;
        const result = await post({ action: "upsert", source: "computer_history", sourceRecordId: item.id,
          revision: item.revision, title: item.title, content: item.content,
          startedAt: item.startedAt, endedAt: item.endedAt,
          provenance: { applications: item.applications, historyId: item.id,
            summaryWindow: item.summaryWindow ?? "10min" },
          ...(item.parentSourceRecordIds?.length ? { parentSourceRecordIds: item.parentSourceRecordIds } : {}),
          namespace });
        if (result?.status === "deleted") {
          // A user may have removed the observation in Memory itself. Its
          // server tombstone is authoritative; do not resurrect or link it.
          this.remove(item.id);
          continue;
        }
        this.lastError = null;
        this.lastSyncedAt = new Date().toISOString();
        this.state.synced[item.id] = item.revision;
        if (result?.id) this.state.memoryIds[item.id] = result.id;
        this.writeState();
        if (!this.input.enabled()) { this.revokeAll(); break; }
      }
      for (const group of Object.values(this.state.pendingSkillGroups)) {
        if (!this.input.enabled()) { this.revokeAll(); break; }
        if (this.state.skillGroups[group.id]?.revision === group.revision) continue;
        if (group.sourceRecordIds.some((id) => !this.state.synced[id] || this.state.deleted[id])) continue;
        try {
          const result = await (this.input.suggest ?? suggestSkill)({ source: "computer_history",
            groupId: group.id, revision: group.revision, sourceRecordIds: group.sourceRecordIds,
            actions: group.actions, namespace });
          // Consent or a source can disappear while the model is deciding.
          // The final delete pass retracts any candidate committed remotely.
          if (!this.input.enabled() || group.sourceRecordIds.some((id) => this.state.deleted[id])) continue;
          const previous = this.state.skillGroups[group.id];
          if (previous?.skillId) this.input.onSkillCandidate?.({ ...group,
            sourceRecordIds: previous.sourceRecordIds }, null, previous.skillId);
          this.state.skillGroups[group.id] = { revision: group.revision,
            sourceRecordIds: group.sourceRecordIds, ...(result.id ? { skillId: result.id } : {}) };
          delete this.state.pendingSkillGroups[group.id];
          if (result.status === "candidate" && result.id) this.input.onSkillCandidate?.(group, result.id);
          this.lastSkillError = null;
          this.writeState();
        } catch (error) {
          // A missing evolution model must not block evidence deletion/sync.
          this.lastSkillError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    await flushDeletes();
  }

  private readState(): SyncState {
    try {
      if (fs.statSync(this.stateFile).size > 16 * 1024 * 1024) throw new Error("History Memory sync state is unexpectedly large");
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      const validPendingGroups = !parsed?.pendingSkillGroups || (
        typeof parsed.pendingSkillGroups === "object" && !Array.isArray(parsed.pendingSkillGroups)
        && Object.entries(parsed.pendingSkillGroups).every(([id, value]) => {
          const group = value as Partial<HistorySkillGroup> | null;
          return group && group.id === id && typeof group.revision === "string"
            && Array.isArray(group.sourceRecordIds) && group.sourceRecordIds.length <= 12
            && group.sourceRecordIds.every((sourceId) => typeof sourceId === "string")
            && Array.isArray(group.actions) && group.actions.length <= 60
            && group.actions.every((action) => action && typeof action.sourceRecordId === "string"
              && typeof action.text === "string" && action.text.length <= 300);
        })
      );
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)
        && parsed.synced && typeof parsed.synced === "object" && !Array.isArray(parsed.synced)
        && parsed.deleted && typeof parsed.deleted === "object" && !Array.isArray(parsed.deleted)
        && (parsed.namespaceUserId === undefined || (typeof parsed.namespaceUserId === "string"
          && parsed.namespaceUserId.trim().length > 0 && parsed.namespaceUserId.length <= 200))
        && validPendingGroups
        && Object.values(parsed.synced).every((value) => typeof value === "string")
        && Object.values(parsed.deleted).every((value) => typeof value === "string")
        && (!parsed.skillGroups || (typeof parsed.skillGroups === "object" && !Array.isArray(parsed.skillGroups)
          && Object.values(parsed.skillGroups).every((value) => value && typeof value === "object"
            && typeof (value as { revision?: unknown }).revision === "string"
            && Array.isArray((value as { sourceRecordIds?: unknown }).sourceRecordIds)
            && (value as { sourceRecordIds: unknown[] }).sourceRecordIds.every((id) => typeof id === "string")
            && ((value as { skillId?: unknown }).skillId === undefined
              || typeof (value as { skillId?: unknown }).skillId === "string"))))) {
        return { ...(parsed.namespaceUserId ? { namespaceUserId: parsed.namespaceUserId } : {}),
          synced: { ...parsed.synced }, deleted: { ...parsed.deleted },
          memoryIds: parsed.memoryIds && typeof parsed.memoryIds === "object" && !Array.isArray(parsed.memoryIds)
            ? { ...parsed.memoryIds } : {},
          skillGroups: parsed.skillGroups && typeof parsed.skillGroups === "object" && !Array.isArray(parsed.skillGroups)
            ? { ...parsed.skillGroups } : {},
          pendingSkillGroups: parsed.pendingSkillGroups && typeof parsed.pendingSkillGroups === "object"
            && !Array.isArray(parsed.pendingSkillGroups) ? { ...parsed.pendingSkillGroups } : {},
          deleteAck: parsed.deleteAck && typeof parsed.deleteAck === "object" && !Array.isArray(parsed.deleteAck)
            ? { ...parsed.deleteAck } : {} };
      }
      this.stateCorrupt = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.stateCorrupt = true;
    }
    return { synced: {}, deleted: {}, deleteAck: {}, memoryIds: {}, skillGroups: {}, pendingSkillGroups: {} };
  }

  private writeState(): void {
    if (this.stateCorrupt) throw new Error("History Memory sync state is unreadable; refusing to overwrite it");
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    const temp = `${this.stateFile}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(this.state), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temp, this.stateFile);
    } finally { fs.rmSync(temp, { force: true }); }
  }
}
