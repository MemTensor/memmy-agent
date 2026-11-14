/**
 * 引导的宿主：挂在应用根部，负责推进引导与调用云端的协作接口。
 *
 * 蒙版与卡片在 {@link CollabDemoGuideOverlay}；这里做三件事：
 * 1. 按当前子状态轮询协助（第二步等结果、第三步等请求与执行结果），不靠定时器猜步骤；
 * 2. 该换页面时换页面（第二步结束后回看板、允许协助后回到看板的「协助」）；
 * 3. 演示一停就叫云端结束，并在离开看板或关窗时尽力发送。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CollabClient } from "../../api/collab-client.js";
import { requestAssistFocus } from "../../app/collab-assist-focus.js";
import { requestDemoGuideInvite } from "../../app/collab-demo-guide-invite.js";
import {
  dispatchDemoGuide,
  endDemoGuide,
  getDemoGuideState,
  isDemoGuideActive,
  subscribeDemoGuide
} from "../../app/collab-demo-guide-store.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { CollabDemoGuideOverlay } from "./collab-demo-guide-overlay.js";
import styles from "./collab-demo-guide.module.css";

/** 第二步等结果、第三步等请求与执行结果时的轮询间隔：够快，也不至于一直打本机接口。 */
export const DEMO_GUIDE_POLL_MS = 1_500;

/** 等小饭团的请求最多等这么久：超时就按「这一步没有完成」处理，不让人卡在蒙版里。 */
const HELP_REQUEST_TIMEOUT_MS = 30_000;

export function CollabDemoGuideHost(props: {
  collab: CollabClient | null;
  /** 当前路由：只在看板与对话页之间时不算离开。 */
  route: string;
  /** 打开某个本机项目的看板。 */
  openBoard: (localProjectId: string) => void;
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
  const noticeRef = useRef(props.onNotice);
  noticeRef.current = props.onNotice;
  const collabRef = useRef(props.collab);
  collabRef.current = props.collab;
  /** 第三步那条请求的 id：允许之后回到看板时要展开的就是它。 */
  const helpThreadRef = useRef<string | null>(null);
  const helpSinceRef = useRef<number | null>(null);
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
  useEffect(() => {
    if (state.status !== "active") return;
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

  // 第二步结束后回到看板：下一步是从看板的项目设置开始。
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
    let cancelled = false;

    /** 第二步：本项目里由我发起、执行人是演示成员的那次协助有了结果。 */
    const readAskOutcome = async () => {
      const listing = await client.assistThreads(projectId);
      const thread = listing.threads.find((item) => (
        item.requester.mine && item.executor.userId === memberUserId
      ));
      const latest = thread?.requests[0];
      if (!latest) return;
      if (latest.status === "done") {
        dispatchDemoGuide({ type: "assist-delivered" });
        return;
      }
      if (latest.status === "rejected" || latest.status === "failed" || latest.status === "expired" || latest.status === "cancelled") {
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
          // 「允许」之后就回到看板的「协助」，展开这一次。
          dispatchDemoGuide({ type: "help-decided", allow: true });
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
  }, [state.status, state.phase, state.projectId, state.memberUserId, state.localProjectId, state.memberName, props.collab, t]);

  // 心跳或请求说演示已结束（云端返回 `demo: null`）：直接收场，并告诉用户体验已经结束。
  useEffect(() => {
    if (!state.cloudEnded || cloudEndedNoticedRef.current) return;
    cloudEndedNoticedRef.current = true;
    setNotice(t("collab.demo.ended"));
    noticeRef.current(t("collab.demo.ended"));
  }, [state.cloudEnded, t]);

  // 换了一步就重新计时：第三步的 30 秒从「开启接收」之后算起。
  useEffect(() => {
    helpSinceRef.current = null;
  }, [state.phase]);

  // 第二步那句话由界面按当前语言给出：句子里带着执行提示，句子本身也是用户看到的那一句。
  const askPrefill = () => t("collab.demo.prefill.ask", {
    name: state.memberName,
    member: state.memberUserId ?? ""
  });

  return (
    <>
    <CollabDemoGuideOverlay
      state={state}
      onNext={() => dispatchDemoGuide({
        type: "next",
        prefill: state.phase === "reply-done" ? askPrefill() : undefined
      })}
      onSkip={() => dispatchDemoGuide({
        type: "skip",
        prefill: state.phase === "task-row" || state.phase === "reader" || state.phase === "compose" || state.phase === "reply-waiting" || state.phase === "reply-done"
          ? askPrefill()
          : undefined
      })}
      onExit={() => void endDemoGuide("exited")}
      onRetry={() => dispatchDemoGuide({ type: "retry" })}
      onCloseComplete={() => dispatchDemoGuide({ type: "close-complete" })}
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
