import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

/** One SKILL.md found under an agent's skills directory. */
export interface AgentSkillInventoryItem {
  /** Directory of the skill relative to the scanned root, with "/" separators. */
  sourceSkillId: string;
  sourceSkillPath: string;
  content: string;
  contentHash: string;
  modifiedAt: string;
  name?: string;
  description?: string;
  version?: string;
  /** `disable-model-invocation: true` in the frontmatter. */
  disableModelInvocation: boolean;
  /** Codex `agents/openai.yaml` `policy.allow_implicit_invocation`; undefined when not declared. */
  allowImplicitInvocation?: boolean;
  /** The skill directory holds files besides SKILL.md (scripts, references, ...). */
  hasSupportingFiles: boolean;
  /** Set when the frontmatter is not valid YAML; fields were read line by line. */
  frontmatterError?: string;
  /** Set when `agents/openai.yaml` could not be read; the policy is treated as undeclared. */
  policyError?: string;
}

export interface AgentSkillInventoryError {
  path: string;
  reason: string;
}

/**
 * `complete` is true only when every directory and SKILL.md under the root was
 * read. Callers must not treat a skill missing from an incomplete inventory as
 * removed.
 */
export interface AgentSkillInventory {
  complete: boolean;
  items: AgentSkillInventoryItem[];
  errors: AgentSkillInventoryError[];
}

export interface AgentSkillInventoryOptions {
  /** Called between filesystem steps so a scan can pause or abort. */
  checkpoint?: () => Promise<void>;
}

const EXCLUDED_ENTRY_NAMES = new Set(["memmy-memory", "node_modules", ".git"]);
const MAX_DIRECTORY_DEPTH = 2;

export interface SkillFrontmatter {
  data: Record<string, unknown>;
  error?: string;
}

/**
 * Parses the leading `---` YAML block of a SKILL.md. Values are read with the
 * YAML failsafe schema so scalars stay as written (`version: 1.0` stays
 * "1.0"). Agents accept frontmatter that is not strict YAML, such as an
 * unquoted description containing ": "; when YAML parsing fails the top-level
 * `key: value` lines are still read and `error` says why.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const text = content.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) return { data: {} };
  const end = text.search(/\r?\n---[ \t]*(?:\r?\n|$)/);
  if (end < 0) return { data: {}, error: "frontmatter is not closed" };
  const firstLineEnd = text.search(/\r?\n/);
  const block = text.slice(firstLineEnd + 1, end + 1);
  try {
    const parsed: unknown = parseYaml(block, { schema: "failsafe" });
    return { data: isRecord(parsed) ? parsed : {} };
  } catch (error) {
    return { data: parseFrontmatterLines(block), error: errorReason(error) };
  }
}

function parseFrontmatterLines(block: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!match || match[2] === "") continue;
    const value = match[2]!;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    data[match[1]!] = quoted ? quoted[2] : value;
  }
  return data;
}

export function frontmatterString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

/** Reads every SKILL.md under `skillsRoot`. A missing root is an empty, complete inventory. */
export async function readAgentSkillInventory(
  skillsRoot: string,
  options: AgentSkillInventoryOptions = {}
): Promise<AgentSkillInventory> {
  const checkpoint = options.checkpoint ?? (async () => {});
  const errors: AgentSkillInventoryError[] = [];
  const files = await findSkillFiles(skillsRoot, checkpoint, errors);
  const items: AgentSkillInventoryItem[] = [];
  for (const filePath of files) {
    await checkpoint();
    try {
      items.push(await readSkillItem(skillsRoot, filePath));
    } catch (error) {
      errors.push({ path: filePath, reason: errorReason(error) });
    }
  }
  return { complete: errors.length === 0, items, errors };
}

async function readSkillItem(skillsRoot: string, filePath: string): Promise<AgentSkillInventoryItem> {
  const content = await readFile(filePath, "utf8");
  const fileStat = await stat(filePath);
  const skillDir = dirname(filePath);
  const frontmatter = parseSkillFrontmatter(content);
  let allowImplicitInvocation: boolean | undefined;
  let policyError: string | undefined;
  try {
    allowImplicitInvocation = await readOpenAiImplicitInvocation(skillDir);
  } catch (error) {
    policyError = errorReason(error);
  }
  return {
    sourceSkillId: relative(skillsRoot, skillDir).replaceAll("\\", "/"),
    sourceSkillPath: filePath,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    modifiedAt: fileStat.mtime.toISOString(),
    name: frontmatterString(frontmatter.data, "name"),
    description: frontmatterString(frontmatter.data, "description"),
    version: frontmatterString(frontmatter.data, "version"),
    disableModelInvocation: frontmatterBoolean(frontmatter.data, "disable-model-invocation") === true,
    ...(allowImplicitInvocation === undefined ? {} : { allowImplicitInvocation }),
    hasSupportingFiles: (await readdir(skillDir)).some((entry) => entry.toLowerCase() !== "skill.md"),
    ...(frontmatter.error ? { frontmatterError: frontmatter.error } : {}),
    ...(policyError ? { policyError } : {})
  };
}

/** Codex declares per-skill invocation policy in `agents/openai.yaml`. */
async function readOpenAiImplicitInvocation(skillDir: string): Promise<boolean | undefined> {
  let text: string;
  try {
    text = await readFile(join(skillDir, "agents", "openai.yaml"), "utf8");
  } catch (error) {
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
    throw error;
  }
  const parsed: unknown = parseYaml(text, { schema: "failsafe" });
  const policy = isRecord(parsed) && isRecord(parsed.policy) ? parsed.policy : undefined;
  return policy ? frontmatterBoolean(policy, "allow_implicit_invocation") : undefined;
}

async function findSkillFiles(
  root: string,
  checkpoint: () => Promise<void>,
  errors: AgentSkillInventoryError[]
): Promise<string[]> {
  const files: string[] = [];
  const visited = new Set<string>();
  await visit(root, 0);
  return files.sort((left, right) => left.localeCompare(right));

  async function visit(directory: string, depth: number): Promise<void> {
    await checkpoint();
    let resolved: string;
    let entries;
    try {
      resolved = await realpath(directory);
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      errors.push({ path: directory, reason: errorReason(error) });
      return;
    }
    // Symlinked skill directories are followed; the same real directory is read once.
    if (visited.has(resolved)) return;
    visited.add(resolved);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (EXCLUDED_ENTRY_NAMES.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        files.push(path);
        continue;
      }
      if (depth >= MAX_DIRECTORY_DEPTH) continue;
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isSymbolicLink()) {
        let target;
        try {
          target = await stat(path);
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") continue;
          errors.push({ path, reason: errorReason(error) });
          continue;
        }
        if (target.isDirectory()) await visit(path, depth + 1);
        else if (target.isFile() && entry.name.toLowerCase() === "skill.md") files.push(path);
      }
    }
  }
}

/**
 * Skill directories shared by several Agents. Each entry lists the Agents whose
 * documentation says they load skills from it; Memmy treats skills found there
 * as installed for each of those Agents.
 * - `~/.agents/skills`: Codex user-scope skills (Codex "Agent Skills" docs).
 */
export const SHARED_AGENT_SKILL_ROOTS: ReadonlyArray<{ id: string; relativeToHome: string; agentIds: readonly string[] }> = [
  { id: "agents", relativeToHome: ".agents/skills", agentIds: ["codex"] }
];

/** Shared skill roots an Agent loads, as absolute paths. */
export function sharedSkillRootsForAgent(agentId: string, homeDirectory: string): Array<{ id: string; root: string }> {
  return SHARED_AGENT_SKILL_ROOTS
    .filter((entry) => entry.agentIds.includes(agentId))
    .map((entry) => ({ id: entry.id, root: join(homeDirectory, entry.relativeToHome) }));
}

/** A skill shipped inside an enabled agent plugin. Only its identity is read, never its body. */
export interface PluginSkillEntry {
  pluginId: string;
  name: string;
  sourceSkillPath: string;
}

export interface PluginSkillInventory {
  complete: boolean;
  items: PluginSkillEntry[];
  errors: AgentSkillInventoryError[];
}

/**
 * Claude Code: enabled plugins are listed in `settings.json` `enabledPlugins`;
 * `plugins/installed_plugins.json` gives each plugin's install path.
 */
export async function readClaudeCodePluginSkills(
  claudeHome: string,
  options: AgentSkillInventoryOptions = {}
): Promise<PluginSkillInventory> {
  const errors: AgentSkillInventoryError[] = [];
  const settings = await readJsonFile(join(claudeHome, "settings.json"), errors);
  const installed = await readJsonFile(join(claudeHome, "plugins", "installed_plugins.json"), errors);
  if (errors.length > 0) return { complete: false, items: [], errors };
  const enabled = isRecord(settings?.enabledPlugins) ? settings.enabledPlugins : {};
  const plugins = isRecord(installed?.plugins) ? installed.plugins : {};
  const roots: Array<{ pluginId: string; root: string }> = [];
  for (const [pluginId, isEnabled] of Object.entries(enabled)) {
    if (isEnabled !== true) continue;
    const installs = plugins[pluginId];
    if (!Array.isArray(installs)) continue;
    for (const install of installs) {
      if (isRecord(install) && typeof install.installPath === "string") {
        roots.push({ pluginId, root: join(install.installPath, "skills") });
      }
    }
  }
  return readPluginSkillRoots(roots, errors, options);
}

/**
 * Codex: enabled plugins are `[plugins."<plugin>@<marketplace>"] enabled = true`
 * in `config.toml`; their skills live under
 * `plugins/cache/<marketplace>/<plugin>/<version>/skills`.
 */
export async function readCodexPluginSkills(
  codexHome: string,
  options: AgentSkillInventoryOptions = {}
): Promise<PluginSkillInventory> {
  const errors: AgentSkillInventoryError[] = [];
  let config: unknown = {};
  try {
    config = parseToml(await readFile(join(codexHome, "config.toml"), "utf8"));
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) {
      return { complete: false, items: [], errors: [{ path: join(codexHome, "config.toml"), reason: errorReason(error) }] };
    }
  }
  const plugins = isRecord(config) && isRecord(config.plugins) ? config.plugins : {};
  const roots: Array<{ pluginId: string; root: string }> = [];
  for (const [pluginId, entry] of Object.entries(plugins)) {
    if (!isRecord(entry) || entry.enabled !== true) continue;
    const separator = pluginId.lastIndexOf("@");
    if (separator <= 0) continue;
    const pluginDir = join(codexHome, "plugins", "cache", pluginId.slice(separator + 1), pluginId.slice(0, separator));
    let versions;
    try {
      versions = await readdir(pluginDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      errors.push({ path: pluginDir, reason: errorReason(error) });
      continue;
    }
    // The cache can keep older versions next to the installed one; only the
    // most recently written version directory is the one Codex loads.
    let latest: { name: string; modifiedMs: number } | undefined;
    for (const version of versions) {
      if (!version.isDirectory()) continue;
      try {
        const modifiedMs = (await stat(join(pluginDir, version.name))).mtimeMs;
        if (!latest || modifiedMs > latest.modifiedMs) latest = { name: version.name, modifiedMs };
      } catch (error) {
        errors.push({ path: join(pluginDir, version.name), reason: errorReason(error) });
      }
    }
    if (latest) roots.push({ pluginId, root: join(pluginDir, latest.name, "skills") });
  }
  return readPluginSkillRoots(roots, errors, options);
}

async function readPluginSkillRoots(
  roots: ReadonlyArray<{ pluginId: string; root: string }>,
  errors: AgentSkillInventoryError[],
  options: AgentSkillInventoryOptions
): Promise<PluginSkillInventory> {
  const checkpoint = options.checkpoint ?? (async () => {});
  const items: PluginSkillEntry[] = [];
  for (const { pluginId, root } of roots) {
    for (const filePath of await findSkillFiles(root, checkpoint, errors)) {
      let name: string | undefined;
      try {
        name = frontmatterString(parseSkillFrontmatter(await readFile(filePath, "utf8")).data, "name");
      } catch (error) {
        errors.push({ path: filePath, reason: errorReason(error) });
        continue;
      }
      items.push({ pluginId, name: name ?? basename(dirname(filePath)), sourceSkillPath: filePath });
    }
  }
  return { complete: errors.length === 0, items, errors };
}

async function readJsonFile(path: string, errors: AgentSkillInventoryError[]): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    errors.push({ path, reason: errorReason(error) });
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
