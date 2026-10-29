/**
 * 协作项目指令的本机缓存：一份文件，按云端项目 id 存。
 *
 * <p>它和本机项目的指令是两个独立的东西：本机指令属于这台电脑上的文件夹（{@code project-instructions-service}），
 * 协作指令属于云端项目，本机只保存一份缓存，供 Memmy 任务与其他 Agent 的钩子只读。因此这里没有
 * 「本机 / 云端」两种来源，也没有降级逻辑：项目停止共享或被删除时，缓存跟着删掉。</p>
 *
 * <p>一条指令的生效范围是「这个项目关联了哪些 Agent 的哪些单位」（见 {@code @memmy/local-api-contracts} 的
 * collab-instructions）：Claude Code 的目录、Cursor 的 workspace、Codex 的项目，以及 Memmy 自己的项目目录。
 * 写入只发生在这里，读方是只读的另外两个进程。</p>
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  COLLAB_INSTRUCTIONS_FILE_NAME,
  MAX_COLLAB_INSTRUCTIONS_CHARS,
  MAX_COLLAB_INSTRUCTIONS_ENTRIES,
  collabInstructionsFor,
  emptyCollabInstructionsFile,
  normalizeScopes,
  parseCollabInstructionsFile,
  type CollabInstructionQuery,
  type CollabInstructionScope,
  type CollabInstructionsEntry,
  type CollabInstructionsFile
} from "@memmy/local-api-contracts";

export interface CollabInstructionsService {
  /** 某个协作项目当前缓存的指令；没有则返回 null。 */
  read(projectId: string): Promise<CollabInstructionsEntry | null>;
  /** 某个会话命中的协作项目指令；注入侧只读文件，这里给排障与测试用。 */
  forQuery(query: CollabInstructionQuery): Promise<{ projectId: string; text: string } | null>;
  /**
   * 把云端指令与它覆盖的会话单位记进本机缓存：项目所有者保存时与成员读取项目列表时都会走这里。
   * 文本为空表示云端删除了指令，本机条目一并清掉。
   */
  remember(input: CollabInstructionsRememberInput): Promise<void>;
  /** 项目离开或被删除：缓存不再代表任何云端项目，直接丢弃。 */
  forget(projectId: string): Promise<void>;
  /** 关联的会话单位变了（新增或取消关联）时更新范围，指令内容不动。 */
  updateScopes(projectId: string, scopes: readonly CollabInstructionScope[]): Promise<void>;
  /** 测试与排障用：文件里的全部条目。 */
  snapshot(): Promise<CollabInstructionsFile>;
}

export interface CollabInstructionsRememberInput {
  projectId: string;
  /** 该项目覆盖的会话单位；为空时保留已有范围，不覆盖成空。 */
  scopes: readonly CollabInstructionScope[];
  text: string;
}

export interface CollabInstructionsServiceOptions {
  /** Memmy 配置路径；文件写在它所在目录，与注入侧读的是同一个位置。 */
  memmyConfigPath: string;
  /** 测试用：直接指定文件路径。 */
  filePath?: string;
  now?: () => Date;
}

export function collabInstructionsFilePath(memmyConfigPath: string): string {
  return join(dirname(memmyConfigPath), COLLAB_INSTRUCTIONS_FILE_NAME);
}

export function createCollabInstructionsService(
  options: CollabInstructionsServiceOptions
): CollabInstructionsService {
  const filePath = options.filePath ?? collabInstructionsFilePath(options.memmyConfigPath);
  const now = options.now ?? (() => new Date());
  /** 写入串行化：同一次启动里的并发保存不能互相覆盖。 */
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<CollabInstructionsFile> {
    try {
      const raw = await readFile(filePath, "utf8");
      if (!raw.trim()) return emptyCollabInstructionsFile();
      return parseCollabInstructionsFile(JSON.parse(raw));
    } catch {
      // 首次运行时没有文件；内容坏了也当作没有缓存，下一次写入会重建。
      return emptyCollabInstructionsFile();
    }
  }

  async function store(file: CollabInstructionsFile): Promise<void> {
    const entries = Object.entries(file.projects);
    const kept = entries.length > MAX_COLLAB_INSTRUCTIONS_ENTRIES
      ? Object.fromEntries(
        entries
          .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
          .slice(0, MAX_COLLAB_INSTRUCTIONS_ENTRIES)
      )
      : file.projects;
    await mkdir(dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, projects: kept }, null, 2)}\n`, "utf8");
    try {
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    async read(projectId) {
      const key = projectId.trim();
      if (!key) return null;
      return (await load()).projects[key] ?? null;
    },

    async forQuery(query) {
      const hit = collabInstructionsFor(await load(), query);
      if (!hit) return null;
      const text = hit.entry.text.trim();
      return text ? { projectId: hit.projectId, text } : null;
    },

    /** 写一个项目的条目；文本为空时删除条目，文件里不留空指令。 */
    async remember(input) {
      const projectId = input.projectId.trim();
      if (!projectId) return;
      const value = input.text.trim();
      if ([...value].length > MAX_COLLAB_INSTRUCTIONS_CHARS) {
        throw new Error(`项目指令不超过 ${MAX_COLLAB_INSTRUCTIONS_CHARS} 字`);
      }
      const scopes = normalizeScopes(input.scopes);
      await enqueue(async () => {
        const file = await load();
        const existing = file.projects[projectId] ?? null;
        if (!value) {
          if (!existing) return;
          delete file.projects[projectId];
          await store(file);
          return;
        }
        // 同步时可能还没算全范围（例如项目刚建、目录未定），沿用已有范围，不要因为一次缺参把范围冲掉。
        const target = scopes.length ? scopes : (existing?.scopes ?? []);
        if (!target.length) throw new Error("协作项目没有可生效的会话范围");
        if (existing && existing.text === value && sameScopes(existing.scopes, target)) return;
        file.projects[projectId] = { scopes: target, text: value, updatedAt: now().toISOString() };
        await store(file);
      });
    },

    async forget(projectId) {
      const key = projectId.trim();
      if (!key) return;
      await enqueue(async () => {
        const file = await load();
        if (!file.projects[key]) return;
        delete file.projects[key];
        await store(file);
      });
    },

    async updateScopes(projectId, scopes) {
      const key = projectId.trim();
      const next = normalizeScopes(scopes);
      if (!key) return;
      await enqueue(async () => {
        const file = await load();
        const existing = file.projects[key];
        if (!existing || !next.length || sameScopes(existing.scopes, next)) return;
        file.projects[key] = { ...existing, scopes: next, updatedAt: now().toISOString() };
        await store(file);
      });
    },

    snapshot() {
      return load();
    }
  };
}

function sameScopes(left: readonly CollabInstructionScope[], right: readonly CollabInstructionScope[]): boolean {
  if (left.length !== right.length) return false;
  const keys = new Set(left.map((scope) => `${scope.sourceId}\u0000${scope.groupId}`));
  return right.every((scope) => keys.has(`${scope.sourceId}\u0000${scope.groupId}`));
}

/**
 * 一次性迁移：老版本把协作项目的云端指令镜像在本机项目指令文件里（`origin: "cloud"`）。
 * 搬到新文件后从老文件删掉，避免同一段指令被两个钩子各注入一次。
 *
 * <p>老数据只有目录，这里转成「项目自己的工作目录 + 该目录」两个范围：前者让 Memmy 的会话命中，
 * 后者让跑在同一个目录里的其他 Agent 会话命中。</p>
 */
export async function migrateLegacyCollabInstructions(input: {
  collabInstructions: Pick<CollabInstructionsService, "remember" | "snapshot">;
  /** 老文件里的云端条目；由调用方从 project-instructions-service 取，避免这里依赖它。 */
  legacyEntries: Array<{ directory: string; text: string; cloudProjectId: string | null }>;
  /** 迁移成功后从老文件删除该目录的条目。 */
  forgetLegacy: (directory: string) => Promise<void>;
}): Promise<number> {
  if (!input.legacyEntries.length) return 0;
  const known = await input.collabInstructions.snapshot();
  let migrated = 0;
  for (const entry of input.legacyEntries) {
    const projectId = entry.cloudProjectId?.trim() ?? "";
    const text = entry.text.trim();
    const directory = entry.directory.trim();
    if (!projectId || !text || !directory) continue;
    // 新文件里已经有这个项目（成员已经同步过），只清老文件里的旧镜像。
    if (!known.projects[projectId]) {
      await input.collabInstructions.remember({
        projectId,
        scopes: [
          { sourceId: "memmy", groupId: directory },
          { sourceId: "*", groupId: directory }
        ],
        text
      });
      migrated += 1;
    }
    await input.forgetLegacy(directory);
  }
  return migrated;
}
