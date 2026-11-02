import {
  renderL3WorldModelFields,
  type SessionL3WorldModelContextResponse
} from "../../contracts/index.js";
import type { Repositories, SessionRecord } from "../../storage/repositories.js";
import { nowIso } from "../../utils/time.js";

export class L3WorldModelContextReadModel {
  constructor(private readonly repos: Repositories) {}

  load(session: SessionRecord): SessionL3WorldModelContextResponse {
    const projectId = session.projectId ?? null;
    const { fields, memories } = this.repos.l3WorldModels.effectiveFields(projectId);
    if (!memories.length) return emptyResponse(projectId);
    const representative = memories[0]!;
    return {
      schemaVersion: 2,
      projectId,
      // Preserve the strict v2 wire shape and a real representative record ID.
      // Shared-context caches must also compare rendered content and evidence.
      memoryId: representative.id,
      memoryVersion: representative.version,
      renderedContext: renderL3WorldModelFields(fields),
      sourceMemoryIds: [...new Set(memories.flatMap(memory =>
        sourceMemoryIdsFromL3(memory.properties.internal_info.source_memory_ids)))],
      ...fields,
      serverTime: nowIso()
    };
  }

}

function emptyResponse(projectId: string | null): SessionL3WorldModelContextResponse {
  return {
    schemaVersion: 2,
    projectId,
    memoryId: null,
    memoryVersion: null,
    renderedContext: "",
    sourceMemoryIds: [],
    generalRulesAndSafetyConstraints: null,
    projectEnvironmentProfile: null,
    projectContract: null,
    domainKnowledge: null,
    serverTime: nowIso()
  };
}

function sourceMemoryIdsFromL3(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item))
    : [];
}
