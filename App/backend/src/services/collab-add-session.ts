/**
 * Decides which collaboration project and which local task `memmy-project session add` is about, and the words the command
 * prints. Adding never links a whole workspace: the caller saves one session link, and only after the project name
 * matches exactly. Anything short of that is a next command for the agent to confirm with the person.
 */

export interface AddableSession {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  group: { id: string; path: string | null } | null;
  updatedAt: string;
}

export interface NamedProject {
  name: string;
  memberCount: number;
  sessionCount: number;
}

export type ProjectNameMatch<T extends { name: string }> =
  | { kind: "exact"; project: T }
  | { kind: "suggest"; project: T }
  | { kind: "many"; projects: T[] }
  | { kind: "none"; projects: T[] };

export type SessionPick =
  | { kind: "none" }
  | { kind: "unmatched"; session: AddableSession }
  | { kind: "many"; sessions: readonly AddableSession[]; reason: "need-hint" | "ambiguous" | "miss" };

const NO_PROJECTS = "你还没有加入任何 Memmy 协作项目，无法把当前任务加进去。请先在 Memmy 中新建或加入协作项目。";
const NO_DIRECTORY = "无法确定当前目录，没有加入。请在这个对话的工作目录重新运行 memmy-project session add，不要先 cd 到别处。";

/** Sessions whose directory is the command's working directory, or contains it, newest first. */
export function pickAddCandidates<T extends AddableSession>(sessions: readonly T[], cwd: string): T[] {
  return sessions
    .filter((session) => sessionInWorkspace(session, cwd))
    .sort((left, right) => activityMs(right.updatedAt) - activityMs(left.updatedAt));
}

/** True when the task ran in `cwd`, in a directory inside it, or in a parent directory of it. */
export function sessionInWorkspace(session: AddableSession, cwd: string): boolean {
  const paths = [session.workspacePath, session.group?.path ?? null, session.group?.id ?? null];
  return paths.some((path) => sameDirectory(path, cwd));
}

/**
 * Exact name, including case-insensitive when only one project matches. A partial name is never exact: the person
 * confirms it before anything is added.
 */
export function matchProjectName<T extends { name: string }>(projects: readonly T[], rawQuery: string): ProjectNameMatch<T> {
  const query = rawQuery.trim();
  const exact = projects.filter((project) => project.name === query);
  if (exact.length === 1) return { kind: "exact", project: exact[0]! };
  if (exact.length > 1) return { kind: "many", projects: exact };

  const folded = query.toLowerCase();
  const insensitive = projects.filter((project) => project.name.toLowerCase() === folded);
  if (insensitive.length === 1) return { kind: "exact", project: insensitive[0]! };
  if (insensitive.length > 1) return { kind: "many", projects: insensitive };

  if ([...query].length < 2) return { kind: "none", projects: [...projects] };
  const partial = projects.filter((project) => {
    const name = project.name.trim();
    return [...name].length >= 2 && (name.includes(query) || query.includes(name));
  });
  if (partial.length === 1) return { kind: "suggest", project: partial[0]! };
  if (partial.length > 1) return { kind: "many", projects: partial };
  return { kind: "none", projects: [...projects] };
}

export function formatNoProjects(): string {
  return NO_PROJECTS;
}

export function formatNoDirectory(): string {
  return NO_DIRECTORY;
}

/** The running conversation is known, but Memmy has not read that task yet. Do not substitute another one. */
export function formatCurrentSessionMissing(): string {
  return [
    "找不到当前这条任务，还没有加入。",
    "Memmy 还没有读到正在进行的这个对话。请确认 Memmy 已打开；若对话刚开始，先再聊一轮后重试。不要改加别的任务。"
  ].join("\n");
}

/** The person has not named a project yet. Lists the ones they are in and the command to run after they choose. */
export function formatNeedProject(projects: readonly NamedProject[], session: AddableSession, hint: string): string {
  const lines = [
    "还没有指定协作项目，当前任务尚未加入。",
    "",
    `当前任务：${sessionLine(session)}`,
    ""
  ];
  if (projects.length === 1) {
    const only = projects[0]!;
    lines.push(`你只加入了「${only.name}」。向用户确认后运行：`, addCommand({ project: only.name, hint }));
  } else {
    lines.push(
      `你加入了 ${projects.length} 个协作项目：`,
      ...projects.map(projectLine),
      "",
      "请用户选择项目，确认后运行：",
      addCommand({ projectPlaceholder: true, hint })
    );
  }
  return lines.join("\n");
}

/** The name they gave is not an exact project name. Nothing is added. */
export function formatProjectProblem<T extends NamedProject>(
  match: Exclude<ProjectNameMatch<T>, { kind: "exact" }>,
  query: string,
  hint: string
): string {
  if (match.kind === "suggest") {
    return [
      `没有名为「${query}」的协作项目。`,
      `是不是「${match.project.name}」？向用户确认后运行：`,
      addCommand({ project: match.project.name, hint })
    ].join("\n");
  }
  if (match.kind === "many") {
    return [
      `「${query}」对应多个协作项目，请用户选一个完整名称：`,
      ...match.projects.map(projectLine),
      "",
      "确认后运行：",
      addCommand({ projectPlaceholder: true, hint })
    ].join("\n");
  }
  return [
    `没有名为「${query}」的协作项目。你加入的是：`,
    ...match.projects.map(projectLine),
    "",
    "请用户选择后运行：",
    addCommand({ projectPlaceholder: true, hint })
  ].join("\n");
}

/** The current task could not be picked. Nothing is added. */
export function formatSessionProblem(pick: SessionPick, options: { hint: string; project?: string }): string {
  if (pick.kind === "none") {
    return [
      "找不到当前这条任务，还没有加入。",
      "Memmy 没有读到当前目录下的任务。请确认 Memmy 已打开，并且这个 Agent 的任务能在 Memmy 里看到；对话刚开始时，先再聊一轮后重试。",
      "若这个 Agent 的读取规则对不上，请提交当前任务：",
      "memmy-project session add --project \"<项目名称>\" --submit '<{\"agentName\":\"<Agent 名称>\",\"title\":\"<标题>\",\"question\":\"<用户原文>\",\"reply\":\"<助手正文>\"}>'"
    ].join("\n");
  }
  if (pick.kind === "unmatched") {
    return [
      `当前目录只有一条任务：${sessionLine(pick.session)}`,
      "但这句原话不在其中，所以没有加入。",
      "若用户确认就是这一条，运行：",
      addCommand({ project: options.project, hint: "" })
    ].join("\n");
  }
  const listed = pick.sessions.map((session) => `- ${sessionLine(session)}`);
  if (pick.reason === "miss") {
    return [
      "这句原话不在当前目录的这些任务里，还没有加入：",
      ...listed,
      "",
      "换这个对话里另一句原话后运行：",
      addCommand({ project: options.project, hint: "<一句原话>" }),
      "若规则仍然对不上，请提交当前任务：",
      "memmy-project session add --project \"<项目名称>\" --submit '<{\"agentName\":\"<Agent 名称>\",\"title\":\"<标题>\",\"question\":\"<用户原文>\",\"reply\":\"<助手正文>\"}>'"
    ].join("\n");
  }
  if (pick.reason === "ambiguous") {
    return [
      "这句原话对应多条任务，还没有加入。请用户确认是哪一条，并换一句只在那条里出现过的原话：",
      ...listed,
      "",
      "然后运行：",
      addCommand({ project: options.project, hint: "<那句原话>" })
    ].join("\n");
  }
  return [
    "当前目录下有多条任务，还没有加入。请用这个对话里已经出现过的一句原话指定是哪一条：",
    ...listed,
    "",
    "然后运行：",
    addCommand({ project: options.project, hint: "<一句原话>" })
  ].join("\n");
}

export function formatAdded(session: AddableSession, projectName: string, syncing: boolean): string {
  const follow = syncing
    ? "正在同步，之后的新内容也会更新。"
    : "关联已保存，同步完成后成员即可看到，之后的新内容也会更新。";
  return [
    `已把当前任务「${taskTitle(session)}」加入协作项目「${projectName}」。`,
    `关联的是这一整条任务，包含目前已有的全部轮次，没有关联整个工作区。${follow}`
  ].join("\n");
}

export function formatAlready(session: AddableSession, projectName: string, viaGroup: boolean): string {
  const line = `当前任务「${taskTitle(session)}」已经在协作项目「${projectName}」中。`;
  return viaGroup ? `${line}\n这个工作区已经整组关联，新的任务也会同步。这次没有再单独添加。` : line;
}

/** The next command, with values quoted so a name that contains spaces survives a copy. */
export function addCommand(options: { project?: string; hint?: string; projectPlaceholder?: boolean }): string {
  const parts = ["memmy-project session add"];
  if (options.projectPlaceholder) parts.push("--project \"<完整名称>\"");
  else if (options.project?.trim()) parts.push(`--project ${shellArg(options.project)}`);
  if (options.hint?.trim()) parts.push(`--hint ${shellArg(options.hint)}`);
  return parts.join(" ");
}

function projectLine(project: NamedProject): string {
  return `${project.name} · ${count(project.memberCount)} 位成员 · ${count(project.sessionCount)} 个任务`;
}

function sessionLine(session: AddableSession): string {
  const when = /^(\d{4}-\d{2}-\d{2})/u.exec(session.updatedAt)?.[1] ?? "";
  return [session.agentName.trim(), `「${taskTitle(session)}」`, when].filter(Boolean).join(" · ");
}

function taskTitle(session: Pick<AddableSession, "title" | "lastQuestion">): string {
  const raw = session.title.trim() || session.lastQuestion.trim() || "未命名任务";
  const line = raw.replace(/\s+/gu, " ");
  const chars = [...line];
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : line;
}

function shellArg(value: string): string {
  return `"${value.replace(/\s+/gu, " ").trim().replace(/(["\\$`])/gu, "\\$1")}"`;
}

function sameDirectory(path: string | null, cwd: string): boolean {
  const left = canonical(path ?? "");
  const right = canonical(cwd);
  if (!left || !right) return false;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function canonical(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

function activityMs(updatedAt: string): number {
  const parsed = Date.parse(updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function count(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
