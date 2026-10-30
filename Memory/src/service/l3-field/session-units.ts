import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLocalWorkspaceUri } from "../../contracts/index.js";
import type { Repositories, SessionRecord } from "../../storage/repositories.js";
import { l3UnitKey } from "../../storage/l3-field-repository.js";
import { resolveProject, type ResolverContext } from "./project-resolver.js";
import type { L3UnitRecord, ResolvedProject } from "./types.js";

/** What the new L3 needs to know about the computer the Memory service runs on. */
export interface L3FieldEnvironment {
  /** Stable id of this installation (the workspace host id); machine units are keyed by it. */
  machineId: string;
  homeDir: string;
  /** Folders never treated as projects; defaults to the system temp folders. Tests override it. */
  tempRoots?: readonly string[];
}

export interface SessionUnits {
  machine: L3UnitRecord;
  project: { resolved: ResolvedProject; unit: L3UnitRecord } | null;
  sessionCwd: string | null;
  workspaceIsLocal: boolean;
}

/** The session's working directory: the v2 workspace URI when present, else the legacy workspace path. */
export function sessionWorkingDirectory(session: SessionRecord): { cwd: string | null; isLocal: boolean } {
  const uri = typeof session.meta.workspace_uri === "string" ? session.meta.workspace_uri : null;
  if (uri) {
    if (!isLocalWorkspaceUri(uri)) return { cwd: null, isLocal: false };
    try {
      return { cwd: fileURLToPath(uri), isLocal: true };
    } catch {
      return { cwd: null, isLocal: false };
    }
  }
  const legacy = session.workspacePath;
  return legacy && path.isAbsolute(legacy) ? { cwd: legacy, isLocal: true } : { cwd: null, isLocal: true };
}

export function resolverContextFor(
  repos: Repositories,
  env: L3FieldEnvironment,
  userId: string,
  workspaceIsLocal: boolean
): ResolverContext {
  const standalone = repos.l3Field.getStandaloneRoots(userId);
  return {
    homeDir: env.homeDir,
    userProjects: repos.l3Field.listUserProjects(userId),
    standaloneRoots: standalone.length ? standalone : [path.join(env.homeDir, "Memmy")],
    tempRoots: env.tempRoots,
    workspaceIsLocal
  };
}

/** Machine unit plus the project unit of the session folder (if it is a project); creates units on first use. */
export function resolveSessionUnits(
  repos: Repositories,
  env: L3FieldEnvironment,
  session: SessionRecord
): SessionUnits {
  const { cwd, isLocal } = sessionWorkingDirectory(session);
  const machine = repos.l3Field.ensureMachineUnit({ userId: session.userId, machineId: env.machineId });
  if (!cwd) return { machine, project: null, sessionCwd: null, workspaceIsLocal: isLocal };
  const resolved = resolveProject(
    { path: cwd, role: "session_dir", sessionCwd: cwd, sessionProjectRoot: null },
    resolverContextFor(repos, env, session.userId, isLocal)
  );
  if (!resolved) return { machine, project: null, sessionCwd: cwd, workspaceIsLocal: isLocal };
  const unit = repos.l3Field.ensureProjectUnit({ userId: session.userId, machineId: env.machineId, project: resolved });
  return { machine, project: { resolved, unit }, sessionCwd: cwd, workspaceIsLocal: isLocal };
}

/**
 * The session's units as they already exist, creating nothing: for reads while memory writes are
 * off. A unit that was never created has nothing to show yet.
 */
export function findSessionUnits(
  repos: Repositories,
  env: L3FieldEnvironment,
  session: SessionRecord
): { machine: L3UnitRecord | undefined; project: L3UnitRecord | undefined } {
  const machine = repos.l3Field.getUnit(l3UnitKey({ userId: session.userId, machineId: env.machineId, kind: "machine", identity: null }));
  const { cwd, isLocal } = sessionWorkingDirectory(session);
  const resolved = cwd ? resolveProject(
    { path: cwd, role: "session_dir", sessionCwd: cwd, sessionProjectRoot: null },
    resolverContextFor(repos, env, session.userId, isLocal)
  ) : null;
  const project = resolved
    ? repos.l3Field.getUnit(l3UnitKey({ userId: session.userId, machineId: env.machineId, kind: "project", identity: resolved.identity }))
    : undefined;
  return { machine, project };
}
