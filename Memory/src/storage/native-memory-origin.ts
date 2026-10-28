import type Database from "better-sqlite3";
import type { MemoryRow } from "../types.js";
import { canonicalNamespaceKey, canonicalProjectId } from "./device-scope.js";
import { isRecord, parseJson } from "../utils/json.js";
import { stableHash } from "../utils/id.js";
import { normalizeMemoryCaptureSource } from "../utils/memory-capture-claim.js";

/** Present null is a captured empty scope. A missing snapshot is unknown, not a wildcard. */
export interface NativeOrigin {
  version: 1;
  source: string;
  profileId: string;
  conversationId: string | null;
  projectId: string | null;
  workspaceId: string | null;
  tenantId: string | null;
  namespaceKey: string | null;
  hostSessionKey?: string | null;
}

export const pendingOriginKey = (sessionId: string, turnId: string): string =>
  `native_turn_origin:${stableHash({ sessionId, turnId })}`;

export function captureNativeOrigin(input: {
  source: string; profileId: string; conversationId?: string | null;
  projectId?: string | null; workspaceId?: string | null; tenantId?: string | null;
  meta?: Record<string, unknown>;
  hostSessionKey?: string | null;
}): NativeOrigin {
  const meta = input.meta ?? {};
  return { version: 1, source: normalizeMemoryCaptureSource(input.source), profileId: input.profileId,
    conversationId: input.conversationId ?? null, projectId: input.projectId ?? null,
    workspaceId: input.workspaceId ?? null,
    tenantId: input.tenantId ?? text(meta.tenant_id) ?? text(meta.tenantId) ?? null,
    namespaceKey: text(meta.source_namespace_key) ?? null, hostSessionKey: input.hostSessionKey ?? null };
}

export function readNativeOrigin(value: unknown): NativeOrigin | undefined {
  if (!isRecord(value) || value.version !== 1 || !text(value.source) || !text(value.profileId)) return undefined;
  for (const key of ["conversationId", "projectId", "workspaceId", "tenantId", "namespaceKey"]) {
    if (value[key] !== null && typeof value[key] !== "string") return undefined;
  }
  return value as unknown as NativeOrigin;
}

export interface NativeIdentity {
  source: string; profileId: string; conversationId: string; turnId: string; namespaceKey: string;
}

/** Claim compatibility may use a host key, without promoting it to native provenance. */
export function nativeClaimIdentity(origin: NativeOrigin, turnId: string) {
  const conversationId = origin.conversationId ?? origin.hostSessionKey;
  return conversationId ? { projectId: origin.projectId, workspaceId: origin.workspaceId,
    tenantId: origin.tenantId, profileId: origin.profileId, conversationId, turnId } : undefined;
}

export function nativeIdentity(db: Database.Database, origin: NativeOrigin, turnId: string, allowHostConversation = false): NativeIdentity | undefined {
  const conversationId = origin.conversationId ?? (allowHostConversation ? origin.hostSessionKey : null);
  if (!conversationId || !turnId) return undefined;
  const scope = { tenantId: origin.tenantId, projectId: canonicalProjectId(db, origin.projectId),
    workspaceId: canonicalProjectId(db, origin.workspaceId) };
  const namespaceKey = stableHash(scope);
  if (origin.namespaceKey && canonicalNamespaceKey(db, origin.namespaceKey) !== namespaceKey) return undefined;
  return { source: normalizeMemoryCaptureSource(origin.source), profileId: origin.profileId,
    conversationId, turnId,
    namespaceKey };
}

/** Called only for a new row, never to backfill a persisted historical row. */
export function freezeMemoryOrigin(db: Database.Database, memory: MemoryRow): MemoryRow {
  if (memory.memoryLayer !== "L1" || memory.properties.internal_info.memory_kind === "work_memory") return memory;
  if (Object.hasOwn(memory.info, "native_origin_v1")) {
    const captured = readNativeOrigin(memory.info.native_origin_v1);
    return captured ? withMemoryOrigin(memory, captured) : memory;
  }
  const trace = memory.properties.internal_info.trace;
  const rawId = text(memory.info.raw_turn_id) ?? (isRecord(trace) ? text(trace.raw_turn_id) : undefined);
  const raw = rawId ? db.prepare("SELECT message_payload_json FROM raw_turns WHERE id=?").get(rawId) as
    { message_payload_json: string } | undefined : undefined;
  const rawOrigin = readNativeOrigin(parseJson<Record<string, unknown>>(raw?.message_payload_json, {}).native_origin_v1);
  const session = memory.sessionId ? db.prepare("SELECT * FROM sessions WHERE id=?").get(memory.sessionId) as
    {source: string; profile_id: string; conversation_id: string | null; host_session_key: string | null; meta_json: string} | undefined : undefined;
  const origin = rawOrigin ?? (session ? captureNativeOrigin({
    source: memory.agentId ?? session.source, profileId: text(memory.info.profile_id) ?? session.profile_id,
    conversationId: memory.conversationId ?? session.conversation_id,
    projectId: text(memory.info.project_id) ?? null, workspaceId: memory.appId ?? null,
    meta: parseJson<Record<string, unknown>>(session.meta_json, {}), hostSessionKey: session.host_session_key
  }) : undefined);
  return origin ? withMemoryOrigin(memory, origin) : memory;
}

export function withMemoryOrigin(memory: MemoryRow, origin: NativeOrigin): MemoryRow {
  const info = { ...memory.info, native_origin_v1: origin, project_id: origin.projectId, profile_id: origin.profileId };
  return { ...memory, agentId: origin.source, appId: origin.workspaceId ?? undefined,
    conversationId: origin.conversationId ?? undefined, info,
    properties: { ...memory.properties, info } };
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function nativeTurnId(memory: MemoryRow): string | undefined {
  const trace = memory.properties.internal_info.trace;
  return text(memory.info.turn_id) ?? (isRecord(trace) ? text(trace.turn_id) : undefined);
}

/** No mutable Session fields are used to reconstruct a historical origin. */
export function resolveNativeIdentity(db: Database.Database, memory: MemoryRow, allowHostConversation = false): NativeIdentity | undefined {
  const turn = nativeTurnId(memory);
  if (!turn) return undefined;
  if (Object.hasOwn(memory.info, "native_origin_v1")) {
    const origin = readNativeOrigin(memory.info.native_origin_v1);
    return origin ? nativeIdentity(db, origin, turn, allowHostConversation) : undefined;
  }
  const trace = memory.properties.internal_info.trace;
  const rawId = text(memory.info.raw_turn_id) ?? (isRecord(trace) ? text(trace.raw_turn_id) : undefined);
  const raw = rawId ? db.prepare("SELECT message_payload_json FROM raw_turns WHERE id=?").get(rawId) as
    { message_payload_json: string } | undefined : undefined;
  const rawOrigin = readNativeOrigin(parseJson<Record<string, unknown>>(raw?.message_payload_json, {}).native_origin_v1);
  if (rawOrigin) return nativeIdentity(db, rawOrigin, turn, allowHostConversation);
  // A Session+turn match alone is insufficient after scope reuse. Require a
  // durable reference to this memory or its raw turn, including old input traces.
  const linkedRawIds = db.prepare("SELECT raw_turn_id FROM l3_world_model_input_traces WHERE l1_memory_id=?")
    .pluck().all(memory.id) as string[];
  if (rawId) linkedRawIds.push(rawId);
  const captures = db.prepare(`SELECT source,profile_id,conversation_id,namespace_key FROM source_turn_captures
    WHERE turn_id=? AND (raw_turn_id IN (SELECT value FROM json_each(?))
      OR json_extract(response_json,'$.legacyImportMemoryId')=?
      OR EXISTS (SELECT 1 FROM json_each(response_json,'$.result.l1MemoryIds') WHERE value=?))`)
    .all(turn, JSON.stringify(linkedRawIds), memory.id, memory.id) as Array<{
      source: string; profile_id: string; conversation_id: string; namespace_key: string;
    }>;
  const identities = new Map<string, NativeIdentity>();
  for (const row of captures) {
    const identity = { source: normalizeMemoryCaptureSource(row.source), profileId: row.profile_id,
      conversationId: row.conversation_id, namespaceKey: canonicalNamespaceKey(db, row.namespace_key), turnId: turn };
    if (memory.agentId && normalizeMemoryCaptureSource(memory.agentId) !== identity.source) return undefined;
    if (memory.conversationId && memory.conversationId !== identity.conversationId) return undefined;
    if (text(memory.info.profile_id) && memory.info.profile_id !== identity.profileId) return undefined;
    identities.set(stableHash(identity), identity);
  }
  return identities.size === 1 ? [...identities.values()][0] : undefined;
}
