/**
 * 协作项目指令：云端项目自己的背景与规范，成员的本机只保存一份缓存。
 *
 * <p>它与本机项目的指令是两套东西，不共用文件、不共用键、不互相降级：本机指令属于这台电脑上的一个文件夹
 * （见 {@code project-instructions}），协作指令属于云端的一个项目。</p>
 *
 * <p>一条指令的生效范围不是一个目录，而是**这个项目关联了哪些 Agent 的哪些会话单位**。单位由每个 Agent
 * 自己的组织方式决定，Memmy 在关联会话时也是按同一套单位让人选的：Claude Code 与 WorkBuddy 是工作目录、
 * Cursor 是 workspace（多根工作区即 workspace 文件）、Codex 是它自己的项目（一个项目可含多个根目录）。
 * 所以条目的键是 (sourceId, groupId)，而不是路径；路径只在单位本身就是目录时才出现。</p>
 *
 * ```json
 * {
 *   "version": 1,
 *   "projects": {
 *     "1853c1ee-3037-4630-9b99-f1709b1514ac": {
 *       "scopes": [
 *         { "sourceId": "memmy", "groupId": "/Users/me/.memmy/local-projects/MemOS" },
 *         { "sourceId": "claude_code", "groupId": "/Users/me/code/memmy" },
 *         { "sourceId": "cursor", "groupId": "/Users/me/work/MemOS.code-workspace" },
 *         { "sourceId": "codex", "groupId": "01a17657-0cd5-7be0-a611-3fdcd387e8ae" }
 *       ],
 *       "text": "本项目负责 Memmy 桌面端的研发。",
 *       "updatedAt": "2026-10-28T13:02:11.000Z"
 *     }
 *   }
 * }
 * ```
 */
import { z } from "zod";

export const COLLAB_INSTRUCTIONS_FILE_NAME = "collab-project-instructions.json";

/**
 * 与云端上限一致。指令全文注入每一轮的系统提示词，所以上限按「够写完项目的背景与规范」定。
 * 这是协作侧自己的常量：本机项目指令调整上限时不应该牵动它。
 */
export const MAX_COLLAB_INSTRUCTIONS_CHARS = 10_000;

/** 一个成员最多缓存多少个协作项目的指令：多出的不再注入，也不让文件无限增长。 */
export const MAX_COLLAB_INSTRUCTIONS_ENTRIES = 200;

/** 一个项目最多记多少个会话单位：关联的 Agent 分组数量级，再多也不该无限增长。 */
export const MAX_COLLAB_INSTRUCTION_SCOPES = 200;

/** 代表这台机器上 Memmy 自己的会话：它们的单位就是项目的工作目录。 */
export const MEMMY_SCOPE_SOURCE = "memmy";

/** 老版本只记目录时用的来源标记：任何 Agent 只要工作目录落在里面都算命中。 */
const ANY_SOURCE = "*";

export const CollabInstructionScopeSchema = z.object({
  /** Agent 来源：claude_code / cursor / codex / workbuddy / memmy 等，与关联会话时的来源一致。 */
  sourceId: z.string().max(64),
  /**
   * 该 Agent 自己的单位 id，语义由 Agent 决定：Claude Code 与 WorkBuddy 是目录路径，Cursor 是 workspace
   * （多根工作区即 .code-workspace 文件），Codex 是它的项目 id；单独关联的会话则是会话 id。
   */
  groupId: z.string().max(4_096),
  /**
   * 这个单位覆盖的目录。Cursor 的 workspace 与 Codex 的项目都可能跨目录，只存单位 id 时从会话端无法匹配，
   * 所以把「它盖住哪些目录」一并记下；单位本身就是目录时可省。
   */
  roots: z.array(z.string().max(4_096)).max(64).optional()
}).strict();
export type CollabInstructionScope = z.infer<typeof CollabInstructionScopeSchema>;

export const CollabInstructionsEntrySchema = z.object({
  scopes: z.array(CollabInstructionScopeSchema).max(MAX_COLLAB_INSTRUCTION_SCOPES).optional(),
  /** 老版本的单个目录与目录列表；只用于读取历史文件，写入一律用 scopes。 */
  directories: z.array(z.string().max(4_096)).max(64).optional(),
  directory: z.string().max(4_096).optional(),
  text: z.string().max(MAX_COLLAB_INSTRUCTIONS_CHARS * 4),
  updatedAt: z.string().max(40)
}).strict().transform((entry) => ({
  scopes: normalizeScopes([
    ...(entry.scopes ?? []),
    // 老数据只有目录：当作「任何来源、按目录覆盖」，迁移后方向仍然正确。
    ...(entry.directories ?? []).map((directory) => ({ sourceId: ANY_SOURCE, groupId: directory })),
    ...(entry.directory ? [{ sourceId: ANY_SOURCE, groupId: entry.directory }] : [])
  ]),
  text: entry.text,
  updatedAt: entry.updatedAt
}));
export type CollabInstructionsEntry = z.infer<typeof CollabInstructionsEntrySchema>;

export const CollabInstructionsFileSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string().max(128), CollabInstructionsEntrySchema)
}).strict();
export type CollabInstructionsFile = z.infer<typeof CollabInstructionsFileSchema>;

/** 空文件：本机还没有缓存任何协作项目的指令时就是它。 */
export function emptyCollabInstructionsFile(): CollabInstructionsFile {
  return { version: 1, projects: {} };
}

/**
 * 解析文件内容。读方不只一个进程，坏文件只能当作「没有指令」：
 * 抛错会让一次普通的任务因为别处写坏了文件而开始不了。
 */
export function parseCollabInstructionsFile(raw: unknown): CollabInstructionsFile {
  const parsed = CollabInstructionsFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyCollabInstructionsFile();
}

/** 目录比较用的规范化：去掉结尾分隔符，`a/` 与 `a` 是同一个目录。 */
export function collabInstructionsDirectoryKey(directory: string): string {
  const trimmed = directory.trim();
  if (!trimmed) return "";
  return trimmed.length > 1 ? trimmed.replace(/[/\\]+$/u, "") : trimmed;
}

/** 去重并丢掉空项；顺序保留，方便排障时看到先关联了哪些单位。 */
export function normalizeScopes(scopes: readonly CollabInstructionScope[]): CollabInstructionScope[] {
  const seen = new Set<string>();
  const kept: CollabInstructionScope[] = [];
  for (const scope of scopes) {
    const sourceId = scope.sourceId.trim();
    const groupId = scope.groupId.trim();
    if (!sourceId || !groupId) continue;
    const key = `${sourceId}\u0000${groupId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const roots = normalizeRoots(scope.roots ?? (needsRoots(groupId) ? [groupId] : []));
    kept.push({
      sourceId,
      groupId: isPathLikeGroup(groupId) ? collabInstructionsDirectoryKey(groupId) : groupId,
      ...(roots.length ? { roots } : {})
    });
  }
  return kept;
}

/** 单位本身就是一个目录时，它盖住的目录就是自己。 */
function needsRoots(groupId: string): boolean {
  return isPathLikeGroup(groupId) && !isWorkspaceFile(groupId);
}

function normalizeRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const root of roots) {
    const key = collabInstructionsDirectoryKey(root);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(key);
  }
  return kept;
}

/** 这个单位本身是不是一个路径（目录或 workspace 文件）。Codex 的项目 id 不是。 */
export function isPathLikeGroup(groupId: string): boolean {
  return groupId.startsWith("/") || groupId.startsWith("~") || /^[A-Za-z]:[\\/]/u.test(groupId);
}

/** Cursor 的多根工作区存成 <name>.code-workspace；它不是目录，要展开里面记录的根。 */
export function isWorkspaceFile(groupId: string): boolean {
  return groupId.endsWith(".code-workspace");
}

/** 某个目录是否属于某个目录单位（本身或它的子目录）。 */
export function collabInstructionsDirectoryCovers(projectDirectory: string, directory: string): boolean {
  const root = collabInstructionsDirectoryKey(projectDirectory);
  const target = collabInstructionsDirectoryKey(directory);
  if (!root || !target) return false;
  if (root === target) return true;
  const separator = root.includes("\\") ? "\\" : "/";
  return target.startsWith(`${root}${separator}`);
}

/** 一个会话在这次查找里的身份：哪个 Agent、属于哪个单位、跑在哪个目录、会话本身是哪个。 */
export interface CollabInstructionQuery {
  sourceId: string;
  /** 该 Agent 按自己的规则算出的单位；算不出来时为 null。 */
  groupId?: string | null;
  /** 会话的工作目录；单位是目录时用它兜底匹配，也用于老数据的目录覆盖。 */
  directory?: string | null;
  /** 会话自身的 id，用于「只关联了这一个会话」的情况。 */
  conversationId?: string | null;
  /**
   * 调用方是否自己算出了精确的单位 id（例如 Codex 的项目）。算出时只认单位与会话的精确匹配，
   * 不再用「单位覆盖的目录」兜底：Codex 的项目根可以互相嵌套，按目录兜底会把别的项目算进来。
   */
  unitIsExact?: boolean;
}

/**
 * 按会话取指令：先看单位是否正好被关联，再看目录是否落在某个目录单位里，最后看是否只关联了这个会话。
 *
 * <p>三个条件都用「这个项目关联过」这一件事做判断，只是粒度不同：Codex 的项目、Cursor 的 workspace、
 * Claude Code 的目录，或单独挑出来的一个会话。</p>
 */
export function collabInstructionsFor(
  file: CollabInstructionsFile,
  query: CollabInstructionQuery
): { projectId: string; entry: CollabInstructionsEntry } | null {
  const sourceId = query.sourceId.trim();
  if (!sourceId) return null;
  const groupId = query.groupId?.trim() ?? "";
  const directory = query.directory?.trim() ?? "";
  const conversationId = query.conversationId?.trim() ?? "";
  if (!groupId && !directory && !conversationId) return null;
  const unitIsExact = query.unitIsExact === true && Boolean(groupId);

  let matched: { projectId: string; entry: CollabInstructionsEntry; weight: number } | null = null;
  for (const [projectId, entry] of Object.entries(file.projects)) {
    for (const scope of entry.scopes) {
      const weight = scopeWeight(scope, { sourceId, groupId, directory, conversationId, unitIsExact });
      if (weight <= 0) continue;
      if (!matched || weight > matched.weight) matched = { projectId, entry, weight };
    }
  }
  return matched ? { projectId: matched.projectId, entry: matched.entry } : null;
}

/** 命中强度：单位精确命中 > 目录覆盖 > 单会话；老数据的通配来源按目录覆盖算。 */
function scopeWeight(
  scope: CollabInstructionScope,
  query: { sourceId: string; groupId: string; directory: string; conversationId: string; unitIsExact: boolean }
): number {
  const sameSource = scope.sourceId === query.sourceId;
  const anySource = scope.sourceId === ANY_SOURCE;
  if (!sameSource && !anySource) return 0;
  // 单位精确命中（钩子自己算出了同一个单位 id）优先，其次单独关联的会话，最后用单位覆盖的目录兜底。
  if (sameSource && query.groupId && scope.groupId === query.groupId) return 300 + scope.groupId.length;
  if (query.conversationId && scope.groupId === query.conversationId) return 200;
  // 算出了精确单位时不再按目录兜底：Codex 的项目根会互相嵌套，兜底会把别的项目算进来。
  if (query.unitIsExact) return 0;
  if (query.directory) {
    const roots = scope.roots?.length ? scope.roots : (needsRoots(scope.groupId) ? [scope.groupId] : []);
    for (const root of roots) {
      if (collabInstructionsDirectoryCovers(root, query.directory)) return 100 + root.length;
    }
  }
  return 0;
}

/** 指令是否够短到能全文注入；超出时后端在写入前就拒绝，这里兜住历史数据。 */
export function collabInstructionsText(value: string | null | undefined): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const chars = [...text];
  return chars.length <= MAX_COLLAB_INSTRUCTIONS_CHARS ? text : chars.slice(0, MAX_COLLAB_INSTRUCTIONS_CHARS).join("");
}
