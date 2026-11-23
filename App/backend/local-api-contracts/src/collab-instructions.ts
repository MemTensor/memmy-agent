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
 *       "name": "MemOS",
 *       "members": ["孙起", "张三"],
 *       "text": "本项目负责 Memmy 桌面端的研发。",
 *       "updatedAt": "2026-10-28T13:02:11.000Z"
 *     }
 *   }
 * }
 * ```
 *
 * <p>条目代表的是「这个目录属于一个协作项目」，不只是「这个项目有背景与规范」：项目没写背景与规范时
 * `text` 是空串，条目照样存在，{@link renderCollabProjectContext} 会省掉这一段、只说明项目与成员。</p>
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

/**
 * 项目名的长度上限。名字进注入文本的第一句与标签属性，不参与决策，所以只按「够写一个项目名」定。
 * 写入时按它截断，读取侧的上限放宽：名字过长不该让整份文件解析失败、连带别的项目也拿不到指令。
 */
export const MAX_COLLAB_PROJECT_NAME_CHARS = 120;

/** 一个项目最多记多少个成员名：与云端成员上限同量级，再多也不该无限增长。 */
export const MAX_COLLAB_PROJECT_MEMBERS = 200;

/** 单个成员显示名的长度上限。 */
export const MAX_COLLAB_PROJECT_MEMBER_NAME_CHARS = 64;

/** 读取侧对这两个字段的上限：宽松到不会被历史或云端数据撑破，写入时再按上面的常量收紧。 */
const READ_NAME_MAX = 4_096;
const READ_MEMBER_NAME_MAX = 4_096;
const READ_MEMBERS_MAX = 1_000;

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
  /**
   * 项目名。没有背景与规范的项目也有条目，靠它告诉 Agent「这个目录属于哪个协作项目」，
   * 所以老条目没有这个字段是正常的，读到 undefined 时按「不知道名字」处理。
   */
  name: z.string().max(READ_NAME_MAX).optional(),
  /** 成员显示名；同样可能缺省，缺省时注入文本里不提成员。 */
  members: z.array(z.string().max(READ_MEMBER_NAME_MAX)).max(READ_MEMBERS_MAX).optional(),
  /** 背景与规范全文；项目没设定时是空串——条目仍然代表「这个目录属于一个协作项目」。 */
  text: z.string().max(MAX_COLLAB_INSTRUCTIONS_CHARS * 4),
  updatedAt: z.string().max(40)
}).strict().transform((entry) => {
  const name = collabProjectName(entry.name);
  const members = collabProjectMembers(entry.members);
  return {
    scopes: normalizeScopes([
      ...(entry.scopes ?? []),
      // 老数据只有目录：当作「任何来源、按目录覆盖」，迁移后方向仍然正确。
      ...(entry.directories ?? []).map((directory) => ({ sourceId: ANY_SOURCE, groupId: directory })),
      ...(entry.directory ? [{ sourceId: ANY_SOURCE, groupId: entry.directory }] : [])
    ]),
    ...(name ? { name } : {}),
    ...(members.length ? { members } : {}),
    text: entry.text,
    updatedAt: entry.updatedAt
  };
});
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

/**
 * 项目名：换行与连续空白换成单个空格，按上限截断；没有名字时返回空串。
 *
 * <p>名字只是提示词里的一句话与一个标签属性，不是键：写与读都按同一套规则归一，
 * 存进去的和渲染出来的一致，也方便写入侧判断「内容没变就不重写文件」。</p>
 */
export function collabProjectName(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return truncateChars(value.replace(/\s+/gu, " ").trim(), MAX_COLLAB_PROJECT_NAME_CHARS);
}

/** 成员显示名：去换行、去空项、按名字去重；超过人数上限的部分不再记。 */
export function collabProjectMembers(value: readonly (string | null | undefined)[] | null | undefined): string[] {
  if (!value?.length) return [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of value) {
    const name = typeof raw === "string" ? truncateChars(raw.replace(/\s+/gu, " ").trim(), MAX_COLLAB_PROJECT_MEMBER_NAME_CHARS) : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    kept.push(name);
    if (kept.length >= MAX_COLLAB_PROJECT_MEMBERS) break;
  }
  return kept;
}

function truncateChars(value: string, limit: number): string {
  const chars = [...value];
  return chars.length <= limit ? value : chars.slice(0, limit).join("").trim();
}

/**
 * 注入用的协作项目段：这个目录属于哪个项目、成员有谁、背景与规范是什么。
 *
 * <p>它是「项目背景」而不是「指令全文」，所以三种缺省都要能出文：没有背景与规范时只留项目与成员，
 * 没有成员时只提项目，两者都没有时也要能说清「这个目录属于一个协作项目」——不然 Agent 在已关联的
 * 目录里仍然不知道要先查项目任务。</p>
 */
export interface CollabProjectContextInput {
  /** 项目名；不知道时留空。 */
  name?: string | null;
  /** 成员显示名；为空时不提成员。 */
  members?: readonly string[] | null;
  /** 背景与规范全文；为空时省去这一段。 */
  text?: string | null;
}

export function renderCollabProjectContext(input: CollabProjectContextInput): string {
  const name = collabProjectName(input.name);
  const members = collabProjectMembers(input.members);
  const text = collabInstructionsText(input.text);
  const lines = [
    name ? `<collab_project name="${collabProjectAttribute(name)}">` : "<collab_project>",
    `当前工作目录属于${name ? ` Memmy 协作项目「${name}」` : "一个 Memmy 协作项目"}`
      + `${members.length ? `，成员有${members.join("、")}` : ""}`
      + "，成员在各自 Agent 里做过的任务都共享在这个项目中。",
    "用户问到这个项目里以前做过什么、怎么定的、为什么这样做、谁在做、进展到哪时，"
      + "即使没提成员和项目，也先用 memmy-project 在本项目的任务里查；问代码现在是什么样，以代码为准。"
  ];
  if (text) lines.push("", "所有者设定了以下背景与规范，在本项目中的任务里遵循：", "", text);
  lines.push("</collab_project>");
  return lines.join("\n");
}

/** 项目名进属性前收拾一下：引号换成单引号、尖括号去掉，免得把标签拆坏。 */
function collabProjectAttribute(name: string): string {
  return name.replace(/"/gu, "'").replace(/[<>]/gu, "");
}
