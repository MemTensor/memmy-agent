import { stableHash } from "../../src/utils/id.js";
import { sanitizeMemmyProtocolText } from "../../src/utils/memmy-context-tags.js";
import { firstLine } from "../../src/utils/text.js";
import type { MemoryService } from "../../src/service/memory-service.js";
import type { Repositories } from "../../src/storage/repositories.js";
import type { MemoryAddRequest, MemoryRow } from "../../src/types.js";

/** Replays old normalization, body copies and persistence under the real request pipeline. */
export function withLegacyImportedSkillWriter<T>(service: MemoryService, run: () => T, options: { memoryKey?: string } = {}): T {
  const host = service as unknown as {
    repos: Repositories;
    agentSkills: { upsertMemoryAdd(memory: MemoryRow, at: string): { memory: MemoryRow; created: boolean; previous?: MemoryRow } };
  };
  const original = host.agentSkills.upsertMemoryAdd;
  const originalAdd = service.addMemory;
  let observed: MemoryAddRequest | undefined;
  service.addMemory = request => {
    observed = request;
    // The historical processor classified every Skill as an import and inferred
    // its source Agent, even for the plugin tool's manual request shape.
    return originalAdd.call(service, request.layer === "Skill"
      ? { ...request, sourceAgentId: request.sourceAgentId || request.source || request.namespace?.source }
      : request);
  };
  host.agentSkills.upsertMemoryAdd = (memory, at) => {
    // Freeze the old writer's duplicated body and lack of raw-byte proof too.
    const storedContent = sanitizeMemmyProtocolText(memory.memoryValue);
    const tags = [...new Set(["manual", ...(observed?.source ? [observed.source] : []), ...(observed?.tags ?? [])])];
    const title = observed?.title?.trim() || firstLine(storedContent).slice(0, 120) || "Untitled memory";
    const info: MemoryRow["info"] = { ...memory.info, title, tags, summary: firstLine(storedContent) };
    const internal: MemoryRow["properties"]["internal_info"] = { ...memory.properties.internal_info, summary: firstLine(storedContent), title, name: title };
    delete internal.source_raw_content_hash;
    delete internal.source_kind;
    internal.invocation_guide = storedContent;
    internal.procedure_json = { summary: storedContent };
    internal.skill = { ...(internal.skill as Record<string, unknown>), name: title, invocation_guide: storedContent,
      procedure_json: { summary: storedContent } };
    const identity = internal.source_skill_id || internal.source_skill_path;
    const legacyKey = memory.memoryKey?.startsWith("skill.import:") && identity
      ? `skill.import:${stableHash([internal.source_agent_id, identity, internal.source_content_hash]).slice(0, 20)}`
      : memory.memoryKey?.startsWith("manual:")
        ? `manual:${stableHash(`Skill:${String(info.title)}:${storedContent}`).slice(0, 20)}` : memory.memoryKey;
    memory = { ...memory, memoryKey: options.memoryKey ?? legacyKey, memoryValue: storedContent, tags,
      contentHash: stableHash(storedContent), info,
      properties: { ...memory.properties, tags, info: { ...memory.properties.info, ...info }, internal_info: internal } };
    const upsert = host.repos.memories.upsertByKey(memory);
    if (upsert.created && identity) host.repos.memories.archivePriorReadOnlySkillVersions({
      sourceAgentId: String(internal.source_agent_id), sourceSkillIdentity: String(identity),
      currentMemoryId: upsert.memory.id, at: memory.timeline ?? at
    });
    return upsert;
  };
  try {
    return run();
  } finally {
    host.agentSkills.upsertMemoryAdd = original;
    service.addMemory = originalAdd;
  }
}
