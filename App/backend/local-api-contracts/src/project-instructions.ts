/**
 * 项目指令：项目全体成员在本项目中的任务要遵循的背景与规范。
 *
 * <p>指令既属于本地项目，也属于开启了共享的协作项目，所以它不放在任何一个 Agent 自己的配置里，而是由桌面端
 * 后端写一份本机文件，供三处只读使用：Memmy 任务的系统提示词、其他 Agent 的钩子、以及看板的项目配置。
 * 这样本地项目与协作项目走同一条注入路径，区别只在「指令由谁维护」。</p>
 *
 * <p>文件由后端单独写入（先写临时文件再改名），读方只解析：</p>
 *
 * ```json
 * {
 *   "version": 1,
 *   "projects": {
 *     "/Users/me/code/memmy": {
 *       "text": "本项目负责 Memmy 桌面端的研发。",
 *       "origin": "cloud",
 *       "cloudProjectId": "9f1c…",
 *       "updatedAt": "2026-10-24T12:00:00.000Z"
 *     }
 *   }
 * }
 * ```
 *
 * <p>键是项目任务所在目录（规范化后的绝对路径），因为三个读方都能拿到它：Memmy 任务知道会话的工作目录，
 * 其他 Agent 的钩子拿到 cwd，看板知道本机项目根目录。</p>
 */
import { z } from "zod";

export const PROJECT_INSTRUCTIONS_FILE_NAME = "project-instructions.json";

/**
 * 与云端上限一致。指令全文注入每一轮的系统提示词，所以上限按「够写完项目的背景与规范」定：
 * 1 万字与 WorkBuddy 一致。存储不是瓶颈（1 万字 UTF-8 约 30KB，云端 TEXT 列可用 64KB），
 * 代价在每轮上下文：见 {@link MAX_PROJECT_INSTRUCTIONS_CHARS} 在注入侧的说明。
 */
export const MAX_PROJECT_INSTRUCTIONS_CHARS = 10_000;

/** 一个项目最多记录多少条：多出的目录不会注入，也不会让文件无限增长。 */
export const MAX_PROJECT_INSTRUCTIONS_ENTRIES = 200;

export const ProjectInstructionsOriginSchema = z.enum(["local", "cloud"]);
export type ProjectInstructionsOrigin = z.infer<typeof ProjectInstructionsOriginSchema>;

export const ProjectInstructionsEntrySchema = z.object({
  text: z.string().max(MAX_PROJECT_INSTRUCTIONS_CHARS * 4),
  origin: ProjectInstructionsOriginSchema,
  /** 协作项目的云端 ID；本地项目为 null。 */
  cloudProjectId: z.string().max(64).nullable(),
  updatedAt: z.string().max(40)
}).strict();
export type ProjectInstructionsEntry = z.infer<typeof ProjectInstructionsEntrySchema>;

export const ProjectInstructionsFileSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string().max(4_096), ProjectInstructionsEntrySchema)
}).strict();
export type ProjectInstructionsFile = z.infer<typeof ProjectInstructionsFileSchema>;

/** 空文件：没有项目设定过指令时就是它。 */
export function emptyProjectInstructionsFile(): ProjectInstructionsFile {
  return { version: 1, projects: {} };
}

/**
 * 解析文件内容。读方不只一个进程，坏文件只能当作「没有指令」：
 * 抛错会让一次普通的任务因为别处写坏了文件而开始不了。
 */
export function parseProjectInstructionsFile(raw: unknown): ProjectInstructionsFile {
  const parsed = ProjectInstructionsFileSchema.safeParse(raw);
  return parsed.success ? parsed.data : emptyProjectInstructionsFile();
}

/** 目录 → 文件的键。去掉结尾的分隔符，`a/` 与 `a` 是同一个项目。 */
export function projectInstructionsKey(directory: string): string {
  const trimmed = directory.trim();
  if (!trimmed) return "";
  return trimmed.length > 1 ? trimmed.replace(/[/\\]+$/u, "") : trimmed;
}

/**
 * 取某个目录的指令：命中即返回，否则返回空文本。
 * 读方只要文本，`origin` 与时间由看板与排障使用。
 */
export function projectInstructionsAt(
  file: ProjectInstructionsFile,
  directory: string | null | undefined
): ProjectInstructionsEntry | null {
  if (!directory) return null;
  return file.projects[projectInstructionsKey(directory)] ?? null;
}

/** 指令是否够短到能全文注入；超出时后端在写入前就拒绝，这里兜住历史数据。 */
export function projectInstructionsText(value: string | null | undefined): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const chars = [...text];
  return chars.length <= MAX_PROJECT_INSTRUCTIONS_CHARS ? text : chars.slice(0, MAX_PROJECT_INSTRUCTIONS_CHARS).join("");
}
