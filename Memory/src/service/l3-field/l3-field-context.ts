import type { SessionL3WorldModelContextResponse } from "../../contracts/index.js";
import type { Repositories, SessionRecord } from "../../storage/repositories.js";
import { nowIso } from "../../utils/time.js";
import { findSessionUnits, resolveSessionUnits, type L3FieldEnvironment } from "./session-units.js";
import type { L3ItemRecord, L3UnitRecord, ProjectIdentitySource } from "./types.js";

const SOURCE_LABEL: Record<ProjectIdentitySource, string> = {
  user_selected: "用户选定",
  git: "git 仓库",
  folder: "文件夹"
};

/**
 * Session-start context for the new L3: this machine (profile and facts) and,
 * when the session folder is a project, that project (profile, facts and
 * constraints). The response keeps the schema-2 shape hooks already consume.
 * With `readOnly` (memory writes are off) nothing is created or rewritten: units and snapshots
 * that do not exist yet are simply not shown.
 */
export function loadL3FieldContext(
  repos: Repositories,
  env: L3FieldEnvironment,
  session: SessionRecord,
  options: { readOnly?: boolean } = {}
): SessionL3WorldModelContextResponse {
  const units = options.readOnly ? findSessionUnits(repos, env, session) : (() => {
    const resolved = resolveSessionUnits(repos, env, session);
    return { machine: resolved.machine, project: resolved.project?.unit };
  })();
  // A unit whose snapshot the user archived is not injected, like an archived old-L3 world model.
  const archived = (unit: L3UnitRecord) =>
    Boolean(unit.snapshotMemoryId && repos.memories.get(unit.snapshotMemoryId)?.status === "archived");
  const machine = units.machine && !archived(units.machine) ? units.machine : null;
  const projectUnit = units.project && !archived(units.project) ? units.project : null;
  const machineItems = machine ? repos.l3Field.activeItems(machine.unitKey) : [];
  const projectItems = projectUnit ? repos.l3Field.activeItems(projectUnit.unitKey) : [];

  const machineFacts = bulletList(machineItems, "env_fact");
  const projectFacts = bulletList(projectItems, "env_fact");
  const constraints = bulletList(projectItems, "project_constraint");
  const machineProfile = trimmed(machine?.profileText);
  const projectProfile = trimmed(projectUnit?.profileText);
  const hasContent = Boolean(machineProfile || machineFacts || projectProfile || projectFacts || constraints);
  // Clients treat projectId as the session's own project id, so it keeps that meaning.
  const projectId = session.projectId ?? null;
  if (!hasContent) return emptyResponse(projectId);

  const sections = [
    projectUnit
      ? `当前项目：${projectUnit.displayName ?? projectUnit.projectIdentity}（${SOURCE_LABEL[projectUnit.identitySource ?? "folder"]}）`
      : "当前项目：无",
    section("本机环境画像", machineProfile),
    section("本机环境事实", machineFacts),
    section("项目环境画像", projectProfile),
    section("项目环境事实", projectFacts),
    section("项目约束", constraints)
  ].filter(Boolean);

  // The version hooks cache on belongs to the project snapshot when there is a project; machine
  // changes bump every project snapshot on the same machine, so this version still moves.
  const snapshotUnit = (projectUnit ?? units.machine)!;
  const stored = snapshotUnit.snapshotMemoryId ? repos.memories.get(snapshotUnit.snapshotMemoryId) : undefined;
  const snapshot = stored ?? (options.readOnly ? undefined : repos.l3Field.refreshSnapshot(snapshotUnit.unitKey));

  return {
    schemaVersion: 2,
    projectId,
    memoryId: snapshot?.id ?? null,
    memoryVersion: snapshot?.version ?? null,
    renderedContext: sections.join("\n\n"),
    sourceMemoryIds: [...new Set([...machineItems, ...projectItems].flatMap((item) => item.evidence.l1MemoryIds))],
    generalRulesAndSafetyConstraints: null,
    projectEnvironmentProfile: [machineProfile, projectProfile].filter(Boolean).join("\n\n") || null,
    projectContract: constraints,
    domainKnowledge: [machineFacts, projectFacts].filter(Boolean).join("\n") || null,
    serverTime: nowIso()
  };
}

function bulletList(items: readonly L3ItemRecord[], kind: L3ItemRecord["kind"]): string | null {
  const lines = items.filter((item) => item.kind === kind).map((item) => `- ${item.content}`);
  return lines.length ? lines.join("\n") : null;
}

function section(title: string, body: string | null): string | null {
  return body ? `## ${title}\n${body}` : null;
}

function trimmed(value: string | null | undefined): string | null {
  return value?.trim() ? value.trim() : null;
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
