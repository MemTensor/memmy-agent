/**
 * 成员协助的宿主：轮询收件箱、发通知、弹出授权，并把人带到协助所在的地方。
 *
 * 挂在应用根部：协作项目只在账号模式可用，这里也只在同一个条件下工作。执行方的请求每 5 秒查一次——
 * 云端没有推送通道，邀请与审批也是同一个做法。
 *
 * 协助放在项目里：由 Memmy 执行时它就是项目里的一条 Memmy 任务，允许后直接进入；由外部 Agent 执行时
 * 打开项目看板并在右侧展开这次协助。通知随请求的状态收起：请求在别处处理掉（另一处点了允许、限时授权自动执行、
 * 对方撤回、过期）后，对应的通知不再留着。
 *
 * 发起方也在这里得到通知：从外部 Agent 发出的请求，Agent 常常不在本轮等到结果（比如对方不在线），
 * 结果回来、Agent 还没取走时弹一条通知，告诉发起人回到那个 Agent 取回结果，或者在项目的「协助」里查看。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AssistInboxItem, AssistOutcome, CollabClient } from "../api/collab-client.js";
import { requestAssistFocus } from "../app/collab-assist-focus.js";
import { getCollabProjectsSnapshot, subscribeCollabProjects } from "../app/collab-projects-store.js";
import { useOptionalNotificationCenter } from "../components/notification-center.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { CollabAssistDialog } from "./collab-assist-dialog.js";
import { assistAgentName } from "./collab-assist-view.js";

/** 收件箱的轮询间隔：与看板一致，够快也不打扰。 */
export const ASSIST_POLL_MS = 5_000;

/** 等她处理的请求：等待授权或等待确认。 */
function waitingForHer(item: AssistInboxItem): boolean {
  return item.status === "pending" || item.status === "confirm";
}

/** 发起方收到的结果通知：按结局写标题与正文。 */
function outcomeNotice(
  outcome: AssistOutcome,
  t: (key: MessageKey, values?: Record<string, string>) => string
): { variant: "success" | "info" | "warning"; title: string; body: string } {
  const name = outcome.executor.name;
  const title = outcome.title;
  switch (outcome.status) {
    case "done":
      return {
        variant: "success",
        title: t("collab.assist.outcome.doneTitle", { name }),
        body: t("collab.assist.outcome.doneBody", { title, via: outcome.via, name })
      };
    case "rejected":
      // 她关闭了接收协助请求时，原因写在 failure 里：照原因说。
      return {
        variant: "warning",
        title: t("collab.assist.outcome.rejectedTitle", { name }),
        body: outcome.failure ?? t("collab.assist.outcome.rejectedBody", { title })
      };
    case "expired":
      return {
        variant: "warning",
        title: t("collab.assist.outcome.expiredTitle"),
        body: t("collab.assist.outcome.expiredBody", { name, title })
      };
    case "stopped":
      return {
        variant: "info",
        title: t("collab.assist.outcome.stoppedTitle", { name }),
        body: t("collab.assist.outcome.stoppedBody", { title })
      };
    default:
      return {
        variant: "warning",
        title: t("collab.assist.outcome.failedTitle", { name }),
        body: t("collab.assist.outcome.failedBody", { title, reason: outcome.failure ?? t("collab.assist.state.failed") })
      };
  }
}

/** 等待确认、上一次由 Memmy 执行且任务还在：确认就在那条任务的底部进行，不另弹窗。 */
function confirmsInTask(item: AssistInboxItem): boolean {
  return item.status === "confirm" && item.lastAgent === "memmy" && Boolean(item.conversationId);
}

export function CollabAssistHost(props: {
  collab: CollabClient | null;
  /** 协作项目可用且处于账号模式；关掉后不再轮询。 */
  enabled: boolean;
  /**
   * 打开一条 Memmy 任务：执行方选了 Memmy 时，协助就是项目里的一条真实任务，直接进入它。
   * 参数是任务的 chat id。
   */
  onOpenTask?: (conversationId: string) => void;
  /** 打开某个本机项目的看板：由外部 Agent 执行的协助在看板右侧展开详情。 */
  onOpenBoard?: (localProjectId: string) => void;
  /**
   * 当前正开着看板的本机项目 id（未在看板时为 null）。属于它的待处理请求已经出现在看板的提示条与「协助」数字上，
   * 不再计入右下角角标：同一个请求不在两处同时催。
   */
  boardProjectId?: string | null;
}) {
  const { t } = useTranslation();
  const notifications = useOptionalNotificationCenter();
  const { collab, enabled } = props;
  /** 上层每次渲染都会给新的函数：放在 ref 里，轮询不必因此重启。 */
  const openTaskRef = useRef(props.onOpenTask);
  openTaskRef.current = props.onOpenTask;
  const openBoardRef = useRef(props.onOpenBoard);
  openBoardRef.current = props.onOpenBoard;
  const [inbox, setInbox] = useState<AssistInboxItem[]>([]);
  const [dialogRequest, setDialogRequest] = useState<AssistInboxItem | null>(null);
  /** 云端的项目列表：用来把请求的云端 id 对上本机项目，判断它是否正开在看板上。 */
  const projects = useSyncExternalStore(subscribeCollabProjects, getCollabProjectsSnapshot, getCollabProjectsSnapshot).projects ?? [];
  /** 已经提示过的请求 → 那条通知的 id：同一条请求只弹一次，请求处理掉后收起。 */
  const announced = useRef(new Map<string, string | null>());
  /** 已经通知过的发起方结果：本机删除失败时也不重复弹。 */
  const announcedOutcomes = useRef(new Set<string>());

  /** 把人带到这次协助：由 Memmy 执行的进入那条任务，其余打开项目看板并展开详情。 */
  const openAssist = useCallback((item: { projectId: string; threadId: string; conversationId?: string | null }, viaMemmy: boolean) => {
    if (viaMemmy && item.conversationId && openTaskRef.current) {
      openTaskRef.current(item.conversationId);
      return;
    }
    const project = (getCollabProjectsSnapshot().projects ?? []).find((candidate) => candidate.id === item.projectId);
    if (!project?.localProjectId || !openBoardRef.current) return;
    requestAssistFocus({ projectId: item.projectId, threadId: item.threadId });
    openBoardRef.current(project.localProjectId);
  }, []);

  /** 通知或右下角入口被点开：确认在任务里进行的直接进任务，其余弹授权。 */
  const actOn = useCallback((item: AssistInboxItem) => {
    if (confirmsInTask(item)) {
      openAssist(item, true);
      return;
    }
    setDialogRequest(item);
  }, [openAssist]);

  /** 发起方：外部 Agent 发出的请求有了结果、Agent 还没取走，各通知一次，通知过就从本机删掉。 */
  const announceOutcomes = useCallback(async () => {
    if (!collab?.assistOutcomes || !notifications) return;
    let outcomes: AssistOutcome[];
    try {
      outcomes = await collab.assistOutcomes();
    } catch {
      return;
    }
    for (const outcome of outcomes) {
      if (announcedOutcomes.current.has(outcome.requestId)) continue;
      announcedOutcomes.current.add(outcome.requestId);
      const notice = outcomeNotice(outcome, t);
      notifications.notify({
        variant: notice.variant,
        title: notice.title,
        body: notice.body,
        actionLabel: t("collab.assist.outcome.action"),
        onAction: () => openAssist({ projectId: outcome.projectId, threadId: outcome.threadId }, false)
      });
      void collab.dismissAssistOutcome?.(outcome.requestId).catch(() => undefined);
    }
  }, [collab, notifications, t, openAssist]);

  const poll = useCallback(async () => {
    if (!collab || !enabled) return;
    void announceOutcomes();
    let next: AssistInboxItem[] = [];
    try {
      next = (await collab.assistInbox()).requests;
    } catch {
      return;
    }
    setInbox(next);
    // 请求已经在别处处理掉：开着的授权弹窗不再有意义，直接关掉。
    setDialogRequest((current) => (
      current && !next.some((item) => item.id === current.id && waitingForHer(item)) ? null : current
    ));
    // 通知随请求状态收起：已经不等她处理的请求，把留着的通知撤掉。
    for (const [id, notificationId] of announced.current) {
      if (next.some((item) => item.id === id && waitingForHer(item))) continue;
      if (notificationId) notifications?.dismiss(notificationId);
      announced.current.set(id, null);
    }
    for (const item of next) {
      if (announced.current.has(item.id)) continue;
      if (!waitingForHer(item)) continue;
      const confirm = item.status === "confirm";
      // 一条不打断她的通知：点击就去授权或确认。
      const notificationId = notifications?.notify({
        variant: "info",
        title: t("collab.assist.notifyTitle", { name: item.requester.name }),
        body: confirm
          ? t("collab.assist.notifyConfirmBody", {
              agent: assistAgentName(item.lastAgent ?? item.agent ?? item.grantAgent, t("collab.assist.executorFallback")),
              issue: item.reason || item.title
            })
          : t("collab.assist.notifyBody", { issue: item.reason || item.title }),
        actionLabel: confirm ? t("collab.assist.notifyConfirmAction") : t("collab.assist.notifyAction"),
        onAction: () => actOn(item)
      }) ?? null;
      announced.current.set(item.id, notificationId);
      // 有生效中的限时授权的请求不打扰她：她的 Memmy 会直接开始执行。
      if (item.status === "pending" && !item.granted) setDialogRequest(item);
    }
  }, [collab, enabled, notifications, t, actOn, announceOutcomes]);

  useEffect(() => {
    announced.current.clear();
    setInbox([]);
    setDialogRequest(null);
  }, [collab, enabled]);

  useEffect(() => {
    if (!collab || !enabled) return;
    void poll();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, ASSIST_POLL_MS);
    return () => clearInterval(timer);
  }, [collab, enabled, poll]);

  const waiting = useMemo(() => {
    const onBoardId = props.boardProjectId;
    if (!onBoardId) return inbox.filter(waitingForHer);
    // 收件箱里的 projectId 是云端项目 id，看板记的是本机项目 id：过 projects 里的 localProjectId 对一次。
    const onBoard = new Set(projects
      .filter((project) => project.localProjectId === onBoardId)
      .map((project) => project.id));
    return inbox.filter((item) => waitingForHer(item) && !onBoard.has(item.projectId));
  }, [inbox, projects, props.boardProjectId]);

  if (!collab || !enabled) return null;

  return (
    <>
      <CollabAssistDialog
        open={dialogRequest !== null}
        request={dialogRequest}
        collab={collab}
        onDecided={async (decision) => {
          if (!dialogRequest) return;
          const request = dialogRequest;
          const decided = await collab.decideAssist(request.id, decision);
          setDialogRequest(null);
          void poll();
          if (decision.action !== "allow") return;
          // 由 Memmy 执行：等它在项目里建好任务（通常一两秒），直接进入那条任务。
          if (decision.agent === "memmy" && openTaskRef.current) {
            const conversationId = await waitForMemmyTask(collab, decided.id);
            if (conversationId) {
              openTaskRef.current?.(conversationId);
              return;
            }
          }
          // 由外部 Agent 执行：打开项目看板，在右侧展开这次协助。
          openAssist({ projectId: request.projectId, threadId: request.threadId }, false);
        }}
        onClose={() => setDialogRequest(null)}
      />

      {waiting.length > 0 && !dialogRequest ? (
        <button
          type="button"
          className="fixed bottom-4 right-4 z-40 rounded-full bg-action-sky px-4 py-2 text-xs font-semibold text-white shadow-lg"
          onClick={() => actOn(waiting[0]!)}
        >
          {t("collab.assist.pendingBadge", { count: String(waiting.length) })}
        </button>
      ) : null}
    </>
  );
}

/** 由 Memmy 执行时，等它在项目里建好那条任务；最多等 15 秒，等不到就退回看板。 */
async function waitForMemmyTask(collab: CollabClient, requestId: string): Promise<string | null> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const execution = (await collab.assistExecutions()).find((item) => item.requestId === requestId);
      if (execution?.conversationId) return execution.conversationId;
      if (execution?.status === "failed") return null;
    } catch {
      // 本机接口短暂不可用：下一次再试。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}
