/**
 * 协作项目指令：云端项目自己设定的背景与规范，注入到该项目里的任务。
 *
 * <p>它与本机项目的项目指令是两条独立的路线：本机的按文件夹归属，读
 * {@code project-instructions.json}；这里的按云端项目归属，读 {@code collab-project-instructions.json}。
 * 两个模块互不 import，段落也各自独立，因此同一段文本不会被注入两次，本机指令的改动也不会牵动协作项目。</p>
 *
 * <p>桌面端后端是这份缓存的唯一写方；这里只读。匹配按工作目录的覆盖关系判断（项目根目录与其子目录都算），
 * 因为协作项目的任务不一定都在根目录下运行。</p>
 */
import fs from "node:fs";
import path from "node:path";
import {
  COLLAB_INSTRUCTIONS_FILE_NAME,
  MEMMY_SCOPE_SOURCE,
  collabInstructionsFor,
  emptyCollabInstructionsFile,
  parseCollabInstructionsFile,
  type CollabInstructionsFile
} from "@memmy/local-api-contracts";
import { getConfigPath } from "../config/paths.js";
import { AgentHook, type SystemPromptBuildContext } from "../core/agent-runtime/hook.js";

/** 系统提示词里的段落标题，注入内容被标签包住，便于模型与排障区分。 */
const SECTION_ID = "collab-project-instructions";

export interface CollabInstructionsSource {
  /**
   * 某个 Memmy 任务命中的协作项目指令；没有则返回 null。
   * Memmy 自己的任务是项目内会话，单位就是项目的工作目录。
   */
  forDirectory(workspace: string | null | undefined): { projectId: string; text: string } | null;
}

export interface CollabInstructionsSourceOptions {
  /** 缓存文件路径；默认与桌面端后端写入的是同一个位置。 */
  filePath?: string;
}

/** 与后端一致：配置文件所在目录下的 collab-project-instructions.json。 */
export function defaultCollabInstructionsPath(): string {
  return path.join(path.dirname(getConfigPath()), COLLAB_INSTRUCTIONS_FILE_NAME);
}

/**
 * 读缓存文件，按修改时间与大小缓存。系统提示词每一轮都会重建，而文件只在云端同步或保存时变化，
 * 所以一次任务里通常只读一次盘。
 */
export function createCollabInstructionsSource(
  options: CollabInstructionsSourceOptions = {}
): CollabInstructionsSource {
  const filePath = options.filePath ?? defaultCollabInstructionsPath();
  let cached: { key: string; file: CollabInstructionsFile } | null = null;

  function load(): CollabInstructionsFile {
    let key: string;
    try {
      const info = fs.statSync(filePath);
      key = `${info.mtimeMs}:${info.size}`;
    } catch {
      // 没有文件就是还没有缓存过任何协作项目的指令。
      return emptyCollabInstructionsFile();
    }
    if (cached?.key === key) return cached.file;
    try {
      const file = parseCollabInstructionsFile(JSON.parse(fs.readFileSync(filePath, "utf8")));
      cached = { key, file };
      return file;
    } catch {
      // 文件正被替换或内容坏了：当作没有指令，不让一次任务因此起不来。
      return emptyCollabInstructionsFile();
    }
  }

  return {
    forDirectory(workspace) {
      if (!workspace) return null;
      const hit = collabInstructionsFor(load(), {
        sourceId: MEMMY_SCOPE_SOURCE,
        groupId: workspace,
        directory: workspace
      });
      if (!hit) return null;
      const text = hit.entry.text.trim();
      return text ? { projectId: hit.projectId, text } : null;
    }
  };
}

/** 注入用的段落；带上项目 id，排障时能看出这段指令来自哪个协作项目。 */
export function renderCollabInstructionsSection(input: { projectId: string; text: string }): string {
  return [
    "# 协作项目指令",
    "",
    "本项目是一个协作项目，所有者设定了以下项目指令，在本项目中的任务里遵循：",
    "",
    `<collab_project_instructions project="${input.projectId}">`,
    input.text,
    "</collab_project_instructions>"
  ].join("\n");
}

/**
 * 把协作项目指令作为系统提示词的一段加进去。放在本机项目指令之后：两者都是项目级规则，
 * 一个属于这台电脑上的文件夹，一个属于云端项目，一起读时先看本机约定再看团队约定。
 */
export function createCollabInstructionsHook(
  source: CollabInstructionsSource = createCollabInstructionsSource()
): AgentHook {
  return new (class extends AgentHook {
    override onBuildSystemPrompt(ctx: SystemPromptBuildContext): void {
      const hit = source.forDirectory(ctx.workspace);
      if (!hit) return;
      ctx.upsertSection(
        { id: SECTION_ID, content: renderCollabInstructionsSection(hit), source: "collab_project" },
        { after: "project-instructions" }
      );
    }
  })();
}
