/**
 * Online projects. Projects, members and associated sessions live in the Memmy cloud; this service signs those
 * requests with the person's account, reads local agent sessions through the Memory service when they associate
 * one, and reads a referenced session online for an agent.
 *
 * 协作任务只在云端保存，本机不保留正文副本：读取、引用、检索都现查云端，离线时不可用。
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ApiErrorCode } from "./error-envelope.js";
import { LocalSessionReadError, type LocalSessionReader } from "../adapters/outbound/agent-source/session-reference/local-session-reader.js";
import {
  formatAdded,
  formatAlready,
  formatCurrentSessionMissing,
  formatNeedProject,
  formatNoDirectory,
  formatNoProjects,
  formatProjectProblem,
  formatSessionProblem,
  matchProjectName,
  pickAddCandidates,
  type SessionPick
} from "./collab-add-session.js";
import { ensureDirectory, uniqueProjectDirectory } from "./project-directory.js";
import { MAX_COLLAB_INSTRUCTIONS_CHARS, collabInstructionsDirectoryKey, type CollabInstructionScope } from "@memmy/local-api-contracts";
import { instructionScopesFrom } from "./collab-instruction-scopes.js";
import type { CollabInstructionsService } from "./collab-instructions-service.js";
import type { ProjectInstructionsService } from "./project-instructions-service.js";

const CLOUD_TIMEOUT_MS = 20_000;
/** A delete slower than this is worth a log line: the cloud call and the links write are the only things in it. */
const SLOW_DELETE_MS = 2_000;
const UPLOAD_TIMEOUT_MS = 60_000;
/** Enough for every agent's recent sessions, so association sees the same pool as the picker. */
const MAX_LOCAL_SESSIONS = 500;
/** How many sessions the @ menu lists before the person types anything. */
const CANDIDATE_LIMIT = 5;
/** The board's page size, so a long project does not render every session at once. */
export const SESSION_PAGE_SIZE = 10;
/**
 * Sessions uploaded in parallel. Reading one session from the Memory service dominates the cost — large agent
 * sessions take seconds — so a bounded pool keeps a bulk association from taking minutes.
 */
const UPLOAD_CONCURRENCY = 4;
/**
 * Sessions of one agent read together. An agent's store is read whole whichever session is asked for, so one batch
 * costs about what one session did; the cap bounds how many sessions one pass holds at once.
 */
const READ_MANY_CHUNK = 20;
const LINKS_FILE = "links.json";
/**
 * 每名成员在一个项目内最多保留的任务数（云端 `CollabLimits.MAX_SESSIONS_PER_MEMBER`），
 * 新建的 Memmy 任务与关联的 Agent 任务共用。超出这个数量的任务不上传：云端本来就会按最近交互挤掉。
 */
const SESSIONS_PER_MEMBER = 20;
/** Matches the cloud limits so an upload is never rejected for size. */
const MAX_UPLOAD_TURNS = 300;
const MAX_QUESTION_CHARS = 4_000;
const MAX_REPLY_CHARS = 8_000;
const MAX_STEPS_PER_TURN = 40;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,36}$/u;
/** Marks the sessions of Memmy's own tasks, which are not one of the external agent sources. */
export const MEMMY_SOURCE_ID = "memmy";
/** The ID ends at the path, the query, or whatever the person typed after pasting the link. */
const SESSION_LINK_PATTERN = /\/s\/([A-Za-z0-9-]{1,36})(?=[/?#\s]|$)/u;
/** An invite code alone, or inside the copied invite text: `…/i/<code>`. */
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{16,32}$/u;
const INVITE_LINK_PATTERN = /\/i\/([A-Za-z0-9_-]{16,32})(?=[/?#\s]|$)/u;
/** Turns `sessions read` prints in full by default; earlier turns are listed by their question. */
const OVERVIEW_TURNS = 5;
/** Turns printed on each side of the one asked for with `around`, or the first one `find` hits. */
const NEIGHBOUR_TURNS = 2;
/** Latest turns added after an excerpt from the middle, so the agent also sees where the session ended up. */
const EXCERPT_LATEST_TURNS = 3;
/** Turns of one `find` printed in full; the rest are only named. */
const MAX_FIND_TURNS = 5;
/** Earlier turns listed one line each; a longer session says how many more there are. */
const OUTLINE_LIMIT = 30;
const OUTLINE_QUESTION_CHARS = 80;
/**
 * The cloud returns at most this many. A search always asks for all of them: the same session shared to several
 * projects comes back once per project, and `since` filters afterwards, so a smaller page could come up short.
 */
const CLOUD_SEARCH_LIMIT = 20;
const DEFAULT_SEARCH_RESULTS = 5;
/** 一条任务最多列几处命中，与云端一致；再多的命中换成更具体的词比继续读更有用。 */
const MAX_SEARCH_HITS = 3;
/** How many local tasks `add` looks at in the working directory. The current one is among the newest. */
const ADD_CANDIDATE_LIMIT = 50;
/** Tasks reread to see whether a sentence from the conversation is in them. */
const ADD_HINT_READS = 8;
const SINCE_UNITS_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export class CollabError extends Error {
  constructor(readonly code: ApiErrorCode, message: string) {
    super(message);
    this.name = "CollabError";
  }
}

export interface CollabAccount {
  accountId: string;
  credential: string;
  /** The signed-in person's nickname, shown on their own sessions instead of a generic "you". */
  memberName?: string;
}

export interface CollabServiceOptions {
  cloudBaseUrl: string;
  getAccount: () => CollabAccount | null;
  /** Reads this machine's agent sessions, in this process; null when they cannot be read here. */
  localSessions: LocalSessionReader | null;
  /** Origin of session links; the cloud origin when absent. */
  linkBaseUrl?: string;
  /** Where this computer keeps each project's links file; ~/.memmy/projects by default. */
  projectsDir?: string;
  /** Memmy's own task sessions; ~/.memmy/workspace/sessions by default. */
  agentSessionsDir?: string;
  fetcher?: typeof fetch;
  now?: () => Date;
  /** Codex 的状态库目录，用来把关联的 Codex 项目换算成它覆盖的根；默认 ~/.codex。 */
  codexHome?: string;
  /**
   * 协作项目指令的本机缓存。云端项目是权威，这里只保存一份供注入读取的副本：
   * 项目里的 Memmy 任务与其他 Agent 的任务据此注入；未提供时只做云端读写。
   *
   * <p>它不读也不写本机项目的项目指令文件：那套按文件夹归属，与协作项目没有关系。</p>
   */
  collabInstructions?: CollabInstructionsService;
  /**
   * 本机项目的项目指令。只在一个方向上有写入：项目所有者停止共享（删除云端项目）时，
   * 协作项目那份背景与规范写回这个文件夹，成为创建者本机项目的背景与规范；未提供时不写回。
   */
  projectInstructions?: ProjectInstructionsService;
}

/**
 * 停止共享时背景与规范的落点：`saved` 已写成本机项目的背景与规范，`none` 没有可写回的内容或目录。
 */
export type CollabInstructionsHandover = "saved" | "none";

export interface CollabProject {
  id: string;
  name: string;
  role: string;
  memberCount: number;
  sessionCount: number;
  createdAt: string | null;
  /**
   * The local Memmy project this online project runs tasks in, or null before it is bound. It is what lets an
   * online project behave like a local one: tasks, sessions and the sidebar's expandable task list.
   */
  localProjectId: string | null;
  /** 项目指令全文；成员只读。未设定时为空串。 */
  instructions: string;
}

/** 项目关联的一个知识库：只是引用，名字随知识库改名而变。 */
export interface CollabKnowledgeBase {
  id: string;
  name: string;
  /** 这个库是本机用户关联的：本人可以解除，别人的只有所有者与管理员能解除。 */
  mine: boolean;
}

/** 项目配置里的知识库卡片：列表加一条「还能加几个」。 */
export interface CollabKnowledgeView {
  canManage: boolean;
  maxBases: number;
  bases: CollabKnowledgeBase[];
}

export interface CollabProjectSession {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  lastQuestion: string;
  memberName: string;
  mine: boolean;
  source: string;
  turnCount: number;
  lastActiveAt: string | null;
  /**
   * 单任务超出云端容量上限时只保留最近轮次，详情里带这个标记；列表不带，按 false 处理。
   */
  trimmed: boolean;
  /** The link a member pastes into another agent. */
  link: string;
  /** What「复制链接」puts on the clipboard. */
  shareText: string;
  /**
   * 本人在这台电脑上用 Memmy 建的这条任务的对话 id（= 会话文件名里的 chatId），其他成员的任务、
   * 其他 Agent 的任务都是 null。看板据此把「点开」落到真正的会话页，而不是只给只读面板。
   */
  conversationId?: string | null;
}

export interface SessionListOptions {
  query?: string;
  /** 「全部成员」/「你」/「其他成员」: who shared the session decides what the page contains. */
  member?: "me" | "others";
  /** Zero-based index of the first session to return. */
  offset?: number;
  /** Page size; the board asks for ten. */
  limit?: number;
}

export interface CollabSessionPage {
  project: CollabProject;
  /** The page only; `total` counts every session matching the query. */
  sessions: CollabProjectSession[];
  total: number;
}

export interface CollabSessionTurn {
  question: string;
  reply: string;
  steps: string[];
  startedAt: string;
}

/** The agent's project or workspace a session belongs to, or its directory. */
export interface LocalSessionGroup {
  id: string;
  label: string;
  path: string | null;
}

export interface LocalAgentSession {
  sourceId: string;
  agentName: string;
  conversationId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  group: LocalSessionGroup | null;
  updatedAt: string;
  turnCount: number;
}

/** A whole group associated with a project, sessions that appear in it later included. */
export interface CollabGroupLink {
  sourceId: string;
  groupId: string;
  /** Sessions of the group the person unchecked. */
  excluded: string[];
}

/** A session associated on its own. */
export interface CollabSessionLink {
  sourceId: string;
  conversationId: string;
}

/** What this computer associates with one project. Kept on this computer, since groups are local directories. */
export interface CollabLinks {
  groups: CollabGroupLink[];
  sessions: CollabSessionLink[];
}

/** The fields association rules look at; a session that is no longer listed keeps the group it was uploaded with. */
export interface LinkCandidate {
  sourceId: string;
  conversationId: string;
  groupId: string | null;
}

export interface CollabSyncResult {
  uploaded: number;
  removed: number;
  /** Uploads that failed; the next automatic sync retries them. */
  failed: number;
  /** Sessions queued for upload; the board shows their progress as they arrive. */
  started?: number;
}

/** Upload progress for one project, so the board can show sessions arriving instead of blocking a dialog. */
export interface CollabSyncProgress {
  running: boolean;
  total: number;
  completed: number;
  failed: number;
}

export type CollabRole = "owner" | "admin" | "member";
/** Who gets in with a link: anyone at once, or after an owner or admin approves. */
export type CollabJoinMode = "direct" | "approval";

export interface CollabMember {
  userId: string;
  name: string;
  role: CollabRole;
  /** The signed-in person, labelled「（你）」. */
  mine: boolean;
  joinedAt: string | null;
}

export interface CollabJoinRequest {
  userId: string;
  name: string;
  /** Whose link the person applied through. */
  inviterName: string;
  createdAt: string | null;
}

export interface CollabMembers {
  project: CollabProject;
  joinMode: CollabJoinMode;
  /** Owners and admins set the join mode, review requests, and change or remove other members. */
  canManage: boolean;
  members: CollabMember[];
  /** Waiting for review; empty for members, who cannot review. */
  requests: CollabJoinRequest[];
}

export interface CollabInvite {
  code: string;
  link: string;
  /** What「复制邀请链接」puts on the clipboard. */
  shareText: string;
}

/** What the join dialog shows before the person decides. */
export interface CollabInvitePreview {
  code: string;
  projectId: string;
  projectName: string;
  inviterName: string;
  memberCount: number;
  /** The first few members, drawn as avatars on the project card. */
  memberNames: string[];
  joinMode: CollabJoinMode;
  /** Already in the project, waiting for review, or neither. */
  status: "none" | "pending" | "member";
}

export interface CollabJoinResult {
  /** In at once, waiting for review, or already a member. */
  status: "joined" | "pending" | "member";
  projectId: string;
  /** The project when the person is in it; null while the request waits. */
  project: CollabProject | null;
}

/** What one upload put in the cloud, and when. */
interface SyncedSession {
  cloudSessionId: string;
  updatedAt: string;
  groupId: string | null;
  /**
   * The title the listing reported when this session was uploaded. Absent on records written before titles came
   * from the agent itself, which is what makes the next sync refresh them.
   */
  title?: string;
}

interface StoredLinks extends CollabLinks {
  projectId: string;
  accountId: string;
  /** The local Memmy project bound to this online project, once the person created it. */
  localProjectId: string | null;
  /**
   * Memmy tasks the person chose to share with the project, by conversation id. Sharing is per task and off by
   * default: a task of the bound project reaches the cloud only when it is listed here, or was uploaded before
   * this list existed (`synced`).
   */
  sharedSessions: string[];
  /** Memmy tasks deleted from the project, so the next sync does not upload them again. */
  removedSessions: string[];
  /** Where this project's tasks run when the person picked no folder; named after the project. */
  workingDirectory: string | null;
  /**
   * The person picked `workingDirectory` when they applied to join. Such a folder may already hold their own files
   * and projects, so the project made for it later must be a record of its own over that folder.
   */
  directoryChosen: boolean;
  /** Last upload of each session, by session key. */
  synced: Record<string, SyncedSession>;
}

/** What one upload pass did: the counts, and the sessions it stored for the links file. */
interface UploadOutcome {
  result: CollabSyncResult;
  synced: Record<string, SyncedSession>;
}

/** A session read ahead in its agent's batch: the record, gone from the agent, or not read ahead. */
type PreloadedSession = Record<string, unknown> | "missing" | null;

export interface CollabSessionReference {
  session: CollabProjectSession;
  /**
   * Handed to the agent: source and the turns the view asks for. It is read online and never written to this
   * computer, so an agent that needs more asks again with another view.
   */
  text: string;
}

/**
 * Which turns `sessions read` prints inline. An empty view is the overview: the latest turns in full and one line
 * per earlier turn. At most one field is set; turn numbers are the ones the saved file shows.
 */
export interface SessionView {
  turns?: { from: number; to: number };
  /** One turn with its neighbours, plus the latest turns. */
  around?: number;
  /** Turns containing this text, to check a screenshot against the session. */
  find?: string;
  all?: boolean;
}

/** 当前用户已提交、还在等审核的加入申请。还不是成员，侧边栏单独显示。 */
export interface CollabApplication {
  projectId: string;
  projectName: string;
  createdAt: string | null;
}

/**
 * 已经审完的加入申请。云端把审核结果写回申请行；桌面端读到后给一次明确结果，
 * 而不是让侧栏的「申请中」默默消失。
 */
export interface CollabApplicationDecision {
  projectId: string;
  projectName: string;
  status: "approved" | "rejected";
  decidedAt: string | null;
}

export interface CollabService {
  listProjects(): Promise<{
    projects: CollabProject[];
    applications?: CollabApplication[];
    /** 旧云端没有这一列：字段缺省表示读不到结果，桌面端就不提示。 */
    decisions?: CollabApplicationDecision[];
    /** 每个账号可创建的在线项目数上限，旧云端不返回；桌面端据此在新建时先说明「只能建成本机项目」。 */
    maxOwnedProjects?: number;
  }>;
  /**
   * Creates the cloud project and prepares the directory its tasks run in: the person's chosen folder, or a
   * managed folder when none was chosen, so a task always has a working directory.
   */
  createProject(name: string, directory?: string): Promise<{ project: CollabProject; localDirectory: string }>;
  /** Records which local Memmy project runs this online project's tasks. */
  bindLocalProject(projectId: string, localProjectId: string): Promise<{ ok: true }>;
  /**
   * 某个工作目录属于哪个协作项目；不属于任何项目时返回 null。
   * 知识库检索用它把会话所在目录翻成项目，再把项目关联的知识库并入检索。
   */
  cloudProjectForDirectory(directory: string): Promise<string | null>;
  /** Projects explicitly linked to this agent session or its linked group. */
  projectsForAgentSession(sourceId: string, conversationId: string): Promise<CollabProject[]>;
  /**
   * The directory a project's tasks run in, created on demand; lets an older project gain a working project.
   * `name` names the managed folder after the project instead of its generated id.
   */
  ensureWorkingDirectory(projectId: string, name?: string, directory?: string): Promise<{ localDirectory: string; chosen: boolean }>;
  /**
   * One page of a project's sessions, newest activity first. A `query` keeps the sessions whose title, last
   * question or member name matches any keyword, which is what the board's search box and the @ menu use.
   */
  listSessions(projectId: string, options?: SessionListOptions): Promise<CollabSessionPage>;
  /** A session with its turns, read from the cloud; nothing is written to this computer. */
  readSessionDetail(sessionId: string): Promise<{ session: CollabProjectSession; turns: CollabSessionTurn[] }>;
  /**
   * Sessions the person can reference from a message, limited to one online project: a reference stays inside the
   * project the task belongs to. No query returns the most recent `limit` sessions, which is what the @ menu shows
   * before typing.
   */
  candidateSessions(projectId: string, input?: { query?: string; limit?: number }): Promise<{ sessions: CollabProjectSession[] }>;
  listLocalSessions(input: { query?: string; sourceIds?: string[]; limit?: number; fresh?: boolean }): Promise<{ sessions: LocalAgentSession[]; refreshing: boolean }>;
  getLinks(projectId: string): Promise<CollabLinks>;
  /**
   * Saves what this computer associates and queues the new sessions. It returns before the upload finishes so the
   * person can keep working; `getSyncProgress` reports the rest.
   */
  saveLinks(projectId: string, links: CollabLinks): Promise<CollabSyncResult>;
  /** How far the queued upload for this project has come. */
  getSyncProgress(projectId: string): Promise<CollabSyncProgress>;
  /**
   * The Memmy sessions of the project's local folder, each saying whether the project includes it. Sharing a
   * project uploads only the included ones; the rest stay on this computer.
   */
  listProjectTasks(projectId: string): Promise<{ tasks: ProjectTaskSession[] }>;
  /**
   * Saves which of those sessions the project includes and queues what is missing. Unchecked sessions are taken
   * out of the project, both from the cloud and from later uploads.
   */
  saveProjectTasks(projectId: string, included: readonly string[]): Promise<CollabSyncResult>;
  /** 一条 Memmy 任务在本项目里是否共享；输入框旁的开关据此显示当前状态。 */
  getTaskSharing(projectId: string, conversationId: string): Promise<TaskSharing>;
  /**
   * 开启或关闭一条 Memmy 任务的共享。开启后排队上传（任务刚建、还没有轮次时等第一条消息），
   * 关闭会把云端副本一并删掉，本机任务保留。
   */
  setTaskSharing(projectId: string, conversationId: string, shared: boolean): Promise<TaskSharing & { started: number }>;
  /**
   * 把正在进行的这条 Memmy 任务共享给它所在的协作项目，供 `memmy-project session share` 使用。
   * 项目尚未开启共享、或任务不属于任何项目时，只返回要告诉用户的话。
   */
  shareCurrentTask(input: { conversationId: string; shared: boolean; project?: string }): Promise<{ text: string }>;
  /**
   * Deletes the project in the cloud and drops this computer's binding. The local project is kept, so the tasks
   * that ran in it stay on this computer.
   *
   * <p>`instructions` 告诉界面背景与规范去了哪里：`saved` 已写成本机项目的背景与规范，`none` 没有可写回的内容或目录。</p>
   */
  deleteProject(projectId: string): Promise<{ ok: true; instructions: CollabInstructionsHandover }>;
  /** Uploads sessions that appeared in associated groups or changed since their last upload. Never removes any. */
  syncLinkedSessions(): Promise<CollabSyncResult>;
  /**
   * Uploads only this computer's Memmy tasks, which need no agent scan. Opening a board uses this so the list
   * appears at once, even while the Memory service is busy indexing other agents. `projectId` keeps it to the
   * board being opened instead of every project this computer has.
   */
  syncProjectTasks(projectId?: string): Promise<CollabSyncResult>;
  removeSession(projectId: string, sessionId: string): Promise<{ ok: true }>;
  /**
   * Sessions of every project the person is in that match an agent's keywords. A session shared to several
   * projects is listed once with all their names; `sinceMs` keeps the ones active within that window.
   */
  searchSessions(input: SessionSearchInput): Promise<{ sessions: SessionSearchHit[] }>;
  /** Reads a referenced session from the cloud; a `view` picks the turns to print. Nothing is saved locally. */
  readSession(reference: string, view?: SessionView): Promise<CollabSessionReference>;
  /**
   * Adds the agent's current local task to one project, as that one session and not the whole workspace.
   * A project name that is not exact, or a task that cannot be told apart, only produces the next command.
   */
  addCurrentSession(input: {
    project?: string;
    cwd?: string;
    hint?: string;
    /** The conversation this command is running inside, when the agent exposes it. */
    sourceId?: string;
    conversationId?: string;
  }): Promise<{ text: string }>;
  /** Who is in the project and how people join it; owners and admins also get the requests waiting for them. */
  listMembers(projectId: string): Promise<CollabMembers>;
  /** The person's own invite link to the project; any member may invite. */
  createInvite(projectId: string): Promise<CollabInvite>;
  setJoinMode(projectId: string, joinMode: CollabJoinMode): Promise<{ joinMode: CollabJoinMode }>;
  /** Renames the project in the cloud, which is what every member's list reads. Owners only, enforced there. */
  renameProject(projectId: string, name: string): Promise<{ project: CollabProject }>;
  /**
   * Saves the project instructions in the cloud (owners and admins, enforced there) and keeps this computer's copy
   * in step, so the tasks started here follow them. `directory` is the local project's folder: the board knows it and
   * passes it, so the copy lands where this computer's tasks read it.
   */
  updateInstructions(projectId: string, text: string, directory?: string): Promise<{ project: CollabProject }>;
  /** 项目关联的知识库。关联只把这些库纳入本项目任务的检索，原文仍按知识库自己的共享设置。 */
  knowledge(projectId: string): Promise<CollabKnowledgeView>;
  addKnowledge(projectId: string, baseId: string): Promise<CollabKnowledgeView>;
  removeKnowledge(projectId: string, baseId: string): Promise<CollabKnowledgeView>;
  approveRequest(projectId: string, userId: string): Promise<{ member: CollabMember }>;
  rejectRequest(projectId: string, userId: string): Promise<{ ok: true }>;
  setMemberRole(projectId: string, userId: string, role: Exclude<CollabRole, "owner">): Promise<{ member: CollabMember }>;
  removeMember(projectId: string, userId: string): Promise<{ ok: true }>;
  /**
   * Leaves the project. Like a deleted project, the local project stays with this person's tasks; the binding and
   * any session copy an older version left on this computer go.
   */
  leaveProject(projectId: string): Promise<{ ok: true }>;
  /** Reads a pasted invite link (or its copied text) for the join dialog. */
  previewInvite(reference: string): Promise<{ invite: CollabInvitePreview }>;
  /**
   * Joins through an invite. A chosen `directory` is kept for the project, so the local project made once the person
   * is in — now, or after approval — runs its tasks there.
   */
  joinProject(reference: string, directory?: string): Promise<CollabJoinResult>;
}

export interface SessionSearchInput {
  query?: string;
  member?: string;
  project?: string;
  limit?: number;
  sinceMs?: number;
  /** `30d` 这样的窗口原样交给云端：窗口要在云端分页之前生效，否则正文命中一多，近期任务反而会被挤掉。 */
  since?: string;
}

/** 关键词命中的一轮：轮次号可直接写成 `任务ID#轮次`，片段说明为什么会命中。 */
export interface SessionTurnHit {
  turnNo: number;
  snippet: string;
}

/** A search result: one session, with every project it is shared to. */
export interface SessionSearchHit extends CollabProjectSession {
  projectNames: string[];
  /** 云端没有在正文里找过时为空，此时按旧的单行格式展示。 */
  hits: SessionTurnHit[];
}

/** One Memmy session of a project's local folder, as the sync picker lists it. */
export interface ProjectTaskSession {
  conversationId: string;
  title: string;
  lastQuestion: string;
  updatedAt: string;
  turnCount: number;
  /** Included in the project, so it is (or will be) on the board. */
  included: boolean;
  /** Already uploaded at least once. */
  synced: boolean;
}

/** 一条 Memmy 任务在该项目里的共享状态；`synced` 表示云端已经有它的副本。 */
export interface TaskSharing {
  shared: boolean;
  synced: boolean;
}

/** Identifies a local session across agents. */
export function sessionKey(session: { sourceId: string; conversationId: string }): string {
  return `${session.sourceId}\u0000${session.conversationId}`;
}

function parseSessionKey(key: string): { sourceId: string; conversationId: string } {
  const separator = key.indexOf("\u0000");
  return { sourceId: key.slice(0, separator), conversationId: key.slice(separator + 1) };
}

/**
 * Which of the candidates the links cover, as session keys. A whole-group link covers every session of that agent's
 * group except the excluded ones; a session link covers that one session.
 */
export function linkedSessionKeys(links: CollabLinks, candidates: readonly LinkCandidate[]): Set<string> {
  const keys = new Set(links.sessions.map(sessionKey));
  for (const candidate of candidates) {
    const group = links.groups.find((link) => link.sourceId === candidate.sourceId && link.groupId === candidate.groupId);
    if (group && !group.excluded.includes(candidate.conversationId)) keys.add(sessionKey(candidate));
  }
  return keys;
}

/** Extracts a session ID from a pasted Memmy session link, the copied share text, or a bare ID. */
export function parseSessionReference(reference: string): string | null {
  const trimmed = reference.trim();
  if (SESSION_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return SESSION_LINK_PATTERN.exec(trimmed)?.[1] ?? null;
}

/** Extracts the code from a pasted invite link, the copied invite text, or a bare code. */
export function parseInviteReference(reference: string): string | null {
  const trimmed = reference.trim();
  if (INVITE_CODE_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return INVITE_LINK_PATTERN.exec(trimmed)?.[1] ?? null;
}

export type CollabCloudRequest = (
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number }
) => Promise<Record<string, unknown>>;

/** `/api/collab` requests signed with the person's account; the payload's `data` on success. */
/** Resolves after `ms`, for a wait that must not outlast the person's patience. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function createCollabCloudRequest(
  options: Pick<CollabServiceOptions, "cloudBaseUrl" | "getAccount" | "fetcher">
): CollabCloudRequest {
  const fetcher = options.fetcher ?? globalThis.fetch;
  return async (path, init = {}) => {
    const account = options.getAccount();
    if (!account) {
      throw new CollabError("unauthorized", "请先登录 Memmy 后使用协作项目");
    }
    let response: Response;
    try {
      response = await fetcher(`${options.cloudBaseUrl.replace(/\/+$/u, "")}/api/collab${path}`, {
        method: init.method ?? "GET",
        redirect: "error",
        signal: AbortSignal.timeout(init.timeoutMs ?? CLOUD_TIMEOUT_MS),
        headers: {
          Authorization: `Bearer ${account.credential}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" })
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body)
      });
    } catch {
      throw new CollabError("memory_layer_unavailable", "暂时无法连接 Memmy 云端，请稍后重试。");
    }
    const payload = record(await response.json().catch(() => ({})));
    if (!response.ok || (typeof payload.code === "number" && payload.code !== 0)) {
      const cloudCode = typeof payload.code === "number" && payload.code !== 0 ? payload.code : null;
      // The cloud reports some failures with an empty message; the code is what makes them diagnosable.
      const code = cloudCode === null ? "" : `云端返回错误码 ${cloudCode}`;
      // 数量上限要能被界面单独解释（「这次只建了本机项目」），所以不看 HTTP 状态，直接按云端错误码对应。
      const mapped = cloudCode === null ? undefined : LOCAL_CODE_BY_CLOUD_CODE[cloudCode];
      throw new CollabError(mapped ?? errorCode(response.status), text(payload.message) || code || "协作项目请求未完成");
    }
    return record(payload.data);
  };
}

export function createCollabService(options: CollabServiceOptions): CollabService {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const memmyHome = process.env.MEMMY_HOME?.trim() || join(homedir(), ".memmy");
  const projectsDir = options.projectsDir ?? join(memmyHome, "projects");
  /** Working directories for online projects that did not choose a folder, next to the project links. */
  const onlineWorkdirRoot = join(dirname(projectsDir), "online-projects");
  const agentSessionsDir = options.agentSessionsDir ?? join(memmyHome, "workspace", "sessions");
  const linkBase = (options.linkBaseUrl?.trim() || safeOrigin(options.cloudBaseUrl)).replace(/\/+$/u, "");
  const cloud = createCollabCloudRequest(options);

  /** Reads this machine's agent sessions; a session or agent that is gone reads as not found. */
  async function readLocal<T>(read: (reader: LocalSessionReader) => Promise<T>): Promise<T> {
    if (!options.localSessions) {
      throw new CollabError("memory_layer_unavailable", "无法读取本机任务，请重启 Memmy 后重试。");
    }
    try {
      return await read(options.localSessions);
    } catch (error) {
      if (error instanceof LocalSessionReadError) throw new CollabError(error.code, error.message);
      throw new CollabError("internal", "读取本机任务失败");
    }
  }

  function requireAccount(): CollabAccount {
    const account = options.getAccount();
    if (!account) {
      throw new CollabError("unauthorized", "请先登录 Memmy 后使用协作项目");
    }
    return account;
  }

  /** One page of a project's sessions, shared by the board and the @ menu so both read the same list. */
  async function listSessions(projectId: string, options: SessionListOptions = {}): Promise<CollabSessionPage> {
    const account = requireAccount();
    const data = await cloud(`/projects/${encodeURIComponent(projectId)}/sessions`);
    // The board reuses this project to refresh the sidebar, so the binding has to come with it.
    const stored = await readLinks(projectId, account.accountId);
    return {
      project: { ...toProject(data.project), localProjectId: stored.localProjectId },
      ...pageOf(list(data.sessions).map((raw) => withLocalConversation(stored, withLink(raw))), options)
    };
  }

  async function listLocalSessions(input: { query?: string; sourceIds?: string[]; limit?: number; fresh?: boolean }) {
    const data = await readLocal((reader) => reader.available({
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      fresh: input.fresh === true
    }));
    return { sessions: data.sessions.map(toLocalSession), refreshing: data.refreshing };
  }

  /** Upload progress per project, kept in memory: the board polls it while sessions arrive. */
  const syncProgress = new Map<string, CollabSyncProgress>();

  function reportProgress(projectId: string, patch: Partial<CollabSyncProgress>): void {
    const current = syncProgress.get(projectId) ?? { running: false, total: 0, completed: 0, failed: 0 };
    syncProgress.set(projectId, { ...current, ...patch });
  }

  /**
   * Uploads run on their own per-project chain, so saving the next selection never waits for the last upload.
   * One chain per project keeps a session from being uploaded twice.
   */
  const uploadChains = new Map<string, Promise<unknown>>();

  function enqueueUpload(projectId: string, task: () => Promise<void>): void {
    const previous = uploadChains.get(projectId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task).catch(() => undefined);
    uploadChains.set(projectId, next);
  }

  /** Saving links and reading them back take this lock; one at a time keeps the file consistent. */
  let queue: Promise<unknown> = Promise.resolve();
  function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Syncs take this lane instead of the lock: two of them would otherwise upload the same session twice. Uploads
   * inside one sync still run in parallel, and the lock is only taken to read and to record results.
   */
  let syncLane: Promise<unknown> = Promise.resolve();
  function serializedSync<T>(task: () => Promise<T>): Promise<T> {
    const run = syncLane.then(task, task);
    syncLane = run.catch(() => undefined);
    return run;
  }

  /**
   * 一条 Memmy 任务是否共享给了这个项目：本人手动开启的、或这一版之前已经上传过的，都算。
   * 删除过的任务不再共享，哪怕它之前上传过。
   */
  function isTaskShared(stored: StoredLinks, conversationId: string): boolean {
    if (stored.removedSessions.includes(conversationId)) return false;
    return stored.sharedSessions.includes(conversationId)
      || Boolean(stored.synced[sessionKey({ sourceId: MEMMY_SOURCE_ID, conversationId })]);
  }

  /** 一条任务在项目里的共享状态，给输入框旁的开关读。 */
  function taskSharingOf(stored: StoredLinks, conversationId: string): TaskSharing {
    return {
      shared: isTaskShared(stored, conversationId),
      synced: Boolean(stored.synced[sessionKey({ sourceId: MEMMY_SOURCE_ID, conversationId })])
    };
  }

  /**
   * 开启或关闭一条 Memmy 任务的共享。开启只改本机的名单并排队上传：任务刚建、还没有任何轮次时
   * 文件还不存在，等下一条消息写进来，下一次同步会把它传上去。关闭会顺手删掉云端副本。
   */
  function applyTaskSharing(
    projectId: string,
    accountId: string,
    conversationId: string,
    shared: boolean
  ): Promise<TaskSharing & { started: number }> {
    return exclusive(async () => {
      const stored = await readLinks(projectId, accountId);
      const tasks = await projectTaskSessions(stored);
      const key = sessionKey({ sourceId: MEMMY_SOURCE_ID, conversationId });
      if (!tasks.some((task) => task.conversationId === conversationId)) {
        // 刚建的任务还没有会话文件：本机项目对得上就接受，写入名单后等第一条消息上车。
        const records = await readSessionRecords(join(agentSessionsDir, `websocket_${conversationId}.jsonl`));
        if (records || !stored.localProjectId) {
          throw new CollabError("not_found", "这个项目里没有这条任务");
        }
      }

      if (shared) {
        if (!stored.sharedSessions.includes(conversationId)) stored.sharedSessions.push(conversationId);
        stored.removedSessions = stored.removedSessions.filter((id) => id !== conversationId);
        const pending = sessionsToUpload(stored, tasks);
        await writeLinks(stored);
        if (!pending.length) return { ...taskSharingOf(stored, conversationId), started: 0 };
        syncProgress.set(projectId, { running: true, total: pending.length, completed: 0, failed: 0 });
        enqueueUpload(projectId, () => runUpload(projectId, accountId));
        return { ...taskSharingOf(stored, conversationId), started: pending.length };
      }

      stored.sharedSessions = stored.sharedSessions.filter((id) => id !== conversationId);
      const synced = stored.synced[key];
      if (synced) {
        await deleteCloudSession(projectId, synced.cloudSessionId, createListingReader(projectId));
        delete stored.synced[key];
        // 记住这次取消，否则下一次同步会把它当成共享中的任务重新传上去。
        if (!stored.removedSessions.includes(conversationId)) stored.removedSessions.push(conversationId);
      }
      await writeLinks(stored);
      return { ...taskSharingOf(stored, conversationId), started: 0 };
    });
  }

  /**
   * 要上传的任务：在本项目范围内、且首次上传或内容变了的那几条。只取最近交互的前 20 条，
   * 更早的传上去也会被云端清理掉。Memmy 自己的任务还要本人开启共享，未开启的只留在本机。
   */
  function sessionsToUpload(stored: StoredLinks, local: readonly LocalAgentSession[]): LocalAgentSession[] {
    const covered = linkedSessionKeys(stored, linkCandidates(stored, local));
    const inScope = local.filter((session) => session.sourceId === MEMMY_SOURCE_ID
      ? isTaskShared(stored, session.conversationId)
      : covered.has(sessionKey(session)));
    return inScope
      .sort((left, right) => (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0))
      .slice(0, SESSIONS_PER_MEMBER)
      .filter((session) => {
        const synced = stored.synced[sessionKey(session)];
        // A retitled session needs a new upload even when its turns did not change: the board shows the title.
        return !synced || isNewer(session.updatedAt, synced.updatedAt) || session.title !== synced.title;
      });
  }

  /**
   * Uploads what the project still owes the cloud. The network part runs without the links lock and reports what
   * it stored instead of writing it: a slow upload must not hold someone else's save, and merging the result into
   * a fresh read keeps whatever that save changed.
   */
  async function uploadPending(
    stored: StoredLinks,
    local: readonly LocalAgentSession[],
    onProgress?: (result: CollabSyncResult) => void
  ): Promise<UploadOutcome> {
    const result: CollabSyncResult = { uploaded: 0, removed: 0, failed: 0 };
    const synced: Record<string, SyncedSession> = {};
    const pending = sessionsToUpload(stored, local);
    const preload = preloadSessions(pending);
    let next = 0;
    let fatal: unknown = null;

    // A small pool: progress stays per-session while the agents' batches load side by side.
    const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, async () => {
      for (;;) {
        if (fatal) return;
        const index = next;
        if (index >= pending.length) return;
        next += 1;
        const session = pending[index]!;
        try {
          const cloudSessionId = await uploadSession(stored.projectId, session, await preload(session));
          synced[sessionKey(session)] = {
            cloudSessionId,
            updatedAt: session.updatedAt,
            groupId: session.group?.id ?? null,
            // The listed title is what the next sync compares against, so a retitled session uploads once more.
            title: session.title
          };
          result.uploaded += 1;
        } catch (error) {
          if (error instanceof CollabError && (error.code === "unauthorized" || error.code === "forbidden")) {
            fatal = error;
            return;
          }
          result.failed += 1;
        }
        onProgress?.(result);
      }
    });
    await Promise.all(workers);
    if (fatal) throw fatal;
    return { result, synced };
  }

  /** Records what an upload stored, merged into a fresh read so a save made meanwhile is not lost. */
  async function recordUploaded(projectId: string, accountId: string, synced: Record<string, SyncedSession>): Promise<void> {
    if (!Object.keys(synced).length) return;
    await exclusive(async () => {
      const latest = await readLinks(projectId, accountId);
      Object.assign(latest.synced, synced);
      await writeLinks(latest);
    });
  }

  /**
   * Uploads whatever this project still owes the cloud. It reads the links again, so a selection saved while an
   * earlier upload was running is picked up too, and its own list is what the progress counts against.
   */
  async function runUpload(projectId: string, accountId: string): Promise<void> {
    const stored = await readLinks(projectId, accountId);
    const { sessions: local } = await listLocalSessions({ limit: MAX_LOCAL_SESSIONS })
      .then((listing) => listing)
      .catch(() => ({ sessions: [] as LocalAgentSession[] }));
    const candidates = [...local, ...await projectTaskSessions(stored)];
    const pending = sessionsToUpload(stored, candidates);
    syncProgress.set(projectId, { running: true, total: pending.length, completed: 0, failed: 0 });

    try {
      const { result, synced } = await uploadPending(stored, candidates, (progress) => {
        reportProgress(projectId, { completed: progress.uploaded + progress.failed, failed: progress.failed });
      });
      // Merge only what was uploaded: another save may have changed groups or exclusions in the meantime.
      await recordUploaded(projectId, accountId, synced);
      const latest = await readLinks(projectId, accountId);
      // Still running only for sessions selected meanwhile; one that failed here waits for the next sync, and
      // counting it would leave the board showing an upload that is not happening.
      const attempted = new Set(pending.map(sessionKey));
      const remaining = sessionsToUpload(latest, candidates).filter((session) => !attempted.has(sessionKey(session)));
      reportProgress(projectId, {
        running: remaining.length > 0,
        total: pending.length,
        completed: result.uploaded + result.failed,
        failed: result.failed
      });
    } catch {
      reportProgress(projectId, { running: false });
    }
  }

  /**
   * Reads the pending sessions of each agent in batches, each started when a worker first needs one of its sessions
   * and shared by the others. A session resolves to its record, "missing" when the agent no longer has it, or null
   * when its batch could not be read, which leaves it to a read of its own.
   */
  function preloadSessions(pending: readonly LocalAgentSession[]): (session: LocalAgentSession) => Promise<PreloadedSession> {
    const chunkOf = new Map<string, string[]>();
    const bySource = new Map<string, string[]>();
    for (const session of pending) {
      if (session.sourceId === MEMMY_SOURCE_ID) continue;
      const ids = bySource.get(session.sourceId) ?? [];
      ids.push(session.conversationId);
      bySource.set(session.sourceId, ids);
    }
    for (const [sourceId, ids] of bySource) {
      for (let start = 0; start < ids.length; start += READ_MANY_CHUNK) {
        const chunk = ids.slice(start, start + READ_MANY_CHUNK);
        for (const id of chunk) chunkOf.set(sessionKey({ sourceId, conversationId: id }), chunk);
      }
    }
    const loads = new Map<string[], Promise<Map<string, Record<string, unknown>> | null>>();
    return async (session) => {
      const chunk = chunkOf.get(sessionKey(session));
      if (!chunk) return null;
      let load = loads.get(chunk);
      if (!load) {
        load = readLocal((reader) => reader.readMany({ sourceId: session.sourceId, conversationIds: chunk }))
          .then((data) => new Map(data.sessions.map((raw) => [raw.conversationId, record(raw)] as const)))
          // A failed batch: its sessions are read one by one instead.
          .catch(() => null);
        loads.set(chunk, load);
      }
      const loaded = await load;
      if (!loaded) return null;
      return loaded.get(session.conversationId) ?? "missing";
    };
  }

  /** Rereads one session so the upload carries its latest turns; one session per request stays inside the cloud's size limit. */
  async function uploadSession(
    projectId: string,
    session: { sourceId: string; conversationId: string },
    preloaded: PreloadedSession = null
  ): Promise<string> {
    if (session.sourceId === MEMMY_SOURCE_ID) {
      // Memmy's own tasks are not an external agent source; their turns live in this agent's session files.
      const task = await readMemmyTask(session.conversationId);
      return putCloudSession(projectId, MEMMY_SOURCE_ID, session.conversationId, task.title, task.updatedAt, task.turns);
    }
    if (preloaded === "missing") {
      throw new CollabError("not_found", "本机已找不到该任务");
    }
    const local = preloaded
      ?? record(await readLocal((reader) => reader.read({ sourceId: session.sourceId, conversationId: session.conversationId })));
    const turns = list(local.turns).slice(-MAX_UPLOAD_TURNS).map(toUploadTurn);
    return putCloudSession(projectId, session.sourceId, session.conversationId, text(local.title), isoOrNull(local.updatedAt), turns);
  }

  /**
   * Memmy's own tasks that belong to one local project. The agent records the project on each session, so a bound
   * online project can upload exactly its own tasks and nothing else on this computer.
   */
  async function listMemmyTaskSessions(localProjectId: string): Promise<LocalAgentSession[]> {
    const entries = await readdir(agentSessionsDir, { withFileTypes: true }).catch(() => []);
    const sessions: LocalAgentSession[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(agentSessionsDir, entry.name);
      const records = await readSessionRecords(path);
      if (!records) continue;
      if (records.projectId !== localProjectId) continue;
      sessions.push({
        sourceId: MEMMY_SOURCE_ID,
        agentName: "Memmy",
        conversationId: records.conversationId,
        title: records.title,
        lastQuestion: records.lastQuestion,
        workspacePath: records.workspacePath,
        group: null,
        updatedAt: records.updatedAt,
        turnCount: records.turns.length
      });
    }
    return sessions;
  }

  /** The Memmy tasks of the bound project, when this project has one. */
  async function projectTaskSessions(stored: StoredLinks): Promise<LocalAgentSession[]> {
    return stored.localProjectId ? listMemmyTaskSessions(stored.localProjectId) : [];
  }

  async function readMemmyTask(conversationId: string): Promise<{ title: string; updatedAt: string; turns: CollabSessionTurn[] }> {
    const records = await readSessionRecords(join(agentSessionsDir, `websocket_${conversationId}.jsonl`));
    if (!records) {
      throw new CollabError("not_found", "无法读取该 Memmy 任务");
    }
    return { title: records.title, updatedAt: records.updatedAt, turns: records.turns.slice(-MAX_UPLOAD_TURNS).map(toUploadTurn) };
  }

  async function putCloudSession(
    projectId: string,
    source: string,
    sourceSessionId: string,
    title: string,
    lastActiveAt: string | null,
    turns: CollabSessionTurn[]
  ): Promise<string> {
    const data = await cloud(`/projects/${encodeURIComponent(projectId)}/sessions`, {
      method: "PUT",
      timeoutMs: UPLOAD_TIMEOUT_MS,
      body: { sessions: [{ source, sourceSessionId, title, lastActiveAt, turns }] }
    });
    return text(record(list(data.sessions)[0]).id);
  }

  /**
   * The project's cloud sessions, read once per save. `complete` means the list holds every session the project
   * reports, so an id that is missing from it really is gone rather than on a later page.
   */
  interface CloudSessionListing {
    ids: Set<string>;
    complete: boolean;
  }

  async function readCloudSessionListing(projectId: string): Promise<CloudSessionListing | null> {
    const data = await cloud(`/projects/${encodeURIComponent(projectId)}/sessions`);
    const project = record(data.project);
    if (text(project.id) !== projectId || !Array.isArray(data.sessions)) return null;
    const listed = data.sessions.map((item) => text(record(item).id));
    if (listed.some((id) => !id)) return null;
    const ids = new Set(listed);
    const complete = typeof project.sessionCount === "number"
      && project.sessionCount === listed.length && ids.size === listed.length;
    return { ids, complete };
  }

  /** One read per save, so a batch of stale local records does not ask the cloud again for each one. */
  function createListingReader(projectId: string): () => Promise<CloudSessionListing | null> {
    let pending: Promise<CloudSessionListing | null> | null = null;
    return () => {
      pending ??= readCloudSessionListing(projectId).catch(() => null);
      return pending;
    };
  }

  /**
   * Removes one cloud session. A local record the cloud already dropped (quota eviction, an earlier save) is
   * skipped instead of sent as a delete that the cloud answers with a refusal. Older clouds report a missing
   * session as 403, so only a complete listing can prove it is gone; a real permission refusal keeps its error.
   */
  async function deleteCloudSession(
    projectId: string,
    cloudSessionId: string,
    listing?: () => Promise<CloudSessionListing | null>
  ): Promise<void> {
    if (listing) {
      const known = await listing();
      if (known?.complete && !known.ids.has(cloudSessionId)) return;
    }
    try {
      await cloud(`/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(cloudSessionId)}`, { method: "DELETE" });
    } catch (error) {
      if (!(error instanceof CollabError && (error.code === "forbidden" || error.code === "not_found"))) throw error;
      // Read again rather than reuse the cached list: the refusal may follow another delete in this batch.
      const current = await readCloudSessionListing(projectId).catch((cause: unknown) => {
        // Losing the project or the membership explains the refusal better than the delete's own message.
        if (cause instanceof CollabError && (cause.code === "not_found" || cause.code === "unauthorized")) throw cause;
        return null;
      });
      if (!current?.complete || current.ids.has(cloudSessionId)) throw error;
    }
  }

  function linksPath(projectId: string): string {
    return join(projectsDir, safeSegment(projectId), LINKS_FILE);
  }

  async function readLinks(projectId: string, accountId: string): Promise<StoredLinks> {
    const stored = parseStoredLinks(await readFile(linksPath(projectId), "utf8").catch(() => ""));
    // Links saved by another account on this computer are not this person's.
    return stored && stored.projectId === projectId && stored.accountId === accountId
      ? stored
      : { projectId, accountId, localProjectId: null, sharedSessions: [], removedSessions: [], workingDirectory: null, directoryChosen: false, groups: [], sessions: [], synced: {} };
  }

  async function readAllLinks(accountId: string): Promise<StoredLinks[]> {
    const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    const all: StoredLinks[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stored = parseStoredLinks(await readFile(join(projectsDir, entry.name, LINKS_FILE), "utf8").catch(() => ""));
      // A bound project syncs its Memmy tasks even when no other agent sessions are associated.
      if (stored?.accountId === accountId && (stored.groups.length || stored.sessions.length || stored.localProjectId)) all.push(stored);
    }
    return all;
  }

  async function writeLinks(stored: StoredLinks): Promise<void> {
    const path = linksPath(stored.projectId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }

  /**
   * Forgets this computer's binding to a project the person is no longer in, after it was deleted or they left.
   * Only the binding goes: the local project and its sessions remain usable as a plain local project, and the
   * folder is remembered so rejoining runs there again. The write is queued behind any upload already running, so
   * a later read of the links never sees the old binding again.
   */
  async function releaseBinding(projectId: string, accountId: string, reason: "delete" | "leave"): Promise<void> {
    const stored = await readLinks(projectId, accountId);
    stored.localProjectId = null;
    stored.groups = [];
    stored.sessions = [];
    stored.synced = {};
    stored.sharedSessions = [];
    stored.removedSessions = [];
    await exclusive(() => writeLinks(stored)).catch((error: unknown) => {
      console.warn(`Project links not cleared after ${reason}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /**
   * Copies a project's cloud instructions to this computer, where its tasks read them.
   * A failed copy must not fail the cloud call that carried the text: the board still shows it, and the next read
   * of the project list tries again.
   */
  /**
   * Keeps a copy of a project's cloud instructions with the scopes they cover.
   * A failed copy must not fail the cloud call that carried the text: the board still shows it, and the next read
   * of the project list tries again.
   */
  async function rememberInstructions(
    projectId: string,
    instructions: string,
    scopes: readonly CollabInstructionScope[]
  ): Promise<void> {
    if (!options.collabInstructions) return;
    // 还没有可生效的范围时等下一次同步；云端删除指令（空文本）不需要范围，照旧清掉。
    if (!scopes.length && instructions.trim()) return;
    try {
      await options.collabInstructions.remember({ projectId, scopes, text: instructions });
    } catch (error) {
      console.warn(`Project instructions not cached for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * What this project's instructions cover: Memmy's own folder, every associated Agent unit (Claude Code folders,
   * Cursor workspaces, Codex projects), and any session associated on its own.
   */
  function instructionScopes(stored: StoredLinks): CollabInstructionScope[] {
    return instructionScopesFrom(stored, options.codexHome ? { codexHome: options.codexHome } : {});
  }

  /** 关联变了就换范围：新关联的 Agent 分组立即带上已有指令，取消关联的不再带。 */
  async function updateInstructionScopes(projectId: string, stored: StoredLinks): Promise<void> {
    if (!options.collabInstructions) return;
    const scopes = instructionScopes(stored);
    if (!scopes.length) return;
    try {
      await options.collabInstructions.updateScopes(projectId, scopes);
    } catch (error) {
      console.warn(`Project instruction scopes not updated for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Leaving a project drops the cache: the instructions belong to that cloud project and the person was not its
   * owner, so there is nothing of theirs to keep here. 停止共享走的是 `handOverInstructions`，不在这里。
   */
  async function forgetInstructions(projectId: string): Promise<void> {
    if (!options.collabInstructions) return;
    try {
      await options.collabInstructions.forget(projectId);
    } catch (error) {
      console.warn(`Project instructions not cleared for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 停止共享（删除云端项目）时，把背景与规范交接给创建者的本机项目：
   * 云端项目没了，但这仍是这个文件夹的规矩，任务还要继续按它跑。
   *
   * <p>以云端那份为准直接覆盖：共享期间这一项只在看板（云端）维护，本机那份是共享之前留下的旧内容，
   * 项目本身就是与时俱进的，保留旧版本没有意义（2026-10-29 用户明确要求）。</p>
   */
  async function handOverInstructions(directory: string | null, text: string): Promise<CollabInstructionsHandover> {
    const value = text.trim();
    if (!value || !directory || !options.projectInstructions) return "none";
    try {
      await options.projectInstructions.saveLocal(directory, value);
      return "saved";
    } catch (error) {
      console.warn(`Project instructions not kept locally for ${directory}: ${error instanceof Error ? error.message : String(error)}`);
      return "none";
    }
  }

  /**
   * Projects the person is still in, so a sync stops sending sessions to one they were removed from. When the
   * cloud cannot answer, every project is kept: a failed listing must not look like being removed everywhere.
   *
   * 被移出或退出后，云端已删除本人在这两个项目里的任务：本机随之解除关联、停止同步，并清掉旧版本留下的
   * 缓存；本机项目、任务与文件保留。重新加入后，已删除的任务不会自动恢复。
   */
  async function stillJoined(projects: StoredLinks[]): Promise<StoredLinks[]> {
    if (!projects.length) return projects;
    const data = await cloud("/projects").catch(() => null);
    if (!data) return projects;
    const joined = new Set(list(data.projects).map((project) => text(record(project).id)));
    const kept: StoredLinks[] = [];
    for (const stored of projects) {
      if (joined.has(stored.projectId)) {
        kept.push(stored);
        continue;
      }
      try {
        await releaseBinding(stored.projectId, stored.accountId, "leave");
        await forgetInstructions(stored.projectId);
        await rm(join(projectsDir, safeSegment(stored.projectId), "sessions"), { recursive: true, force: true });
      } catch (error) {
        console.warn(`Project links not cleared after leaving ${stored.projectId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return kept;
  }

  function requireInviteCode(reference: string): string {
    const code = parseInviteReference(reference);
    if (!code) {
      throw new CollabError("invalid_argument", "无法识别的邀请链接。请向项目成员重新获取。");
    }
    return code;
  }

  function withLink(raw: unknown): CollabProjectSession {
    const session = record(raw);
    const id = text(session.id);
    const title = text(session.title);
    const link = `${linkBase}/s/${id}`;
    const mine = session.mine === true;
    return {
      id,
      projectId: text(session.projectId),
      projectName: text(session.projectName),
      title,
      lastQuestion: text(session.lastQuestion),
      // On your own sessions your nickname is what other members see, so show the same name here.
      memberName: (mine ? options.getAccount()?.memberName?.trim() : "") || text(session.memberName),
      mine,
      source: text(session.source),
      turnCount: number(session.turnCount),
      lastActiveAt: nullableText(session.lastActiveAt),
      trimmed: session.trimmed === true,
      link,
      shareText: `【Memmy】${title} ${link}`
    };
  }

  /**
   * 本人 Memmy 任务的对话 id：云端不返回来源会话 id，但本机 links.json 记着每个云端副本对应的会话，
   * 按云端 id 反查一次就够了。其他成员或其他 Agent 的任务保持 null。
   */
  function withLocalConversation(stored: StoredLinks, session: CollabProjectSession): CollabProjectSession {
    if (!session.mine || session.source !== MEMMY_SOURCE_ID) return session;
    const entry = Object.entries(stored.synced).find(([, synced]) => synced.cloudSessionId === session.id);
    return entry ? { ...session, conversationId: parseSessionKey(entry[0]).conversationId } : session;
  }

  /**
   * What the cloud found inside the turns, as `任务ID#轮次` plus a quote. Missing in replies from a cloud that only
   * looked at titles and questions, which the command prints as one line the way it used to.
   */
  function withSearchHits(session: CollabProjectSession, raw: unknown): SessionSearchHit {
    const hits = list(record(raw).hits)
      .map((hit) => ({ turnNo: number(record(hit).turnNo), snippet: text(record(hit).snippet) }))
      .filter((hit) => hit.turnNo > 0)
      .slice(0, MAX_SEARCH_HITS);
    return { ...session, projectNames: [], hits };
  }

  /**
   * 协作任务只在云端保存。旧版本把引用的任务写到每个项目的 sessions 目录，这里在启动时清掉这些遗留文件，
   * 之后读取不再生成新的副本。清理失败不影响后续使用。
   */
  async function removeLegacySessionCaches(): Promise<void> {
    const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
      rm(join(projectsDir, entry.name, "sessions"), { recursive: true, force: true }).catch(() => undefined)
    ));
  }
  void removeLegacySessionCaches();

  /**
   * Questions of these tasks, one read per agent. The title and the latest question are already known; the read
   * adds the earlier ones. An agent that is gone contributes only what the list already had.
   */
  async function questionText(sessions: readonly LocalAgentSession[]): Promise<Map<string, string>> {
    const textOf = new Map(sessions.map((session) => [sessionKey(session), squash(`${session.title}\n${session.lastQuestion}`)]));
    const bySource = new Map<string, LocalAgentSession[]>();
    for (const session of sessions) {
      const group = bySource.get(session.sourceId) ?? [];
      group.push(session);
      bySource.set(session.sourceId, group);
    }
    await Promise.all([...bySource].map(async ([sourceId, group]) => {
      try {
        const data = await readLocal((reader) => reader.readMany({
          sourceId,
          conversationIds: group.map((session) => session.conversationId)
        }));
        for (const full of data.sessions) {
          textOf.set(
            sessionKey({ sourceId, conversationId: full.conversationId }),
            squash([full.title, ...full.turns.map((turn) => turn.question)].join("\n"))
          );
        }
      } catch (error) {
        if (error instanceof CollabError && (error.code === "not_found" || error.code === "invalid_argument")) return;
        throw error;
      }
    }));
    return textOf;
  }

  /** The named conversation, from the fresh list or a direct read. Null when Memmy has not seen it. */
  async function sessionByIdentity(sourceId: string, conversationId: string): Promise<LocalAgentSession | null> {
    const listed = await readLocal((reader) => reader.available({ sourceIds: [sourceId], limit: ADD_CANDIDATE_LIMIT, fresh: true }));
    const found = listed.sessions.map(toLocalSession).find((session) => session.sourceId === sourceId && session.conversationId === conversationId);
    if (found) return found;
    try {
      const full = await readLocal((reader) => reader.read({ sourceId, conversationId }));
      return {
        sourceId: full.sourceId,
        agentName: full.agentName,
        conversationId: full.conversationId,
        title: full.title,
        lastQuestion: full.lastQuestion,
        workspacePath: full.workspacePath,
        group: full.group,
        updatedAt: full.updatedAt,
        turnCount: full.turns.length
      };
    } catch (error) {
      if (error instanceof CollabError && error.code === "not_found") return null;
      throw error;
    }
  }

  /**
   * The task this command is running inside, when the agent did not name it. One task in the directory is that
   * one, unless a sentence was given and it is not in the task. Several tasks need a sentence that is in exactly
   * one of them.
   */
  async function chooseAddSession(candidates: readonly LocalAgentSession[], hint: string): Promise<SessionPick | { kind: "one"; session: LocalAgentSession }> {
    if (!candidates.length) return { kind: "none" };
    const shown = candidates.slice(0, ADD_HINT_READS);
    if (!hint) {
      return candidates.length === 1
        ? { kind: "one", session: candidates[0]! }
        : { kind: "many", sessions: shown, reason: "need-hint" };
    }
    const needle = squash(hint);
    const listed = (session: LocalAgentSession) => squash(`${session.title}\n${session.lastQuestion}`).includes(needle);
    const fast = shown.filter(listed);
    if (fast.length === 1) return { kind: "one", session: fast[0]! };
    if (fast.length > 1) return { kind: "many", sessions: fast, reason: "ambiguous" };
    const textOf = await questionText(shown);
    const matched = shown.filter((session) => (textOf.get(sessionKey(session)) ?? "").includes(needle));
    if (candidates.length === 1) {
      return matched.length === 1 ? { kind: "one", session: matched[0]! } : { kind: "unmatched", session: candidates[0]! };
    }
    if (matched.length === 1) return { kind: "one", session: matched[0]! };
    if (!matched.length) return { kind: "many", sessions: shown, reason: "miss" };
    return { kind: "many", sessions: matched, reason: "ambiguous" };
  }

  return {
    async listProjects() {
      const account = requireAccount();
      const data = await cloud("/projects");
      const projects = list(data.projects).map(toProject);
      // Each project's local working project is recorded on this computer, next to its session links.
      const bound = await Promise.all(projects.map(async (project) => {
        const stored = await readLinks(project.id, account.accountId);
        // The list is read at every launch, so this is where members pick up instructions the owner changed.
        await rememberInstructions(project.id, project.instructions, instructionScopes(stored));
        return { ...project, localProjectId: stored.localProjectId };
      }));
      // 旧云端没有这份列表时不填字段，桌面端就保留本机刚记下的申请，避免一次刷新把「申请中」冲掉。
      if (!Array.isArray(data.applications)) return { projects: bound };
      const decisions = Array.isArray(data.decisions)
        ? list(data.decisions).map(toDecision).filter((decision): decision is CollabApplicationDecision => decision !== null)
        : undefined;
      return {
        projects: bound,
        applications: list(data.applications).map(toApplication),
        ...(decisions ? { decisions } : {}),
        ...(typeof data.maxOwnedProjects === "number" ? { maxOwnedProjects: data.maxOwnedProjects } : {})
      };
    },

    async createProject(name, directory) {
      const data = await cloud("/projects", { method: "POST", body: { name } });
      const project = toProject(data.project);
      const localDirectory = await prepareWorkingDirectory(onlineWorkdirRoot, project.id, project.name, directory);
      const account = requireAccount();
      const stored = await readLinks(project.id, account.accountId);
      stored.workingDirectory = localDirectory;
      await writeLinks(stored);
      return { project: { ...project, localProjectId: null }, localDirectory };
    },

    async ensureWorkingDirectory(projectId, name, directory) {
      const account = requireAccount();
      const stored = await readLinks(projectId, account.accountId);
      // A project created earlier keeps the folder it already had, so its tasks stay where they were.
      const existing = directory ? undefined : stored.workingDirectory;
      const localDirectory = existing
        ?? await prepareWorkingDirectory(onlineWorkdirRoot, projectId, name ?? projectId, directory);
      if (!stored.workingDirectory) {
        stored.workingDirectory = localDirectory;
        await writeLinks(stored);
      }
      return { localDirectory, chosen: Boolean(directory) || (Boolean(existing) && stored.directoryChosen) };
    },

    async bindLocalProject(projectId, localProjectId) {
      const account = requireAccount();
      const stored = await readLinks(projectId, account.accountId);
      stored.localProjectId = localProjectId;
      await writeLinks(stored);
      return { ok: true };
    },

    /**
     * 目录 → 协作项目：逐个读本机各项目的 links 文件，按工作目录匹配。
     *
     * <p>这里不用 {@code readAllLinks}：它只挑出「还欠云端东西」的项目（已绑定或已选会话），
     * 而一个刚建好、什么都没同步的项目也应该能让它的知识库参与检索。目录数量是本机项目数量级，成本可忽略。</p>
     */
    async cloudProjectForDirectory(directory) {
      const account = options.getAccount();
      const key = collabInstructionsDirectoryKey(directory);
      if (!account || !key) return null;
      const entries = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const stored = parseStoredLinks(await readFile(join(projectsDir, entry.name, LINKS_FILE), "utf8").catch(() => ""));
        if (!stored || stored.accountId !== account.accountId || !stored.workingDirectory) continue;
        if (collabInstructionsDirectoryKey(stored.workingDirectory) === key) return stored.projectId;
      }
      return null;
    },

    async projectsForAgentSession(sourceId, conversationId) {
      const account = requireAccount();
      const projects = list((await cloud("/projects")).projects).map(toProject);
      const records = await Promise.all(projects.map(async (project) => ({ project, links: await readLinks(project.id, account.accountId) })));
      const key = sessionKey({ sourceId, conversationId });
      // Prefer the current group for group links; uploaded records can resolve a session not in the local scan.
      const needsGroup = records.some(({ links }) => links.groups.some((group) => group.sourceId === sourceId));
      const session = needsGroup ? await sessionByIdentity(sourceId, conversationId) : null;
      return records.filter(({ links }) => {
        const groupId = session?.group?.id ?? links.synced[key]?.groupId ?? null;
        return linkedSessionKeys(links, [{ sourceId, conversationId, groupId }]).has(key);
      }).map(({ project }) => project);
    },

    listSessions,

    async candidateSessions(projectId, input = {}) {
      // The same page the board reads, so the @ menu can only offer what this project holds.
      const { sessions } = await listSessions(projectId, {
        ...(input.query ? { query: input.query } : {}),
        offset: 0,
        limit: input.limit ?? CANDIDATE_LIMIT
      });
      return { sessions };
    },

    async readSessionDetail(sessionId) {
      // Same payload the reference reads, and the reader stays a viewer.
      const data = record((await cloud(`/sessions/${encodeURIComponent(sessionId)}`)).session);
      return { session: withLink(data), turns: list(data.turns).map(toTurn) };
    },



    listLocalSessions,

    async getLinks(projectId) {
      const account = requireAccount();
      const stored = await readLinks(projectId, account.accountId);
      return { groups: stored.groups, sessions: stored.sessions };
    },

    saveLinks(projectId, links) {
      const account = requireAccount();
      return exclusive(async () => {
        const stored = await readLinks(projectId, account.accountId);
        const { sessions: local } = await listLocalSessions({ limit: MAX_LOCAL_SESSIONS });
        const tasks = await projectTaskSessions(stored);
        const candidates = linkCandidates(stored, [...local, ...tasks]);
        // Both sides are judged on the same candidates, so only what the person changed is removed.
        const before = linkedSessionKeys(stored, candidates);
        const after = linkedSessionKeys(links, candidates);
        const listing = createListingReader(projectId);
        let removed = 0;
        for (const key of before) {
          const synced = stored.synced[key];
          if (after.has(key) || !synced) continue;
          await deleteCloudSession(projectId, synced.cloudSessionId, listing);
          delete stored.synced[key];
          const { sourceId, conversationId } = parseSessionKey(key);
          const candidate = candidates.find((item) => sessionKey(item) === key);
          stored.sessions = stored.sessions.filter((link) => sessionKey(link) !== key);
          for (const group of stored.groups) {
            if (group.sourceId === sourceId && (group.groupId === synced.groupId || group.groupId === candidate?.groupId)
              && !group.excluded.includes(conversationId)) group.excluded.push(conversationId);
          }
          // Persist each confirmed deletion and exclusion to prevent background sync recreating it.
          await writeLinks(stored);
          removed += 1;
        }
        stored.groups = links.groups;
        stored.sessions = links.sessions;
        // 关联的 Agent 分组变了，已有指令的生效范围跟着走。
        await updateInstructionScopes(projectId, stored);

        // The selection is saved before any upload, so closing the board or the app never loses it.
        const pending = sessionsToUpload(stored, [...local, ...tasks]);
        await writeLinks(stored);
        if (!pending.length) {
          syncProgress.delete(projectId);
          return { uploaded: 0, removed, failed: 0 };
        }

        syncProgress.set(projectId, { running: true, total: pending.length, completed: 0, failed: 0 });
        enqueueUpload(projectId, () => runUpload(projectId, account.accountId));
        return { uploaded: 0, removed, failed: 0, started: pending.length };
      });
    },

    async getSyncProgress(projectId) {
      return syncProgress.get(projectId) ?? { running: false, total: 0, completed: 0, failed: 0 };
    },

    async getTaskSharing(projectId, conversationId) {
      const account = requireAccount();
      const stored = await readLinks(projectId, account.accountId);
      return taskSharingOf(stored, conversationId);
    },

    setTaskSharing(projectId, conversationId, shared) {
      const account = requireAccount();
      return applyTaskSharing(projectId, account.accountId, conversationId, shared);
    },

    async listProjectTasks(projectId) {
      const account = requireAccount();
      const stored = await readLinks(projectId, account.accountId);
      const tasks = await projectTaskSessions(stored);
      return {
        tasks: [...tasks]
          .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
          .map((task) => ({
            conversationId: task.conversationId,
            title: task.title,
            lastQuestion: task.lastQuestion,
            updatedAt: task.updatedAt,
            turnCount: task.turnCount,
            // 本人开启过共享、或这一版之前已上传过的任务才算在内；新任务默认不共享。
            included: isTaskShared(stored, task.conversationId),
            synced: Boolean(stored.synced[sessionKey(task)])
          }))
      };
    },

    saveProjectTasks(projectId, included) {
      const account = requireAccount();
      return exclusive(async () => {
        const stored = await readLinks(projectId, account.accountId);
        const tasks = await projectTaskSessions(stored);
        const keep = new Set(included);
        const onDisk = new Set(tasks.map((task) => task.conversationId));
        // Exclusions for sessions that are gone stay as they were; the ones here follow this selection.
        const nextRemovedSessions = [
          ...stored.removedSessions.filter((conversationId) => !onDisk.has(conversationId)),
          ...tasks.filter((task) => !keep.has(task.conversationId)).map((task) => task.conversationId)
        ];

        let removed = 0;
        const listing = createListingReader(projectId);
        for (const task of tasks) {
          if (keep.has(task.conversationId)) continue;
          const key = sessionKey(task);
          const synced = stored.synced[key];
          if (!synced) continue;
          await deleteCloudSession(projectId, synced.cloudSessionId, listing);
          delete stored.synced[key];
          if (!stored.removedSessions.includes(task.conversationId)) stored.removedSessions.push(task.conversationId);
          await writeLinks(stored);
          removed += 1;
        }

        stored.removedSessions = nextRemovedSessions;
        // The selection is the shared list itself: what is checked here is what the project holds.
        stored.sharedSessions = tasks
          .filter((task) => keep.has(task.conversationId))
          .map((task) => task.conversationId);
        // Saved before any upload, so closing the board or the app never loses the choice.
        const pending = sessionsToUpload(stored, tasks);
        await writeLinks(stored);
        if (!pending.length) {
          syncProgress.delete(projectId);
          return { uploaded: 0, removed, failed: 0 };
        }
        syncProgress.set(projectId, { running: true, total: pending.length, completed: 0, failed: 0 });
        enqueueUpload(projectId, () => runUpload(projectId, account.accountId));
        return { uploaded: 0, removed, failed: 0, started: pending.length };
      });
    },

    async deleteProject(projectId) {
      const account = requireAccount();
      const startedAt = now().getTime();
      // 删云端之前先把要带走的读出来：缓存会跟着项目一起清掉，links 也会在解绑时改掉。
      const stored = await readLinks(projectId, account.accountId);
      const sharedInstructions = (await options.collabInstructions?.read(projectId).catch(() => null))?.text ?? "";
      await cloud(`/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" });
      const cloudDoneAt = now().getTime();
      syncProgress.delete(projectId);
      await releaseBinding(projectId, account.accountId, "delete");
      // 背景与规范属于这个文件夹，项目停止共享后写回创建者的本机项目；缓存随后清掉。
      const instructions = await handOverInstructions(stored.workingDirectory, sharedInstructions);
      await forgetInstructions(projectId);
      const finishedAt = now().getTime();
      if (finishedAt - startedAt > SLOW_DELETE_MS) {
        console.warn(`Deleting project ${projectId} took ${finishedAt - startedAt}ms (cloud ${cloudDoneAt - startedAt}ms, links ${finishedAt - cloudDoneAt}ms)`);
      }
      return { ok: true as const, instructions };
    },

    async leaveProject(projectId) {
      const account = requireAccount();
      await cloud(`/projects/${encodeURIComponent(projectId)}/leave`, { method: "POST", body: {} });
      syncProgress.delete(projectId);
      await releaseBinding(projectId, account.accountId, "leave");
      await forgetInstructions(projectId);
      // 协作任务不在本机缓存正文，读取只现查云端；旧版本留下的缓存目录在这里一并清掉。
      await rm(join(projectsDir, safeSegment(projectId), "sessions"), { recursive: true, force: true });
      return { ok: true };
    },

    async listMembers(projectId) {
      const account = requireAccount();
      const data = await cloud(`/projects/${encodeURIComponent(projectId)}/members`);
      const stored = await readLinks(projectId, account.accountId);
      return {
        project: { ...toProject(data.project), localProjectId: stored.localProjectId },
        joinMode: toJoinMode(data.joinMode),
        canManage: data.canManage === true,
        members: list(data.members).map(toMember),
        requests: list(data.requests).map(toJoinRequest)
      };
    },

    async createInvite(projectId) {
      const data = await cloud(`/projects/${encodeURIComponent(projectId)}/invite`, { method: "POST", body: {} });
      const code = text(data.code);
      if (!INVITE_CODE_PATTERN.test(code)) {
        throw new CollabError("internal", "邀请链接生成失败，请稍后重试");
      }
      const link = `${linkBase}/i/${code}`;
      const name = text(data.projectName);
      return { code, link, shareText: name ? `【Memmy】邀请你加入协作项目「${name}」 ${link}` : `【Memmy】邀请你加入协作项目 ${link}` };
    },

    async setJoinMode(projectId, joinMode) {
      const data = await cloud(`/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: { joinMode } });
      return { joinMode: toJoinMode(data.joinMode) };
    },

    async renameProject(projectId, name) {
      const trimmed = name.trim();
      if (!trimmed) throw new CollabError("invalid_argument", "请填写项目名称");
      const data = await cloud(`/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: { name: trimmed } });
      const account = requireAccount();
      // The binding stays as it is; only the name the board and the sidebar read comes back.
      const stored = await readLinks(projectId, account.accountId);
      return { project: { ...toProject(record(data.project)), localProjectId: stored.localProjectId } };
    },

    async updateInstructions(projectId, text, directory) {
      const instructions = text.trim();
      if ([...instructions].length > MAX_COLLAB_INSTRUCTIONS_CHARS) {
        throw new CollabError("invalid_argument", `背景与规范不超过 ${MAX_COLLAB_INSTRUCTIONS_CHARS} 字`);
      }
      const data = await cloud(`/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: { instructions } });
      const account = requireAccount();
      const stored = await readLinks(projectId, account.accountId);
      const project = { ...toProject(record(data.project)), localProjectId: stored.localProjectId };
      await rememberInstructions(projectId, project.instructions, instructionScopes(stored));
      return { project };
    },

    async knowledge(projectId) {
      return toKnowledge(await cloud(`/projects/${encodeURIComponent(projectId)}/knowledge`));
    },

    async addKnowledge(projectId, baseId) {
      const data = await cloud(`/projects/${encodeURIComponent(projectId)}/knowledge`, {
        method: "POST",
        body: { baseId }
      });
      return toKnowledge(data);
    },

    async removeKnowledge(projectId, baseId) {
      const data = await cloud(
        `/projects/${encodeURIComponent(projectId)}/knowledge/${encodeURIComponent(baseId)}`,
        { method: "DELETE" }
      );
      return toKnowledge(data);
    },

    async approveRequest(projectId, userId) {
      const data = await cloud(`/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(userId)}/approve`, { method: "POST", body: {} });
      return { member: toMember(data.member) };
    },

    async rejectRequest(projectId, userId) {
      await cloud(`/projects/${encodeURIComponent(projectId)}/requests/${encodeURIComponent(userId)}`, { method: "DELETE" });
      return { ok: true };
    },

    async setMemberRole(projectId, userId, role) {
      const data = await cloud(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: "PATCH", body: { role } });
      return { member: toMember(data.member) };
    },

    async removeMember(projectId, userId) {
      await cloud(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
      return { ok: true };
    },

    async previewInvite(reference) {
      const code = requireInviteCode(reference);
      const data = await cloud(`/invites/${encodeURIComponent(code)}`);
      return { invite: toInvitePreview(data.invite) };
    },

    async joinProject(reference, directory) {
      const account = requireAccount();
      const code = requireInviteCode(reference);
      const data = await cloud(`/invites/${encodeURIComponent(code)}/join`, { method: "POST", body: {} });
      const status = data.status === "joined" || data.status === "pending" || data.status === "member" ? data.status : null;
      const project = data.project === undefined || data.project === null ? null : toProject(data.project);
      const projectId = project?.id || text(data.projectId);
      if (!status || !projectId) {
        throw new CollabError("internal", "加入项目的结果无法识别，请稍后重试");
      }
      const chosen = directory?.trim() ? await prepareWorkingDirectory(onlineWorkdirRoot, projectId, projectId, directory) : null;
      const stored = await exclusive(async () => {
        const latest = await readLinks(projectId, account.accountId);
        // A project this computer already runs keeps its folder; otherwise the latest choice wins, so a person who
        // applied with a folder and again without one gets a managed folder.
        if (!latest.localProjectId && (chosen || latest.directoryChosen)) {
          latest.workingDirectory = chosen;
          latest.directoryChosen = chosen !== null;
          await writeLinks(latest);
        }
        return latest;
      });
      return { status, projectId, project: project ? { ...project, localProjectId: stored.localProjectId } : null };
    },

    syncProjectTasks(projectId) {
      return serializedSync(async () => {
        const account = options.getAccount();
        const total: CollabSyncResult = { uploaded: 0, removed: 0, failed: 0 };
        if (!account) return total;
        const projects = await readAllLinks(account.accountId);
        // One board only waits for its own project: syncing the others first is what made opening a board slow.
        // A board only opens on a project the person is in, so only the full sync checks membership.
        const scoped = projectId ? projects.filter((stored) => stored.projectId === projectId) : await stillJoined(projects);
        for (const stored of scoped) {
          const tasks = await projectTaskSessions(stored);
          if (!tasks.length) continue;
          const { result, synced } = await uploadPending(stored, tasks);
          await recordUploaded(stored.projectId, account.accountId, synced);
          total.uploaded += result.uploaded;
          total.failed += result.failed;
        }
        return total;
      });
    },

    syncLinkedSessions() {
      return serializedSync(async () => {
        const account = options.getAccount();
        const total: CollabSyncResult = { uploaded: 0, removed: 0, failed: 0 };
        if (!account) return total;
        const projects = await stillJoined(await readAllLinks(account.accountId));
        if (!projects.length) return total;
        // The Memory service only holds the other agents' sessions; Memmy's own tasks must still sync without it.
        // A cached list is enough here: forcing a rescan every minute would re-walk every agent's history.
        const local = await listLocalSessions({ limit: MAX_LOCAL_SESSIONS })
          .then((listing) => listing.sessions)
          .catch(() => []);
        for (const stored of projects) {
          const { result, synced } = await uploadPending(stored, [...local, ...await projectTaskSessions(stored)]);
          await recordUploaded(stored.projectId, account.accountId, synced);
          total.uploaded += result.uploaded;
          total.failed += result.failed;
        }
        return total;
      });
    },

    async removeSession(projectId, sessionId) {
      await deleteCloudSession(projectId, sessionId);
      const account = options.getAccount();
      if (account) {
        // Otherwise the next sync would upload it again: drop the session link, or exclude it from its group.
        await exclusive(async () => {
          const stored = await readLinks(projectId, account.accountId);
          const entry = Object.entries(stored.synced).find(([, synced]) => synced.cloudSessionId === sessionId);
          if (!entry) return;
          const [key, synced] = entry;
          const { sourceId, conversationId } = parseSessionKey(key);
          delete stored.synced[key];
          if (sourceId === MEMMY_SOURCE_ID && !stored.removedSessions.includes(conversationId)) {
            stored.removedSessions.push(conversationId);
          }
          stored.sessions = stored.sessions.filter((link) => sessionKey(link) !== key);
          const group = stored.groups.find((link) => link.sourceId === sourceId && link.groupId === synced.groupId);
          if (group && !group.excluded.includes(conversationId)) group.excluded.push(conversationId);
          await writeLinks(stored);
        });
      }
      return { ok: true };
    },

    async searchSessions(input) {
      const { words, mineOnly, member } = ownNameAsFilter(input, options.getAccount()?.memberName);
      const query = new URLSearchParams();
      query.set("q", searchKeywords(words.join(" ")).join(" "));
      if (member) query.set("member", member);
      if (input.project) query.set("project", input.project);
      // 窗口随请求下发：云端在分页前过滤，正文命中一多也不会把近期任务挤掉。旧云端不认这个参数，
      // 下面的本地过滤照旧生效，两边各自发版都能用。
      if (input.since) query.set("since", input.since);
      query.set("limit", String(CLOUD_SEARCH_LIMIT));
      const data = await cloud(`/sessions/search?${query.toString()}`);
      const found = list(data.sessions)
        .map((raw) => withSearchHits(withLink(raw), raw))
        .filter((session) => !mineOnly || session.mine);
      const cutoff = input.sinceMs === undefined ? null : now().getTime() - input.sinceMs;
      const recent = cutoff === null
        ? found
        : found.filter((session) => session.lastActiveAt !== null && Date.parse(session.lastActiveAt) >= cutoff);
      return { sessions: mergeShared(recent).slice(0, input.limit ?? DEFAULT_SEARCH_RESULTS) };
    },

    async readSession(reference, view) {
      const id = parseSessionReference(reference);
      if (!id) {
        throw new CollabError("invalid_argument", "无法识别的任务链接。请从 Memmy 中重新复制链接。");
      }
      // The cloud returns one `session` that also carries this session's `turns`.
      const data = record((await cloud(`/sessions/${encodeURIComponent(id)}`)).session);
      const session = withLink(data);
      const turns = list(data.turns).map(toTurn);
      // 协作任务只在云端保留，读取结果直接交给调用方，不在本机写文件。
      return { session, text: renderSessionView(session, turns, now(), view ?? {}) };
    },

    async addCurrentSession(input) {
      // Memmy 自己的任务没有外部 Agent 的会话记录，加入项目就是共享它：走同一条开关键路。
      if (input.sourceId?.trim() === MEMMY_SOURCE_ID && input.conversationId?.trim()) {
        return this.shareCurrentTask({
          conversationId: input.conversationId.trim(),
          shared: true,
          ...(input.project?.trim() ? { project: input.project.trim() } : {})
        });
      }
      const { projects } = await this.listProjects();
      if (!projects.length) return { text: formatNoProjects() };
      const hint = input.hint?.trim() ?? "";
      const project = input.project?.trim() ?? "";
      const sourceId = input.sourceId?.trim() ?? "";
      const conversationId = input.conversationId?.trim() ?? "";
      // The running conversation, when the agent names it. That whole task is added; a different one is not.
      const named = sourceId && conversationId ? await sessionByIdentity(sourceId, conversationId) : undefined;
      if (sourceId && conversationId && !named) return { text: formatCurrentSessionMissing() };
      const cwd = input.cwd?.trim() ?? "";
      let session = named;
      if (!session) {
        if (!cwd) return { text: formatNoDirectory() };
        const listed = await readLocal((reader) => reader.available({ cwd, limit: ADD_CANDIDATE_LIMIT, fresh: true }));
        const candidates = pickAddCandidates(listed.sessions.map(toLocalSession), cwd);
        const chosen = await chooseAddSession(candidates, squash(hint) ? hint : "");
        if (chosen.kind !== "one") {
          return { text: formatSessionProblem(chosen, { hint, ...(project ? { project } : {}) }) };
        }
        session = chosen.session;
      }
      if (!project) return { text: formatNeedProject(projects, session, hint) };
      const matched = matchProjectName(projects, project);
      if (matched.kind !== "exact") return { text: formatProjectProblem(matched, project, hint) };

      const account = requireAccount();
      const stored = await readLinks(matched.project.id, account.accountId);
      const covered = linkedSessionKeys(stored, [{
        sourceId: session.sourceId,
        conversationId: session.conversationId,
        groupId: session.group?.id ?? null
      }]);
      if (covered.has(sessionKey(session))) {
        const groupId = session.group?.id ?? "";
        const viaGroup = stored.groups.some((group) =>
          group.sourceId === session.sourceId && group.groupId === groupId && !group.excluded.includes(session.conversationId));
        return { text: formatAlready(session, matched.project.name, viaGroup) };
      }
      const saved = await this.saveLinks(matched.project.id, {
        groups: stored.groups,
        sessions: [...stored.sessions, { sourceId: session.sourceId, conversationId: session.conversationId }]
      });
      return { text: formatAdded(session, matched.project.name, (saved.started ?? 0) > 0 || saved.uploaded > 0) };
    },

    async shareCurrentTask(input) {
      const account = requireAccount();
      const records = await readSessionRecords(join(agentSessionsDir, `websocket_${input.conversationId}.jsonl`));
      if (!records) {
        return { text: "找不到当前这条任务，还没有共享。Memmy 还没有读到正在进行的这个对话，确认 Memmy 已打开；若刚开始，先再聊一轮后重试。" };
      }
      if (!records.projectId) {
        return { text: "当前任务不属于任何项目，没有共享。先在 Memmy 的侧栏选择一个项目，在那里新建任务。" };
      }
      const bound = (await readAllLinks(account.accountId))
        .filter((stored) => stored.localProjectId === records.projectId);
      if (!bound.length) {
        return { text: `当前任务所在的项目还没有开启协作共享，没有共享。在 Memmy 中打开该项目并开启「与成员共享」后重试。` };
      }
      const named = input.project?.trim() ?? "";
      const { projects } = await this.listProjects();
      const namedMatches = named ? bound.filter((stored) => projects.find((project) => project.id === stored.projectId)?.name === named) : bound;
      if (named && !namedMatches.length) {
        const names = bound
          .map((stored) => projects.find((project) => project.id === stored.projectId)?.name ?? stored.projectId)
          .join("、");
        return { text: `没有名为「${named}」的协作项目，当前任务属于：${names}。向用户确认后重试。` };
      }
      if (namedMatches.length > 1) {
        const names = namedMatches
          .map((stored) => projects.find((project) => project.id === stored.projectId)?.name ?? stored.projectId)
          .join("、");
        return { text: `当前任务关联了多个协作项目：${names}。请用户选择后加上 --project <完整名称> 重试。` };
      }
      const stored = namedMatches[0]!;
      const name = projects.find((project) => project.id === stored.projectId)?.name ?? "";
      const members = projects.find((project) => project.id === stored.projectId)?.memberCount ?? 0;
      const before = await readLinks(stored.projectId, account.accountId);
      const wasShared = isTaskShared(before, input.conversationId);
      if (wasShared === input.shared) {
        return {
          text: input.shared
            ? `当前任务「${records.title}」已经在协作项目「${name}」中共享。`
            : `当前任务「${records.title}」没有在协作项目「${name}」中共享。`
        };
      }
      await applyTaskSharing(stored.projectId, account.accountId, input.conversationId, input.shared);
      return {
        text: input.shared
          ? `已把当前任务「${records.title}」共享给协作项目「${name}」，${members} 位成员可以查看与引用；之后的对话也会继续更新。`
          : `已停止共享当前任务「${records.title}」：协作项目「${name}」的成员不再看到它，本机任务保留。`
      };
    }
  };
}

/**
 * Filters by keyword, then takes one page. Keywords are matched against what a person would search by: the
 * title, the last question, and the member's name; any keyword matching is enough.
 */
export function pageOf(
  sessions: readonly CollabProjectSession[],
  options: { query?: string; member?: "me" | "others"; offset?: number; limit?: number } = {}
): { sessions: CollabProjectSession[]; total: number } {
  const byMember = options.member
    ? sessions.filter((session) => (options.member === "me" ? session.mine : !session.mine))
    : [...sessions];
  const keywords = (options.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  const matched = keywords.length
    ? byMember.filter((session) => {
      const haystack = `${session.title}\n${session.lastQuestion}\n${session.memberName}`.toLowerCase();
      return keywords.some((keyword) => haystack.includes(keyword));
    })
    : byMember;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit === undefined ? matched.length : Math.max(0, options.limit);
  return { sessions: matched.slice(offset, offset + limit), total: matched.length };
}

/**
 * Turns an agent's words into the keywords the cloud matches. The cloud lists a session when any keyword is a
 * substring of its title, last question, member or project name, ranks by how many keywords hit, and keeps the
 * first 10 distinct keywords. The skill asks agents for short words separated by spaces, so spaces are the split.
 */
export function searchKeywords(query: string): string[] {
  return query.trim().split(/\s+/u).filter(Boolean);
}

/**
 * The person's own sessions show their nickname here, but the cloud matches the name it stores for them, which
 * may differ. Their nickname, given as the member or as one of the words, therefore means "my sessions" and is
 * applied on this side: it leaves the cloud query, and only the person's own sessions are kept.
 */
export function ownNameAsFilter(
  input: Pick<SessionSearchInput, "query" | "member">,
  nickname: string | undefined
): { words: string[]; mineOnly: boolean; member: string | undefined } {
  const words = (input.query ?? "").trim().split(/\s+/u).filter(Boolean);
  const own = nickname?.trim().toLowerCase() ?? "";
  if (!own) return { words, member: input.member, mineOnly: false };
  const memberIsMe = input.member?.trim().toLowerCase() === own;
  const topicWords = words.filter((word) => word.toLowerCase() !== own);
  // Another member named alongside the person's nickname keeps the search on that member.
  const nameInWords = topicWords.length < words.length && !input.member;
  return { words: topicWords, member: memberIsMe ? undefined : input.member, mineOnly: memberIsMe || nameInWords };
}

/** `30d`, `24h` or `2w` as milliseconds; null when the text is none of these. */
export function sinceWindowMs(value: string): number | null {
  const match = /^(\d{1,4})([hdw])$/u.exec(value.trim());
  return match ? Number(match[1]) * (SINCE_UNITS_MS[match[2] ?? ""] ?? 0) : null;
}

/**
 * A session shared to several projects comes back once per project with a different ID; the copies have the same
 * member, title and last activity. One hit names all its projects, so copies do not crowd out other results. The
 * turn hits are merged the same way: a copy that matched another turn adds it instead of repeating the session.
 */
function mergeShared(sessions: readonly SessionSearchHit[]): SessionSearchHit[] {
  const merged = new Map<string, SessionSearchHit>();
  for (const session of sessions) {
    const key = [session.memberName, session.mine, session.title, session.lastActiveAt ?? ""].join("\u0000");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...session, projectNames: session.projectName ? [session.projectName] : [], hits: [...session.hits] });
      continue;
    }
    if (session.projectName && !existing.projectNames.includes(session.projectName)) {
      existing.projectNames.push(session.projectName);
    }
    existing.hits = mergeTurnHits(existing.hits, session.hits);
  }
  return [...merged.values()];
}

/** The same turn can be quoted twice through two project copies; keep the first quote of each turn, in turn order. */
function mergeTurnHits(left: readonly SessionTurnHit[], right: readonly SessionTurnHit[]): SessionTurnHit[] {
  const byTurn = new Map<number, SessionTurnHit>();
  for (const hit of [...left, ...right]) {
    if (!byTurn.has(hit.turnNo)) byTurn.set(hit.turnNo, hit);
  }
  return [...byTurn.values()].sort((first, second) => first.turnNo - second.turnNo).slice(0, MAX_SEARCH_HITS);
}

/**
 * What `sessions read` prints: where the session comes from, then the turns the view asks for in full. The
 * overview lists earlier turns one line each, so an agent expands only the part it needs. Nothing is written to
 * this computer, so a reader asks again with another view instead of opening a file.
 */
export function renderSessionView(
  session: CollabProjectSession,
  turns: readonly CollabSessionTurn[],
  readAt: Date,
  view: SessionView
): string {
  const speaker = sessionSpeaker(session);
  const numbered = numberTurns(session, turns);
  const total = session.turnCount || turns.length;
  const activity = session.lastActiveAt ? `最近交互 ${formatTime(new Date(session.lastActiveAt))}，` : "";
  const lines = [
    `已读取${speaker}的任务「${session.title}」（${session.projectName}，${activity}读取于 ${formatTime(readAt)}）。`,
    `共 ${total} 轮${turns.length < total ? `，云端保留最近 ${turns.length} 轮` : ""}。`
  ];
  if (session.trimmed) {
    // 单任务超过容量或轮次上限时，云端只保留近期记录；来源 Agent 的原始记录不受影响。
    lines.push("该任务仅保留近期记录；更早的轮次已按单任务上限清理，来源 Agent 的原始记录不受影响。");
  }
  if (!numbered.length) {
    lines.push("这个任务还没有可显示的轮次。");
    return lines.join("\n");
  }
  const { shown, note, outline } = selectTurns(numbered, view);
  lines.push(note);
  if (outline) {
    const rest = numbered.filter((entry) => !shown.has(entry.number));
    const listed = rest.slice(-OUTLINE_LIMIT);
    lines.push("");
    if (rest.length > listed.length) lines.push(`（更早的 ${rest.length - listed.length} 轮未列出）`);
    for (const entry of listed) lines.push(`- 第 ${entry.number} 轮：${oneLine(entry.turn.question, OUTLINE_QUESTION_CHARS) || "（无提问）"}`);
  }
  let previous: number | null = null;
  for (const entry of numbered) {
    if (!shown.has(entry.number)) continue;
    if (previous !== null && entry.number > previous + 1) lines.push("", `……（略去第 ${previous + 1}–${entry.number - 1} 轮）`);
    lines.push("", ...turnLines(entry, speaker));
    previous = entry.number;
  }
  return lines.join("\n");
}

interface NumberedTurn {
  number: number;
  turn: CollabSessionTurn;
}

/** The turns a view prints in full, the line that says which they are, and whether the others are listed. */
function selectTurns(numbered: readonly NumberedTurn[], view: SessionView): { shown: Set<number>; note: string; outline: boolean } {
  const first = numbered[0]!.number;
  const last = numbered[numbered.length - 1]!.number;
  const range = (from: number, to: number) => numbered.map((entry) => entry.number).filter((number) => number >= from && number <= to);
  const latest = (count: number) => range(last - count + 1, last);
  const absent = (asked: string) => ({
    shown: new Set<number>(),
    outline: true,
    note: `第 ${asked} 轮不在记录中，记录中为第 ${first}–${last} 轮。以下只列各轮提问。`
  });

  if (view.all) {
    return { shown: new Set(range(first, last)), outline: false, note: "以下为全部轮次。" };
  }
  if (view.find !== undefined) {
    // Punctuation and spacing differ between a screenshot and the record, so only the words are compared.
    const needle = squash(view.find);
    const hits = needle
      ? numbered.filter((entry) => squash(`${entry.turn.question}\n${entry.turn.reply}`).includes(needle)).map((entry) => entry.number)
      : [];
    const quoted = oneLine(view.find, 30);
    if (!hits.length) {
      return {
        shown: new Set<number>(),
        outline: true,
        note: `这个任务中没有找到「${quoted}」：它可能不是要找的任务，或这部分内容还没有同步。以下只列各轮提问。`
      };
    }
    const at = hits[0]!;
    const named = hits.length > MAX_FIND_TURNS ? `${hits.slice(0, MAX_FIND_TURNS).join("、")} 等 ${hits.length} 轮` : `${hits.join("、")} 轮`;
    return {
      shown: new Set([...range(at - NEIGHBOUR_TURNS, at + NEIGHBOUR_TURNS), ...hits.slice(0, MAX_FIND_TURNS), ...latest(EXCERPT_LATEST_TURNS)]),
      outline: false,
      note: `「${quoted}」出现在第 ${named}。以下为第 ${at} 轮前后、其余命中的轮次与最近 ${EXCERPT_LATEST_TURNS} 轮。`
    };
  }
  if (view.around !== undefined) {
    const around = range(view.around - NEIGHBOUR_TURNS, view.around + NEIGHBOUR_TURNS);
    if (!around.includes(view.around)) return absent(String(view.around));
    return {
      shown: new Set([...around, ...latest(EXCERPT_LATEST_TURNS)]),
      outline: false,
      note: `以下为第 ${around[0]}–${around[around.length - 1]} 轮与最近 ${EXCERPT_LATEST_TURNS} 轮。`
    };
  }
  if (view.turns) {
    const asked = range(view.turns.from, view.turns.to);
    if (!asked.length) return absent(`${view.turns.from}–${view.turns.to}`);
    return { shown: new Set(asked), outline: false, note: `以下为第 ${asked[0]}–${asked[asked.length - 1]} 轮。` };
  }
  const recent = latest(OVERVIEW_TURNS);
  if (recent.length === numbered.length) {
    return { shown: new Set(recent), outline: false, note: "以下为全部轮次。" };
  }
  return {
    shown: new Set(recent),
    outline: true,
    note: `以下为最近 ${recent.length} 轮全文；更早的轮次只列提问，展开用 --turns <起>-<止>。`
  };
}

/** The file is shared reading: name the member, since "you" means nothing to a later reader. */
function sessionSpeaker(session: CollabProjectSession): string {
  return session.memberName || (session.mine ? "你" : "");
}

/** Numbers turns as the session counts them; the cloud keeps only the latest ones of a long session. */
function numberTurns(session: CollabProjectSession, turns: readonly CollabSessionTurn[]): NumberedTurn[] {
  const offset = Math.max(0, (session.turnCount || turns.length) - turns.length);
  return turns.map((turn, index) => ({ number: offset + index + 1, turn }));
}

function turnLines({ number, turn }: NumberedTurn, speaker: string): string[] {
  const lines = [`### 第 ${number} 轮`];
  if (turn.question) lines.push(`${speaker}：${turn.question}`);
  if (turn.reply) lines.push(`回复：${turn.reply}`);
  if (turn.steps.length) lines.push(`执行步骤：${summarizeSteps(turn.steps)}`);
  return lines;
}

function squash(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function oneLine(value: string, maxChars: number): string {
  return clip(value.replace(/\s+/gu, " ").trim(), maxChars);
}

/** Listed sessions with their current group, plus uploaded ones that dropped out of the list with the group they had. */
function linkCandidates(stored: StoredLinks, local: readonly LocalAgentSession[]): LinkCandidate[] {
  const candidates = new Map<string, LinkCandidate>();
  for (const [key, synced] of Object.entries(stored.synced)) {
    candidates.set(key, { ...parseSessionKey(key), groupId: synced.groupId });
  }
  for (const session of local) {
    candidates.set(sessionKey(session), { sourceId: session.sourceId, conversationId: session.conversationId, groupId: session.group?.id ?? null });
  }
  return [...candidates.values()];
}

interface MemmySessionRecords {
  conversationId: string;
  projectId: string;
  title: string;
  lastQuestion: string;
  workspacePath: string | null;
  updatedAt: string;
  turns: CollabSessionTurn[];
}

/**
 * Reads one of Memmy's task session files: a metadata line first, then user, assistant and tool records that
 * group into turns the same way the board shows them.
 */
async function readSessionRecords(path: string): Promise<MemmySessionRecords | null> {
  const content = await readFile(path, "utf8").catch(() => null);
  if (!content) return null;

  let key = "";
  let projectId = "";
  let title = "";
  let workspacePath: string | null = null;
  let updatedAt = "";
  let lastQuestion = "";
  const turns: CollabSessionTurn[] = [];
  let current: CollabSessionTurn | null = null;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: Record<string, unknown>;
    try {
      raw = record(JSON.parse(trimmed));
    } catch {
      continue;
    }
    const timestamp = text(raw.timestamp);
    if (timestamp) updatedAt = timestamp;

    if (text(raw.recordType) === "metadata") {
      key = text(raw.key);
      const metadata = record(raw.metadata);
      projectId = text(metadata.webuiProjectId);
      title = text(metadata.title);
      workspacePath = nullableText(metadata.webuiWorkspaceCwd);
      const metaTime = text(raw.updatedAt);
      if (metaTime && !updatedAt) updatedAt = metaTime;
      continue;
    }

    const role = text(raw.role);
    if (role === "user") {
      if (current) turns.push(current);
      lastQuestion = text(raw.content);
      current = { question: lastQuestion, reply: "", steps: [], startedAt: timestamp };
      continue;
    }
    if (role === "assistant") {
      if (!current) current = { question: "", reply: "", steps: [], startedAt: timestamp };
      current.reply = current.reply ? `${current.reply}\n\n${text(raw.content)}` : text(raw.content);
      continue;
    }
    if (role === "tool" && current) {
      const name = text(raw.name);
      if (name) current.steps.push(name);
    }
  }
  if (current) turns.push(current);
  if (!turns.length && !title) return null;

  const conversationId = key.replace(/^websocket:/u, "") || path.split("/").pop()!.replace(/^websocket_/u, "").replace(/\.jsonl$/u, "");
  return {
    conversationId,
    projectId,
    title: title || lastQuestion,
    lastQuestion,
    workspacePath,
    updatedAt,
    turns
  };
}

function parseStoredLinks(content: string): StoredLinks | null {
  let raw: Record<string, unknown>;
  try {
    raw = record(JSON.parse(content));
  } catch {
    return null;
  }
  const projectId = text(raw.projectId);
  const accountId = text(raw.accountId);
  if (!projectId || !accountId) return null;
  const synced: StoredLinks["synced"] = {};
  for (const [key, value] of Object.entries(record(raw.synced))) {
    const entry = record(value);
    if (text(entry.cloudSessionId)) {
      synced[key] = {
        cloudSessionId: text(entry.cloudSessionId),
        updatedAt: text(entry.updatedAt),
        groupId: nullableText(entry.groupId),
        ...(nullableText(entry.title) === null ? {} : { title: text(entry.title) })
      };
    }
  }
  return {
    projectId,
    accountId,
    localProjectId: nullableText(raw.localProjectId),
    sharedSessions: list(raw.sharedSessions).filter((id): id is string => typeof id === "string"),
    removedSessions: list(raw.removedSessions).filter((id): id is string => typeof id === "string"),
    workingDirectory: nullableText(raw.workingDirectory),
    directoryChosen: raw.directoryChosen === true,
    groups: list(raw.groups).map(record).map((group) => ({
      sourceId: text(group.sourceId),
      groupId: text(group.groupId),
      excluded: list(group.excluded).filter((id): id is string => typeof id === "string")
    })).filter((group) => group.sourceId && group.groupId),
    sessions: list(raw.sessions).map(record).map((session) => ({
      sourceId: text(session.sourceId),
      conversationId: text(session.conversationId)
    })).filter((session) => session.sourceId && session.conversationId),
    synced
  };
}

/** True when the local session changed after the uploaded copy; an unknown time counts as changed. */
function isNewer(updatedAt: string, uploadedAt: string): boolean {
  const local = Date.parse(updatedAt);
  const uploaded = Date.parse(uploadedAt);
  return Number.isNaN(local) || Number.isNaN(uploaded) || local > uploaded;
}

/**
 * The directory an online project's tasks run in: the folder the person picked, or a managed empty folder so a
 * task always has a working directory. Either way it is created before the local project is registered.
 */
async function prepareWorkingDirectory(
  root: string,
  projectId: string,
  name: string,
  directory: string | undefined
): Promise<string> {
  // The folder name is what a task page and the project picker show, so it carries the project name and only
  // falls back to the id when the name is already taken by another project.
  const target = directory?.trim()
    ? directory.trim()
    : await uniqueProjectDirectory(root, name, projectId);
  return ensureDirectory(target);
}

function toApplication(raw: unknown): CollabApplication {
  const application = record(raw);
  return {
    projectId: text(application.projectId),
    projectName: text(application.projectName),
    createdAt: nullableText(application.createdAt)
  };
}

/** 只认「已通过 / 未通过」两种结果；云端还没升级时这里拿到的是空，不会被当成结果。 */
function toDecision(raw: unknown): CollabApplicationDecision | null {
  const decision = record(raw);
  const status = text(decision.status);
  if (status !== "approved" && status !== "rejected") return null;
  return {
    projectId: text(decision.projectId),
    projectName: text(decision.projectName),
    status,
    decidedAt: nullableText(decision.decidedAt)
  };
}

function toProject(raw: unknown): CollabProject {
  const project = record(raw);
  return {
    id: text(project.id),
    name: text(project.name),
    role: toRole(project.role),
    memberCount: number(project.memberCount),
    sessionCount: number(project.sessionCount),
    createdAt: nullableText(project.createdAt),
    // The cloud has no notion of this computer's project; listProjects fills it in from the local store.
    localProjectId: null,
    // A cloud from before instructions existed omits the field; the board then shows the empty state.
    instructions: text(project.instructions).trim()
  };
}

/** The cloud stores roles in upper case; everything on this side compares lower case. */
function toRole(raw: unknown): CollabRole {
  const role = text(raw).toLowerCase();
  return role === "owner" || role === "admin" ? role : "member";
}

/** Asking for approval is the default, so anything unrecognised reads as the safer mode. */
function toJoinMode(raw: unknown): CollabJoinMode {
  return text(raw).toLowerCase() === "direct" ? "direct" : "approval";
}

function toMember(raw: unknown): CollabMember {
  const member = record(raw);
  return {
    userId: text(member.userId),
    name: text(member.name),
    role: toRole(member.role),
    mine: member.mine === true,
    joinedAt: nullableText(member.joinedAt)
  };
}

function toKnowledge(raw: unknown): CollabKnowledgeView {
  const view = record(raw);
  return {
    canManage: view.canManage === true,
    maxBases: typeof view.maxBases === "number" ? view.maxBases : 10,
    bases: list(view.bases).map((value) => {
      const base = record(value);
      return { id: text(base.id), name: text(base.name), mine: base.mine === true };
    })
  };
}

function toJoinRequest(raw: unknown): CollabJoinRequest {
  const request = record(raw);
  return {
    userId: text(request.userId),
    name: text(request.name),
    inviterName: text(request.inviterName),
    createdAt: nullableText(request.createdAt)
  };
}

function toInvitePreview(raw: unknown): CollabInvitePreview {
  const invite = record(raw);
  const status = invite.status === "member" || invite.status === "pending" ? invite.status : "none";
  return {
    code: text(invite.code),
    projectId: text(invite.projectId),
    projectName: text(invite.projectName),
    inviterName: text(invite.inviterName),
    memberCount: number(invite.memberCount),
    memberNames: list(invite.memberNames).filter((name): name is string => typeof name === "string"),
    joinMode: toJoinMode(invite.joinMode),
    status
  };
}

function toLocalSession(raw: unknown): LocalAgentSession {
  const session = record(raw);
  return {
    sourceId: text(session.sourceId),
    agentName: text(session.agentName),
    conversationId: text(session.conversationId),
    title: text(session.title),
    lastQuestion: text(session.lastQuestion),
    workspacePath: nullableText(session.workspacePath),
    group: toGroup(session.group),
    updatedAt: text(session.updatedAt),
    turnCount: number(session.turnCount)
  };
}

function toGroup(raw: unknown): LocalSessionGroup | null {
  const group = record(raw);
  return text(group.id) ? { id: text(group.id), label: text(group.label) || text(group.id), path: nullableText(group.path) } : null;
}

function toTurn(raw: unknown): CollabSessionTurn {
  const turn = record(raw);
  return {
    question: text(turn.question),
    reply: text(turn.reply),
    steps: list(turn.steps).filter((step): step is string => typeof step === "string"),
    startedAt: text(turn.startedAt)
  };
}

function toUploadTurn(raw: unknown): CollabSessionTurn {
  const turn = toTurn(raw);
  return {
    question: clip(turn.question, MAX_QUESTION_CHARS),
    reply: clip(turn.reply, MAX_REPLY_CHARS),
    steps: turn.steps.slice(0, MAX_STEPS_PER_TURN),
    startedAt: turn.startedAt
  };
}

/** Collapses repeated tool names, e.g. Bash ×3、Edit. */
function summarizeSteps(steps: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step, (counts.get(step) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join("、");
}

/**
 * 云端错误码 → 本机错误码。只有界面需要单独解释的才列出来，其余按 HTTP 状态归类就够。
 * 例如在线项目数量达到上限时要先把项目建在本机并说明原因，不能当成服务故障去提示「稍后重试」。
 */
const LOCAL_CODE_BY_CLOUD_CODE: Readonly<Record<number, ApiErrorCode>> = Object.freeze({
  /** 云端 ErrorCode.COLLAB_QUOTA：每人可创建的在线项目数量达到上限。 */
  41004: "collab_quota_exceeded"
});

function errorCode(status: number): ApiErrorCode {
  if (status === 400 || status === 413) return "invalid_argument";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "memory_layer_unavailable" : "internal";
}

function formatTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return "未知";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 120) || "_";
}

function isoOrNull(value: unknown): string | null {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
