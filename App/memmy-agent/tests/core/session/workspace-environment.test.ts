import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GOAL_STATE_KEY } from "../../../src/core/session/goal-state.js";
import { Session } from "../../../src/core/session/manager.js";
import {
  captureGoalWorkspaceBaseline,
  createOrCheckoutWorkspaceBranch,
  readWorkspaceEnvironment,
  readWorkspaceFileDiff,
  switchWorkspaceBranch,
  type WorkspaceEnvironmentContext,
} from "../../../src/core/session/workspace-environment.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(String(result.stderr || "git failed"));
}

function repository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-workspace-environment-"));
  roots.push(root);
  git(root, ["init"]);
  git(root, ["config", "user.name", "Memmy Test"]);
  git(root, ["config", "user.email", "memmy@example.test"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n", "utf8");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "base"]);
  return root;
}

function sessionFor(root: string): Session {
  const session = new Session({ key: "websocket:environment-test" });
  session.metadata.webui = true;
  session.metadata.webuiProjectId = null;
  session.metadata.webuiWorkspaceCwd = fs.realpathSync(root);
  return session;
}

function contextFor(session: Session): WorkspaceEnvironmentContext {
  return {
    scope: { kind: "session", key: session.key },
    cwd: String(session.metadata.webuiWorkspaceCwd),
    metadata: session.metadata,
  };
}

function activateGoal(session: Session, goalId: string): void {
  const now = new Date().toISOString();
  session.metadata[GOAL_STATE_KEY] = {
    goalId,
    objective: "Implement environment panel",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe("workspace environment", () => {
  it("attributes Goal changes without claiming pre-existing dirty files", async () => {
    const root = repository();
    const session = sessionFor(root);
    const goalId = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";
    fs.writeFileSync(path.join(root, "tracked.txt"), "dirty before goal\n", "utf8");

    await captureGoalWorkspaceBaseline(session, goalId);
    activateGoal(session, goalId);
    fs.writeFileSync(path.join(root, "goal-file.ts"), "export const goal = true;\n", "utf8");

    const { snapshot, files } = await readWorkspaceEnvironment(contextFor(session));
    expect(snapshot).toMatchObject({
      status: "ready",
      repository: { worktree: "dirty" },
      changes: { file_count: 2, untracked: 1 },
      goal: {
        goal_id: goalId,
        goal_files: 1,
        preexisting_files: 1,
        uncertain_files: 0,
        baseline_status: "captured",
      },
    });
    expect(files.find((file) => file.path === "tracked.txt")?.attribution).toBe("preexisting");
    expect(files.find((file) => file.path === "goal-file.ts")?.attribution).toBe("goal");
  });

  it("marks a pre-existing dirty file uncertain when it changes during the Goal", async () => {
    const root = repository();
    const session = sessionFor(root);
    const goalId = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";
    fs.writeFileSync(path.join(root, "tracked.txt"), "dirty before goal\n", "utf8");
    await captureGoalWorkspaceBaseline(session, goalId);
    activateGoal(session, goalId);
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed during goal\n", "utf8");

    const { snapshot, files } = await readWorkspaceEnvironment(contextFor(session));
    expect(files[0]?.attribution).toBe("uncertain");
    expect(snapshot.goal).toMatchObject({ uncertain_files: 1, completion_audit: "risk" });
  });

  it("treats staging a pre-existing dirty file as a Goal-time mutation", async () => {
    const root = repository();
    const session = sessionFor(root);
    const goalId = "8f59f58a-7295-4c34-8e03-55e7035a5a8d";
    fs.writeFileSync(path.join(root, "tracked.txt"), "dirty before goal\n", "utf8");
    await captureGoalWorkspaceBaseline(session, goalId);
    activateGoal(session, goalId);

    git(root, ["add", "tracked.txt"]);

    expect((await readWorkspaceEnvironment(contextFor(session))).files[0]?.attribution).toBe("uncertain");
  });

  it("returns a bounded diff only for a currently changed tracked file", async () => {
    const root = repository();
    const session = sessionFor(root);
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n", "utf8");

    const environment = await readWorkspaceEnvironment(contextFor(session));
    expect(await readWorkspaceFileDiff(environment, "tracked.txt")).toMatchObject({
      path: "tracked.txt",
      unavailable_reason: null,
    });
    expect((await readWorkspaceFileDiff(environment, "tracked.txt"))?.diff).toContain("+changed");
    expect(await readWorkspaceFileDiff(environment, "../outside.txt")).toBeNull();
  });

  it("reports non-Git workspaces explicitly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-workspace-no-git-"));
    roots.push(root);
    const session = sessionFor(root);
    expect((await readWorkspaceEnvironment(contextFor(session))).snapshot).toMatchObject({
      status: "not_git",
      repository: null,
      changes: null,
    });
  });

  it("lists local branches and switches only from the expected environment revision", async () => {
    const root = repository();
    const session = sessionFor(root);
    const context = contextFor(session);
    git(root, ["branch", "alternate"]);
    const environment = await readWorkspaceEnvironment(context);

    expect(environment.branches).toContain("alternate");
    const switched = await switchWorkspaceBranch(context, environment, "alternate", environment.snapshot.revision);
    expect(switched.snapshot.repository?.branch).toBe("alternate");

    await expect(switchWorkspaceBranch(context, switched, environment.snapshot.repository?.branch ?? "", "stale"))
      .rejects.toMatchObject({ code: "workspace_environment_stale", status: 409 });
  });

  it("creates and checks out a valid branch while rejecting invalid names", async () => {
    const root = repository();
    const context = contextFor(sessionFor(root));
    const environment = await readWorkspaceEnvironment(context);

    const created = await createOrCheckoutWorkspaceBranch(
      context,
      environment,
      "feature/new-branch",
      environment.snapshot.revision,
    );
    expect(created.snapshot.repository?.branch).toBe("feature/new-branch");
    expect(created.branches).toContain("feature/new-branch");

    await expect(createOrCheckoutWorkspaceBranch(
      context,
      created,
      "invalid branch name",
      created.snapshot.revision,
    )).rejects.toMatchObject({ code: "workspace_branch_invalid", status: 400 });
  });
});
