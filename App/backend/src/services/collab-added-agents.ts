/**
 * Agents the person added to use collaboration projects. Adding one installs the `memmy-project` skill into the
 * folder that agent reads skills from, and nothing else: Memmy never reads that agent's own task records, so it
 * joins a project by submitting the task itself. Nothing here installs memmy-memory or imports history.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { renderMemmyProjectSkillFile } from "../adapters/outbound/skill-writer/templates/memmy-project-skill.js";
import { createBuiltinAgentSourceRegistry } from "./builtin-agent-source-registry.js";

export interface CollabAddedAgent {
  sourceId: string;
  displayName: string;
  /** 该 Agent 读取技能的目录（`<这里>/memmy-project/SKILL.md`）。 */
  skillDirectory: string;
  updatedAt: string;
}

export interface ConnectCollabAgentInput {
  name: string;
  skillDirectory: string;
  homeDirectory?: string;
  /** Agents Memmy already reads on its own; tests pass a fixed list instead of the registry. */
  supportedNames?: readonly string[];
}

export interface ConnectCollabAgentResult {
  ok: true;
  sourceId: string;
  skillPath: string;
  text: string;
}

/** Stable id within the 32-character source id used by collaboration links. */
export function collabSourceId(name: string): string {
  const trimmed = name.trim();
  // Hashed from the lowercase name: adding the same agent again with different capitals must update one entry.
  const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 12);
  const hash = createHash("sha256").update(trimmed.toLowerCase()).digest("hex").slice(0, 8);
  return `added-${slug || "agent"}-${hash}`;
}

export function collabAgentsPath(homeDirectory = defaultHome()): string {
  return join(homeDirectory, "collab-agents.json");
}

/** 展开 `~` 并解析成绝对路径；技能目录由用户填，可能是 `~/...` 这种写法。 */
export function expandAgentDirectory(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

export async function loadCollabAgents(homeDirectory = defaultHome()): Promise<CollabAddedAgent[]> {
  const text = await readFile(collabAgentsPath(homeDirectory), "utf8").catch(() => "");
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { agents?: unknown };
    return Array.isArray(parsed.agents) ? parsed.agents.filter(isAddedAgent) : [];
  } catch {
    return [];
  }
}

/**
 * Memmy 自己就能读的 Agent。再按名字添加一次只会在列表里多出一个重复条目，
 * 而它的任务本来就会出现在列表里（有任务的时候）。
 */
function builtinAgentNames(): string[] {
  return createBuiltinAgentSourceRegistry().list().map((adapter) => adapter.descriptor.displayName);
}

/** 名字比较放宽到大小写、空格、连字符与全角括号：用户写的和产品名往往不完全一样。 */
function sameAgentName(left: string, right: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[\s_\-（）()]+/gu, "");
  return normalize(left) === normalize(right);
}

/**
 * 添加一个用户自己的 Agent。只做一件事：把 `memmy-project` 装进它的技能目录。
 * 技能目录必须已经存在——新建一个空目录不能说明任何 Agent 会读它。
 */
export async function connectCollabAgent(input: ConnectCollabAgentInput): Promise<ConnectCollabAgentResult> {
  const name = input.name.trim();
  if (!name) throw new Error("请填写 Agent 名称");
  const supported = (input.supportedNames ?? builtinAgentNames()).find((candidate) => sameAgentName(candidate, name));
  if (supported) {
    throw new Error(
      `Memmy 已经能读取 ${supported} 的任务，不需要在这里添加；它有任务时会直接出现在列表里。`
    );
  }
  const skillDirectory = expandAgentDirectory(input.skillDirectory);
  const directory = await stat(skillDirectory).catch(() => null);
  if (!directory?.isDirectory()) {
    throw new Error(`技能目录不存在：${skillDirectory}。请填写 ${name} 读取技能的那个目录。`);
  }
  const target = join(skillDirectory, "memmy-project");
  const skillPath = join(target, "SKILL.md");
  await mkdir(target, { recursive: true });
  await writeFile(skillPath, renderMemmyProjectSkillFile({ agentName: name }), "utf8");
  const agent: CollabAddedAgent = {
    sourceId: collabSourceId(name),
    displayName: name,
    skillDirectory,
    updatedAt: new Date().toISOString()
  };
  const home = input.homeDirectory ?? defaultHome();
  const agents = (await loadCollabAgents(home)).filter((item) => item.sourceId !== agent.sourceId);
  agents.push(agent);
  await writeAgents(home, agents);
  return {
    ok: true,
    sourceId: agent.sourceId,
    skillPath,
    text: [
      `已添加 ${name}。`,
      `技能：${skillPath}`,
      `在 ${name} 中新开一个对话即可使用协作项目：直接说「把这个任务加入 <项目名称>」。`
    ].join("\n")
  };
}

export async function removeCollabAgent(name: string, homeDirectory = defaultHome()): Promise<string> {
  const sourceId = collabSourceId(name);
  const agents = await loadCollabAgents(homeDirectory);
  const existing = agents.find((agent) => agent.sourceId === sourceId);
  if (!existing) return `没有名为「${name.trim()}」的已添加 Agent。`;
  await rm(join(existing.skillDirectory, "memmy-project"), { recursive: true, force: true });
  await writeAgents(homeDirectory, agents.filter((agent) => agent.sourceId !== sourceId));
  return `已移除 ${existing.displayName}，并卸掉 memmy-project。已加入项目的任务保留。`;
}

/**
 * 启动时把已添加 Agent 的技能刷新到当前版本。技能目录已经不存在时跳过：不重新创建，
 * 也不因此删掉记录（用户可能只是临时换了目录）。
 */
export async function refreshCollabAgentSkills(options: { homeDirectory?: string } = {}): Promise<number> {
  const home = options.homeDirectory ?? defaultHome();
  const agents = await loadCollabAgents(home);
  let updated = 0;
  for (const agent of agents) {
    const target = join(agent.skillDirectory, "memmy-project");
    const skillPath = join(target, "SKILL.md");
    const directory = await stat(agent.skillDirectory).catch(() => null);
    if (!directory?.isDirectory()) continue;
    const expected = renderMemmyProjectSkillFile({ agentName: agent.displayName });
    const actual = await readFile(skillPath, "utf8").catch(() => null);
    if (actual === expected) continue;
    await mkdir(target, { recursive: true });
    await writeFile(skillPath, expected, "utf8");
    updated += 1;
  }
  return updated;
}

/** A submitted task is one agent's conversation: the same agent asking the same first question keeps one task. */
export function submittedConversationId(agentName: string, firstQuestion: string): string {
  return createHash("sha256").update(`${agentName.trim()}\n${firstQuestion.trim()}`).digest("hex").slice(0, 24);
}

export function defaultCollabHome(): string {
  return defaultHome();
}

function defaultHome(): string {
  return process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy");
}

async function writeAgents(homeDirectory: string, agents: CollabAddedAgent[]): Promise<void> {
  await mkdir(homeDirectory, { recursive: true });
  await writeFile(collabAgentsPath(homeDirectory), JSON.stringify({ agents }, null, 2), "utf8");
}

/**
 * 旧版本在这里还存了 `rule` 与 `needsReonboard`：读取时忽略它们，只保留名称与技能目录，
 * 于是升级后这两项自然退场，不需要迁移脚本。
 */
function isAddedAgent(value: unknown): value is CollabAddedAgent {
  if (!value || typeof value !== "object") return false;
  const agent = value as Partial<CollabAddedAgent>;
  return typeof agent.sourceId === "string"
    && typeof agent.displayName === "string"
    && typeof agent.skillDirectory === "string";
}
