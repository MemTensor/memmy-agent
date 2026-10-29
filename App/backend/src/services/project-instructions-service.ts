/**
 * 本机项目的项目指令：「这台电脑上的这个文件夹」的规矩，存一份文件。
 *
 * <p>它只管本机项目。协作项目有自己的文件与自己的注入路径（见 {@code collab-instructions-service}），
 * 两边不读写对方的文件：同一段文本不会注入两次，一方的保存也不会改写另一方的内容。</p>
 *
 * <p>文件格式与读取规则见 {@code @memmy/local-api-contracts} 的 project-instructions：键是项目所在的文件夹。
 * 写入只发生在这里（桌面端后端），读方是只读的另外两个进程。</p>
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MAX_PROJECT_INSTRUCTIONS_CHARS,
  MAX_PROJECT_INSTRUCTIONS_ENTRIES,
  PROJECT_INSTRUCTIONS_FILE_NAME,
  emptyProjectInstructionsFile,
  parseProjectInstructionsFile,
  projectInstructionsKey,
  type ProjectInstructionsEntry,
  type ProjectInstructionsFile,
  type ProjectInstructionsOrigin
} from "@memmy/local-api-contracts";

export interface ProjectInstructionsView {
  /** 当前生效的指令；没有设定时为空串。 */
  text: string;
  /** 谁在维护这份指令：本机编辑，还是同步自协作项目。 */
  origin: ProjectInstructionsOrigin | null;
  cloudProjectId: string | null;
  updatedAt: string | null;
}

export const EMPTY_PROJECT_INSTRUCTIONS: ProjectInstructionsView = {
  text: "",
  origin: null,
  cloudProjectId: null,
  updatedAt: null
};

export interface ProjectInstructionsService {
  /** 某个目录当前生效的指令；目录没有指令时返回空文本。 */
  read(directory: string): Promise<ProjectInstructionsView>;
  /** 本机项目在项目配置中保存的指令。空文本表示清除。 */
  saveLocal(directory: string, text: string): Promise<ProjectInstructionsView>;
  /**
   * 删掉某个目录的条目。用于迁移：老版本曾把协作项目的指令镜像在这里，搬走后要把镜像清掉。
   */
  forget(directory: string): Promise<void>;
  /** 测试与排障用：文件里的全部条目。 */
  snapshot(): Promise<ProjectInstructionsFile>;
}

export interface ProjectInstructionsServiceOptions {
  /** Memmy 配置路径；文件写在它所在目录，与 Memmy 任务读的是同一个位置。 */
  memmyConfigPath: string;
  /** 测试用：直接指定文件路径。 */
  filePath?: string;
  now?: () => Date;
}

export function projectInstructionsFilePath(memmyConfigPath: string): string {
  return join(dirname(memmyConfigPath), PROJECT_INSTRUCTIONS_FILE_NAME);
}

export function createProjectInstructionsService(options: ProjectInstructionsServiceOptions): ProjectInstructionsService {
  const filePath = options.filePath ?? projectInstructionsFilePath(options.memmyConfigPath);
  const now = options.now ?? (() => new Date());
  /** 写入串行化：同一次启动里的并发保存不能互相覆盖。 */
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<ProjectInstructionsFile> {
    try {
      const raw = await readFile(filePath, "utf8");
      if (!raw.trim()) return emptyProjectInstructionsFile();
      return parseProjectInstructionsFile(JSON.parse(raw));
    } catch {
      // 首次运行时没有文件；内容坏了也当作没有指令，下一次写入会重建。
      return emptyProjectInstructionsFile();
    }
  }

  async function store(file: ProjectInstructionsFile): Promise<void> {
    const entries = Object.entries(file.projects);
    const kept = entries.length > MAX_PROJECT_INSTRUCTIONS_ENTRIES
      ? Object.fromEntries(
        entries
          .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
          .slice(0, MAX_PROJECT_INSTRUCTIONS_ENTRIES)
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

  function view(entry: ProjectInstructionsEntry | null): ProjectInstructionsView {
    if (!entry || !entry.text) return EMPTY_PROJECT_INSTRUCTIONS;
    return {
      text: entry.text,
      origin: entry.origin,
      cloudProjectId: entry.cloudProjectId,
      updatedAt: entry.updatedAt
    };
  }

  /** 写一条本机指令；文本为空时删除该目录，文件里不留空条目。 */
  async function write(directory: string, text: string): Promise<ProjectInstructionsView> {
    const key = projectInstructionsKey(directory);
    if (!key) throw new Error("项目目录无效");
    const value = text.trim();
    if ([...value].length > MAX_PROJECT_INSTRUCTIONS_CHARS) {
      throw new Error(`项目指令不超过 ${MAX_PROJECT_INSTRUCTIONS_CHARS} 字`);
    }
    return enqueue(async () => {
      const file = await load();
      const existing = file.projects[key] ?? null;
      if (!value) {
        if (existing) {
          delete file.projects[key];
          await store(file);
        }
        return EMPTY_PROJECT_INSTRUCTIONS;
      }
      if (existing && existing.text === value && existing.origin === "local" && existing.cloudProjectId === null) {
        return view(existing);
      }
      const entry: ProjectInstructionsEntry = {
        text: value,
        origin: "local",
        cloudProjectId: null,
        updatedAt: now().toISOString()
      };
      file.projects[key] = entry;
      await store(file);
      return view(entry);
    });
  }

  return {
    async read(directory) {
      const key = projectInstructionsKey(directory);
      if (!key) return EMPTY_PROJECT_INSTRUCTIONS;
      return view((await load()).projects[key] ?? null);
    },

    saveLocal(directory, text) {
      return write(directory, text);
    },

    async forget(directory) {
      const key = projectInstructionsKey(directory);
      if (!key) return;
      await enqueue(async () => {
        const file = await load();
        if (!file.projects[key]) return;
        delete file.projects[key];
        await store(file);
      });
    },

    snapshot() {
      return load();
    }
  };
}
