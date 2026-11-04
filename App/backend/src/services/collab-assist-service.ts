/**
 * 成员协助：执行方与发起方在本机的两侧。
 *
 * <p>云端只存请求、授权与结果（见 memmy-backend 的 {@code CollabAssistService}），这里负责真正要做的事：</p>
 *
 * <ul>
 *   <li><b>执行方</b>：每 5 秒查一次收件箱。要她授权的请求留给界面去问；已经有长期授权的直接开始执行；
 *       执行时通过 ACP 拉起她选的 Agent 新开会话，把每一步追加到云端，完成后回传结果。</li>
 *   <li><b>发起方</b>：发起请求、等结果。Memmy 发起的请求以卡片出现在任务里，结果回来后接着分析；
 *       外部 Agent 用 {@code memmy-project assist ask / wait / status / end}。</li>
 * </ul>
 *
 * <p>本机只留三样东西：总开关、每个请求用来续跑的 Agent 会话 id、正在执行的进度。请求正文与结果都在云端，
 * 换一台电脑照常能看到自己等待中的请求。</p>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { AssistStep } from "./assist/acp-client.js";
import { AcpError } from "./assist/acp-client.js";
import { assistAgentName } from "./assist/recipes.js";
import { assistPrompt, parseResultItems, replyWithoutItems } from "./assist/prompt.js";

/** 与 collab-service 同一套云端请求签名：路径前缀 `/api/collab`，带账号凭据。 */
export type CollabCloudRequest = (
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number }
) => Promise<Record<string, unknown>>;

/** 执行方可以选的一个 Agent：已关联到协作项目的，加上 Memmy 自己。 */
export interface AssistAgentCandidate {
  sourceId: string;
  name: string;
  /** 这台电脑上装没装、能不能跑；界面据此把不能用的标出来。 */
  available: boolean;
}

export type AssistStatus =
  | "pending" | "running" | "confirm" | "done" | "rejected"
  | "cancelled" | "expired" | "failed" | "stopped";

export interface AssistMember {
  userId: string;
  name: string;
  mine: boolean;
}

/** 一条协助请求，与云端返回的结构一致。 */
export interface AssistRequest {
  id: string;
  projectId: string;
  projectName: string;
  threadId: string;
  attempt: number;
  /** 发起方的 Agent 名称（如 Codex、Memmy）：弹窗里要说明是谁的 Agent 在请求。 */
  via: string;
  title: string;
  reason: string;
  items: string[];
  status: AssistStatus;
  agent: string | null;
  scope: "once" | "always" | null;
  steps: AssistStep[];
  reply: string;
  resultItems: Array<{ key: string; value: string }>;
  files: Array<{ name: string; size: string; content?: string }>;
  failure: string | null;
  requester: AssistMember;
  executor: AssistMember;
  mine: boolean;
  createdAt: string | null;
  decidedAt: string | null;
  finishedAt: string | null;
}

/** 收件箱里的一条：请求本身，加上「她是否已经长期授权」与今天已经执行了几次。 */
export interface AssistInboxItem extends AssistRequest {
  granted: boolean;
  grantAgent: string | null;
  usedToday: number;
}

export interface AssistGrant {
  projectId: string;
  projectName: string;
  grantee: AssistMember;
  agent: string;
  active: boolean;
  /** 今天这位成员已经请她执行了几次。 */
  usedToday: number;
  createdAt: string | null;
  revokedAt: string | null;
}

/** 协助记录的一行：设置页的「协助记录」用它。 */
export interface AssistRecord {
  id: string;
  title: string;
  memberName: string;
  status: AssistStatus;
  agent: string | null;
  files: number;
  createdAt: string | null;
  attempt: number;
  threadId: string;
}

/** 本机正在执行的一次协助：界面按它展示每一步，不必向云端轮询过程。 */
export interface AssistExecution {
  requestId: string;
  threadId: string;
  projectId: string;
  agent: string;
  status: "queued" | "running" | "done" | "failed";
  steps: AssistStep[];
  startedAt: string;
  finishedAt: string | null;
  failure: string | null;
}

export interface AssistSettings {
  /** 允许成员请这台电脑上的 Agent 执行任务。关掉后不再领取新请求。 */
  allowAssist: boolean;
  /** 一次只执行一个请求，其余排队：与产品内置的频率限制一致。 */
  running: number;
  queued: number;
}

/** 真正去执行的那一层：默认走 ACP，测试里可以替换。 */
export interface AssistRunner {
  run(input: {
    agent: string;
    cwd: string;
    prompt: string;
    sessionId?: string;
    signal: AbortSignal;
    onStep: (step: AssistStep) => void;
    onSession: (sessionId: string) => void;
  }): Promise<{ reply: string; steps: AssistStep[]; sessionId: string | null }>;
}

export interface CollabAssistServiceOptions {
  cloud: CollabCloudRequest;
  /** API Key 模式下没有云端账号：协助在这台机器上不可用。 */
  userMode?: () => string;
  /** 本机状态文件所在目录，默认 ~/.memmy。 */
  homeDirectory?: string;
  /** 项目在本机的工作目录：执行方的 Agent 在这里跑。 */
  projectDirectory: (projectId: string) => Promise<string | null>;
  /** 执行方可以选的 Agent：已关联到协作项目的 Agent，加上 Memmy。 */
  agents: (projectId: string) => Promise<AssistAgentCandidate[]>;
  runner: AssistRunner;
  now?: () => Date;
  /** 轮询间隔，默认 5 秒。 */
  pollIntervalMs?: number;
  /** 每一步向云端追加的最小间隔，默认 1.5 秒：步骤是给人看的摘要，不必逐字同步。 */
  progressIntervalMs?: number;
}

const DEFAULT_POLL_MS = 5_000;
const DEFAULT_PROGRESS_MS = 1_500;
/** 命令行等结果时默认等多久：一次请求最长 15 分钟，等它结束再多留一会儿。 */
const WAIT_TIMEOUT_MS = 16 * 60 * 1000;
const WAIT_POLL_MS = 2_000;

interface LocalState {
  allowAssist: boolean;
  /** 每个请求用来续跑的 Agent 会话 id：同一次排查的后续请求落在同一个会话里。 */
  sessions: Record<string, string>;
}

const EMPTY_STATE: LocalState = { allowAssist: true, sessions: {} };

export interface CollabAssistService {
  /** 发起一次协助请求（发起方）。 */
  createRequest(input: {
    project: string;
    member: string;
    title: string;
    reason?: string;
    items: string[];
    thread?: string;
    /** 发起方的 Agent 名称；不给时按 Memmy 计。 */
    via?: string;
  }): Promise<{ request: AssistRequest; threadId: string; text: string }>;
  /** 等结果，返回给命令行打印的一段文字。 */
  waitRequest(requestId: string, options?: { timeoutMs?: number }): Promise<{ request: AssistRequest; text: string }>;
  /** 一条请求的当前状态。 */
  requestStatus(requestId: string): Promise<AssistRequest>;
  /** 结束协助：结束本人对这个项目里的成员的长期授权。 */
  endAssist(input: { project: string; member?: string }): Promise<{ text: string }>;
  /** 撤回自己还没被执行的请求。 */
  cancelRequest(requestId: string): Promise<AssistRequest>;
  /** 执行方：等待授权或确认的请求。 */
  inbox(): Promise<{ requests: AssistInboxItem[]; dailyLimit: number }>;
  /** 执行方：允许或拒绝。 */
  decide(input: { requestId: string; action: "allow" | "reject"; agent?: string; scope?: "once" | "always" }): Promise<AssistRequest>;
  /** 执行方：停止当前执行。 */
  stop(requestId: string): Promise<AssistRequest>;
  /** 执行方补充一句说明：作为一条进展发给发起方。 */
  addNote(requestId: string, note: string): Promise<void>;
  /** 执行方：在项目里执行过、正在执行与排队中的请求。 */
  executions(): AssistExecution[];
  /** 执行方：长期授权清单。 */
  grants(projectId: string): Promise<{ grants: AssistGrant[]; dailyLimit: number }>;
  revokeGrant(input: { projectId: string; grantee: string }): Promise<{ grants: AssistGrant[]; dailyLimit: number }>;
  setGrantAgent(input: { projectId: string; grantee: string; agent: string }): Promise<{ grants: AssistGrant[]; dailyLimit: number }>;
  /** 协助记录，保留 30 天。 */
  records(projectId: string): Promise<{ records: AssistRecord[]; retentionDays: number }>;
  settings(): AssistSettings;
  setAllowAssist(allow: boolean): Promise<AssistSettings>;
  /** 执行方可以选的 Agent。 */
  agents(projectId: string): Promise<AssistAgentCandidate[]>;
  /** 开始后台轮询；返回停止函数。 */
  start(): () => void;
  /** 立即轮询一次（界面刚授权后不必等下一个周期）。 */
  pollNow(): Promise<void>;
}

export class AssistError extends Error {
  constructor(readonly code: "unauthorized" | "not_found" | "invalid_argument" | "conflict" | "forbidden" | "internal", message: string) {
    super(message);
    this.name = "AssistError";
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list<T>(value: unknown, read: (item: Record<string, unknown>) => T): T[] {
  return Array.isArray(value) ? value.map((item) => read(record(item))) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function member(value: unknown): AssistMember {
  const raw = record(value);
  return { userId: text(raw.userId), name: text(raw.name), mine: raw.mine === true };
}

/** 云端返回的一条请求，转成本机的视图。 */
export function toAssistRequest(value: unknown): AssistRequest {
  const raw = record(value);
  return {
    id: text(raw.id),
    projectId: text(raw.projectId),
    projectName: text(raw.projectName),
    threadId: text(raw.threadId),
    attempt: typeof raw.attempt === "number" ? raw.attempt : 1,
    via: text(raw.via) || "Memmy",
    title: text(raw.title),
    reason: text(raw.reason),
    items: Array.isArray(raw.items) ? raw.items.map((item) => text(item)) : [],
    status: (text(raw.status) || "pending") as AssistStatus,
    agent: typeof raw.agent === "string" ? raw.agent : null,
    scope: raw.scope === "always" ? "always" : raw.scope === "once" ? "once" : null,
    steps: list(raw.steps, (step) => ({ text: text(step.text), ...(text(step.output) ? { output: text(step.output) } : {}) })),
    reply: text(raw.reply),
    resultItems: list(raw.resultItems, (item) => ({ key: text(item.key), value: text(item.value) })),
    files: list(raw.files, (file) => ({
      name: text(file.name),
      size: text(file.size),
      ...(typeof file.content === "string" ? { content: file.content } : {})
    })),
    failure: typeof raw.failure === "string" && raw.failure ? raw.failure : null,
    requester: member(raw.requester),
    executor: member(raw.executor),
    mine: raw.mine === true,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : null,
    finishedAt: typeof raw.finishedAt === "string" ? raw.finishedAt : null
  };
}

export function createCollabAssistService(options: CollabAssistServiceOptions): CollabAssistService {
  const now = options.now ?? (() => new Date());
  const home = options.homeDirectory ?? join(homedir(), ".memmy");
  const statePath = join(home, "collab-assist.json");
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const progressMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_MS;

  let state: LocalState | null = null;
  const executions = new Map<string, AssistExecution>();
  const running = new Map<string, AbortController>();
  const queue: string[] = [];
  let active: string | null = null;
  let polling = false;

  function requireAccount(): void {
    if (options.userMode?.() === "byok") {
      throw new AssistError("forbidden", "成员协助需要登录 Memmy 账号；当前是 API Key 模式。");
    }
  }

  async function loadState(): Promise<LocalState> {
    if (state) return state;
    try {
      const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<LocalState>;
      state = {
        allowAssist: parsed.allowAssist !== false,
        sessions: parsed.sessions && typeof parsed.sessions === "object" ? { ...parsed.sessions } : {}
      };
    } catch {
      state = { ...EMPTY_STATE, sessions: {} };
    }
    return state;
  }

  /** 写回本机状态：只写这三样，失败不影响正在执行的请求。 */
  async function saveState(next: LocalState): Promise<void> {
    state = next;
    try {
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    } catch {
      // 写不进去只影响下次续跑会用新会话，不影响这一轮。
    }
  }

  async function cloud(path: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<Record<string, unknown>> {
    requireAccount();
    return options.cloud(path, init);
  }

  /** 项目名或 id 换成云端 id：命令行用名字，界面用 id。 */
  async function projectIdOf(project: string): Promise<string> {
    if (/^[A-Za-z0-9-]{8,36}$/u.test(project)) return project;
    const data = await cloud("/projects");
    const projects = list(data.projects, (item) => ({ id: text(item.id), name: text(item.name) }));
    const matches = projects.filter((item) => item.name === project);
    if (!matches.length) throw new AssistError("not_found", `没有项目「${project}」，或你不是项目成员`);
    if (matches.length > 1) throw new AssistError("conflict", `有 ${matches.length} 个同名项目，请改用项目 id 指定`);
    return matches[0]!.id;
  }

  async function createRequest(input: {
    project: string;
    member: string;
    title: string;
    reason?: string;
    items: string[];
    thread?: string;
    via?: string;
  }): Promise<{ request: AssistRequest; threadId: string; text: string }> {
    const projectId = await projectIdOf(input.project);
    const data = await cloud(`/projects/${encodeURIComponent(projectId)}/assist/requests`, {
      method: "POST",
      body: {
        member: input.member,
        title: input.title,
        ...(input.reason ? { reason: input.reason } : {}),
        items: input.items,
        ...(input.thread ? { thread: input.thread } : {}),
        ...(input.via ? { via: input.via } : {})
      }
    });
    const request = toAssistRequest(data);
    return {
      request,
      threadId: request.threadId,
      text: `已发送协助请求 ${shortId(request.id)}。等待 ${request.executor.name} 选择执行的 Agent 并授权；用 memmy-project assist wait ${shortId(request.id)} 取结果。`
    };
  }

  async function readRequest(requestId: string): Promise<AssistRequest> {
    const data = await cloud(`/assist/requests/${encodeURIComponent(requestId)}`);
    return toAssistRequest(data.request);
  }

  /** 等结果：轮询到终态为止，超时就把当前状态告诉调用方，不假装完成。 */
  async function waitRequest(requestId: string, wait: { timeoutMs?: number } = {}): Promise<{ request: AssistRequest; text: string }> {
    const deadline = Date.now() + (wait.timeoutMs ?? WAIT_TIMEOUT_MS);
    for (;;) {
      const request = await readRequest(requestId);
      if (request.status !== "pending" && request.status !== "running" && request.status !== "confirm") {
        return { request, text: resultText(request) };
      }
      if (Date.now() >= deadline) {
        return { request, text: `还没结束：${statusText(request)}。之后可以用 memmy-project assist status ${shortId(request.id)} 再查。` };
      }
      await sleep(WAIT_POLL_MS);
    }
  }

  async function requestStatus(requestId: string): Promise<AssistRequest> {
    return readRequest(requestId);
  }

  async function endAssist(input: { project: string; member?: string }): Promise<{ text: string }> {
    const projectId = await projectIdOf(input.project);
    const data = await cloud(`/projects/${encodeURIComponent(projectId)}/assist/grants`);
    const grants = list(data.grants, (item) => ({
      grantee: member(item.grantee),
      agent: text(item.agent),
      active: item.active === true
    })).filter((grant) => grant.active);
    const targets = input.member
      ? grants.filter((grant) => grant.grantee.name === input.member || grant.grantee.userId === input.member)
      : grants;
    if (!targets.length) {
      return { text: input.member ? `没有对「${input.member}」生效中的协助授权。` : "这个项目里没有生效中的协助授权。" };
    }
    for (const grant of targets) {
      await cloud(`/projects/${encodeURIComponent(projectId)}/assist/grants/${encodeURIComponent(grant.grantee.userId)}`, { method: "DELETE" });
    }
    const names = targets.map((grant) => grant.grantee.name).join("、");
    return { text: `已结束对 ${names} 的协助授权；之后的请求会重新询问你。` };
  }

  async function cancelRequest(requestId: string): Promise<AssistRequest> {
    const request = await readRequest(requestId);
    const data = await cloud(`/projects/${encodeURIComponent(request.projectId)}/assist/requests/${encodeURIComponent(requestId)}/cancel`, { method: "POST" });
    return toAssistRequest(data.request);
  }

  async function inbox(): Promise<{ requests: AssistInboxItem[]; dailyLimit: number }> {
    if (!(await loadState()).allowAssist) return { requests: [], dailyLimit: 20 };
    const data = await cloud("/assist/inbox");
    return {
      requests: list(data.requests, (item) => ({
        ...toAssistRequest(item),
        granted: item.granted === true,
        grantAgent: typeof item.grantAgent === "string" ? item.grantAgent : null,
        usedToday: typeof item.usedToday === "number" ? item.usedToday : 0
      })),
      dailyLimit: typeof data.dailyLimit === "number" ? data.dailyLimit : 20
    };
  }

  async function decide(input: { requestId: string; action: "allow" | "reject"; agent?: string; scope?: "once" | "always" }): Promise<AssistRequest> {
    const request = await readRequest(input.requestId);
    const data = await cloud(`/projects/${encodeURIComponent(request.projectId)}/assist/requests/${encodeURIComponent(input.requestId)}/decision`, {
      method: "POST",
      body: {
        action: input.action,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.scope ? { scope: input.scope } : {})
      }
    });
    // 云端正常会回带这条请求；万一没带，就用刚读到的那份加上这次的决定，别让执行因为空字段跑不起来。
    const decided = data.request
      ? toAssistRequest(data.request)
      : { ...request, status: "running" as AssistStatus, agent: input.agent ?? request.agent, scope: input.scope ?? request.scope };
    // 允许之后立刻开跑：界面点完「允许」就看到执行过程，不必等下一个轮询周期。
    if (input.action === "allow") void startExecution(decided);
    return decided;
  }

  async function stop(requestId: string): Promise<AssistRequest> {
    running.get(requestId)?.abort();
    const request = await readRequest(requestId);
    const data = await cloud(`/projects/${encodeURIComponent(request.projectId)}/assist/requests/${encodeURIComponent(requestId)}/stop`, { method: "POST" });
    return toAssistRequest(data.request);
  }

  /**
   * 执行方在任务页里补充一句说明：追加成一条进展，发起方按同一顺序看到。
   * 正在执行时也发，不必等这一轮结束。
   */
  async function addNote(requestId: string, note: string): Promise<void> {
    const trimmed = note.trim();
    if (!trimmed) return;
    const request = await readRequest(requestId);
    const execution = executions.get(requestId);
    const steps = [...(execution?.steps ?? request.steps), { text: `你补充的说明：${trimmed}` }];
    if (execution) execution.steps = steps;
    await cloud(`/projects/${encodeURIComponent(request.projectId)}/assist/requests/${encodeURIComponent(requestId)}/progress`, {
      method: "POST",
      body: { steps }
    });
  }

  function executionsList(): AssistExecution[] {
    return [...executions.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async function grants(projectId: string): Promise<{ grants: AssistGrant[]; dailyLimit: number }> {
    const data = await cloud(`/projects/${encodeURIComponent(projectId)}/assist/grants`);
    return {
      grants: list(data.grants, (item) => ({
        projectId: text(item.projectId),
        projectName: text(item.projectName),
        grantee: member(item.grantee),
        agent: text(item.agent),
        active: item.active === true,
        usedToday: typeof item.usedToday === "number" ? item.usedToday : 0,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
        revokedAt: typeof item.revokedAt === "string" ? item.revokedAt : null
      })),
      dailyLimit: typeof data.dailyLimit === "number" ? data.dailyLimit : 20
    };
  }

  async function revokeGrant(input: { projectId: string; grantee: string }): Promise<{ grants: AssistGrant[]; dailyLimit: number }> {
    await cloud(`/projects/${encodeURIComponent(input.projectId)}/assist/grants/${encodeURIComponent(input.grantee)}`, { method: "DELETE" });
    return grants(input.projectId);
  }

  async function setGrantAgent(input: { projectId: string; grantee: string; agent: string }): Promise<{ grants: AssistGrant[]; dailyLimit: number }> {
    await cloud(`/projects/${encodeURIComponent(input.projectId)}/assist/grants/${encodeURIComponent(input.grantee)}`, {
      method: "PATCH",
      body: { agent: input.agent }
    });
    return grants(input.projectId);
  }

  async function records(projectId: string): Promise<{ records: AssistRecord[]; retentionDays: number }> {
    const data = await cloud(`/projects/${encodeURIComponent(projectId)}/assist/records`);
    return {
      records: list(data.records, (item) => ({
        id: text(item.id),
        title: text(item.title),
        memberName: text(item.memberName),
        status: (text(item.status) || "done") as AssistStatus,
        agent: typeof item.agent === "string" ? item.agent : null,
        files: typeof item.files === "number" ? item.files : 0,
        createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
        attempt: typeof item.attempt === "number" ? item.attempt : 1,
        threadId: text(item.threadId)
      })),
      retentionDays: typeof data.retentionDays === "number" ? data.retentionDays : 30
    };
  }

  function settings(): AssistSettings {
    return {
      allowAssist: state?.allowAssist !== false,
      running: running.size,
      queued: queue.length
    };
  }

  async function setAllowAssist(allow: boolean): Promise<AssistSettings> {
    const current = await loadState();
    await saveState({ ...current, allowAssist: allow });
    return settings();
  }

  async function agents(projectId: string): Promise<AssistAgentCandidate[]> {
    return options.agents(projectId);
  }

  /**
   * 执行方开始跑一条已经允许的请求：一次只跑一个，其余排队。
   * 同一请求重复调用只跑一次。
   */
  async function startExecution(request: AssistRequest): Promise<void> {
    if (request.status !== "running") return;
    if (running.has(request.id) || queue.includes(request.id)) return;
    if (!(await loadState()).allowAssist) return;
    executions.set(request.id, {
      requestId: request.id,
      threadId: request.threadId,
      projectId: request.projectId,
      agent: request.agent ?? "",
      status: "queued",
      steps: [],
      startedAt: now().toISOString(),
      finishedAt: null,
      failure: null
    });
    queue.push(request.id);
    void drain();
  }

  /** 队列一次只跑一个：同一时间只执行一个请求，其余排在后面。 */
  async function drain(): Promise<void> {
    if (active) return;
    const next = queue.shift();
    if (!next) return;
    active = next;
    try {
      await execute(next);
    } catch {
      // execute 自己会把失败写回云端；这里只保证队列继续。
    } finally {
      active = null;
      void drain();
    }
  }

  async function execute(requestId: string): Promise<void> {
    const state_ = await loadState();
    const execution = executions.get(requestId);
    if (!execution) return;
    const request = await readRequest(requestId).catch(() => null);
    if (!request || request.status !== "running") {
      executions.delete(requestId);
      return;
    }
    const agent = request.agent ?? execution.agent;
    execution.agent = agent;
    execution.status = "running";
    running.set(requestId, new AbortController());
    const controller = running.get(requestId)!;

    const cwd = await options.projectDirectory(request.projectId)
      .catch(() => null)
      ?? home;

    let lastPush = 0;
    const pushProgress = async (force = false) => {
      const at = Date.now();
      if (!force && at - lastPush < progressMs) return;
      lastPush = at;
      await cloud(`/projects/${encodeURIComponent(request.projectId)}/assist/requests/${encodeURIComponent(requestId)}/progress`, {
        method: "POST",
        body: { steps: execution.steps }
      }).catch(() => undefined);
    };

    try {
      const result = await options.runner.run({
        agent,
        cwd,
        prompt: assistPrompt({
          requesterName: request.requester.name,
          projectName: request.projectName,
          title: request.title,
          ...(request.reason ? { reason: request.reason } : {}),
          items: request.items
        }),
        ...(state_.sessions[requestId] ? { sessionId: state_.sessions[requestId]! } : {}),
        signal: controller.signal,
        onStep: (step) => {
          execution.steps.push(step);
          void pushProgress();
        },
        onSession: (sessionId) => {
          void saveState({ ...state_, sessions: { ...state_.sessions, [requestId]: sessionId } });
        }
      });
      execution.steps = result.steps.length ? result.steps : execution.steps;
      await pushProgress(true);
      const items = parseResultItems(result.reply);
      await finish(request, {
        status: "done",
        reply: replyWithoutItems(result.reply) || result.reply,
        items,
        failure: null
      });
      execution.status = "done";
    } catch (error) {
      const failure = error instanceof AcpError ? error.message
        : `执行没有完成：${error instanceof Error ? error.message : String(error)}`;
      const stopped = error instanceof AcpError && error.kind === "cancelled";
      execution.status = "failed";
      execution.failure = failure;
      // 停止由云端那一步写成 STOPPED；其余失败在这里回传原因，双方都能看到。
      await finish(request, { status: stopped ? null : "failed", reply: "", items: [], failure }).catch(() => undefined);
    } finally {
      execution.finishedAt = now().toISOString();
      running.delete(requestId);
      await pushProgress(true).catch(() => undefined);
    }
  }

  /** 回传结果：失败时至少要有一句原因，否则发起方只看到「already handled」。 */
  async function finish(
    request: AssistRequest,
    result: { status: "done" | "failed" | null; reply: string; items: Array<{ key: string; value: string }>; failure: string | null }
  ): Promise<void> {
    if (!result.status) return;
    await cloud(`/projects/${encodeURIComponent(request.projectId)}/assist/requests/${encodeURIComponent(request.id)}/result`, {
      method: "POST",
      body: {
        status: result.status === "done" ? "DONE" : "FAILED",
        ...(result.reply ? { reply: result.reply } : {}),
        ...(result.items.length ? { items: result.items } : {}),
        ...(result.failure ? { failure: result.failure } : {})
      }
    });
  }

  /**
   * 一轮轮询：收件箱里已有长期授权的直接开始执行；要她授权的留给界面。
   * 失败只记日志，不让定时器挂掉。
   */
  async function poll(): Promise<void> {
    if (polling) return;
    if (!(await loadState()).allowAssist) return;
    if (options.userMode?.() === "byok") return;
    polling = true;
    try {
      const { requests } = await inbox();
      for (const request of requests) {
        // 长期授权在：不必再问她，直接由她当时选定的 Agent 执行。
        if (request.status === "pending" && request.granted && request.grantAgent) {
          await decide({ requestId: request.id, action: "allow", agent: request.grantAgent, scope: "always" });
          continue;
        }
        if (request.status === "running") await startExecution(request);
      }
    } catch {
      // 网络或登录态问题：下一个周期再试。
    } finally {
      polling = false;
    }
  }

  function start(): () => void {
    const timer = setInterval(() => void poll(), pollMs);
    timer.unref?.();
    void poll();
    return () => clearInterval(timer);
  }

  return {
    createRequest,
    waitRequest,
    requestStatus,
    endAssist,
    cancelRequest,
    inbox,
    decide,
    stop,
    addNote,
    executions: executionsList,
    grants,
    revokeGrant,
    setGrantAgent,
    records,
    settings,
    setAllowAssist,
    agents,
    start,
    pollNow: async () => {
      await poll();
    }
  };
}

/** 请求 id 在命令行里显示前 6 位：够短，也够区分。 */
export function shortId(id: string): string {
  return id.replace(/-/gu, "").slice(0, 6).toUpperCase();
}

/** 一条已经结束的请求，打印成命令行读得懂的一段话。 */
export function resultText(request: AssistRequest): string {
  const name = request.agent ? assistAgentName(request.agent) : "执行方";
  if (request.status === "done") {
    const lines = [`已完成：由${request.executor.name}的 ${name} 执行。`, "── 结果 ──", request.reply];
    for (const item of request.resultItems) lines.push(`${item.key}：${item.value}`);
    for (const file of request.files) lines.push(`文件：${file.name}（${file.size}）`);
    return lines.filter(Boolean).join("\n");
  }
  if (request.status === "rejected") return `${request.executor.name}没有允许这次请求。`;
  if (request.status === "cancelled") return "这次请求已撤回。";
  if (request.status === "expired") return "这次请求已过期：对方 24 小时内没有处理。";
  if (request.status === "stopped") return request.failure || `${request.executor.name}停止了这次执行。`;
  if (request.status === "failed") return `执行没有完成：${request.failure || "原因不明"}`;
  return statusText(request);
}

/** 还没结束时的一句话：命令行等结果时用它。 */
export function statusText(request: AssistRequest): string {
  const name = request.agent ? assistAgentName(request.agent) : "Agent";
  switch (request.status) {
    case "pending":
      return `等待${request.executor.name}选择执行的 Agent 并授权`;
    case "confirm":
      return `等待${request.executor.name}确认这次请求`;
    case "running":
      return `${request.executor.name}的 ${name} 正在执行`;
    default:
      return resultText(request);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}