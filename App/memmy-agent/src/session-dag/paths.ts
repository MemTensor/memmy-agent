import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SESSION_DAG_DIR_ENV = "MEMMY_AGENT_SESSION_DAG_DIR";

export function safeSessionDagKey(sessionKey: string): string {
  return sessionKey.replaceAll(":", "_").replace(/[^A-Za-z0-9_.-]+/g, "_");
}

export function sessionDagRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[SESSION_DAG_DIR_ENV];
  return override && override.trim()
    ? path.resolve(override)
    : path.join(env.MEMMY_HOME?.trim() || path.join(os.homedir(), ".memmy"), "session-dag");
}

export function sessionDagDbPath(sessionKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(sessionDagRoot(env), `${safeSessionDagKey(sessionKey)}.sqlite`);
}

export function sessionDagDebugDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(sessionDagRoot(env), "debug");
}

export function sessionDagDebugLogPath(sessionKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(sessionDagDebugDir(env), `${safeSessionDagKey(sessionKey)}.jsonl`);
}

export function ensureSessionDagDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = sessionDagRoot(env);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

export function removeSessionDagFiles(
  sessionKey: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dbPath = sessionDagDbPath(sessionKey, env);
  for (const candidate of [
    dbPath,
    `${dbPath}-wal`,
    `${dbPath}-shm`,
    sessionDagDebugLogPath(sessionKey, env),
  ]) {
    fs.rmSync(candidate, { force: true });
  }
}
