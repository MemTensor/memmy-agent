/**
 * Cloud sharing state for projects. A project is a local Memmy project; a cloud project is attached to it and
 * names the project's shared record. The sidebar lists local projects and the board reads the same store, so one
 * store keeps a single open project — named by the local project id — and a single fetch of the cloud list.
 */
import type { CollabApplication, CollabApplicationDecision, CollabClient, CollabProject } from "../api/collab-client.js";

export interface CollabProjectsSnapshot {
  /** Null until the first load finishes, so the sidebar can tell "none" from "not loaded yet". */
  projects: CollabProject[] | null;
  /** 已提交、尚未通过的加入申请。云端没返回这个字段时保持上次的值。 */
  applications: CollabApplication[];
  /** 已经审完的申请（通过或未通过），带审核时间；桌面端据此提示一次结果。 */
  decisions: CollabApplicationDecision[];
  /** The local project whose board is open; the cloud project, if any, is derived from it. */
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  /** Set when the sidebar asks for the new-project dialog; the frame opens it once and clears the flag. */
  createPending: boolean;
  /**
   * A local project whose Memmy sessions should be chosen right after sharing started. The board opens that picker
   * once and clears the flag, so a project that was just shared asks which of its own sessions go to the cloud.
   */
  taskPickerFor: string | null;
  /**
   * 看板顶部的一次性提示文案（已本地化）：例如新建项目时勾了共享但云端不可用。看板显示几秒后自行清除。
   */
  notice: string | null;
}

let snapshot: CollabProjectsSnapshot = {
  projects: null,
  applications: [],
  decisions: [],
  selectedId: null,
  loading: false,
  error: null,
  createPending: false,
  taskPickerFor: null,
  notice: null
};
const listeners = new Set<() => void>();

function update(patch: Partial<CollabProjectsSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

export function subscribeCollabProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCollabProjectsSnapshot(): CollabProjectsSnapshot {
  return snapshot;
}

/** The cloud project a local project is shared through, or null while it is only on this computer. */
export function sharedProjectFor(
  projects: CollabProject[] | null | undefined,
  localProjectId: string | null | undefined
): CollabProject | null {
  if (!projects || !localProjectId) return null;
  return projects.find((project) => project.localProjectId === localProjectId) ?? null;
}

/**
 * 共享 store 的两个写入点都会收到「内容一样的新对象」（轮询、切回窗口后的重读），
 * 字段逐个比一遍就能判断要不要通知订阅方；值都是字符串与数字，浅比即可。
 */
function sameRecord(left: object, right: object): boolean {
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key] === b[key]);
}

function sameRecords(left: readonly object[], right: readonly object[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => sameRecord(entry, right[index]!));
}

/** The load in flight, so a caller that arrives during one waits for it instead of reading a stale list. */
let inFlight: Promise<void> | null = null;

/**
 * Reloads the shared list. A second caller while a load runs waits for it and then loads again: dropping that
 * reload is what left the sidebar showing a project whose cloud record had already been deleted.
 */
export async function loadCollabProjects(client: CollabClient): Promise<void> {
  if (inFlight) await inFlight.catch(() => undefined);
  const run = (async () => {
    // 列表第一次读之前才需要「加载中」；重读时不动这个标记，也就不会白通知一次订阅方。
    if (snapshot.projects === null) update({ loading: true, error: null });
    try {
      const listed = normalizeProjectList(await client.listProjects());
      // The open project is local, so a reload must not move the board: only a vanished project clears it.
      // 云端没带申请列表时保留本机刚记下的申请；已经是成员的项目不再显示「申请中」。
      const joined = new Set(listed.projects.map((project) => project.id));
      const applications = (listed.applications ?? snapshot.applications)
        .filter((application) => !joined.has(application.projectId));
      // 后台还没有审核结果这一列时保留上一次的值，免得一次刷新把待提示的结果冲掉。
      // 结果不按「已加入」过滤：通过的那一条正是靠它给一次提示，提示过之后就记在本机不再弹。
      const decisions = listed.decisions ?? snapshot.decisions;
      // 一个字段都没变（切回窗口、轮询带来的重读）就不写：侧栏与看板不必跟着重画一遍。
      const unchanged = snapshot.projects !== null
        && snapshot.error === null
        && sameRecords(snapshot.projects, listed.projects)
        && sameRecords(snapshot.applications, applications)
        && sameRecords(snapshot.decisions, decisions);
      if (unchanged) return;
      update({ projects: listed.projects, applications, decisions, loading: false, error: null });
    } catch (cause) {
      // 云端不可用时保留已有列表：项目就在本机，云端只决定能不能看共享内容。
      update({ loading: false, error: messageOf(cause) });
    }
  })();
  inFlight = run;
  try {
    await run;
  } finally {
    if (inFlight === run) inFlight = null;
  }
}

/** 在看板顶部显示一次性提示（传入已本地化的文案），由看板在几秒后清除。 */
export function showCollabNotice(message: string): void {
  update({ notice: message });
}

/** 清除看板顶部的一次性提示。 */
export function dismissCollabNotice(): void {
  if (snapshot.notice !== null) update({ notice: null });
}

/** Opens one project's board, named by its local project id. */
export function selectCollabProject(localProjectId: string | null): void {
  if (snapshot.selectedId === localProjectId) return;
  update({ selectedId: localProjectId });
}

/** 申请刚提交时先记到侧边栏，随后的列表刷新会用云端结果替换。 */
export function addPendingApplication(application: CollabApplication): void {
  const rest = snapshot.applications.filter((current) => current.projectId !== application.projectId);
  update({ applications: [application, ...rest] });
}

/** After sharing a project: its cloud record leads the list. Opening the board is the caller's decision. */
export function addCollabProject(project: CollabProject): void {
  const rest = (snapshot.projects ?? []).filter((current) => current.id !== project.id);
  update({ projects: [project, ...rest] });
}

/** Keeps the sidebar name and member count current after the board reloads a project. */
export function replaceCollabProject(project: CollabProject): void {
  if (!snapshot.projects) return;
  // 轮询每 5 秒带回一份新对象：字段没变就不通知，否则侧栏会跟着重画一次。
  const current = snapshot.projects.find((entry) => entry.id === project.id);
  if (current && sameRecord(current, project)) return;
  update({ projects: snapshot.projects.map((entry) => (entry.id === project.id ? project : entry)) });
}

/** Drops a project's cloud record after sharing was turned off; the local project stays. */
export function removeCollabProject(projectId: string): void {
  if (!snapshot.projects) return;
  update({ projects: snapshot.projects.filter((project) => project.id !== projectId) });
}

/**
 * Records the local Memmy project an online project runs tasks in, so the sidebar can list its sessions right
 * after creation instead of waiting for the next full load.
 */
export function markCollabProjectBound(projectId: string, localProjectId: string): void {
  if (!snapshot.projects) return;
  update({
    projects: snapshot.projects.map((project) => (
      project.id === projectId ? { ...project, localProjectId } : project
    ))
  });
}

export function requestCreateProject(): void {
  update({ createPending: true });
}

/** Clears the request the frame just acted on, so navigating back does not reopen the dialog. */
export function consumeCreateProjectRequest(): void {
  if (snapshot.createPending) update({ createPending: false });
}

/** Asks the board to open the project-session picker for a project whose sharing just started. */
export function requestTaskPicker(localProjectId: string): void {
  update({ taskPickerFor: localProjectId });
}

/** Clears the picker request the board just acted on. */
export function consumeTaskPickerRequest(): void {
  if (snapshot.taskPickerFor) update({ taskPickerFor: null });
}

/** Test seam: drops every listener and returns the store to its first state. */
export function resetCollabProjectsStore(): void {
  inFlight = null;
  snapshot = {
    projects: null,
    applications: [],
    decisions: [],
    selectedId: null,
    loading: false,
    error: null,
    createPending: false,
    taskPickerFor: null,
    notice: null
  };
  listeners.clear();
}

/**
 * 测试里有的客户端仍直接返回项目数组。正式客户端返回 `{ projects, applications? }`，
 * `applications` 缺省表示云端还没有这份列表。
 */
function normalizeProjectList(
  listed: {
    projects: CollabProject[];
    applications?: CollabApplication[];
    decisions?: CollabApplicationDecision[];
  } | CollabProject[]
): { projects: CollabProject[]; applications?: CollabApplication[]; decisions?: CollabApplicationDecision[] } {
  if (Array.isArray(listed)) return { projects: listed };
  return listed;
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  // Schema validation prints its whole issue list; leave it to the page's readable fallback.
  if (!raw || raw.startsWith("[") || raw.startsWith("{")) return "";
  return raw;
}
