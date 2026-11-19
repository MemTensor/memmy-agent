/**
 * 协作项目读取其他 Agent 的授权状态。
 *
 * 记忆侧的「扫描已有 Agent 对话」不等于这一项：那一项只在本机整理个人记忆，这一项会把选中的任务
 * 同步给项目成员，并把 `memmy-project` 装进其他 Agent。因此单独存一份，默认未授权。
 *
 * 文件：`~/.memmy/collab-agent-access.json`
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultCollabHome } from "./collab-added-agents.js";

/** 授权状态，以及询问与按 Agent 关闭的记录。 */
export interface CollabAgentAccessState {
  /** 是否授权「在其他 Agent 中使用协作项目」：读取任务记录 + 安装 memmy-project 及钩子里的项目部分。 */
  granted: boolean;
  /**
   * 是否已经在协作项目里询问过。引导结束后询问一次、加入者第一次打开所加入项目的看板时询问一次；
   * 选「暂不安装」也算问过，之后不再主动询问，只能从设置里授权。
   */
  askedInProject: boolean;
  /** 在设置里逐个关掉的 Agent：不再读取它的任务，也不再给它装组件。 */
  disabledAgents: string[];
}

const ACCESS_FILE = "collab-agent-access.json";

export const DEFAULT_COLLAB_AGENT_ACCESS: Readonly<CollabAgentAccessState> = Object.freeze({
  granted: false,
  askedInProject: false,
  disabledAgents: []
});

export function collabAgentAccessPath(homeDirectory = defaultCollabHome()): string {
  return join(homeDirectory, ACCESS_FILE);
}

/** 读取授权状态；文件不存在或读坏了都按「未授权、没问过」处理，不因为坏文件放开读取。 */
export async function readCollabAgentAccess(homeDirectory = defaultCollabHome()): Promise<CollabAgentAccessState> {
  const text = await readFile(collabAgentAccessPath(homeDirectory), "utf8").catch(() => "");
  if (!text) return { ...DEFAULT_COLLAB_AGENT_ACCESS, disabledAgents: [] };
  try {
    const parsed = JSON.parse(text) as Partial<CollabAgentAccessState>;
    return {
      granted: parsed.granted === true,
      askedInProject: parsed.askedInProject === true,
      disabledAgents: Array.isArray(parsed.disabledAgents)
        ? [...new Set(parsed.disabledAgents.filter((id): id is string => typeof id === "string" && id.trim() !== ""))]
        : []
    };
  } catch {
    return { ...DEFAULT_COLLAB_AGENT_ACCESS, disabledAgents: [] };
  }
}

export async function writeCollabAgentAccess(
  state: CollabAgentAccessState,
  homeDirectory = defaultCollabHome()
): Promise<CollabAgentAccessState> {
  const normalized: CollabAgentAccessState = {
    granted: state.granted === true,
    askedInProject: state.askedInProject === true,
    disabledAgents: [...new Set(state.disabledAgents.map((id) => id.trim()).filter((id) => id !== ""))]
  };
  await mkdir(homeDirectory, { recursive: true });
  await writeFile(collabAgentAccessPath(homeDirectory), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}
