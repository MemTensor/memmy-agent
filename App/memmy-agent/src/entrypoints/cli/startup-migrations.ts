import { resolveMigrationTargets, runMigrations } from "@memmy/migrations";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getConfigPath, setConfigPath } from "../../config/loader.js";

export const MIGRATIONS_READY_CONFIG_ENV = "MEMMY_MIGRATIONS_READY_CONFIG";
export const MIGRATIONS_READY_WORKSPACE_ENV = "MEMMY_MIGRATIONS_READY_WORKSPACE";
export const MIGRATIONS_READY_SESSION_DAG_ENV = "MEMMY_MIGRATIONS_READY_SESSION_DAG";
export const MIGRATIONS_READY_APP_DATABASE_ENV = "MEMMY_MIGRATIONS_READY_APP_DATABASE";
export const APP_DATABASE_ENV = "MEMMY_APP_DATABASE";

export interface StartupMigrationTarget {
  runtimeConfigFile: string;
  agentWorkspace: string;
  sessionDagDir: string;
  appDatabaseFile?: string;
}

export interface StartupMigrationPreparation {
  target: StartupMigrationTarget;
  source: "executed" | "prepared-parent";
}

type StartupMigrationInput = {
  config?: string | null;
  workspace?: string | null;
  appDatabase?: string | null;
};

const migrationLogger = {
  info: (event: string, fields?: Record<string, string | number>) =>
    console.info(`[migration] ${event}`, fields ?? {}),
  warn: (event: string, fields?: Record<string, string | number>) =>
    console.warn(`[migration] ${event}`, fields ?? {}),
  error: (event: string, fields?: Record<string, string | number>) =>
    console.error(`[migration] ${event}`, fields ?? {}),
};

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
  if (value !== "~" && !value.startsWith("~/") && !value.startsWith("~\\")) return value;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  return value === "~" ? home : path.join(home, ...value.slice(2).split(/[\\/]+/u));
}

function normalizeConfigPath(value: string, env: NodeJS.ProcessEnv): string {
  return path.normalize(path.resolve(expandHome(value, env)));
}

export function resolveStartupMigrationTarget(
  input: StartupMigrationInput = {},
  env: NodeJS.ProcessEnv = process.env,
): StartupMigrationTarget {
  const runtimeConfigFile = normalizeConfigPath(
    input.config ?? env.MEMMY_CONFIG ?? getConfigPath(),
    env,
  );
  if (input.config) setConfigPath(runtimeConfigFile);
  return resolveMigrationTargets({
    runtimeConfigFile,
    agentWorkspaceOverride: input.workspace ?? env.MEMMY_AGENT_WORKSPACE,
    sessionDagDirOverride: env.MEMMY_AGENT_SESSION_DAG_DIR,
    appDatabaseFile: input.appDatabase ?? env[APP_DATABASE_ENV],
    env,
  });
}

function preparedTargetMatches(
  target: StartupMigrationTarget,
  env: NodeJS.ProcessEnv,
): boolean {
  const preparedConfig = env[MIGRATIONS_READY_CONFIG_ENV];
  const preparedWorkspace = env[MIGRATIONS_READY_WORKSPACE_ENV];
  const preparedSessionDag = env[MIGRATIONS_READY_SESSION_DAG_ENV];
  const preparedAppDatabase = env[MIGRATIONS_READY_APP_DATABASE_ENV];
  if (!preparedConfig || !preparedWorkspace || !preparedSessionDag) return false;
  try {
    const normalizedPreparedWorkspace = normalizeConfigPath(preparedWorkspace, env);
    return normalizeConfigPath(preparedConfig, env) === target.runtimeConfigFile
      && fs.realpathSync(normalizedPreparedWorkspace) === target.agentWorkspace
      && path.normalize(path.resolve(preparedSessionDag)) === target.sessionDagDir
      && (preparedAppDatabase ? normalizeConfigPath(preparedAppDatabase, env) : undefined)
        === target.appDatabaseFile;
  } catch {
    return false;
  }
}

export async function prepareStartupMigrations(
  input: StartupMigrationInput = {},
  env: NodeJS.ProcessEnv = process.env,
  options: { force?: boolean } = {},
): Promise<StartupMigrationPreparation> {
  const target = resolveStartupMigrationTarget(input, env);
  if (!options.force && preparedTargetMatches(target, env)) {
    return { target, source: "prepared-parent" };
  }
  await runMigrations({ targets: target, logger: migrationLogger });
  return { target, source: "executed" };
}
