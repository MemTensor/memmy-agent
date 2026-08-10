import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/storage/db.js";
import { ProjectContextRepository, Repositories } from "../../src/storage/repositories.js";
import type {
  ProjectFactRecord,
  ProjectGoalRecord,
  ProjectWorkItemRecord
} from "../../src/service/project-context/project-context-types.js";

const NOW = "2026-08-10T00:00:00.000Z";

function goal(overrides: Partial<ProjectGoalRecord> = {}): ProjectGoalRecord {
  return {
    id: "goal-1",
    namespaceId: "ns-1",
    userId: "user-1",
    title: "Ship project context",
    summary: "Persist authoritative context",
    detail: "Persist authoritative context in SQLite",
    acceptanceCriteria: ["Tests pass"],
    constraints: ["Keep namespace scoped"],
    status: "active",
    version: 1,
    supersedesId: undefined,
    sourceMemoryIds: ["memory-1"],
    provenance: { source: "test" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function workItem(overrides: Partial<ProjectWorkItemRecord> = {}): ProjectWorkItemRecord {
  return {
    id: "work-1",
    namespaceId: "ns-1",
    userId: "user-1",
    goalId: "goal-1",
    title: "Add persistence",
    summary: "Add SQLite records",
    nextStep: "Write repository",
    acceptanceCriteria: ["Records round trip"],
    constraints: [],
    status: "pending",
    focused: false,
    sourceMemoryIds: [],
    provenance: { source: "test" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function fact(overrides: Partial<ProjectFactRecord> = {}): ProjectFactRecord {
  return {
    id: "fact-1",
    namespaceId: "ns-1",
    userId: "user-1",
    kind: "decision",
    content: "SQLite is authoritative",
    status: "active",
    supersedesId: undefined,
    sourceMemoryIds: [],
    provenance: { source: "test" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function withRepo<T>(run: (repo: ProjectContextRepository, db: MemoryDb["db"]) => T): T {
  const root = mkdtempSync(join(tmpdir(), "project-context-repository-"));
  const db = new MemoryDb({ path: join(root, "memory.sqlite") });
  try {
    return run(new ProjectContextRepository(db.db), db.db);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("project context repository", () => {
  it("allows only one active goal per namespace", () => withRepo((repo) => {
    repo.insertGoal(goal({ id: "goal-1" }));
    expect(() => repo.insertGoal(goal({ id: "goal-2", version: 2 })))
      .toThrow(/active project goal/i);
  }));

  it("replaces the active goal by archiving the prior version transactionally", () => withRepo((repo) => {
    repo.insertGoal(goal({ id: "goal-1" }));
    const next = repo.replaceActiveGoal(goal({ id: "goal-2", version: 2, supersedesId: "goal-1", title: "Updated" }));
    expect(next).toMatchObject({ id: "goal-2", status: "active", supersedesId: "goal-1" });
    expect(repo.getGoal("goal-1")?.status).toBe("archived");
    expect(repo.getActiveGoal("ns-1")?.id).toBe("goal-2");
  }));

  it("focuses exactly one work item without changing the goal", () => withRepo((repo) => {
    repo.insertGoal(goal());
    repo.insertWorkItem(workItem({ id: "work-1" }));
    repo.insertWorkItem(workItem({ id: "work-2" }));
    repo.setFocusedWorkItem("ns-1", "work-1", NOW);
    repo.setFocusedWorkItem("ns-1", "work-2", NOW);
    expect(repo.getFocusedWorkItem("ns-1")?.id).toBe("work-2");
    expect(repo.getActiveGoal("ns-1")?.id).toBe("goal-1");
  }));

  it("rejects cross-namespace focus", () => withRepo((repo) => {
    repo.insertWorkItem(workItem({ id: "work-other", namespaceId: "ns-2", goalId: undefined }));
    expect(() => repo.setFocusedWorkItem("ns-1", "work-other", NOW)).toThrow(/namespace/i);
  }));

  it("preserves stored identity fields when updating a work item", () => withRepo((repo) => {
    repo.insertGoal(goal());
    repo.insertWorkItem(workItem({ projectId: "project-1", workspaceId: "workspace-1" }));
    const updated = repo.updateWorkItem(workItem({
      projectId: "changed-project",
      workspaceId: "changed-workspace",
      title: "Updated title"
    }));
    expect(updated).toMatchObject({
      projectId: "project-1",
      workspaceId: "workspace-1",
      title: "Updated title"
    });
    expect(repo.listWorkItems("ns-1")[0]).toEqual(updated);
  }));
  it("safely hydrates invalid JSON shapes", () => withRepo((repo, db) => {
    repo.insertGoal(goal());
    db.prepare(`
      UPDATE project_context_goals
      SET acceptance_criteria_json = 'null', constraints_json = '{}',
          source_memory_ids_json = '["memory-1", 2]', provenance_json = '[]'
      WHERE id = 'goal-1'
    `).run();
    expect(repo.getGoal("goal-1")).toMatchObject({
      acceptanceCriteria: [], constraints: [], sourceMemoryIds: ["memory-1"], provenance: {}
    });
  }));

  it("includes project context records in bundle export order", () => withRepo((_repo, db) => {
    const tables = new Repositories(db).runtime.exportBundleTables();
    const names = Object.keys(tables);
    expect(names).toEqual(expect.arrayContaining([
      "project_context_goals", "project_context_work_items", "project_context_facts"
    ]));
    expect(names.indexOf("project_context_goals")).toBeLessThan(names.indexOf("project_context_work_items"));
  }));

  it("supersedes a fact and lists only active facts", () => withRepo((repo) => {
    repo.insertFact(fact());
    repo.supersedeFact("fact-1", fact({ id: "fact-2", content: "Postgres is authoritative", supersedesId: "fact-1" }));
    expect(repo.listActiveFacts("ns-1").map((item) => item.id)).toEqual(["fact-2"]);
  }));
});
