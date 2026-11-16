/**
 * 项目协作新手引导（小饭团演示）的内存状态。
 *
 * 只在「刚创建完一个演示项目」时开始，进度不落盘：重新打开 Memmy 后项目就是普通项目。
 * 唯一落盘的是「这台机器已经退出过引导」这个标记：退出、跳过、完成、中途中断都算退出，之后新建项目不再自动带引导。
 * 引导的一切都认云端：项目视图里的 `demo.active` 为真才开始，心跳或请求说演示已结束就立即收场。
 * 这里也负责两件云端的事：演示期间每 30 秒一次心跳（步骤变化时立即补一次），以及结束时叫云端把小饭团移出项目。
 */
import type { CollabClient } from "../api/collab-client.js";

/** 引导的每个子状态。
 *
 * 分三段：先是「建项目之前」的新建弹窗六屏，再是「看板导览」（`tour-*`，纯介绍，不让人操作），
 * 最后是「动手体验」（三步，各自有若干子状态）。
 * 体验段的「1 / 3」由 {@link demoGuideStepNumberOf} 给出，另外两段没有进度可讲。
 */
export type DemoGuidePhase =
  // 建项目之前的那一段：新建弹窗刚打开，一路在弹窗上走完六屏，还没有云端项目。
  | DemoGuideBeforeProjectPhase
  // 演示刚开始：看板蒙版套住成员徽章，点「继续」才进看板导览。
  | "joined"
  // 看板导览的五步：任务列表、协助这一个 tab、工具条上的关联任务、关联会话窗口、侧栏新建任务。
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
 * 建项目之前的六屏，按讲的顺序排：出场、项目名称、文件夹、协作开关、左下角的「加入项目」，最后是「创建项目」。
 *
 * 这一段还没有云端项目：没有心跳、也没有成员，界面只在新建弹窗里一屏一屏地换亮区。
 */
export const DEMO_GUIDE_BEFORE_PROJECT_PHASES = [
  /** 小饭团出场：蒙版亮整个新建弹窗，不画描边。 */
  "intro",
  /** 项目名称：预填好的一项，成员看到的名称与这里一致。 */
  "name",
  /** 文件夹：Agent 工作的本地目录。 */
  "folder",
  /** 协作开关：开与关的差别。 */
  "collab",
  /** 左下角的「加入项目」：已有项目时从这里进，不必新建。 */
  "join-entry",
  /** 「创建项目」按钮：由人点这个真实的按钮推进，没有「下一步」。 */
  "create-project"
] as const;

export type DemoGuideBeforeProjectPhase = (typeof DEMO_GUIDE_BEFORE_PROJECT_PHASES)[number];

/** 这个子状态属于「建项目之前」（新建弹窗上的六屏）。 */
export function demoGuideIsBeforeProjectPhase(phase: DemoGuidePhase): phase is DemoGuideBeforeProjectPhase {
  return (DEMO_GUIDE_BEFORE_PROJECT_PHASES as readonly string[]).includes(phase);
}

/**
 * 建项目之前这一段里的下一屏；最后一屏（`create-project`）之后没有「下一步」，返回 null。
 * 「加入项目」要不要跳过由界面判断（锚点不存在时发 `skip-join-entry`），不在这里决定。
 */
export function demoGuideNextBeforeProjectPhase(phase: DemoGuideBeforeProjectPhase): DemoGuideBeforeProjectPhase | null {
  const index = (DEMO_GUIDE_BEFORE_PROJECT_PHASES as readonly string[]).indexOf(phase);
  return DEMO_GUIDE_BEFORE_PROJECT_PHASES[index + 1] ?? null;
}

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
  /**
   * 「关联任务」打开的关联会话窗口：真的扫一遍这台电脑上的历史会话，只展示能关联什么。
   *
   * 扫描要几秒：拿到结果之前卡片不给「下一步」，人不会以为按了没反应。
   */
  "tour-associate-pick",
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

/** 导览的最后一步：气泡上的主按钮写「开始协作」，点了才进体验的第一步。 */
export function demoGuideStartsExperience(phase: DemoGuidePhase): boolean {
  return phase === DEMO_GUIDE_TOUR_PHASES[DEMO_GUIDE_TOUR_PHASES.length - 1];
}

/** 导览的下一步；最后一步之后是体验的第一步，不在导览段时为 null。 */
export function demoGuideNextTourPhase(phase: DemoGuidePhase): DemoGuidePhase | null {
  const index = demoGuideTourIndex(phase);
  if (index < 0) return null;
  return DEMO_GUIDE_TOUR_PHASES[index + 1] ?? "task-row";
}

/**
 * 每一屏的「上一步」退到哪一屏。
 *
 * 回退按屏走，不按步走：卡片上的「上一步」与「下一步」一一对应，退回去的就是刚才那一屏，
 * 不会一下从「等小饭团回结果」跳回「第一步已完成」。
 *
 * 不在这张表里的屏没有上一步：第一屏（`intro`）、项目已经建好的提示窗（`joined`）、
 * 导览的第一屏（`tour-board`），以及所有「事情已经办成」的屏——第一步拿到回复、第二步拿到结果、
 * 第三步已经在本机跑起来或已经跑完。这些位置能做的只有等待或跳过，
 * 给一个返回按钮会让人以为能撤回已经发生的事。
 */
const DEMO_GUIDE_BACK_TARGET: Partial<Record<DemoGuidePhase, DemoGuidePhase>> = {
  name: "intro",
  folder: "name",
  collab: "folder",
  "join-entry": "collab",
  "create-project": "join-entry",
  "tour-tabs": "tour-board",
  "tour-associate": "tour-tabs",
  "tour-associate-pick": "tour-associate",
  "tour-new-task": "tour-associate-pick",
  "task-row": "tour-new-task",
  reader: "task-row",
  compose: "reader",
  "reply-waiting": "compose",
  "ask-compose": "reply-done",
  "ask-waiting": "ask-compose",
  "settings-open": "ask-done",
  "settings-assist": "settings-open",
  // 第三步退回去一律落在 `settings-open`（「去项目设置」那一屏），不落在 `settings-assist`：
  // 退回 `settings-assist` 意味着设置弹窗得重新打开、开关保持原样，一个刚退回来的人看到弹窗还开着会更迷。
  // 退到 `settings-open` 时弹窗关掉、开关关回去，他重点一下齿轮就是干净地重来一遍。
  "help-waiting": "settings-open",
  "help-dialog": "settings-open"
};

/**
 * 这一屏点「上一步」退到哪一屏；没有上一步时返回 null（卡片上不出现那个按钮）。
 *
 * 前一屏如果标着「这一步已经做完」，而实际是跳过的，就继续往前退到这一步真正的入口：
 * 跳过第二步的人停在 `settings-open`，退回去该看见「请小饭团协助」的输入框，而不是一张
 * 「第二步已完成」的卡片——他根本没做过。
 */
export function demoGuideBackTarget(state: Pick<DemoGuideState, "phase" | "skipped">): DemoGuidePhase | null {
  if (state.phase === "settings-open" && state.skipped.ask) return "ask-compose";
  if (state.phase === "ask-compose" && state.skipped.task) return "task-row";
  return DEMO_GUIDE_BACK_TARGET[state.phase] ?? null;
}

/**
 * 引导按顺序排开的全部子状态。
 *
 * 只用来比较「这一次是往前走还是往后退」：界面靠它认出人点了「上一步」，
 * 从而先把正在跑的那一轮叫停，而不是等它跑完再被当成「这一步做完了」。
 */
const DEMO_GUIDE_PHASE_ORDER: DemoGuidePhase[] = [
  ...DEMO_GUIDE_BEFORE_PROJECT_PHASES,
  "joined",
  ...DEMO_GUIDE_TOUR_PHASES,
  "task-row",
  "reader",
  "compose",
  "reply-waiting",
  "reply-done",
  "ask-compose",
  "ask-waiting",
  "ask-done",
  "settings-open",
  "settings-assist",
  "help-waiting",
  "help-dialog",
  "help-running",
  "help-done",
  "help-rejected",
  "complete"
];

/** 这一屏在引导顺序里的位置；不在表里时 -1。 */
export function demoGuidePhaseOrder(phase: DemoGuidePhase): number {
  return DEMO_GUIDE_PHASE_ORDER.indexOf(phase);
}

/**
 * 这一次变化是往后退的（人点了「上一步」）。
 *
 * 只有 `back` 会让位置变小：`next`、`skip`、各种外部事件都是往前走。
 */
export function demoGuideWentBack(previous: DemoGuidePhase, next: DemoGuidePhase): boolean {
  return demoGuidePhaseOrder(next) < demoGuidePhaseOrder(previous);
}

/**
 * 这一屏会不会出「这一步没有完成」。
 *
 * 错误只在真正等着某个结果的屏上成立。退回去之后迟到的错误（被停下的那一轮报的、
 * 被撤回的请求回的）不能落在新的一屏上，否则人刚退回来就看到一句「这一步没有完成」。
 */
export function demoGuideAcceptsFailure(phase: DemoGuidePhase): boolean {
  return phase === "reply-waiting"
    || phase === "ask-waiting"
    || phase === "help-waiting"
    || phase === "help-running";
}

/** 引导的对外状态：进行中、完成弹窗、已结束。 */
export type DemoGuideStatus = "active" | "complete" | "ended";

/**
 * 「关联会话」这一步的扫描进度。
 *
 * 弹窗自己真实地扫本机历史会话，扫完把一个数交给这里：卡片据此才给「下一步」。
 */
export type DemoGuideScan = { status: "idle" | "scanning" | "done"; count: number };

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
  /** 剧本里会出现在界面上的几句：与云端下发的内容保持一致。 */
  copy: DemoGuideCopy;
  /** 某一步出错时的原因（已本地化），卡片据此显示「这一步没有完成」。 */
  error: string | null;
  /** 用户实际走过的步骤：完成弹窗只列这些。 */
  done: { task: boolean; ask: boolean; help: boolean };
  /** 三步里跳过过哪几步，用来判断「都跳过」。 */
  skipped: { task: boolean; ask: boolean; help: boolean };
  /**
   * 第二步那条协助请求是否已经在云端出现了。
   *
   * 发送之后不代表请求就建出来了：Agent 要先调接口。请求出现之前不能说「已发出」，
   * 否则人会觉得对方正在执行，其实连请求都还没建。
   */
  askSeen: boolean;
  /** 第二步的请求是否已经有结果回到了对话。 */
  askDelivered: boolean;
  /**
   * 第二步这一轮 Agent 已经结束。没有结果回来时，只有它说明「这句话已经执行完了」，
   * 才允许判「协助请求没有发出去」：Agent 还在跑就不判失败。
   */
  askTurnEnded: boolean;
  /** 「关联会话」这一步的扫描进度：没扫出结果之前不给「下一步」。 */
  scan: DemoGuideScan;
  /** 输入框要预填的那句话；`nonce` 变一次填一次，填过的再读不会重复填。 */
  prefill: { text: string; nonce: number } | null;
  /** 结束引导时的原因，云端按它记。 */
  endReason: DemoGuideEndReason | null;
  /** 演示是被云端判定结束的（心跳时返回 `demo: null`）：界面提示一次「体验已结束」。 */
  cloudEnded: boolean;
}

export type DemoGuideEndReason = "finished" | "exited" | "skipped" | "left";

/**
 * 剧本里会出现在界面上的几句，由云端随 `demo` 一并下发。
 *
 * 三步实际做什么只有云端知道；从前客户端各写一份，云端改剧本时这边不知道，同一屏里就会同时出现
 * 「项目协作上手清单」和「分享会通知」两套内容。
 */
export interface DemoGuideCopy {
  /** 演示成员那条任务的标题。 */
  taskTitle: string;
  /** 第一步要接着做的那件事。 */
  taskNext: string;
  /** 第二步请演示成员做的事，接在「请某某」后面。 */
  askSentence: string;
  /** 第三步演示成员请你电脑上的 Agent 做的事，接在「他请你电脑上的 Agent」后面。 */
  helpSentence: string;
}

/**
 * 云端还没带 `copy` 时的兵底（与云端缺省剧本同一套）。
 *
 * 旧云端只给成员与步骤，界面上的话就按这份说：内容可能落后于剧本，但总比空白或报错好。
 */
export const DEMO_GUIDE_COPY_FALLBACK: DemoGuideCopy = {
  taskTitle: "下周五的团队分享会",
  taskNext: "写一段分享会的通知",
  askSentence: "查一下上次分享会一共来了多少人",
  helpSentence: "确认这台电脑的系统版本"
};

export interface DemoGuideStart {
  projectId: string;
  localProjectId: string | null;
  memberUserId: string;
  memberName: string;
  /** 云端下发的剧本文案；旧云端不带时为 {@link DEMO_GUIDE_COPY_FALLBACK}。 */
  copy?: DemoGuideCopy | null;
  client: CollabClient;
}

export type DemoGuideEvent =
  | { type: "start"; input: Omit<DemoGuideStart, "client"> }
  /** 从大卡或侧栏进来：先在新建弹窗上走完六屏，还没有云端项目。 */
  | { type: "start-before-project" }
  /** 「{name}加入了项目」那一屏点了「继续」：才开始第一步。 */
  | { type: "joined-confirmed" }
  /** 「加入项目」这一屏没有对应的按钮（API Key 模式）时由界面发它：直接进「创建项目」。 */
  | { type: "skip-join-entry" }
  | { type: "task-opened" }
  | { type: "task-continued"; prefill?: string }
  | { type: "composer-sent" }
  | { type: "agent-settled" }
  | { type: "assist-delivered" }
  /** 第二步那条请求出现了（可能晚于「没有发出去」那句）：把错误收起来。 */
  | { type: "assist-seen" }
  | { type: "next"; prefill?: string }
  /**
   * 退回上一屏。
   *
   * 与 `next` 对称，退的是「刚才那一屏」，不是「上一步」。退回去要重新发的那句话由界面传进来
   * （第一步、第二步各自的预填），其余屏不带。
   */
  | { type: "back"; prefill?: string }
  | { type: "skip"; prefill?: string }
  /** 关联会话窗口扫完了：`count` 是可以关联的会话数。 */
  | { type: "scan-settled"; count: number }
  /** 这一步没有可扫的东西（没授权读其他 Agent 的记录）：直接放过，不让人卡住。 */
  | { type: "scan-unavailable" }
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
  copy: DEMO_GUIDE_COPY_FALLBACK,
  error: null,
  done: { task: false, ask: false, help: false },
  skipped: { task: false, ask: false, help: false },
  askSeen: false,
  askDelivered: false,
  askTurnEnded: false,
  scan: { status: "idle", count: 0 },
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
  // 建项目之前的六屏都还没有进度可讲。
  if (demoGuideIsBeforeProjectPhase(phase)) return null;
  // 加入那一屏与看板导览都还不是一步：前者讲完就得进导览，后者讲完才进第一步。
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
        // 从出场那一屏开始：新建弹窗上一路走下去，最后才轮到人点「创建项目」。
        phase: DEMO_GUIDE_BEFORE_PROJECT_PHASES[0]
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
        memberName: event.input.memberName,
        copy: event.input.copy ?? DEMO_GUIDE_COPY_FALLBACK
      };
    case "joined-confirmed":
      // 点「继续」先进看板导览：先看一圈看板是干什么的，再动手。
      return state.status === "active" && state.phase === "joined"
        ? { ...state, phase: DEMO_GUIDE_TOUR_PHASES[0] }
        : state;
    case "skip-join-entry":
      // 「加入项目」那一屏没有可亮的按钮时跳过去；别的阶段发这个事件不产生任何变化。
      return state.status === "active" && state.phase === "join-entry"
        ? { ...state, phase: "create-project" }
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
      if (state.phase === "ask-compose") {
        return { ...state, phase: "ask-waiting", askSeen: false, askDelivered: false, askTurnEnded: false };
      }
      return state;
    case "assist-delivered":
      // 结果回来了就是这一步成了：之前那句「没有完成」随之收起。
      return state.status === "active" && state.phase === "ask-waiting"
        ? { ...state, askDelivered: true, error: null }
        : state;
    case "assist-seen":
      // 请求出现了（先一步出现、或 CLI 慢一步晚到）：记下它已经在云端，卡片才能说「已发出」；
      // 之前若报过「没有发出去」，那句也一并收起，人不用卡在失败卡片上。
      // 轮询每拍都会读到同一条请求：已经记过又没有错误时不换状态对象，订阅方不必跟着重画。
      if (state.status !== "active" || state.phase !== "ask-waiting") return state;
      if (state.askSeen && state.error === null) return state;
      return { ...state, askSeen: true, error: null };
    case "agent-settled":
      if (state.status !== "active") return state;
      // 第二步的结果回来之后 Agent 还要再回一句：那时才给「下一步」。
      // 走过一次就抹掉「这一步是跳过的」：跳过之后又从上一屏退回来重做的，完成弹窗该算他做过。
      if (state.phase === "reply-waiting") {
        return {
          ...state,
          phase: "reply-done",
          done: { ...state.done, task: true },
          skipped: { ...state.skipped, task: false }
        };
      }
      if (state.phase === "ask-waiting" && state.askDelivered) {
        // 这一步完成就把那句话从状态里拿掉：之后即使任务页重新挂载，也不会再把旧的那句填回输入框。
        return {
          ...state,
          phase: "ask-done",
          done: { ...state.done, ask: true },
          skipped: { ...state.skipped, ask: false },
          prefill: null
        };
      }
      // 结果还没回来但这一轮已经跑完：从这一刻起才有资格判「没发出去」。
      if (state.phase === "ask-waiting" && !state.askTurnEnded) {
        return { ...state, askTurnEnded: true };
      }
      return state;
    case "next":
      if (state.status !== "active") return state;
      // 建项目之前的六屏：一屏一屏往下走；最后一屏靠人点真实的「创建项目」，没有「下一步」。
      if (demoGuideIsBeforeProjectPhase(state.phase)) {
        const next = demoGuideNextBeforeProjectPhase(state.phase);
        return next ? { ...state, phase: next } : state;
      }
      // 看板导览：一步一步往下讲，最后一步之后就是体验的第一步；全程不换页面、不动数据。
      if (demoGuideIsTourPhase(state.phase)) {
        const next = demoGuideNextTourPhase(state.phase);
        if (!next) return state;
        // 「关联会话」要等扫描出结果才给往下走：按钮在此之前是禁用的，这里再拦一次。
        if (state.phase === "tour-associate-pick" && state.scan.status !== "done") return state;
        return {
          ...state,
          phase: next,
          error: null,
          // 进这一步就开始扫：卡片先写「正在扫描」，弹窗一出现就真的去读本机记录。
          scan: next === "tour-associate-pick" && state.scan.status !== "done"
            ? { status: "scanning", count: 0 }
            : state.scan
        };
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
    case "back": {
      if (state.status !== "active") return state;
      const target = demoGuideBackTarget(state);
      // 这一屏没有上一步（事情已经办成，或已经是第一屏）：卡片的按钮不会出现，这里也不动。
      if (!target) return state;
      // 退回去的那一屏要人再发一次那句话的，把预填带上（nonce 接着往上走，输入框才会重新填）；
      // 其余屏不带，退回去就只展示。
      const refill = target === "compose" || target === "ask-compose" ? event.prefill : undefined;
      return {
        ...state,
        phase: target,
        error: null,
        prefill: nextPrefill(state, refill),
        // 退回「关联会话」时弹窗会重新打开、重新扫一遍：扫描进度也要重新等，不能留着上一次的计数。
        scan: target === "tour-associate-pick" ? { status: "scanning", count: 0 } : state.scan
      };
    }
    case "skip": {
      if (state.status !== "active") return state;
      // 建项目之前没有可跳过的步骤：不建项目就没有后面的演示；加入那一屏也不是一步。
      if (demoGuideIsBeforeProjectPhase(state.phase) || state.phase === "joined") return state;
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
    case "scan-settled":
      // 扫完了：卡片把计数换成结果，「下一步」也就可用了。失败时界面按 0 报，说明这里没有可关联的会话。
      return state.status === "active" && state.phase === "tour-associate-pick"
        ? { ...state, scan: { status: "done", count: Math.max(0, Math.round(event.count)) } }
        : state;
    case "scan-unavailable": {
      // 没有授权读本机其他 Agent 的记录：这一步没什么可展示的，直接接到下一站。
      if (state.status !== "active" || state.phase !== "tour-associate-pick") return state;
      const next = demoGuideNextTourPhase(state.phase);
      return next ? { ...state, phase: next, scan: { status: "done", count: 0 }, error: null } : state;
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
        ? {
          ...state,
          phase: "help-done",
          error: null,
          done: { ...state.done, help: true },
          skipped: { ...state.skipped, help: false }
        }
        : state;
    case "fail":
      // 同一个原因已经说过就不再重复：轮询每拍都会读到同一个失败结果。
      // 不在等结果的屏（刚退回上一屏）一律不接：那时报错的是已经作废的那一轮。
      if (!demoGuideAcceptsFailure(state.phase)) return state;
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

/**
 * 机器级标记：这台机器上已经退出过引导，之后新建项目不再自动带引导。
 *
 * 退出、跳过、完成、离开看板、云端判定结束都算一次收场，收场就记下。与首次引导的完成标记同一套做法：
 * 一次性的初见体验，换账号再演一遍反而突兀，所以按机器记、不按账号记。
 *
 * 云端也按账号判断有没有体验过（`agent_collab_demo` 有过一行就不再演示），但「建项目之前就退出」这种情况
 * 云端还没有项目可记，只能靠本机这个标记；本机标记因此要比云端更早生效，也覆盖云端名单内的重复体验账号。
 */
const DEMO_GUIDE_DONE_STORAGE_KEY = "memmy.collabDemoGuide.v1";

/** 默认用 localStorage；测试与预览可以换成一个内存存储。 */
let injectedStorage: Storage | null = null;

function demoGuideStorage(storage?: Storage): Storage | undefined {
  if (storage) return storage;
  if (injectedStorage) return injectedStorage;
  return typeof window === "undefined" ? undefined : window.localStorage;
}

/**
 * 预览与测试用：把存储换成一个给定对象。
 *
 * @param storage 要用的存储；传 null 恢复默认的 localStorage。
 */
export function setDemoGuideStorageForTest(storage: Storage | null): void {
  injectedStorage = storage;
}

/**
 * 这台机器上是否已经退出过引导：为真时不再自动进演示，新建项目就是普通新建。
 *
 * @param storage 存储；不传时用 localStorage（测试可以直接给一个假存储）。
 */
export function readDemoGuideDone(storage?: Storage): boolean {
  try {
    return demoGuideStorage(storage)?.getItem(DEMO_GUIDE_DONE_STORAGE_KEY) === "1";
  } catch {
    // 读不到存储时按「没退出过」处理：大不了再引导一次，不能让读存储失败挡住新建项目。
    return false;
  }
}

/**
 * 记下「这台机器已经退出过引导」：写过一次就不再自动引导。
 *
 * @param storage 存储；不传时用 localStorage。
 */
export function markDemoGuideDone(storage?: Storage): void {
  try {
    demoGuideStorage(storage)?.setItem(DEMO_GUIDE_DONE_STORAGE_KEY, "1");
  } catch {
    // 写不进去就算了：最多下次再引导一次，不影响当前这一轮。
  }
}

/**
 * 清掉退出标记。只给测试、预览页与自助重置用；正式流程不会再把它清回去。
 *
 * @param storage 存储；不传时用 localStorage。
 */
export function clearDemoGuideDone(storage?: Storage): void {
  try {
    demoGuideStorage(storage)?.removeItem(DEMO_GUIDE_DONE_STORAGE_KEY);
  } catch {
    // 清不掉也不影响这一轮：下一次读到的仍是旧的标记。
  }
}

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

/** 引导停在新建弹窗上（六屏里的任意一屏）：还没有云端项目，还没有心跳。 */
export function isDemoGuideBeforeProject(): boolean {
  return state.status === "active" && demoGuideIsBeforeProjectPhase(state.phase);
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
  if (next !== before) {
    emit(next);
    // 引导真的收场了（完成、退出、跳过、离开看板、云端判定结束）：本机记一笔，之后不再自动带引导。
    if (before.status === "active" && next.status !== "active") markDemoGuideDone();
  }
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

/** 从大卡或侧栏点「新建项目」进来：先在新建弹窗上走六屏，云端还没有项目，也没有心跳。 */
export function startDemoGuideBeforeProject(): void {
  // 本机已经退出过引导：不再带着人走一遍，弹窗按普通新建处理。
  if (readDemoGuideDone()) return;
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
  // 测试与预览共用这一份状态：退出标记与临时存储也一并清掉，免得上一个用例影响下一个。
  clearDemoGuideDone();
  injectedStorage = null;
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
