/**
 * 引导的宿主：挂在应用根部，负责推进引导与调用云端的协作接口。
 *
 * 蒙版与卡片在 {@link CollabDemoGuideOverlay}；这里做四件事：
 * 1. 按当前子状态轮询协助（第二步等结果、第三步等请求与执行结果），不靠定时器猜步骤；
 * 2. 该换页面时换页面（请成员协助前回那条任务、请完回看板的项目设置）；看板导览全程不换页；
 * 3. 演示一停就叫云端结束，并在离开看板或关窗时尽力发送；
 * 4. 完成弹窗关掉后把人放回这个项目的看板「协助」，两条记录都在眼前。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CollabClient } from "../../api/collab-client.js";
import { requestAssistFocus } from "../../app/collab-assist-focus.js";
import { requestDemoGuideInvite } from "../../app/collab-demo-guide-invite.js";
import {
  demoGuideStepNumberOf,
  dispatchDemoGuide,
  endDemoGuide,
  getDemoGuideState,
  isDemoGuideActive,
  subscribeDemoGuide
} from "../../app/collab-demo-guide-store.js";
import { loadCollabProjects } from "../../app/collab-projects-store.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { CollabDemoGuideOverlay } from "./collab-demo-guide-overlay.js";
import styles from "./collab-demo-guide.module.css";

/** 第二步等结果、第三步等请求与执行结果时的轮询间隔：够快，也不至于一直打本机接口。 */
export const DEMO_GUIDE_POLL_MS = 1_500;

/** 等小饭团的请求最多等这么久：超时就按「这一步没有完成」处理，不让人卡在蒙版里。 */
const HELP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 第二步等结果的时限：这么久本项目里还没有「我发起、执行人是演示成员」的请求，才可能说明这次没发出去。
 *
 * 光有时限不够：Agent 还在跑（CLI 还没执行完）时请求本来就还没写进去，那时判失败就是误报。
 * 所以两个条件都要满足：这一轮 Agent 已经结束、并且超过这项时限仍然没有请求。
 */
const ASK_RESULT_TIMEOUT_MS = 90_000;

export function CollabDemoGuideHost(props: {
  collab: CollabClient | null;
  /** 当前路由：只在看板与对话页之间时不算离开。 */
  route: string;
  /** 打开某个本机项目的看板。 */
  openBoard: (localProjectId: string) => void;
  /** 回对话页（当前那条任务）：关联任务之后要继续在任务里发消息。 */
  openTaskPage: () => void;
  /** 当前开着的看板是哪个本机项目（不在看板时为空）：换到别的项目就算离开。 */
  boardProjectId: string | null;
  /** 一次性提示（如「体验已结束」）：引导跨页面，提示也由自己显示。 */
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribeDemoGuide, getDemoGuideState, getDemoGuideState);
  /** 上层每次渲染都给新的函数：放进 ref，轮询不因此重启。 */
  const openBoardRef = useRef(props.openBoard);
  openBoardRef.current = props.openBoard;
  const openTaskPageRef = useRef(props.openTaskPage);
  openTaskPageRef.current = props.openTaskPage;
  const noticeRef = useRef(props.onNotice);
  noticeRef.current = props.onNotice;
  const collabRef = useRef(props.collab);
  collabRef.current = props.collab;
  /** 第三步那条请求的 id：允许之后去那条任务，完成时回看板要展开的就是它。 */
  const helpThreadRef = useRef<string | null>(null);
  const helpSinceRef = useRef<number | null>(null);
  /** 第二步从「请求已发出」算起，等这么久没有那条请求就按失败处理。 */
  const askSinceRef = useRef<number | null>(null);
  /** 演示是否带着一个云端项目：从有到无（完成 / 退出 / 离开 / 心跳超时）要立刻把看板数据重读一遍。 */
  const demoOwnedProjectRef = useRef(false);
  /** 云端说演示已结束时已经提示过，避免每次重画都再提示一次。 */
  const cloudEndedNoticedRef = useRef(false);
  /** 引导自己的一句话提示（如「体验已结束」）：蒙版可能在任何页面，提示不依赖看板。 */
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (notice === null) return undefined;
    const timer = setTimeout(() => setNotice(null), 2_400);
    return () => clearTimeout(timer);
  }, [notice]);

  // 演示期间离开看板与对话页（去了设置、首页等），或者在看板里换到了别的项目：按「离开」结束，小饭团随之退出。
  // 只在演示项目的看板真正打开过之后才判断：刚创建时本机项目还没绑好、页面还停在旧看板或别的页面，
  // 那一小段时间不是「离开」，否则从别的项目看板上新建时演示会在一秒内被结束。
  const demoBoardSeenRef = useRef(false);
  useEffect(() => {
    if (state.status !== "active") {
      demoBoardSeenRef.current = false;
      return;
    }
    if (!demoBoardSeenRef.current) {
      if (props.route === "/collab" && state.localProjectId && props.boardProjectId === state.localProjectId) {
        demoBoardSeenRef.current = true;
      }
      return;
    }
    if (props.route !== "/collab" && props.route !== "/main") {
      void endDemoGuide("left");
      return;
    }
    if (props.route === "/collab" && props.boardProjectId && props.boardProjectId !== state.localProjectId) {
      void endDemoGuide("left");
    }
  }, [props.route, props.boardProjectId, state.status, state.localProjectId]);

  // 关窗或退出 Memmy：尽力发送一次结束，发不出去靠云端的心跳超时兜底。
  useEffect(() => {
    if (state.status !== "active") return undefined;
    const leave = () => {
      void endDemoGuide("left");
    };
    window.addEventListener("beforeunload", leave);
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("beforeunload", leave);
      window.removeEventListener("pagehide", leave);
    };
  }, [state.status]);

  // 体验段才需要换页面：第一步（接续成员的任务）在任务页里，第二步（请成员协助）要回任务发消息，
  // 第三步从看板的项目设置开始。看板导览全程停在同一个看板上，不在这里换任何页面。
  // 每个阶段只拉一次：人自己走开一下再回来，不至于被反复拽回去。
  const navigatedPhaseRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.status !== "active") {
      navigatedPhaseRef.current = null;
      return;
    }
    // 第二步（请成员协助）要回到任务里发消息：从看板上过来时把对话页拉回来。
    if (state.phase === "ask-compose" && props.route === "/collab" && navigatedPhaseRef.current !== "ask-compose") {
      navigatedPhaseRef.current = "ask-compose";
      openTaskPageRef.current();
    }
  }, [state.status, state.phase, state.localProjectId, props.route]);

  // 第二步（请成员协助）结束后回到看板：下一步是从看板的项目设置开始。
  useEffect(() => {
    if (state.status !== "active" || state.phase !== "settings-open") return;
    if (!state.localProjectId) return;
    if (props.route === "/collab") return;
    openBoardRef.current(state.localProjectId);
  }, [state.phase, state.status, state.localProjectId, props.route]);

  // 第二步等结果、第三步等请求：按固定间隔读一次，拿到结果就推进。
  useEffect(() => {
    if (state.status !== "active" || !props.collab) return undefined;
    const phase = state.phase;
    if (phase !== "ask-waiting" && phase !== "help-waiting" && phase !== "help-dialog" && phase !== "help-running") return undefined;
    if (!state.projectId) return undefined;
    const client = props.collab;
    const projectId = state.projectId;
    const memberUserId = state.memberUserId;
    /** 这一轮 Agent 是否已经结束：没结束就不判「没发出去」。 */
    const askTurnEnded = state.askTurnEnded;
    let cancelled = false;

    /** 第二步：本项目里由我发起、执行人是演示成员的那次协助有了结果。 */
    const readAskOutcome = async () => {
      const listing = await client.assistThreads(projectId);
      const thread = listing.threads.find((item) => (
        item.requester.mine && item.executor.userId === memberUserId
      ));
      const latest = thread?.requests[0];
      if (!latest) {
        // 一直没有那条请求：Agent 还在跑时绝不判失败，只有这一轮已经结束、又过了时限，才说没发出去。
        const started = askSinceRef.current ?? Date.now();
        askSinceRef.current = started;
        if (askTurnEnded && Date.now() - started > ASK_RESULT_TIMEOUT_MS) {
          dispatchDemoGuide({ type: "fail", reason: t("collab.demo.failed.request") });
        }
        return;
      }
      askSinceRef.current = null;
      // 请求后来才出现的（之前已经报过「没有发出去」）：先把那句错误收起来，不要卡在失败卡片上。
      dispatchDemoGuide({ type: "assist-seen" });
      if (latest.status === "done") {
        dispatchDemoGuide({ type: "assist-delivered" });
        return;
      }
      if (latest.status === "rejected" || latest.status === "failed" || latest.status === "expired" || latest.status === "cancelled") {
        // 真的被拒或执行失败：这才是这一步确实没完成。
        dispatchDemoGuide({ type: "fail", reason: t("collab.demo.failed.request") });
      }
    };

    /** 第三步：演示成员发来的那条请求，以及它的执行结果。 */
    const readHelp = async () => {
      const listing = await client.assistThreads(projectId);
      const thread = listing.threads.find((item) => item.executor.mine && item.requester.userId === memberUserId);
      if (!thread) return;
      helpThreadRef.current = thread.threadId;
      const latest = thread.requests[0];
      if (!latest) return;
      if (phase === "help-dialog") {
        if (latest.status === "running" || latest.status === "confirm") {
          dispatchDemoGuide({ type: "help-decided", allow: true });
          // 演示里允许之后要进那条 Memmy 任务（由协助宿主打开，它才知道任务 id）：
          // 这里不再把人按在看板的「协助」上。
          if (isDemoGuideActive()) return;
          // 由外部 Agent 执行时没有 Memmy 任务：回看板展开这一次。
          requestAssistFocus({ projectId, threadId: thread.threadId });
          if (state.localProjectId) openBoardRef.current(state.localProjectId);
          return;
        }
        if (latest.status === "rejected" || latest.status === "expired" || latest.status === "cancelled") {
          dispatchDemoGuide({ type: "help-decided", allow: false });
        }
        return;
      }
      if (phase === "help-running") {
        if (latest.status === "done") {
          dispatchDemoGuide({ type: "help-finished" });
          return;
        }
        if (latest.status === "failed" || latest.status === "stopped") {
          dispatchDemoGuide({ type: "fail", reason: latest.failure || t("collab.demo.failed.help") });
        }
      }
    };

    /** 第三步：等演示成员发来那个请求。 */
    const readHelpRequest = async () => {
      const inbox = await client.assistInbox();
      const found = inbox.requests.some((item) => item.requester.userId === memberUserId);
      if (found) {
        helpSinceRef.current = null;
        dispatchDemoGuide({ type: "help-request-seen" });
        return;
      }
      // 30 秒还没等到：说明这一步没走通，给出重试与跳过，不让人卡在蒙版里。
      const started = helpSinceRef.current ?? Date.now();
      helpSinceRef.current = started;
      if (Date.now() - started > HELP_REQUEST_TIMEOUT_MS) {
        dispatchDemoGuide({ type: "fail", reason: t("collab.demo.failed.noRequest", { name: state.memberName }) });
      }
    };

    const run = async () => {
      try {
        if (phase === "ask-waiting") await readAskOutcome();
        else if (phase === "help-waiting") await readHelpRequest();
        else await readHelp();
      } catch {
        // 本机接口短暂不可用：下一轮再读。
      }
    };

    void run();
    const timer = setInterval(() => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void run();
    }, DEMO_GUIDE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state.status, state.phase, state.projectId, state.memberUserId, state.localProjectId, state.memberName, state.askTurnEnded, props.collab, t]);

  /**
   * 演示带着一个云端项目、随后收场（完成 / 退出 / 离开 / 心跳超时）：立刻重读项目列表，
   * 成员数与任务列表不必等下一次轮询，蒙版下面不会留着「2 位成员」。
   */
  useEffect(() => {
    const owning = (state.status === "active" || state.status === "complete") && Boolean(state.projectId);
    const ended = demoOwnedProjectRef.current && !owning;
    demoOwnedProjectRef.current = owning;
    if (!ended) return;
    const client = collabRef.current;
    if (client) void loadCollabProjects(client);
  }, [state.status, state.projectId]);

  // 心跳或请求说演示已结束（云端返回 `demo: null`）：直接收场，并告诉用户体验已经结束。
  useEffect(() => {
    if (!state.cloudEnded || cloudEndedNoticedRef.current) return;
    cloudEndedNoticedRef.current = true;
    setNotice(t("collab.demo.ended"));
    noticeRef.current(t("collab.demo.ended"));
  }, [state.cloudEnded, t]);

  // 换了一步就重新计时：第二步从请求发出算起，第三步从「开启接收」之后算起。
  // 重试（清掉 error）同样重新计一次：不然刚点完重试就立刻又报同一句。
  useEffect(() => {
    helpSinceRef.current = null;
    askSinceRef.current = null;
  }, [state.phase, state.error]);

  // 第二句只预填用户看到的那一句话；执行提示在发送时单独追加给 Agent（见 home-page）。
  const askPrefill = () => t("collab.demo.prefill.ask", { name: state.memberName });

  return (
    <>
    <CollabDemoGuideOverlay
      state={state}
      onJoined={() => dispatchDemoGuide({ type: "joined-confirmed" })}
      onNext={() => dispatchDemoGuide({
        type: "next",
        // 第一步做完就直接请成员协助：那句话在进入这一步时才填；看板导览段不预填任何东西。
        prefill: state.phase === "reply-done" ? askPrefill() : undefined
      })}
      onSkip={() => dispatchDemoGuide({
        type: "skip",
        // 跳过第一步就直接去请成员协助：那句话要跟着填上。导览段与后两步都不预填。
        prefill: demoGuideStepNumberOf(state.phase) === 1 ? askPrefill() : undefined
      })}
      onExit={() => void endDemoGuide("exited")}
      onRetry={() => dispatchDemoGuide({ type: "retry" })}
      onCloseComplete={() => {
        // 完成弹窗关掉：回这个项目的看板「协助」，两条记录留在眼前（刚才是从任务页过来的）。
        const localProjectId = state.localProjectId;
        const projectId = state.projectId;
        const threadId = helpThreadRef.current;
        dispatchDemoGuide({ type: "close-complete" });
        if (!localProjectId) return;
        if (projectId && threadId) requestAssistFocus({ projectId, threadId });
        openBoardRef.current(localProjectId);
      }}
      onInvite={() => {
        requestDemoGuideInvite();
        if (state.localProjectId) openBoardRef.current(state.localProjectId);
        dispatchDemoGuide({ type: "close-complete" });
      }}
    />
    {notice ? <div className={styles.notice} role="status">{notice}</div> : null}
    </>
  );
}

/** 演示是否正压在这个项目上：看板据此压住授权询问与就地提示。 */
export function useDemoGuideActiveFor(localProjectId: string | null): boolean {
  const state = useSyncExternalStore(subscribeDemoGuide, getDemoGuideState, getDemoGuideState);
  if (!localProjectId || state.status !== "active") return false;
  return state.localProjectId === localProjectId;
}

/** 全局是否在演示中：其他大卡与提示据此不出现。 */
export function useDemoGuideActive(): boolean {
  const state = useSyncExternalStore(subscribeDemoGuide, getDemoGuideState, getDemoGuideState);
  return state.status === "active";
}

export { isDemoGuideActive };
