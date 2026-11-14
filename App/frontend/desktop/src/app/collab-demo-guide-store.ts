/**
 * 项目协作新手引导（小饭团演示）的内存状态。
 *
 * 只在「刚创建完一个演示项目」时开始，进度不落盘：重新打开 Memmy 后项目就是普通项目。
 * 引导的一切都认云端：项目视图里的 `demo.active` 为真才开始，心跳或请求说演示已结束就立即收场。
 * 这里也负责两件云端的事：演示期间每 30 秒一次心跳（步骤变化时立即补一次），以及结束时叫云端把小饭团移出项目。
 */
import type { CollabClient } from "../api/collab-client.js";

/** 引导的每个子状态。
 *
 * 分两段：先是「看板导览」（`tour-*`，纯介绍，不让人操作），再是「动手体验」（三步，各自有若干子状态）。
 * 体验段的「1 / 3」由 {@link demoGuideStepNumberOf} 给出，导览段没有进度可讲。
 */
export type DemoGuidePhase =
  // 建项目之前：新建弹窗刚打开，还没有云端项目，蒙版只亮「创建项目」。
  | "create-project"
  // 演示刚开始：先弹一个「{name}加入了项目」的提示窗，点「开始体验」才进看板导览。
  | "joined"
  // 看板导览的四步：任务列表、协助这一个 tab、工具条上的关联任务、侧栏新建任务。
  // 全程停在同一个看板上，只亮给人看，不点任何东西，只留「下一步」与「跳过引导」。
  | DemoGuideTourPhase
  | "task-row"
  | "reader"
  | "compose"
  | "reply-waiting"
  | "reply-done"
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

/**
 * 看板导览的四个子状态，按讲的顺序排。
 *
 * 这一段是纯介绍：只亮区域，遮罩挡住所有操作，页面上什么都不改。
 */
export const DEMO_GUIDE_TOUR_PHASES = [
  /** 任务列表：你和成员的任务都在这里。 */
  "tour-board",
  /** 「协助」这一个 tab：记录你和成员互相请对方做的事。 */
  "tour-tabs",
  /** 工具条右侧的「关联任务」：把别的 Agent 里做过的工作带进来。 */
  "tour-associate",
  /** 侧栏当前项目右侧的「＋」：新建任务。 */
  "tour-new-task"
] as const;

export type DemoGuideTourPhase = (typeof DEMO_GUIDE_TOUR_PHASES)[number];

/** 这个子状态属于看板导览（纯介绍），还是动手体验。 */
export function demoGuideIsTourPhase(phase: DemoGuidePhase): phase is DemoGuideTourPhase {
  return (DEMO_GUIDE_TOUR_PHASES as readonly string[]).includes(phase);
}

/** 导览的第几步（从 0 起）；不在导览段时为 -1。 */
export function demoGuideTourIndex(phase: DemoGuidePhase): number {
  return (DEMO_GUIDE_TOUR_PHASES as readonly string[]).indexOf(phase);
}

/** 导览的最后一步：气泡上的主按钮写「开始体验」，点了才进体验的第一步。 */
export function demoGuideStartsExperience(phase: DemoGuidePhase): boolean {
  return phase === DEMO_GUIDE_TOUR_PHASES[DEMO_GUIDE_TOUR_PHASES.length - 1];
}

/** 导览的下一步；最后一步之后是体验的第一步，不在导览段时为 null。 */
export function demoGuideNextTourPhase(phase: DemoGuidePhase): DemoGuidePhase | null {
  const index = demoGuideTourIndex(phase);
  if (index < 0) return null;
  return DEMO_GUIDE_TOUR_PHASES[index + 1] ?? "task-row";
}

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
  done: { task: boolean; ask: boolean; help: boolean };
  /** 三步里跳过过哪几步，用来判断「都跳过」。 */
  skipped: { task: boolean; ask: boolean; help: boolean };
  /** 第二步的请求是否已经有结果回到了对话。 */
  askDelivered: boolean;
  /**
   * 第二步这一轮 Agent 已经结束。没有结果回来时，只有它说明「这句话已经执行完了」，
   * 才允许判「协助请求没有发出去」：Agent 还在跑就不判失败。
   */
  askTurnEnded: boolean;
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
  /** 第二步那条请求出现了（可能晚于「没有发出去」那句）：把错误收起来。 */
  | { type: "assist-seen" }
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
  done: { task: false, ask: false, help: false },
  skipped: { task: false, ask: false, help: false },
  askDelivered: false,
  askTurnEnded: false,
  prefill: null,
  endReason: null,
  cloudEnded: false
};

/**
 * 一个子状态属于体验段的第几步：卡片上的「1 / 3」按它算。
 *
 * 建项目之前、加入提示窗与看板导览都还没有进度可讲，返回 null：卡片上不出现进度条，改用一个「介绍」标签。
 */
export function demoGuideStepNumberOf(phase: DemoGuidePhase): 1 | 2 | 3 | null {
  // 建项目之前的阶段还没有进度可讲。
  if (phase === "create-project") return null;
  // 加入提示窗与看板导览都还不是一步：前者没有卡片，后者讲完才进第一步。
  if (phase === "joined" || demoGuideIsTourPhase(phase)) return null;
  if (phase === "task-row" || phase === "reader" || phase === "compose" || phase === "reply-waiting" || phase === "reply-done") {
    return 1;
  }
  if (phase === "ask-compose" || phase === "ask-waiting" || phase === "ask-done") return 2;
  return 3;
}

/** 心跳上报的步骤：云端只接受 `1`、`2`、`3` 与 `finish`，与体验段的三步一一对应。 */
export function demoGuideHeartbeatStep(phase: DemoGuidePhase): "1" | "2" | "3" | "finish" {
  if (phase === "complete") return "finish";
  const step = demoGuideStepNumberOf(phase);
  // 还没有进入体验段（建项目之前、加入提示窗、看板导览）：都算在第一步之前。
  if (step === null) return "1";
  return String(step) as "1" | "2" | "3";
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
      // 点「开始体验」先进看板导览：先看一圈看板是干什么的，再动手。
      return state.status === "active" && state.phase === "joined"
        ? { ...state, phase: DEMO_GUIDE_TOUR_PHASES[0] }
        : state;
    case "task-opened":
      return state.status === "active" && state.phase === "task-row" ? { ...state, phase: "reader" } : state;
    case "task-continued":
      return state.status === "active" && state.phase === "reader"
        ? { ...state, phase: "compose", prefill: nextPrefill(state, event.prefill) }
        : state;
    case "composer-sent":
      if (state.status !== "active") return state;
      if (state.phase === "compose") return { ...state, phase: "reply-waiting" };
      if (state.phase === "ask-compose") return { ...state, phase: "ask-waiting", askDelivered: false, askTurnEnded: false };
      return state;
    case "assist-delivered":
      // 结果回来了就是这一步成了：之前那句「没有完成」随之收起。
      return state.status === "active" && state.phase === "ask-waiting"
        ? { ...state, askDelivered: true, error: null }
        : state;
    case "assist-seen":
      // 请求后来出现了（CLI 慢一步、云端晚一拍）：把「没有发出去」那句收起，人不用卡在失败卡片上。
      return state.status === "active" && state.phase === "ask-waiting" && state.error !== null
        ? { ...state, error: null }
        : state;
    case "agent-settled":
      if (state.status !== "active") return state;
      // 第二步的结果回来之后 Agent 还要再回一句：那时才给「下一步」。
      if (state.phase === "reply-waiting") {
        return { ...state, phase: "reply-done", done: { ...state.done, task: true } };
      }
      if (state.phase === "ask-waiting" && state.askDelivered) {
        // 这一步完成就把那句话从状态里拿掉：之后即使任务页重新挂载，也不会再把旧的那句填回输入框。
        return { ...state, phase: "ask-done", done: { ...state.done, ask: true }, prefill: null };
      }
      // 结果还没回来但这一轮已经跑完：从这一刻起才有资格判「没发出去」。
      if (state.phase === "ask-waiting" && !state.askTurnEnded) {
        return { ...state, askTurnEnded: true };
      }
      return state;
    case "next":
      if (state.status !== "active") return state;
      // 看板导览：一步一步往下讲，最后一步之后就是体验的第一步；全程不换页面、不动数据。
      if (demoGuideIsTourPhase(state.phase)) {
        const next = demoGuideNextTourPhase(state.phase);
        return next ? { ...state, phase: next, error: null } : state;
      }
      // 第一步做完直接请成员协助：那句话跟着填上；换一句时 nonce 要接着往上走，输入框才知道该重新填一次。
      if (state.phase === "reply-done") {
        return { ...state, phase: "ask-compose", prefill: nextPrefill(state, event.prefill), error: null };
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
      // 看板导览是纯介绍，没有「跳过这一步」：点跳过引导就是整轮不看，直接收场（小饭团随之离开）。
      if (demoGuideIsTourPhase(state.phase)) return finishOrSkip(state, { help: false, allSkipped: true });
      const step = demoGuideStepNumberOf(state.phase);
      if (step === 1) {
        return {
          ...state,
          phase: "ask-compose",
          prefill: nextPrefill(state, event.prefill),
          error: null,
          done: { ...state.done, task: false },
          skipped: { ...state.skipped, task: true }
        };
      }
      if (step === 2) {
        return {
          ...state,
          phase: "settings-open",
          prefill: null,
          error: null,
          done: { ...state.done, ask: false },
          skipped: { ...state.skipped, ask: true }
        };
      }
      // 第三步跳过：授权弹窗那一步跳过等同于拒绝，其余直接收场。
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

/**
 * 第三步之后：有点〔完成〕的就是收尾弹窗；三步全都跳过时直接结束，不出现完成弹窗。
 * `allSkipped` 用在导览段点「跳过引导」：整轮都没看，直接收场。
 */
function finishOrSkip(state: DemoGuideState, done: { help: boolean; allSkipped?: boolean }): DemoGuideState {
  const next: DemoGuideState = {
    ...state,
    done: { ...state.done, help: done.help && state.done.help ? true : done.help },
    skipped: { ...state.skipped, help: state.skipped.help || !done.help }
  };
  const allSkipped = done.allSkipped
    || (next.skipped.task && next.skipped.ask && next.skipped.help);
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
