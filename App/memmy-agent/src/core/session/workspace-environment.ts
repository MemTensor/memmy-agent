import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { readGoalState } from "./goal-state.js";
import { readWebuiSessionBinding, type Session } from "./manager.js";

export const GOAL_WORKSPACE_BASELINE_KEY = "goalWorkspaceBaselineV1";

export type WorkspaceEnvironmentScope = {
  kind: "session" | "project";
  key: string;
};

export type WorkspaceEnvironmentContext = {
  scope: WorkspaceEnvironmentScope;
  cwd: string | null;
  metadata: Session["metadata"];
};

export type WorkspaceEnvironmentFile = {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
  additions: number | null;
  deletions: number | null;
  attribution: "goal" | "preexisting" | "uncertain" | "unattributed";
};

export type WorkspaceEnvironmentSnapshot = {
  scope_kind: WorkspaceEnvironmentScope["kind"];
  scope_key: string;
  cwd: string;
  status: "ready" | "not_git" | "workspace_unavailable" | "error";
  revision: string;
  captured_at: string;
  repository: null | {
    display_name: string;
    root: string;
    head_sha: string;
    branch: string | null;
    detached: boolean;
    upstream: string | null;
    ahead: number;
    behind: number;
    worktree: "clean" | "dirty";
  };
  changes: null | {
    file_count: number;
    additions: number | null;
    deletions: number | null;
    conflicts: number;
    staged: number;
    unstaged: number;
    untracked: number;
  };
  goal: null | {
    goal_id: string;
    base_head: string | null;
    base_branch: string | null;
    goal_files: number;
    preexisting_files: number;
    uncertain_files: number;
    verification: "not_run" | "running" | "passed" | "failed" | "stale";
    completion_audit: "pending" | "risk" | "satisfied";
    baseline_status: "captured" | "unavailable";
  };
};

type GitStatusEntry = Omit<WorkspaceEnvironmentFile, "attribution">;
type GitState = {
  root: string;
  head: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  branches: string[];
  files: GitStatusEntry[];
};

type GoalWorkspaceBaseline = {
  version: 1;
  goalId: string;
  capturedAt: string;
  status: "captured" | "unavailable";
  head: string | null;
  branch: string | null;
  files: Record<string, string | null>;
};

type GitCommandResult = { ok: true; stdout: string } | { ok: false; stderr: string };

export class WorkspaceEnvironmentError extends Error {
  constructor(
    readonly code: "workspace_environment_stale" | "workspace_branch_invalid" | "workspace_branch_switch_failed",
    readonly status: number,
  ) {
    super(code);
  }
}

const GIT_TIMEOUT_MS = 5_000;
const GIT_OUTPUT_LIMIT = 8 * 1024 * 1024;
const DIFF_OUTPUT_LIMIT = 512 * 1024;

function runGit(cwd: string, args: string[], maxBuffer = GIT_OUTPUT_LIMIT): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stderr: String(stderr || error.message || "git command failed").trim() });
        return;
      }
      resolve({ ok: true, stdout: String(stdout ?? "") });
    });
  });
}

function parseBranchHeader(record: string, state: Pick<GitState, "head" | "branch" | "upstream" | "ahead" | "behind">): void {
  if (record.startsWith("# branch.oid ")) state.head = record.slice(13).trim();
  else if (record.startsWith("# branch.head ")) {
    const branch = record.slice(14).trim();
    state.branch = branch === "(detached)" ? null : branch;
  } else if (record.startsWith("# branch.upstream ")) state.upstream = record.slice(18).trim() || null;
  else if (record.startsWith("# branch.ab ")) {
    const match = record.match(/\+(\d+)\s+-(\d+)/);
    if (match) {
      state.ahead = Number(match[1]);
      state.behind = Number(match[2]);
    }
  }
}

function parseNumstat(raw: string): Map<string, { additions: number | null; deletions: number | null }> {
  const stats = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsRaw = record.slice(0, firstTab);
    const deletionsRaw = record.slice(firstTab + 1, secondTab);
    const filePath = record.slice(secondTab + 1);
    stats.set(filePath, {
      additions: /^\d+$/.test(additionsRaw) ? Number(additionsRaw) : null,
      deletions: /^\d+$/.test(deletionsRaw) ? Number(deletionsRaw) : null,
    });
  }
  return stats;
}

function parseStatus(cwd: string, raw: string): GitState {
  const state: GitState = {
    root: cwd,
    head: "",
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    branches: [],
    files: [],
  };
  const records = raw.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# ")) {
      parseBranchHeader(record, state);
      continue;
    }
    const kind = record[0];
    if (kind === "!" || kind === "#") continue;
    let xy = "??";
    let filePath = "";
    if (kind === "?") {
      filePath = record.slice(2);
    } else {
      const fields = record.split(" ");
      xy = fields[1] ?? "??";
      const fixedFields = kind === "1" ? 8 : kind === "2" ? 9 : 10;
      filePath = fields.slice(fixedFields).join(" ");
      if (kind === "2") index += 1;
    }
    if (!filePath) continue;
    const untracked = kind === "?";
    const conflict = kind === "u" || xy.includes("U") || xy === "AA" || xy === "DD";
    state.files.push({
      path: filePath,
      status: untracked ? "??" : xy,
      staged: !untracked && xy[0] !== ".",
      unstaged: !untracked && xy[1] !== ".",
      untracked,
      conflict,
      additions: null,
      deletions: null,
    });
  }
  return state;
}

async function readGitState(cwd: string): Promise<{ status: "ready"; state: GitState } | { status: "not_git" | "error" }> {
  const rootResult = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!rootResult.ok) {
    return { status: /not a git repository/i.test(rootResult.stderr) ? "not_git" : "error" };
  }
  const root = path.resolve(rootResult.stdout.trim());
  const statusResult = await runGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  if (!statusResult.ok) return { status: "error" };
  const state = parseStatus(root, statusResult.stdout);
  state.root = root;
  const [numstatResult, branchesResult] = await Promise.all([
    runGit(root, ["diff", "HEAD", "--numstat", "-z", "--no-renames"]),
    runGit(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]),
  ]);
  if (numstatResult.ok) {
    const stats = parseNumstat(numstatResult.stdout);
    state.files = state.files.map((file) => ({ ...file, ...(stats.get(file.path) ?? {}) }));
  }
  if (branchesResult.ok) {
    state.branches = branchesResult.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean);
  }
  if (state.branch && !state.branches.includes(state.branch)) state.branches = [state.branch, ...state.branches];
  return { status: "ready", state };
}

async function fileFingerprint(root: string, relativePath: string): Promise<string | null> {
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
    return crypto.createHash("sha256").update(await fs.readFile(candidate)).digest("hex");
  } catch {
    return null;
  }
}

async function fileSignature(root: string, file: GitStatusEntry): Promise<string> {
  const fingerprint = await fileFingerprint(root, file.path);
  return `${file.status}:${fingerprint ?? "unavailable"}`;
}

function readBaseline(context: WorkspaceEnvironmentContext, goalId: string): GoalWorkspaceBaseline | null {
  const raw = context.metadata?.[GOAL_WORKSPACE_BASELINE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const baseline = raw as Partial<GoalWorkspaceBaseline>;
  if (baseline.version !== 1 || baseline.goalId !== goalId || !baseline.files || typeof baseline.files !== "object") return null;
  return baseline as GoalWorkspaceBaseline;
}

export async function captureGoalWorkspaceBaseline(session: Session, goalId: string): Promise<void> {
  let cwd: string;
  try {
    cwd = readWebuiSessionBinding(session).cwd;
  } catch {
    return;
  }
  const result = await readGitState(cwd);
  const capturedAt = new Date().toISOString();
  if (result.status !== "ready") {
    session.metadata[GOAL_WORKSPACE_BASELINE_KEY] = {
      version: 1,
      goalId,
      capturedAt,
      status: "unavailable",
      head: null,
      branch: null,
      files: {},
    } satisfies GoalWorkspaceBaseline;
    return;
  }
  session.metadata[GOAL_WORKSPACE_BASELINE_KEY] = {
    version: 1,
    goalId,
    capturedAt,
    status: "captured",
    head: result.state.head || null,
    branch: result.state.branch,
    files: Object.fromEntries(await Promise.all(
      result.state.files.map(async (file) => [file.path, await fileSignature(result.state.root, file)] as const),
    )),
  } satisfies GoalWorkspaceBaseline;
}

async function attributedFiles(context: WorkspaceEnvironmentContext, state: GitState): Promise<WorkspaceEnvironmentFile[]> {
  const goal = readGoalState(context.metadata);
  if (!goal) return state.files.map((file) => ({ ...file, attribution: "unattributed" }));
  const baseline = readBaseline(context, goal.goalId);
  if (!baseline || baseline.status !== "captured") {
    return state.files.map((file) => ({ ...file, attribution: "uncertain" }));
  }
  return Promise.all(state.files.map(async (file) => {
    if (!Object.prototype.hasOwnProperty.call(baseline.files, file.path)) {
      return { ...file, attribution: "goal" };
    }
    const currentSignature = await fileSignature(state.root, file);
    const attribution = currentSignature === baseline.files[file.path] ? "preexisting" : "uncertain";
    return { ...file, attribution };
  }));
}

function revisionFor(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export async function readWorkspaceEnvironment(context: WorkspaceEnvironmentContext): Promise<{
  snapshot: WorkspaceEnvironmentSnapshot;
  files: WorkspaceEnvironmentFile[];
  branches: string[];
}> {
  const cwd = context.cwd ?? "";
  if (!context.cwd) {
    const captured_at = new Date().toISOString();
    const snapshot: WorkspaceEnvironmentSnapshot = {
      scope_kind: context.scope.kind,
      scope_key: context.scope.key,
      cwd,
      status: "workspace_unavailable",
      revision: revisionFor([context.scope, "workspace_unavailable"]),
      captured_at,
      repository: null,
      changes: null,
      goal: null,
    };
    return { snapshot, files: [], branches: [] };
  }
  const captured_at = new Date().toISOString();
  const result = await readGitState(cwd);
  if (result.status !== "ready") {
    const snapshot: WorkspaceEnvironmentSnapshot = {
      scope_kind: context.scope.kind,
      scope_key: context.scope.key,
      cwd,
      status: result.status,
      revision: revisionFor([context.scope, cwd, result.status]),
      captured_at,
      repository: null,
      changes: null,
      goal: null,
    };
    return { snapshot, files: [], branches: [] };
  }
  const files = await attributedFiles(context, result.state);
  const goalState = readGoalState(context.metadata);
  const baseline = goalState ? readBaseline(context, goalState.goalId) : null;
  const hasIncompleteStats = files.some((file) => file.additions == null || file.deletions == null);
  const changes = {
    file_count: files.length,
    additions: hasIncompleteStats ? null : files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: hasIncompleteStats ? null : files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    conflicts: files.filter((file) => file.conflict).length,
    staged: files.filter((file) => file.staged).length,
    unstaged: files.filter((file) => file.unstaged).length,
    untracked: files.filter((file) => file.untracked).length,
  };
  const goal = goalState ? {
    goal_id: goalState.goalId,
    base_head: baseline?.head ?? null,
    base_branch: baseline?.branch ?? null,
    goal_files: files.filter((file) => file.attribution === "goal").length,
    preexisting_files: files.filter((file) => file.attribution === "preexisting").length,
    uncertain_files: files.filter((file) => file.attribution === "uncertain").length,
    verification: "not_run" as const,
    completion_audit: (changes.conflicts > 0
      || files.some((file) => file.attribution === "uncertain")
      || goalState.status === "completed"
      ? "risk"
      : "pending") as "pending" | "risk" | "satisfied",
    baseline_status: baseline?.status ?? "unavailable",
  } : null;
  const repository = {
    display_name: path.basename(result.state.root),
    root: result.state.root,
    head_sha: result.state.head,
    branch: result.state.branch,
    detached: result.state.branch == null,
    upstream: result.state.upstream,
    ahead: result.state.ahead,
    behind: result.state.behind,
    worktree: files.length ? "dirty" as const : "clean" as const,
  };
  const revision = revisionFor({ repository, changes, goal, files, branches: result.state.branches });
  return {
    snapshot: {
      scope_kind: context.scope.kind,
      scope_key: context.scope.key,
      cwd,
      status: "ready",
      revision,
      captured_at,
      repository,
      changes,
      goal,
    },
    files,
    branches: result.state.branches,
  };
}

export async function switchWorkspaceBranch(
  context: WorkspaceEnvironmentContext,
  environment: Awaited<ReturnType<typeof readWorkspaceEnvironment>>,
  branch: string,
  expectedRevision: string,
): Promise<Awaited<ReturnType<typeof readWorkspaceEnvironment>>> {
  if (environment.snapshot.revision !== expectedRevision) {
    throw new WorkspaceEnvironmentError("workspace_environment_stale", 409);
  }
  if (!environment.snapshot.repository || !environment.branches.includes(branch)) {
    throw new WorkspaceEnvironmentError("workspace_branch_invalid", 400);
  }
  if (environment.snapshot.repository.branch === branch) return environment;
  const switched = await runGit(environment.snapshot.repository.root, ["switch", "--no-guess", branch]);
  if (!switched.ok) throw new WorkspaceEnvironmentError("workspace_branch_switch_failed", 409);
  return readWorkspaceEnvironment(context);
}

export async function createOrCheckoutWorkspaceBranch(
  context: WorkspaceEnvironmentContext,
  environment: Awaited<ReturnType<typeof readWorkspaceEnvironment>>,
  branch: string,
  expectedRevision: string,
): Promise<Awaited<ReturnType<typeof readWorkspaceEnvironment>>> {
  if (environment.snapshot.revision !== expectedRevision) {
    throw new WorkspaceEnvironmentError("workspace_environment_stale", 409);
  }
  const repository = environment.snapshot.repository;
  const normalizedBranch = branch.trim();
  if (!repository || !normalizedBranch) {
    throw new WorkspaceEnvironmentError("workspace_branch_invalid", 400);
  }
  if (environment.branches.includes(normalizedBranch)) {
    return switchWorkspaceBranch(context, environment, normalizedBranch, expectedRevision);
  }
  const validated = await runGit(repository.root, ["check-ref-format", "--branch", normalizedBranch]);
  if (!validated.ok) throw new WorkspaceEnvironmentError("workspace_branch_invalid", 400);
  const switched = await runGit(repository.root, ["switch", "-c", normalizedBranch]);
  if (!switched.ok) throw new WorkspaceEnvironmentError("workspace_branch_switch_failed", 409);
  return readWorkspaceEnvironment(context);
}

export async function readWorkspaceFileDiff(environment: {
  snapshot: WorkspaceEnvironmentSnapshot;
  files: WorkspaceEnvironmentFile[];
}, relativePath: string): Promise<{
  path: string;
  diff: string;
  truncated: boolean;
  unavailable_reason: string | null;
} | null> {
  if (environment.snapshot.status !== "ready" || !environment.snapshot.repository) return null;
  const file = environment.files.find((entry) => entry.path === relativePath);
  if (!file) return null;
  if (file.untracked) {
    return { path: relativePath, diff: "", truncated: false, unavailable_reason: "untracked_diff_unavailable" };
  }
  const result = await runGit(environment.snapshot.repository.root, [
    "diff", "--no-ext-diff", "--no-color", "HEAD", "--", relativePath,
  ], DIFF_OUTPUT_LIMIT);
  if (!result.ok) return { path: relativePath, diff: "", truncated: false, unavailable_reason: "diff_unavailable" };
  const truncated = Buffer.byteLength(result.stdout, "utf8") >= DIFF_OUTPUT_LIMIT;
  return { path: relativePath, diff: result.stdout, truncated, unavailable_reason: null };
}
