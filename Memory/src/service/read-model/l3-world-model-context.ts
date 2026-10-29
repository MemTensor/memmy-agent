import {
  renderL3WorldModelFields,
  type SessionL3WorldModelContextResponse
} from "../../contracts/index.js";
import { fieldsFromL3WorldModelMemory } from "../../storage/repositories.js";
import type { Repositories, SessionRecord } from "../../storage/repositories.js";
import { nowIso } from "../../utils/time.js";

export class L3WorldModelContextReadModel {
  constructor(private readonly repos: Repositories) {}

  load(session: SessionRecord): SessionL3WorldModelContextResponse {
    const projectId = session.projectId ?? null;
    const memories = this.repos.l3WorldModels.sharedMemories(projectId);
    if (!memories.length) return emptyResponse(projectId);
    const records = memories.map(memory => {
      const fields = fieldsFromL3WorldModelMemory(memory);
      const storedProject = typeof memory.info.project_id === "string" ? memory.info.project_id : null;
      if (storedProject && fields.projectEnvironmentProfile !== null && !this.environmentProfileIsApplied(
        memory.userId, storedProject, memory.info.project_environment_applied_scan_id
      )) fields.projectEnvironmentProfile = null;
      return { memory, fields };
    });
    // A read projection only: retain each historical record and its ordering.
    // Never seed/merge the writable device scope with these historical fields.
    const field = (key: keyof typeof records[number]["fields"]) => {
      const values = records.map(record => record.fields[key]).filter((value): value is string => value !== null);
      return values.length ? values.join("\n\n") : null;
    };
    const fields = {
      generalRulesAndSafetyConstraints: field("generalRulesAndSafetyConstraints"),
      projectEnvironmentProfile: field("projectEnvironmentProfile"),
      projectContract: field("projectContract"),
      domainKnowledge: field("domainKnowledge")
    };
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

  private environmentProfileIsApplied(
    userId: string,
    projectId: string,
    memoryScanId: unknown
  ): boolean {
    if (typeof memoryScanId !== "string" || !memoryScanId) return false;
    const row = this.repos.db.prepare(
      `SELECT applied_scan_id
       FROM l3_world_model_project_environment_state
       WHERE user_id = ? AND project_id = ?`
    ).get(userId, projectId) as { applied_scan_id: string | null } | undefined;
    return row?.applied_scan_id === memoryScanId;
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
