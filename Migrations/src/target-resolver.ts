import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { MigrationError, type RunMigrationTargets } from "./types.js";

export type ResolveMigrationTargetsOptions = {
  runtimeConfigFile: string;
  sessionDagDirOverride?: string | null;
  agentWorkspaceOverride?: string | null;
  appDatabaseFile?: string | null;
  defaultAgentWorkspace?: string;
  env?: NodeJS.ProcessEnv;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function expandHome(value: string, env: NodeJS.ProcessEnv): string {
  if (value !== "~" && !value.startsWith("~/") && !value.startsWith("~\\")) return value;
  const home = env.HOME ?? env.USERPROFILE;
  if (!home || value === "~") return home ?? value;
  return path.join(home, ...value.slice(2).split(/[\\/]+/u));
}

function absolutePath(value: string, env: NodeJS.ProcessEnv): string {
  return path.normalize(path.resolve(expandHome(value, env)));
}

function configuredWorkspace(configPath: string): string | null {
  if (!fs.existsSync(configPath)) return null;
  let parsed: unknown;
  try {
    parsed = YAML.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new MigrationError(
      "migration_config_invalid",
      `Runtime config is not valid YAML: ${configPath}`,
      { scope: "runtime-config", cause: error },
    );
  }
  if (parsed === null || parsed === undefined || parsed === "") return null;
  if (!isObject(parsed)) {
    throw new MigrationError("migration_config_invalid", "Runtime config root must be an object", {
      scope: "runtime-config",
    });
  }
  const agents = isObject(parsed.agents) ? parsed.agents : null;
  const defaults = agents && isObject(agents.defaults) ? agents.defaults : null;
  const current = nonEmptyString(defaults?.workspace);
  if (current) return current;
  const legacyAgent = isObject(parsed.agent) ? parsed.agent : null;
  return nonEmptyString(legacyAgent?.workspace);
}

export function resolveMigrationTargets(
  options: ResolveMigrationTargetsOptions,
): RunMigrationTargets {
  const env = options.env ?? process.env;
  const runtimeConfigFile = absolutePath(options.runtimeConfigFile, env);
  const explicitWorkspace = options.agentWorkspaceOverride?.trim();
  const workspace = explicitWorkspace
    || configuredWorkspace(runtimeConfigFile)
    || options.defaultAgentWorkspace
    || "~/.memmy/workspace";
  const workspacePath = absolutePath(workspace, env);
  try {
    fs.mkdirSync(workspacePath, { recursive: true });
  } catch (error) {
    throw new MigrationError(
      "migration_target_unavailable",
      "Agent workspace migration target is unavailable",
      { cause: error },
    );
  }
  const canonicalWorkspace = fs.realpathSync(workspacePath);
  const targets: RunMigrationTargets = {
    runtimeConfigFile,
    agentWorkspace: canonicalWorkspace,
    sessionDagDir: absolutePath(
      options.sessionDagDirOverride?.trim()
        || env.MEMMY_AGENT_SESSION_DAG_DIR
        || path.join(path.dirname(workspacePath), "session-dag"),
      env,
    ),
  };
  if (options.appDatabaseFile?.trim()) {
    targets.appDatabaseFile = absolutePath(options.appDatabaseFile, env);
  }
  return targets;
}
