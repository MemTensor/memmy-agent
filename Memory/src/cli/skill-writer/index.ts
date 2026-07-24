import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_MEMMY_AGENT_IDS = ["codex", "cursor", "claude", "opencode", "openclaw", "hermes"] as const;
export type MemmyAgentId = typeof SUPPORTED_MEMMY_AGENT_IDS[number];

export interface AgentSkillInstallOptions {
  agentRoot?: string;
  assetRoot?: string;
  dryRun?: boolean;
}

export interface AgentSkillBatchInstallOptions extends AgentSkillInstallOptions {
  skipUnavailable?: boolean;
}

export interface AgentSkillInstallResult {
  agent: MemmyAgentId;
  root: string;
  injectPath?: string;
  skillPath: string;
  dryRun: boolean;
}

interface AgentTarget {
  id: MemmyAgentId;
  root: string;
  injectRelativePath: string | null;
  skillsRelativePath: string;
}

const START_MARKER = "<!-- memmy:start v=1 -->";
const END_MARKER = "<!-- memmy:end v=1 -->";
const SKILL_DIRECTORY_NAME = "memmy-memory";

const AGENT_TARGETS: Record<MemmyAgentId, Omit<AgentTarget, "id" | "root">> = {
  codex: {
    injectRelativePath: "AGENTS.md",
    skillsRelativePath: "skills"
  },
  cursor: {
    injectRelativePath: null,
    skillsRelativePath: "skills"
  },
  claude: {
    injectRelativePath: "CLAUDE.md",
    skillsRelativePath: "skills"
  },
  opencode: {
    injectRelativePath: "AGENTS.md",
    skillsRelativePath: "skills"
  },
  openclaw: {
    injectRelativePath: join("workspace", "AGENTS.md"),
    skillsRelativePath: "skills"
  },
  hermes: {
    injectRelativePath: "SOUL.md",
    skillsRelativePath: "skills"
  }
};

export async function installMemmyMemorySkillForAgents(
  agents: string[],
  options: AgentSkillBatchInstallOptions = {}
): Promise<AgentSkillInstallResult[]> {
  const results = await Promise.all(
    normalizeAgentIds(agents).map(async (agent) => {
      if (options.skipUnavailable && !(await isExistingDirectory(targetForAgent(agent, options.agentRoot).root))) {
        return null;
      }
      return installMemmyMemorySkillForAgent(agent, options);
    })
  );
  return results.filter((result): result is AgentSkillInstallResult => result !== null);
}

export async function installMemmyMemorySkillForAgent(
  agent: MemmyAgentId,
  options: AgentSkillInstallOptions = {}
): Promise<AgentSkillInstallResult> {
  const target = targetForAgent(agent, options.agentRoot);
  if (!(await isExistingDirectory(target.root))) {
    throw new Error(`${agent} is not installed or its directory is unavailable: ${target.root}`);
  }

  const assetRoot = await resolveCliAssetRoot(options.assetRoot);
  const injectSourcePath = join(assetRoot, "agent_inject.md");
  const skillSourcePath = join(assetRoot, "skills", SKILL_DIRECTORY_NAME);
  if (target.injectRelativePath && !(await pathExists(injectSourcePath))) {
    throw new Error(`agent inject file not found: ${injectSourcePath}`);
  }
  if (!(await isExistingDirectory(skillSourcePath))) {
    throw new Error(`skill directory not found: ${skillSourcePath}`);
  }

  const injectPath = target.injectRelativePath ? join(target.root, target.injectRelativePath) : undefined;
  const skillPath = join(target.root, target.skillsRelativePath, SKILL_DIRECTORY_NAME);

  if (!options.dryRun) {
    if (injectPath) {
      await writeFileAtomically(
        injectPath,
        upsertMarkerBlock(await readTextFile(injectPath), await readFile(injectSourcePath, "utf8"))
      );
    }
    await replaceDirectoryAtomically(skillSourcePath, skillPath);
  }

  return {
    agent,
    root: target.root,
    ...(injectPath ? { injectPath } : {}),
    skillPath,
    dryRun: options.dryRun ?? false
  };
}

export function normalizeAgentIds(agents: string[]): MemmyAgentId[] {
  const normalized = agents.flatMap((agent) =>
    agent
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map(normalizeAgentId)
  );
  return [...new Set(normalized)];
}

function normalizeAgentId(agent: string): MemmyAgentId {
  switch (agent) {
    case "codex":
    case "cursor":
    case "opencode":
    case "openclaw":
    case "hermes":
      return agent;
    case "claude":
    case "claude_code":
    case "claude-code":
      return "claude";
    default:
      throw new Error(`unknown agent: ${agent}`);
  }
}

function targetForAgent(agent: MemmyAgentId, rootOverride: string | undefined): AgentTarget {
  const target = AGENT_TARGETS[agent];
  return {
    id: agent,
    root: resolve(expandHome(rootOverride ?? defaultAgentRoot(agent))),
    injectRelativePath: target.injectRelativePath,
    skillsRelativePath: target.skillsRelativePath
  };
}

function defaultAgentRoot(agent: MemmyAgentId): string {
  switch (agent) {
    case "codex":
      return configuredDirectory("CODEX_HOME", join(homeDirectory(), ".codex"));
    case "cursor":
      return join(homeDirectory(), ".cursor");
    case "claude":
      return configuredDirectory("CLAUDE_CONFIG_DIR", join(homeDirectory(), ".claude"));
    case "opencode": {
      const xdgConfigRoot = configuredDirectory("XDG_CONFIG_HOME", join(homeDirectory(), ".config"));
      return configuredDirectory("OPENCODE_CONFIG_DIR", join(xdgConfigRoot, "opencode"));
    }
    case "openclaw":
      return configuredDirectory("OPENCLAW_STATE_DIR", join(homeDirectory(), ".openclaw"));
    case "hermes":
      return configuredDirectory("HERMES_HOME", join(homeDirectory(), ".hermes"));
  }
}

function configuredDirectory(environmentVariable: string, fallback: string): string {
  const configured = process.env[environmentVariable]?.trim();
  return configured ? expandHome(configured) : fallback;
}

async function resolveCliAssetRoot(rootOverride: string | undefined): Promise<string> {
  if (rootOverride) {
    return resolve(expandHome(rootOverride));
  }

  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const fallback = join(currentDirectory, "..");
  const candidates = [
    fallback,
    join(process.cwd(), "Memory", "src", "cli")
  ];

  for (const candidate of candidates) {
    if (
      await pathExists(join(candidate, "agent_inject.md")) &&
      await isExistingDirectory(join(candidate, "skills", SKILL_DIRECTORY_NAME))
    ) {
      return candidate;
    }
  }

  return fallback;
}

function upsertMarkerBlock(existing: string, content: string): string {
  const block = `${START_MARKER}\n${content.trimEnd()}\n${END_MARKER}\n`;
  const pattern = createMarkerBlockPattern(START_MARKER, END_MARKER);
  if (pattern.test(existing)) {
    return existing.replace(pattern, block);
  }

  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  return `${existing}${separator}${block}`;
}

function createMarkerBlockPattern(startMarker: string, endMarker: string): RegExp {
  return new RegExp(`${escapeRegExp(startMarker)}\\n[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`, "m");
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = temporarySiblingPath(path);
  try {
    await writeFile(tempPath, content, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true });
    throw error;
  }
}

async function replaceDirectoryAtomically(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const tempPath = temporarySiblingPath(targetPath);
  const backupPath = temporarySiblingPath(`${targetPath}.old`);

  await rm(tempPath, { recursive: true, force: true });
  await rm(backupPath, { recursive: true, force: true });
  await cp(sourcePath, tempPath, { recursive: true });

  const hadExistingTarget = await pathExists(targetPath);
  try {
    if (hadExistingTarget) {
      await rename(targetPath, backupPath);
    }
    await rename(tempPath, targetPath);
    await rm(backupPath, { recursive: true, force: true });
  } catch (error) {
    await rm(tempPath, { recursive: true, force: true });
    if (hadExistingTarget && !(await pathExists(targetPath)) && await pathExists(backupPath)) {
      await rename(backupPath, targetPath);
    }
    throw error;
  }
}

function temporarySiblingPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? join(homeDirectory(), value.slice(2)) : value;
}

function homeDirectory(): string {
  return process.env.HOME || homedir();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
