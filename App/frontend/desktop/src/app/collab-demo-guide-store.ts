/**
 * 项目协作新手引导（小饭团演示）的内存状态。
 *
 * 只在「刚创建完一个演示项目」时开始，进度不落盘：重新打开 Memmy 后项目就是普通项目。
 * 引导的一切都认云端：项目视图里的 `demo.active` 为真才开始，心跳或请求说演示已结束就立即收场。
 * 这里也负责两件云端的事：演示期间每 30 秒一次心跳（步骤变化时立即补一次），以及结束时叫云端把小饭团移出项目。
 */
import type { CollabClient } from "../api/collab-client.js";

/** 引导的每个子状态。四个大步骤各自有若干子状态，卡片上的「1 / 4」由 {@link demoGuideStepNumberOf} 给出。 */
export type DemoGuidePhase =
  // 建项目之前：新建弹窗刚打开，还没有云端项目，蒙版只亮「创建项目」。
  | "create-project"
  // 演示刚开始：先弹一个「{name}加入了项目」的提示窗，点「开始体验」才进第一步的蒙版。
  | "joined"
  | "task-row"
  | "reader"
  | "compose"
  | "reply-waiting"
  | "reply-done"
  | "associate"
  | "ask-compose"
  | "ask-waiting"
  | "ask-done"
  | "settings-open"
  | "settings-assist"
  | "help-waiting"
  | "help-dialog"
  | "help-running"
  | "help-done"
  | "help-rejected"
  | "complete";

/** 引导的对外状态：进行中、完成弹窗、已结束。 */
export type DemoGuideStatus = "active" | "complete" | "ended";

export interface DemoGuideState {
  status: DemoGuideStatus;
  phase: DemoGuidePhase;
  /** 云端项目 id。 */
  projectId: string | null;
  /** 本机项目 id：看板与邀请弹窗都按它找项目。 */
  localProjectId: string | null;
  /** 演示成员，全部来自云端的 `demo` 字段，不写死任何账号或昵称。 */
  memberUserId: string | null;
  memberName: string;
  /** 某一步出错时的原因（已本地化），卡片据此显示「这一步没有完成」。 */
  error: string | null;
  /** 用户实际走过的步骤：完成弹窗只列这些。 */
  done: { task: boolean; associate: boolean; ask: boolean; help: boolean };
  /** 四步里跳过过哪几步，用来判断「都跳过」。 */
  skipped: { task: boolean; associate: boolean; ask: boolean; help: boolean };
  /** 第二步的请求是否已经有结果回到了对话。 */
  askDelivered: boolean;
  /** 输入框要预填的那句话；`nonce` 变一次填一次，填过的再读不会重复填。 */
  prefill: { text: string; nonce: number } | null;
  /** 结束引导时的原因，云端按它记。 */
  endReason: DemoGuideEndReason | null;
  /** 演示是被云端判定结束的（心跳时返回 `demo: null`）：界面提示一次「体验已结束」。 */
  cloudEnded: boolean;
}

export type DemoGuideEndReason = "finished" | "exited" | "skipped" | "left";

export interface DemoGuideStart {
  projectId: string;
  localProjectId: string | null;
  memberUserId: string;
  memberName: string;
  client: CollabClient;
}

export type DemoGuideEvent =
  | { type: "start"; input: Omit<DemoGuideStart, "client"> }
  /** 从大卡点「新建项目」进来：先只在新建弹窗上亮「创建项目」，还没有云端项目。 */
  | { type: "start-before-project" }
  /** 「{name}加入了项目」那个提示窗点了「开始体验」：才开始第一步。 */
  | { type: "joined-confirmed" }
  | { type: "task-opened" }
  | { type: "task-continued"; prefill?: string }
  | { type: "composer-sent" }
  | { type: "agent-settled" }
  | { type: "assist-delivered" }
  | { type: "next"; prefill?: string }
  | { type: "skip"; prefill?: string }
  | { type: "settings-opened" }
  | { type: "receiving-on" }
  | { type: "help-request-seen" }
  | { type: "help-decided"; allow: boolean }
  | { type: "help-finished" }
  | { type: "fail"; reason: string }
  | { type: "retry" }
  | { type: "cloud-ended" }
  | { type: "end"; reason: DemoGuideEndReason }
  | { type: "close-complete" };

const IDLE: DemoGuideState = {
  status: "ended",
  phase: "complete",
  projectId: null,
  localProjectId: null,
  memberUserId: null,
  memberName: "",
  error: null,
  done: { task: false, associate: false, ask: false, help: false },
  skipped: { task: false, associate: false, ask: false, help: false },
  askDelivered: false,
  prefill: null,
  endReason: null,
  cloudEnded: false
};

/** 一个子状态属于第几步：进度条与「1 / 4」按它算。 */
export function demoGuideStepNumberOf(phase: DemoGuidePhase): 1 | 2 | 3 | 4 {
  // 建项目之前的阶段还没有进度可讲：卡片上不出现进度条与「第几步」。
  if (phase === "create-project") return 1;
  // 加入提示窗还不是一步：它上面没有卡片，点完才进第一步。
  if (phase === "joined") return 1;
  if (phase === "task-row" || phase === "reader" || phase === "compose" || phase === "reply-waiting" || phase === "reply-done") {
    return 1;
  }
  if (phase === "associate") return 2;
  if (phase === "ask-compose" || phase === "ask-waiting" || phase === "ask-done") return 3;
  return 4;
}

/**
 * 心跳上报的步骤：云端只接受 `1`、`2`、`3` 与 `finish`，四步要压到这三个值上——
 * 前两步算 1，第三步算 2，第四步算 3。
 */
export function demoGuideHeartbeatStep(phase: DemoGuidePhase): "1" | "2" | "3" | "finish" {
  if (phase === "complete") return "finish";
  const step = demoGuideStepNumberOf(phase);
  if (step >= 4) return "3";
  if (step === 3) return "2";
  return "1";
}

/**
 * 第二步发送时要不要把执行提示一起交给 Agent：只有引导正等这一步的发送、并且输入框里还是引导写好的那句话
 * （用户没改过）时才算。改过就不追加，用户自己说的话原样发出去。
 */
export function demoGuideSendsAssistHint(input: {
  status: DemoGuideStatus;
  phase: DemoGuidePhase;
  typed: string;
  sentence: string;
}): boolean {
  if (input.status !== "active" || input.phase !== "ask-compose") return false;
  const sentence = input.sentence.trim();
  return sentence.length > 0 && input.typed.trim() === sentence;
}

/** 引导的纯状态机：所有推进条件都在这里，界面只负责发事件与画卡片。 */
export function demoGuideReducer(state: DemoGuideState, event: DemoGuideEvent): DemoGuideState {
  switch (event.type) {
    case "start-before-project":
      return {
        ...IDLE,
        status: "active",
        phase: "create-project"
      };
    case "start":
      return {
        ...IDLE,
        status: "active",
        // 先弹「加入了项目」那个提示窗：点「开始体验」才亮第一步的蒙版。
        phase: "joined",
        projectId: event.input.projectId,
        localProjectId: event.input.localProjectId,
        memberUserId: event.input.memberUserId,
        memberName: event.input.memberName
      };
    case "joined-confirmed":
      return state.status === "active" && state.phase === "joined" ? { ...state, phase: "task-row" } : state;
    case "task-opened":
      return state.status === "active" && state.phase === "task-row" ? { ...state, phase: "reader" } : state;
    case "task-continued":
      return state.status === "active" && state.phase === "reader"
        ? { ...state, phase: "compose", prefill: nextPrefill(state, event.prefill) }
        : state;
    case "composer-sent":
      if (state.status !== "active") return state;
      if (state.phase === "compose") return { ...state, phase: "reply-waiting" };
      if (state.phase === "ask-compose") return { ...state, phase: "ask-waiting", askDelivered: false };
      return state;
    case "assist-delivered":
      // 结果回来了就是这一步成了：之前那句「没有完成」随之收起。
      return state.status === "active" && state.phase === "ask-waiting"
        ? { ...state, askDelivered: true, error: null }
        : state;
    case "agent-settled":
      if (state.status !== "active") return state;
      // 第二步的结果回来之后 Agent 还要再回一句：那时才给「下一步」。
      if (state.phase === "reply-waiting") {
        return { ...state, phase: "reply-done", done: { ...state.done, task: true } };
      }
      if (state.phase === "ask-waiting" && state.askDelivered) {
        return { ...state, phase: "ask-done", done: { ...state.done, ask: true } };
      }
      return state;
    case "next":
      if (state.status !== "active") return state;
      // 第一步做完：下一站是看板上的「关联任务」，它的按钮由人自己点（见 collab-page）。
      // 预填留着不动：换一句时 nonce 要接着往上走，输入框才知道该重新填一次。
      if (state.phase === "reply-done") return { ...state, phase: "associate", error: null };
      if (state.phase === "associate") {
        // 这一步的按钮由人自己点（看板上的「关联任务」），点过就算走过。
        return {
          ...state,
          phase: "ask-compose",
          prefill: nextPrefill(state, event.prefill),
          error: null,
          done: { ...state.done, associate: true }
        };
      }
      if (state.phase === "ask-done") return { ...state, phase: "settings-open", error: null };
      if (state.phase === "help-done" || state.phase === "help-rejected") {
        return finishOrSkip(state, { help: state.phase === "help-done" });
      }
      return state;
    case "skip": {
      if (state.status !== "active") return state;
      // 建项目之前没有可跳过的步骤：不建项目就没有后面的演示；加入提示窗也不是一步。
      if (state.phase === "create-project" || state.phase === "joined") return state;
      const step = demoGuideStepNumberOf(state.phase);
      if (step === 1) {
        return {
          ...state,
          phase: "associate",
          error: null,
          done: { ...state.done, task: false },
          skipped: { ...state.skipped, task: true }
        };
      }
      if (step === 2) {
        return {
          ...state,
          phase: "ask-compose",
          prefill: nextPrefill(state, event.prefill),
          error: null,
          done: { ...state.done, associate: false },
          skipped: { ...state.skipped, associate: true }
        };
      }
      if (step === 3) {
        return {
          ...state,
          phase: "settings-open",
          prefill: null,
          error: null,
          done: { ...state.done, ask: false },
          skipped: { ...state.skipped, ask: true }
        };
      }
      // 第四步跳过：授权弹窗那一步跳过等同于拒绝，其余直接收场。
      return finishOrSkip(state, { help: false });
    }
    case "settings-opened":
      return state.status === "active" && state.phase === "settings-open" ? { ...state, phase: "settings-assist" } : state;
    case "receiving-on":
      return state.status === "active" && (state.phase === "settings-assist" || state.phase === "settings-open")
        ? { ...state, phase: "help-waiting", error: null }
        : state;
    case "help-request-seen":
      return state.status === "active" && state.phase === "help-waiting" ? { ...state, phase: "help-dialog" } : state;
    case "help-decided":
      if (state.status !== "active" || state.phase !== "help-dialog") return state;
      return event.allow
        ? { ...state, phase: "help-running", error: null }
        : { ...state, phase: "help-rejected", error: null };
    case "help-finished":
      return state.status === "active" && state.phase === "help-running"
        ? { ...state, phase: "help-done", error: null, done: { ...state.done, help: true } }
        : state;
    case "fail":
      // 同一个原因已经说过就不再重复：轮询每拍都会读到同一个失败结果。
      return state.status === "active" && state.error !== event.reason ? { ...state, error: event.reason } : state;
    case "retry":
      return state.status === "active" && state.error !== null ? { ...state, error: null } : state;
    case "cloud-ended":
      return { ...state, status: "ended", phase: "complete", endReason: "left", prefill: null, cloudEnded: true };
    case "end":
      return { ...state, status: "ended", phase: "complete", endReason: event.reason, prefill: null, error: null };
    case "close-complete":
      return state.status === "complete" ? { ...state, status: "ended", phase: "complete", prefill: null } : state;
    default:
      return state;
  }
}

/** 第四步之后：有点〔完成〕的就是收尾弹窗；四步全都跳过时直接结束，不出现完成弹窗。 */
function finishOrSkip(state: DemoGuideState, done: { help: boolean }): DemoGuideState {
  const next: DemoGuideState = {
    ...state,
    done: { ...state.done, help: done.help && state.done.help ? true : done.help },
    skipped: { ...state.skipped, help: state.skipped.help || !done.help }
  };
  const allSkipped = next.skipped.task && next.skipped.associate && next.skipped.ask && next.skipped.help;
  if (allSkipped) return { ...next, status: "ended", phase: "complete", endReason: "skipped", prefill: null };
  return { ...next, status: "complete", phase: "complete", endReason: "finished", prefill: null, error: null };
}

/**
 * 预填文案由界面按当前语言给出（`{name}` 是演示成员的昵称），这里只负责换一个 nonce：
 * 同一个 nonce 不重复填，用户改过的内容不会被再覆盖一次。
 */
function nextPrefill(state: DemoGuideState, text: string | undefined): DemoGuideState["prefill"] {
  if (!text) return null;
  return { text, nonce: (state.prefill?.nonce ?? 0) + 1 };
}

// ---------------------------------------------------------------------------------------------
// 单例与副作用：心跳、结束演示、给界面的订阅。
// ---------------------------------------------------------------------------------------------

/** 演示期间心跳的间隔：云端按 120 秒没心跳算结束，30 秒一次留足余量。 */
export const DEMO_GUIDE_HEARTBEAT_MS = 30_000;

let state: DemoGuideState = IDLE;
const listeners = new Set<() => void>();
let client: CollabClient | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
/** 已经叫过云端结束的项目：多次结束只发一次请求，幂等也省得重复打扰。 */
const endedProjects = new Set<string>();

export function getDemoGuideState(): DemoGuideState {
  return state;
}

export function subscribeDemoGuide(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 演示是否正压在这个项目上：看板据此压住授权询问与就地提示。 */
export function isDemoGuideActiveFor(projectId: string | null | undefined): boolean {
  if (!projectId || state.status !== "active") return false;
  return state.localProjectId === projectId || state.projectId === projectId;
}

/** 引导停在新建弹窗上：还没有云端项目，只有「创建项目」可点。 */
export function isDemoGuideBeforeProject(): boolean {
  return state.status === "active" && state.phase === "create-project";
}

/** 全局是否在演示中：其他大卡与提示据此不出现。 */
export function isDemoGuideActive(): boolean {
  return state.status === "active";
}

function emit(next: DemoGuideState): void {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

/** 发一个事件；与云端有关的收尾（心跳、结束演示）在这里一并处理。 */
export function dispatchDemoGuide(event: DemoGuideEvent): void {
  if (event.type === "start" || event.type === "start-before-project") {
    stopHeartbeat();
    emit(state = demoGuideReducer({ ...state, ...IDLE }, event));
    return;
  }
  const before = state;
  const next = demoGuideReducer(before, event);
  if (next !== before) emit(next);
  if (next !== before && next.status === "active" && next.phase !== before.phase) {
    // 步骤一变立即补一次心跳，并把「云端说已结束」这条兜底接上。
    void sendHeartbeat();
    if (next.phase === "settings-open" || next.phase === "help-waiting" || next.phase === "help-dialog") startHeartbeat();
    if (next.status === "active" && next.phase === "complete") stopHeartbeat();
  }
  // 完成弹窗一出现就叫云端结束演示，不等用户点按钮。
  if (next.endReason && next.status !== "active" && before.status === "active") {
    void endDemo(next.endReason);
  }
}

/** 开始一次引导：只有云端返回 `demo.active` 时调用。 */
export function startDemoGuide(input: DemoGuideStart): void {
  client = input.client;
  endedProjects.delete(input.projectId);
  dispatchDemoGuide({
    type: "start",
    input: {
      projectId: input.projectId,
      localProjectId: input.localProjectId,
      memberUserId: input.memberUserId,
      memberName: input.memberName
    }
  });
  startHeartbeat();
  void sendHeartbeat();
}

/** 从大卡点「新建项目」进来：先只在新建弹窗上亮「创建项目」，云端还没有项目，也没有心跳。 */
export function startDemoGuideBeforeProject(): void {
  if (state.status === "active") return;
  dispatchDemoGuide({ type: "start-before-project" });
}

/**
 * 收起「建项目之前」的引导，什么都不发生：用户取消了弹窗、关掉了协作开关、或者云端说这次不演示。
 * 这不是退出：本来就还没有项目，不必通知云端，只是收起蒙版不再带着人走。
 */
export function dismissDemoGuideBeforeProject(): void {
  if (!isDemoGuideBeforeProject()) return;
  emit(state = { ...IDLE });
}

/** 演示一停就在这里收场：云端把小饭团移出项目，之后这个项目就是普通项目。 */
export async function endDemoGuide(reason: DemoGuideEndReason): Promise<void> {
  if (state.status === "active") dispatchDemoGuide({ type: "end", reason });
  await endDemo(reason);
}

/** 项目绑定好本机项目之后补上本机 id：引导的每一步都按它找看板与邀请弹窗。 */
export function demoGuideBoundLocalProject(projectId: string, localProjectId: string): void {
  if (state.projectId !== projectId || state.localProjectId === localProjectId) return;
  emit(state = { ...state, localProjectId });
}

/** 心跳说演示已结束（云端返回 `demo: null`）：直接收场，卡片不再留着。 */
export function demoGuideEndedByCloud(): void {
  stopHeartbeat();
  dispatchDemoGuide({ type: "cloud-ended" });
}

/** 预览与测试用：把单例状态换成一个已知状态。 */
export function setDemoGuideStateForTest(next: DemoGuideState | null, nextClient: CollabClient | null = null): void {
  stopHeartbeat();
  client = nextClient;
  state = next ?? IDLE;
  for (const listener of listeners) listener();
}

export function resetDemoGuideStore(): void {
  stopHeartbeat();
  client = null;
  endedProjects.clear();
  state = IDLE;
  listeners.clear();
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => void sendHeartbeat(), DEMO_GUIDE_HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function sendHeartbeat(): Promise<void> {
  if (state.status !== "active" || !state.projectId || !client) return;
  const step = demoGuideHeartbeatStep(state.phase);
  const projectId = state.projectId;
  try {
    const result = await client.demoHeartbeat?.(projectId, step);
    // 演示在云端已经结束（关掉开关、超时、或别处点了结束）：本机也不该继续带着蒙版。
    if (result && result.demo === null && state.projectId === projectId) demoGuideEndedByCloud();
  } catch {
    // 心跳发不出去时什么都不做：下一次再试，云端超时后自己收场。
  }
}

async function endDemo(reason: DemoGuideEndReason): Promise<void> {
  const projectId = state.projectId;
  if (!projectId || !client || endedProjects.has(projectId)) {
    stopHeartbeat();
    return;
  }
  endedProjects.add(projectId);
  stopHeartbeat();
  try {
    await client.demoEnd?.(projectId, reason);
  } catch {
    // 发不出去就靠云端的心跳超时兜底：这里不打扰用户。
  }
}
