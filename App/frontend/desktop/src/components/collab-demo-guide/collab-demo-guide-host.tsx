/**
 * 引导的宿主：挂在应用根部，负责推进引导与调用云端的协作接口。
 *
 * 蒙版与卡片在 {@link CollabDemoGuideOverlay}；这里做三件事：
 * 1. 该换页面时换页面（退回任务里的屏时把对话页拉回来，退回看板上的屏时回看板）；看板导览全程不换页；
 * 2. 演示一停就叫云端结束，并在离开看板或关窗时尽力发送；
 * 3. 演示结束后立刻重读项目列表，蒙版下面不会留着旧数据。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CollabClient } from "../../api/collab-client.js";
import { requestDemoGuideInvite } from "../../app/collab-demo-guide-invite.js";
import {
  demoGuideBackTarget,
  demoGuideLivesOnTaskPage,
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

export function CollabDemoGuideHost(props: {
  collab: CollabClient | null;
  /** 当前路由：只在看板与对话页之间时不算离开。 */
  route: string;
  /** 打开某个本机项目的看板。 */
  openBoard: (localProjectId: string) => void;
  /** 回对话页（当前那条任务）：接续成员的任务要继续在任务里发消息。 */
  openTaskPage: () => void;
  /** 当前开着的看板是哪个本机项目（不在看板时为空）：换到别的项目就算离开。 */
  boardProjectId: string | null;
  /** 一次性提示（如「体验已结束」）：引导跨页面，提示也由自己显示。 */
  onNotice: (message: string) => void;
}) {
  const { t } = useTranslation();
  const state = useSyncExternalStore(subscribeDemoGuide, getDemoGuideState, getDemoGuideState);
  /** 上层每次渲染都给新的函数：放进 ref，回调里用到的永远是最新那个。 */
  const openBoardRef = useRef(props.openBoard);
  openBoardRef.current = props.openBoard;
  const openTaskPageRef = useRef(props.openTaskPage);
  openTaskPageRef.current = props.openTaskPage;
  const noticeRef = useRef(props.onNotice);
  noticeRef.current = props.onNotice;
  const collabRef = useRef(props.collab);
  collabRef.current = props.collab;
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

  /** 退回上一屏时要重新填进输入框的那句话：退到输入框那一屏才给句子，其余屏不带。 */
  const backPrefill = () => {
    const target = demoGuideBackTarget(state);
    if (target === "compose") return t("collab.demo.prefill.task", { name: state.memberName, next: state.copy.taskNext });
    return undefined;
  };

  /**
   * 退回上一屏时把页面恢复到那一屏该有的样子。
   *
   * 退回去的那一屏在哪个页面，就先把人放回那个页面：任务里的屏留在看板上、看板上的屏留在任务页，
   * 蒙版都会因为找不到锚点而一片空白（看起来就是「引导消失了」）。
   */
  const onBack = () => {
    const target = demoGuideBackTarget(state);
    dispatchDemoGuide({ type: "back", prefill: backPrefill() });
    if (!target) return;
    if (demoGuideLivesOnTaskPage(target)) {
      if (props.route !== "/main") openTaskPageRef.current();
    } else if (props.route !== "/collab" && state.localProjectId) {
      openBoardRef.current(state.localProjectId);
    }
  };

  return (
    <>
      <CollabDemoGuideOverlay
        state={state}
        onSkipJoinEntry={() => dispatchDemoGuide({ type: "skip-join-entry" })}
        onBack={onBack}
        onNext={() => dispatchDemoGuide(state.phase === "joined"
          // 加入那一屏的主按钮是「继续」：与旧的「开始体验」同一个事件，进看板导览。
          ? { type: "joined-confirmed" }
          : { type: "next" })}
        onSkip={() => dispatchDemoGuide(state.phase === "tour-associate-pick"
          // 「关联会话」不是一步，而是导览里的一站：跳过它只往下一站走，不结束整轮演示。
          ? { type: "pass" }
          : { type: "skip" })}
        onGrant={() => dispatchDemoGuide({ type: "grant-access" })}
        onExit={() => void endDemoGuide("exited")}
        onRetry={() => dispatchDemoGuide({ type: "retry" })}
        onCloseComplete={() => {
          // 完成弹窗关掉：回这个项目的看板（刚才是从任务页过来的）。
          const localProjectId = state.localProjectId;
          dispatchDemoGuide({ type: "close-complete" });
          if (!localProjectId) return;
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
