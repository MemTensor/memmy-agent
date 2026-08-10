import type { MemoryProvenance, RuntimeNamespace } from "../../types.js";
import { newId } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import { namespaceIdFromContext, normalizeNamespace } from "../namespace/namespace-scope.js";
import type {
  ProjectContextProposeGoalRequest,
  ProjectContextReadState,
  ProjectContextRequest,
  ProjectContextServiceOptions,
  ProjectContextStableResult,
  ProjectFactRecord,
  ProjectGoalRecord,
  ProjectWorkItemRecord,
  ProjectWorkItemStatus
} from "./project-context-types.js";

export interface ProjectGoalDecisionRequest extends ProjectContextRequest {
  candidateId: string;
}

export interface ProjectWorkItemCreateRequest extends ProjectContextRequest {
  goalId?: string;
  title: string;
  summary: string;
  nextStep: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  status?: ProjectWorkItemStatus;
  sourceMemoryIds?: string[];
  provenance?: Partial<MemoryProvenance> & Record<string, unknown>;
}

export interface ProjectWorkItemUpdateRequest extends ProjectContextRequest {
  workItemId: string;
  goalId?: string | null;
  title?: string | null;
  summary?: string | null;
  nextStep?: string | null;
  acceptanceCriteria?: string[] | null;
  constraints?: string[] | null;
  status?: ProjectWorkItemStatus | null;
  sourceMemoryIds?: string[] | null;
  provenance?: (Partial<MemoryProvenance> & Record<string, unknown>) | null;
}

export interface ProjectWorkItemSelectRequest extends ProjectContextRequest {
  workItemId: string | null;
}


export class ProjectContextService {
  private readonly now: () => string;
  private static readonly MIN_RENDER_BUDGET = 120;
  private readonly id: (prefix: string) => string;

  constructor(private readonly options: ProjectContextServiceOptions) {
    this.now = options.now ?? nowIso;
    this.id = options.id ?? newId;
  }

  read(namespace: RuntimeNamespace): ProjectContextReadState {
    const namespaceId = this.namespaceId(namespace);
    return {
      namespaceId,
      activeGoal: this.options.repositories.projectContext.getActiveGoal(namespaceId),
      goals: this.options.repositories.projectContext.listGoals(namespaceId),
      workItems: this.options.repositories.projectContext.listWorkItems(namespaceId),
      focusedWorkItem: this.options.repositories.projectContext.getFocusedWorkItem(namespaceId),
      facts: this.options.repositories.projectContext.listActiveFacts(namespaceId)
    };
  }

  proposeGoal(request: ProjectContextProposeGoalRequest): ProjectGoalRecord {
    const namespace = normalizeNamespace(request.namespace);
    const at = this.now();
    const activeVersion = this.options.repositories.projectContext.getActiveGoal(this.namespaceId(namespace))?.version ?? 0;
    return this.options.repositories.projectContext.insertGoal({
      ...identity(namespace),
      id: this.id("project_goal"),
      title: required(request.title, "goal title"),
      summary: request.summary.trim(),
      detail: request.detail,
      acceptanceCriteria: cleanList(request.acceptanceCriteria),
      constraints: cleanList(request.constraints),
      status: "candidate",
      version: activeVersion,
      sourceMemoryIds: uniq(request.sourceMemoryIds),
      provenance: request.provenance ?? {},
      createdAt: at,
      updatedAt: at
    });
  }

  approveGoal(request: ProjectGoalDecisionRequest): ProjectGoalRecord {
    const namespaceId = this.namespaceId(request.namespace);
    const candidate = this.requireCandidate(request.candidateId, namespaceId);
    const at = this.now();
    return this.options.repositories.transaction(() => {
      const current = this.options.repositories.projectContext.getActiveGoal(namespaceId);
      const version = (current?.version ?? 0) + 1;
      this.options.repositories.projectContext.archiveGoalCandidate(candidate.id, namespaceId, at);
      const active: ProjectGoalRecord = {
        ...candidate,
        id: this.id("project_goal"),
        status: "active",
        version,
        supersedesId: current?.id,
        createdAt: at,
        updatedAt: at
      };
      return current
        ? this.options.repositories.projectContext.replaceActiveGoal(active)
        : this.options.repositories.projectContext.insertGoal(active);
    });
  }

  rejectGoal(request: ProjectGoalDecisionRequest): ProjectGoalRecord {
    const namespaceId = this.namespaceId(request.namespace);
    this.requireCandidate(request.candidateId, namespaceId);
    return this.options.repositories.projectContext.archiveGoalCandidate(request.candidateId, namespaceId, this.now());
  }

  createWorkItem(request: ProjectWorkItemCreateRequest): ProjectWorkItemRecord {
    const namespace = normalizeNamespace(request.namespace);
    const at = this.now();
    return this.options.repositories.projectContext.insertWorkItem({
      ...identity(namespace),
      id: this.id("project_work_item"),
      goalId: request.goalId,
      title: required(request.title, "work item title"),
      summary: request.summary.trim(),
      nextStep: request.nextStep.trim(),
      acceptanceCriteria: cleanList(request.acceptanceCriteria),
      constraints: cleanList(request.constraints),
      status: request.status ?? "pending",
      focused: false,
      sourceMemoryIds: uniq(request.sourceMemoryIds),
      provenance: request.provenance ?? {},
      createdAt: at,
      updatedAt: at
    });
  }

  updateWorkItem(request: ProjectWorkItemUpdateRequest): ProjectWorkItemRecord {
    const namespaceId = this.namespaceId(request.namespace);
    const stored = this.options.repositories.projectContext.listWorkItems(namespaceId).find((item) => item.id === request.workItemId);
    if (!stored) throw new Error(`work item not found in namespace: ${request.workItemId}`);
    const status = request.status === undefined || request.status === null ? stored.status : request.status;
    const next: ProjectWorkItemRecord = {
      ...stored,
      goalId: patchOptional(stored.goalId, request.goalId),
      title: patchString(stored.title, request.title),
      summary: patchString(stored.summary, request.summary),
      nextStep: patchString(stored.nextStep, request.nextStep),
      acceptanceCriteria: patchList(stored.acceptanceCriteria, request.acceptanceCriteria),
      constraints: patchList(stored.constraints, request.constraints),
      status,
      focused: status === "completed" || status === "archived" ? false : stored.focused,
      sourceMemoryIds: patchList(stored.sourceMemoryIds, request.sourceMemoryIds),
      provenance: request.provenance === undefined ? stored.provenance : request.provenance ?? {},
      updatedAt: this.now()
    };
    return this.options.repositories.projectContext.updateWorkItem(next);
  }

  selectWorkItem(request: ProjectWorkItemSelectRequest): ProjectWorkItemRecord | undefined {
    return this.options.repositories.projectContext.setFocusedWorkItem(this.namespaceId(request.namespace), request.workItemId, this.now());
  }

  renderStable(namespace: RuntimeNamespace, budget = 4_000): ProjectContextStableResult {
    if (budget < ProjectContextService.MIN_RENDER_BUDGET) {
      throw new RangeError(`project context render budget must be at least ${ProjectContextService.MIN_RENDER_BUDGET}`);
    }
    const state = this.read(namespace);
    const generatedAt = this.now();
    if (!state.activeGoal) {
      const noGoal = `<memmy_project_context version="0" status="no_confirmed_goal">\nNo confirmed project goal.\n</memmy_project_context>`;
      return {
        namespaceId: state.namespaceId,
        status: "no_confirmed_goal",
        version: 0,
        goal: null,
        focusedWorkItem: null,
        facts: state.facts,
        markdown: noGoal.length <= budget ? noGoal : fitNoGoal(budget),
        sourceMemoryIds: [],
        generatedAt
      };
    }
    const conflictKeys = conflictingFactKeys(state.facts);
    const status = conflictKeys.size > 0 ? "conflict" : "ready";
    const authoritativeFacts = state.facts.filter((fact) => !conflictKeys.has(factKey(fact)));
    const markdown = fitSections(
      state.activeGoal.version,
      status,
      renderSections(state.activeGoal, state.focusedWorkItem ?? null, authoritativeFacts),
      budget
    );
    return {
      namespaceId: state.namespaceId,
      status,
      version: state.activeGoal.version,
      goal: state.activeGoal,
      focusedWorkItem: state.focusedWorkItem ?? null,
      facts: state.facts,
      markdown,
      sourceMemoryIds: uniq([
        ...state.activeGoal.sourceMemoryIds,
        ...(state.focusedWorkItem?.sourceMemoryIds ?? []),
        ...state.facts.flatMap((fact) => fact.sourceMemoryIds)
      ]),
      generatedAt
    };
  }

  private namespaceId(namespace: RuntimeNamespace): string {
    return namespaceIdFromContext(namespace);
  }

  private requireCandidate(id: string, namespaceId: string): ProjectGoalRecord {
    const goal = this.options.repositories.projectContext.getGoal(id);
    if (!goal || goal.namespaceId !== namespaceId) throw new Error("project goal namespace mismatch");
    if (goal.status !== "candidate") throw new Error("project goal is not a candidate");
    return goal;
  }
}

function identity(namespace: RuntimeNamespace & { userId: string; source: string; profileId: string }) {
  return {
    namespaceId: namespaceIdFromContext(namespace),
    userId: namespace.userId,
    projectId: namespace.projectId,
    workspaceId: namespace.workspaceId,
    workspacePath: namespace.workspacePath
  };
}

function renderSections(
  goal: ProjectGoalRecord,
  focus: ProjectWorkItemRecord | null,
  facts: ProjectFactRecord[]
): RenderSection[] {
  const constraints = uniq([...goal.constraints, ...facts.filter((fact) => fact.kind === "constraint").map((fact) => fact.content)]);
  const decisions = facts.filter((fact) => fact.kind === "decision").map((fact) => fact.content);
  const acceptance = uniq([...goal.acceptanceCriteria, ...(focus?.acceptanceCriteria ?? [])]);
  return [
    { label: "Constraint:", value: constraints.join("; ") || "none" },
    { label: "Goal:", value: goal.title },
    { label: "Goal summary:", value: goal.summary },
    { label: "Goal status:", value: `${goal.status}; version=${goal.version}` },
    { label: "Focus:", value: focus?.title ?? "No work item is explicitly focused." },
    { label: "Focus summary:", value: focus?.summary ?? "none" },
    { label: "Focus status:", value: focus?.status ?? "none" },
    { label: "Next step:", value: focus?.nextStep ?? "none" },
    { label: "Acceptance:", value: acceptance.join("; ") || "none" },
    { label: "Decision:", value: decisions.join("; ") || "none" },
    { label: "Metadata:", value: `goal_id=${goal.id}; namespace_id=${goal.namespaceId}; project_id=${goal.projectId ?? "none"}; workspace_id=${goal.workspaceId ?? "none"}; confirmed_updated_at=${goal.updatedAt}` }
  ];
}

interface RenderSection {
  label: string;
  value: string;
}

function fitSections(version: number, status: ProjectContextStableResult["status"], sections: RenderSection[], budget: number): string {
  const open = `<memmy_project_context version="${version}" status="${status}">`;
  const close = "</memmy_project_context>";
  const normal = [open, ...sections.map((section) => `${section.label} ${section.value}`), close].join("\n");
  if (normal.length <= budget) return normal;

  const section = (label: string) => sections.find((candidate) => candidate.label === label)?.value ?? "none";
  const updatedAt = /(?:^|; )confirmed_updated_at=([^;]+)/.exec(section("Metadata:"))?.[1] ?? "unknown";
  const values = [
    section("Goal:"),
    section("Constraint:"),
    section("Focus status:"),
    section("Focus:"),
    section("Next step:"),
    section("Acceptance:"),
    updatedAt
  ];
  const fixedLength = [open, "G=", "C=", "W=||", "A=", "U=", close].join("\n").length;
  const lengths = fairLengths(values, fixedLength, budget);
  return [
    open,
    `G=${values[0]!.slice(0, lengths[0])}`,
    `C=${values[1]!.slice(0, lengths[1])}`,
    `W=${values[2]!.slice(0, lengths[2])}|${values[3]!.slice(0, lengths[3])}|${values[4]!.slice(0, lengths[4])}`,
    `A=${values[5]!.slice(0, lengths[5])}`,
    `U=${values[6]!.slice(0, lengths[6])}`,
    close
  ].join("\n");
}

function fairLengths(values: string[], fixedLength: number, budget: number): number[] {
  const lengths = values.map(() => 0);
  let remaining = budget - fixedLength;
  while (remaining > 0) {
    let allocated = false;
    for (let index = 0; index < values.length && remaining > 0; index += 1) {
      if (lengths[index]! >= values[index]!.length) continue;
      lengths[index]! += 1;
      remaining -= 1;
      allocated = true;
    }
    if (!allocated) break;
  }
  return lengths;
}

function fitNoGoal(budget: number): string {
  const open = '<memmy_project_context version="0" status="no_confirmed_goal">';
  const close = "</memmy_project_context>";
  const available = budget - open.length - close.length - 2;
  return `${open}\n${"No confirmed project goal.".slice(0, Math.max(0, available))}\n${close}`;
}

function conflictingFactKeys(facts: ProjectFactRecord[]): Set<string> {
  const values = new Map<string, Set<string>>();
  for (const fact of facts) {
    const key = factKey(fact);
    const group = values.get(key) ?? new Set<string>();
    group.add(fact.content.trim().toLowerCase());
    values.set(key, group);
  }
  return new Set([...values].filter(([, group]) => group.size > 1).map(([key]) => key));
}

function factKey(fact: ProjectFactRecord): string {
  const content = fact.content.trim().toLowerCase();
  const separator = content.indexOf(":");
  const domain = separator >= 0 ? content.slice(0, separator).trim() : content;
  return `${fact.kind}:${domain}`;
}

function required(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${label} is required`);
  return clean;
}

function bounded(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, Math.max(0, max));
  return `${value.slice(0, max - 3).trimEnd()}...`;
}

function cleanList(values: string[] | undefined): string[] {
  return uniq((values ?? []).map((value) => value.trim()).filter(Boolean));
}

function uniq(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function patchString(current: string, value: string | null | undefined): string {
  return value === undefined ? current : value?.trim() ?? "";
}

function patchList(current: string[], value: string[] | null | undefined): string[] {
  return value === undefined ? current : cleanList(value ?? []);
}

function patchOptional(current: string | undefined, value: string | null | undefined): string | undefined {
  return value === undefined ? current : value ?? undefined;
}
