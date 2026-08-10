import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MemoryDb,
  MemoryService,
  ProjectContextService,
  type ProjectContextProposeGoalRequest,
  type RuntimeNamespace
} from "../../../src/index.js";
import { Repositories } from "../../../src/storage/repositories.js";
import type { ProjectFactRecord } from "../../../src/service/project-context/project-context-types.js";
import { namespaceIdFromContext } from "../../../src/service/namespace/namespace-scope.js";

const NOW = "2026-08-10T12:00:00.000Z";
const ALPHA: RuntimeNamespace = { source: "codex", profileId: "default", tenantId: "tenant-a", userId: "user-a", projectId: "alpha" };
const BETA: RuntimeNamespace = { ...ALPHA, projectId: "beta" };

function proposal(namespace: RuntimeNamespace = ALPHA, overrides: Partial<ProjectContextProposeGoalRequest> = {}): ProjectContextProposeGoalRequest {
  return {
    namespace,
    title: "Ship durable project context",
    summary: "Keep the approved project goal available on every turn.",
    detail: "Full authoritative implementation detail.",
    acceptanceCriteria: ["Approved context renders", "Candidates stay hidden"],
    constraints: ["Do not infer user intent"],
    sourceMemoryIds: ["memory-a"],
    provenance: { sourceAgent: "codex", capturedAt: NOW, sourceMemoryIds: ["memory-a"] },
    ...overrides
  };
}

function withContext<T>(run: (context: { service: ProjectContextService; memory: MemoryService; repos: Repositories }) => T): T {
  const root = mkdtempSync(join(tmpdir(), "project-context-service-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  const repos = new Repositories(db.db);
  try {
    return run({ service: new ProjectContextService({ repositories: repos, now: () => NOW }), memory: new MemoryService({ db, mode: "dev" }), repos });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function approve(service: ProjectContextService, input = proposal()) {
  const candidate = service.proposeGoal(input);
  return service.approveGoal({ namespace: input.namespace, candidateId: candidate.id });
}

function insertFact(repos: Repositories, overrides: Partial<ProjectFactRecord> = {}): ProjectFactRecord {
  return repos.projectContext.insertFact({
    id: overrides.id ?? `fact-${Math.random()}`,
    namespaceId: overrides.namespaceId ?? namespaceIdFromContext(ALPHA),
    userId: "user-a",
    projectId: "alpha",
    kind: "constraint",
    content: "runtime: node 22",
    status: "active",
    sourceMemoryIds: [],
    provenance: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  });
}

describe("ProjectContextService", () => {
  it("returns the exact no_confirmed_goal status when no goal is approved", () => withContext(({ service }) => {
    const candidate = service.proposeGoal(proposal());
    const stable = service.renderStable(ALPHA);
    expect(candidate.status).toBe("candidate");
    expect(stable.status).toBe("no_confirmed_goal");
    expect(stable.goal).toBeNull();
    expect(stable.focusedWorkItem).toBeNull();
    expect(stable.markdown).toContain('status="no_confirmed_goal"');
    expect(stable.markdown).toContain("No confirmed project goal");
    expect(stable.markdown).not.toContain(candidate.title);
  }));

  it("renders an approved goal even for an unrelated prompt", () => withContext(({ service }) => {
    const active = approve(service);
    const stable = service.renderStable(ALPHA);
    expect(stable.status).toBe("ready");
    expect(stable.goal).toEqual(active);
    expect(stable.markdown).toContain("Ship durable project context");
  }));

  it("returns full stable records while bounding only markdown", () => withContext(({ service }) => {
    const detail = "implementation detail ".repeat(500);
    const active = approve(service, proposal(ALPHA, { detail, summary: "summary ".repeat(200) }));
    expect(service.read(ALPHA).activeGoal?.detail).toBe(detail);
    const stable = service.renderStable(ALPHA);
    expect(stable.goal).toEqual(active);
    expect(stable.goal?.detail).toBe(detail);
    expect(stable.markdown).not.toContain(detail);
  }));

  it("changes focus explicitly without mutating the goal", () => withContext(({ service }) => {
    const goal = approve(service);
    const first = service.createWorkItem({ namespace: ALPHA, goalId: goal.id, title: "First", summary: "First item", nextStep: "Do first" });
    const second = service.createWorkItem({ namespace: ALPHA, goalId: goal.id, title: "Second", summary: "Second item", nextStep: "Do second" });
    expect(service.read(ALPHA).focusedWorkItem).toBeUndefined();
    service.selectWorkItem({ namespace: ALPHA, workItemId: first.id });
    service.selectWorkItem({ namespace: ALPHA, workItemId: second.id });
    const state = service.read(ALPHA);
    expect(state.activeGoal).toEqual(goal);
    expect(state.focusedWorkItem?.id).toBe(second.id);
    expect(state.workItems.find((item) => item.id === first.id)?.focused).toBe(false);
  }));

  it("clears focus when the focused work item becomes terminal", () => withContext(({ service }) => {
    const goal = approve(service);
    const item = service.createWorkItem({ namespace: ALPHA, goalId: goal.id, title: "Item", summary: "Summary", nextStep: "Next" });
    service.selectWorkItem({ namespace: ALPHA, workItemId: item.id });

    const completed = service.updateWorkItem({ namespace: ALPHA, workItemId: item.id, status: "completed" });

    expect(completed.focused).toBe(false);
    expect(service.read(ALPHA).focusedWorkItem).toBeUndefined();
    expect(service.renderStable(ALPHA).markdown).toContain("No work item is explicitly focused");
  }));

  it("supports explicit focus clearing and renders a no-focus reminder", () => withContext(({ service }) => {
    const goal = approve(service);
    const item = service.createWorkItem({ namespace: ALPHA, goalId: goal.id, title: "Item", summary: "Summary", nextStep: "Next" });
    service.selectWorkItem({ namespace: ALPHA, workItemId: item.id });
    service.selectWorkItem({ namespace: ALPHA, workItemId: null });
    const stable = service.renderStable(ALPHA);
    expect(stable.focusedWorkItem).toBeNull();
    expect(stable.markdown).toContain("No work item is explicitly focused");
  }));

  it("supersedes the active goal with monotonically increasing versions", () => withContext(({ service }) => {
    const first = approve(service);
    const candidate = service.proposeGoal(proposal(ALPHA, { title: "Second goal" }));
    const second = service.approveGoal({ namespace: ALPHA, candidateId: candidate.id });
    const state = service.read(ALPHA);
    expect(first.version).toBe(1);
    expect(second).toMatchObject({ version: 2, supersedesId: first.id, status: "active" });
    expect(state.activeGoal?.id).toBe(second.id);
    expect(state.goals.find((goal) => goal.id === first.id)?.status).toBe("archived");
    expect(state.goals.find((goal) => goal.id === candidate.id)?.status).toBe("archived");
  }));

  it("does not let candidates consume approval versions", () => withContext(({ service }) => {
    const firstCandidate = service.proposeGoal(proposal(ALPHA, { title: "First candidate" }));
    service.proposeGoal(proposal(ALPHA, { title: "Other candidate" }));
    const first = service.approveGoal({ namespace: ALPHA, candidateId: firstCandidate.id });
    service.proposeGoal(proposal(ALPHA, { title: "Unapproved candidate" }));
    const secondCandidate = service.proposeGoal(proposal(ALPHA, { title: "Second approved" }));
    const second = service.approveGoal({ namespace: ALPHA, candidateId: secondCandidate.id });
    expect([first.version, second.version]).toEqual([1, 2]);
  }));

  it("rejects and archives only the named candidate", () => withContext(({ service }) => {
    const active = approve(service);
    const rejected = service.proposeGoal(proposal(ALPHA, { title: "Rejected goal" }));
    const retained = service.proposeGoal(proposal(ALPHA, { title: "Retained candidate" }));
    expect(service.rejectGoal({ namespace: ALPHA, candidateId: rejected.id }).status).toBe("archived");
    const state = service.read(ALPHA);
    expect(state.activeGoal?.id).toBe(active.id);
    expect(state.goals.find((goal) => goal.id === retained.id)?.status).toBe("candidate");
  }));

  it.each([120, 240])("renders mandatory compact context deterministically within a %i-character budget", (budget) => withContext(({ service, repos }) => {
    const long = (value: string) => `${value} ${"extended context ".repeat(100)}`;
    const goal = approve(service, proposal(ALPHA, {
      title: long("Goal title"),
      summary: long("Goal summary"),
      constraints: [long("goal constraint")],
      acceptanceCriteria: [long("acceptance criterion")]
    }));
    const item = service.createWorkItem({
      namespace: ALPHA,
      goalId: goal.id,
      title: long("Focused item"),
      summary: long("Focused summary"),
      nextStep: long("Focused next step"),
      acceptanceCriteria: [long("work acceptance")],
      status: "active"
    });
    service.selectWorkItem({ namespace: ALPHA, workItemId: item.id });
    insertFact(repos, { id: "constraint", kind: "constraint", content: long("runtime: node 22") });
    insertFact(repos, { id: "decision", kind: "decision", content: long("storage: sqlite") });

    const constrained = service.renderStable(ALPHA, budget);

    expect(service.renderStable(ALPHA, budget).markdown).toBe(constrained.markdown);
    expect(constrained.markdown).toMatch(/^<memmy_project_context[^>]*>\n/);
    expect(constrained.markdown).toMatch(/\nG=.+/);
    expect(constrained.markdown).toMatch(/\nC=.+/);
    expect(constrained.markdown).toMatch(/\nW=.+\|.+\|.+/);
    expect(constrained.markdown).toMatch(/\nA=.+/);
    expect(constrained.markdown).toMatch(/\nU=.+/);
    expect(constrained.markdown).toMatch(/\n<\/memmy_project_context>$/);
    expect(constrained.markdown).not.toContain("Decision:");
    expect(constrained.markdown).not.toContain("Metadata:");
    expect(constrained.markdown.length).toBeLessThanOrEqual(budget);
    expect(constrained.goal).toEqual(goal);
    expect(constrained.focusedWorkItem).toEqual({ ...item, focused: true });
    expect(constrained.facts).toHaveLength(2);
  }));

  it("bounds the no-goal marker at the minimum supported budget", () => withContext(({ service }) => {
    const stable = service.renderStable(ALPHA, 120);
    expect(stable.markdown).toContain('status="no_confirmed_goal"');
    expect(stable.markdown.length).toBeLessThanOrEqual(120);
  }));

  it("rejects budgets below the documented minimum", () => withContext(({ service }) => {
    expect(() => service.renderStable(ALPHA, 119)).toThrow(/at least 120/);
  }));

  it("marks conflicts, preserves their facts for review, and excludes them from authoritative prose", () => withContext(({ service, repos }) => {
    approve(service);
    insertFact(repos, { id: "node-20", content: "runtime: node 20" });
    insertFact(repos, { id: "node-22", content: "runtime: node 22" });
    insertFact(repos, { id: "storage", kind: "decision", content: "storage: sqlite" });
    const stable = service.renderStable(ALPHA);
    expect(stable.status).toBe("conflict");
    expect(stable.facts).toHaveLength(3);
    expect(stable.markdown).not.toContain("runtime: node 20");
    expect(stable.markdown).not.toContain("runtime: node 22");
    expect(stable.markdown).toContain("storage: sqlite");
  }));

  it("renders focused work details and confirmed goal metadata", () => withContext(({ service, repos }) => {
    const goal = approve(service, proposal(ALPHA, { sourceMemoryIds: ["shared", "goal"] }));
    const item = service.createWorkItem({ namespace: ALPHA, goalId: goal.id, title: "Item", summary: "Focused summary", nextStep: "Focused next", acceptanceCriteria: ["Focused accepted"], status: "blocked", sourceMemoryIds: ["shared", "work"] });
    service.selectWorkItem({ namespace: ALPHA, workItemId: item.id });
    insertFact(repos, { id: "fact", content: "runtime: node 22", sourceMemoryIds: ["shared", "fact"] });
    const stable = service.renderStable(ALPHA);
    expect(stable.focusedWorkItem).toEqual(expect.objectContaining({ id: item.id, summary: "Focused summary", status: "blocked", nextStep: "Focused next", acceptanceCriteria: ["Focused accepted"] }));
    expect(stable.focusedWorkItem).toEqual(service.read(ALPHA).focusedWorkItem);
    expect(stable.markdown).toContain("Focus status: blocked");
    expect(stable.markdown).toContain("Focus summary: Focused summary");
    expect(stable.markdown).toContain(`Metadata: goal_id=${goal.id}`);
    expect(stable.markdown).toContain(`confirmed_updated_at=${goal.updatedAt}`);
    expect(stable.sourceMemoryIds).toEqual(["shared", "goal", "work", "fact"]);
  }));

  it("isolates every read and mutation by canonical namespace", () => withContext(({ service }) => {
    const alpha = approve(service);
    const beta = approve(service, proposal(BETA, { title: "Beta goal" }));
    expect(service.read(ALPHA).activeGoal?.id).toBe(alpha.id);
    expect(service.read(BETA).activeGoal?.id).toBe(beta.id);
    expect(() => service.approveGoal({ namespace: BETA, candidateId: service.proposeGoal(proposal(ALPHA)).id })).toThrow(/namespace/i);
  }));

  it("exposes direct namespace reads and renders through MemoryService", () => withContext(({ memory }) => {
    const candidate = memory.proposeProjectGoal(proposal());
    const active = memory.approveProjectGoal({ namespace: ALPHA, candidateId: candidate.id });
    const item = memory.createProjectWorkItem({ namespace: ALPHA, goalId: active.id, title: "Facade item", summary: "Summary", nextStep: "Next" });
    memory.updateProjectWorkItem({ namespace: ALPHA, workItemId: item.id, nextStep: null });
    memory.selectProjectWorkItem({ namespace: ALPHA, workItemId: item.id });
    expect(memory.readProjectContext(ALPHA).focusedWorkItem?.nextStep).toBe("");
    expect(memory.renderStableProjectContext(ALPHA, 500).markdown).toContain("Facade item");
  }));

  it("rejects every unscoped facade mutation, read, and render", () => withContext(({ memory }) => {
    const unscoped: RuntimeNamespace = { source: "codex", profileId: "default", userId: "user-a" };
    const calls = [
      () => memory.proposeProjectGoal(proposal(unscoped)),
      () => memory.approveProjectGoal({ namespace: unscoped, candidateId: "candidate" }),
      () => memory.rejectProjectGoal({ namespace: unscoped, candidateId: "candidate" }),
      () => memory.createProjectWorkItem({ namespace: unscoped, title: "Item", summary: "Summary", nextStep: "Next" }),
      () => memory.updateProjectWorkItem({ namespace: unscoped, workItemId: "item", title: "Updated" }),
      () => memory.selectProjectWorkItem({ namespace: unscoped, workItemId: null }),
      () => memory.readProjectContext(unscoped),
      () => memory.renderStableProjectContext(unscoped)
    ];
    for (const call of calls) expect(call).toThrow(/projectId, workspaceId, or workspacePath/i);
  }));
});
