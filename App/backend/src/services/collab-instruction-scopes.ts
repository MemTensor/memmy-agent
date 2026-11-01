/**
 * 项目指令的生效范围：把这个项目关联的会话单位翻译成指令能匹配的形式。
 *
 * <p>单位仍然保留 Agent 自己的语义（Claude Code 的目录、Cursor 的 workspace、Codex 的项目 id、单独关联的
 * 会话 id），另外补一份「这个单位盖住哪些目录」。补目录不是把单位压平成目录，而是因为会话端只拿得到
 * 工作目录与会话 id：Cursor 的 workspace 与 Codex 的项目都可能跨目录，不带上根就无从判断。</p>
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MEMMY_SCOPE_SOURCE,
  isPathLikeGroup,
  isWorkspaceFile,
  type CollabInstructionScope
} from "@memmy/local-api-contracts";
import { readCodexProjects, readWorkspaceRoots } from "../adapters/outbound/agent-source/session-reference/session-group.js";

export interface InstructionScopeLinks {
  /** 这个项目自己的任务跑在哪。 */
  workingDirectory: string | null;
  /** 整组关联的 Agent 单位。 */
  groups: ReadonlyArray<{ sourceId: string; groupId: string }>;
  /** 单独关联的会话。 */
  sessions: ReadonlyArray<{ sourceId: string; conversationId: string }>;
}

export interface InstructionScopeOptions {
  /** Codex 的状态库所在目录；默认 ~/.codex，测试可替换。 */
  codexHome?: string;
}

/**
 * 范围 = 项目自己的工作目录 + 关联的每个 Agent 单位 + 单独关联的会话。
 * 算不出的单位（比如 Cursor 工作区文件已不存在）仍然保留单位本身，只是没有目录可兜底。
 */
export function instructionScopesFrom(
  links: InstructionScopeLinks,
  options: InstructionScopeOptions = {}
): CollabInstructionScope[] {
  const scopes: CollabInstructionScope[] = [];
  const directory = links.workingDirectory?.trim();
  if (directory) scopes.push({ sourceId: MEMMY_SCOPE_SOURCE, groupId: directory, roots: [directory] });

  for (const group of links.groups) {
    const sourceId = group.sourceId?.trim();
    const groupId = group.groupId?.trim();
    if (!sourceId || !groupId) continue;
    const roots = rootsFor(sourceId, groupId, options);
    scopes.push(roots.length ? { sourceId, groupId, roots } : { sourceId, groupId });
  }

  for (const session of links.sessions) {
    const sourceId = session.sourceId?.trim();
    const conversationId = session.conversationId?.trim();
    if (!sourceId || !conversationId) continue;
    scopes.push({ sourceId, groupId: conversationId });
  }

  return scopes;
}

/** 一个单位盖住的目录：Cursor 的 workspace 文件展开，Codex 的项目按项目 id 查它登记的根。 */
function rootsFor(sourceId: string, groupId: string, options: InstructionScopeOptions): string[] {
  if (isWorkspaceFile(groupId)) return readWorkspaceRoots(groupId);
  if (isPathLikeGroup(groupId)) return [groupId];
  if (sourceId === "codex") {
    const projects = readCodexProjects(options.codexHome ?? join(homedir(), ".codex"));
    return projects?.find((project) => project.id === groupId)?.roots ?? [];
  }
  return [];
}
