/**
 * 项目指令：项目里的任务在系统提示词里带上项目自己设定的背景与规范。
 *
 * <p>桌面端后端把指令写在本机一份文件里（见 {@code @memmy/local-api-contracts} 的 project-instructions），
 * 这里只读。注入按会话的工作目录判断：工作目录就是项目目录时，这段指令对这个会话生效，因此项目里新建的
 * Memmy 任务、以及同一目录下的子任务都自然遵循它，不需要知道项目是否共享、也不必联网。</p>
 *
 * <p>同一份文件也被其他 Agent 的钩子读取，两边的匹配规则必须一致：都按工作目录（会话的 cwd）取条目。</p>
 */
import fs from "node:fs";
import path from "node:path";
import {
  PROJECT_INSTRUCTIONS_FILE_NAME,
  emptyProjectInstructionsFile,
  parseProjectInstructionsFile,
  projectInstructionsAt,
  type ProjectInstructionsFile
} from "@memmy/local-api-contracts";
import { getConfigPath } from "../config/paths.js";
import { AgentHook, type SystemPromptBuildContext } from "../core/agent-runtime/hook.js";

/** 系统提示词里的段落标题，注入内容被标签包住，便于模型与排障区分。 */
const SECTION_ID = "project-instructions";

export interface ProjectInstructionsSource {
  /** 某个工作目录当前生效的指令；没有则返回空串。 */
  textFor(workspace: string | null | undefined): string;
}

export interface ProjectInstructionsSourceOptions {
  /** 指令文件路径；默认与桌面端后端写入的是同一个位置。 */
  filePath?: string;
}

/** 与后端一致：配置文件所在目录下的 project-instructions.json。 */
export function defaultProjectInstructionsPath(): string {
  return path.join(path.dirname(getConfigPath()), PROJECT_INSTRUCTIONS_FILE_NAME);
}

/**
 * 读指令文件，按修改时间与大小缓存。系统提示词每一轮都会重建，而文件只在项目配置保存时变化，
 * 所以一次任务里通常只读一次盘。
 */
export function createProjectInstructionsSource(
  options: ProjectInstructionsSourceOptions = {}
): ProjectInstructionsSource {
  const filePath = options.filePath ?? defaultProjectInstructionsPath();
  let cached: { key: string; file: ProjectInstructionsFile } | null = null;

  function load(): ProjectInstructionsFile {
    let key: string;
    try {
      const info = fs.statSync(filePath);
      key = `${info.mtimeMs}:${info.size}`;
    } catch {
      // 没有文件就是没有项目设过指令。
      return emptyProjectInstructionsFile();
    }
    if (cached?.key === key) return cached.file;
    try {
      const file = parseProjectInstructionsFile(JSON.parse(fs.readFileSync(filePath, "utf8")));
      cached = { key, file };
      return file;
    } catch {
      // 文件正被替换或内容坏了：当作没有指令，不让一次任务因此起不来。
      return emptyProjectInstructionsFile();
    }
  }

  return {
    textFor(workspace) {
      if (!workspace) return "";
      return projectInstructionsAt(load(), workspace)?.text.trim() ?? "";
    }
  };
}

/** 注入用的段落；内容与 PRD 2.5 的 `project_context` 一致，只是当前先带上指令。 */
export function renderProjectInstructionsSection(text: string): string {
  return [
    "# 项目指令",
    "",
    "本项目设定了以下项目指令，在本项目中的任务里遵循：",
    "",
    "<project_instructions>",
    text,
    "</project_instructions>"
  ].join("\n");
}

/**
 * 把项目指令作为系统提示词的一段加进去。放在 bootstrap（项目内的 AGENTS.md 等）之后：
 * 两者都是项目级规则，一起读更连贯。
 */
export function createProjectInstructionsHook(
  source: ProjectInstructionsSource = createProjectInstructionsSource()
): AgentHook {
  return new (class extends AgentHook {
    override onBuildSystemPrompt(ctx: SystemPromptBuildContext): void {
      const text = source.textFor(ctx.workspace);
      if (!text) return;
      ctx.upsertSection({ id: SECTION_ID, content: renderProjectInstructionsSection(text), source: "project" }, { after: "bootstrap" });
    }
  })();
}
