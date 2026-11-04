/**
 * 成员协助的宿主：轮询收件箱、发通知、弹出授权，并把协助本身显示成一个页面。
 *
 * 挂在应用根部：协作项目只在账号模式可用，这里也只在同一个条件下工作。执行方的请求每 5 秒查一次——
 * 云端没有推送通道，邀请与审批也是同一个做法。
 *
 * 两种视角共用同一份视图：别人请求她执行时看执行过程（授权条、每一步、结果），她自己发起时看请求卡片。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { AssistExecution, AssistInboxItem, AssistRequest, CollabClient } from "../api/collab-client.js";
import { useOptionalNotificationCenter } from "../components/notification-center.js";
import { useTranslation } from "../i18n/use-translation.js";
import { CollabAssistDialog } from "./collab-assist-dialog.js";
import { CollabAssistRequestCard } from "./collab-assist-card.js";
import { CollabAssistTask, agentNameOf } from "./collab-assist-task.js";

/** 收件箱的轮询间隔：与看板一致，够快也不打扰。 */
export const ASSIST_POLL_MS = 5_000;

export function CollabAssistHost(props: {
  collab: CollabClient | null;
  /** 协作项目可用且处于账号模式；关掉后不再轮询。 */
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const notifications = useOptionalNotificationCenter();
  const { collab, enabled } = props;
  const [inbox, setInbox] = useState<AssistInboxItem[]>([]);
  const [dialogRequest, setDialogRequest] = useState<AssistInboxItem | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [view, setView] = useState<{ request: AssistRequest; execution?: AssistExecution } | null>(null);
  /** 已经提示过的请求：重启不重复提示，同一条请求只弹一次。 */
  const announced = useRef(new Set<string>());

  const poll = useCallback(async () => {
    if (!collab || !enabled) return;
    let next: AssistInboxItem[] = [];
    try {
      next = (await collab.assistInbox()).requests;
    } catch {
      return;
    }
    setInbox(next);
    for (const item of next) {
      if (announced.current.has(item.id)) continue;
      if (item.status !== "pending" && item.status !== "confirm") continue;
      announced.current.add(item.id);
      // 一条不打断她的通知：点击就打开授权或确认。
      notifications?.notify({
        variant: "info",
        title: t("collab.assist.notifyTitle", { name: item.requester.name }),
        body: item.status === "confirm"
          ? t("collab.assist.notifyConfirmBody", {
              agent: agentNameOf(item.agent ?? item.grantAgent, t("collab.assist.executorFallback")),
              issue: item.reason
            })
          : t("collab.assist.notifyBody", { issue: item.reason }),
        actionLabel: t("collab.assist.notifyAction"),
        onAction: () => setDialogRequest(item)
      });
      // 已经有长期授权的请求不打扰她：她的 Memmy 会直接开始执行。
      if (item.status === "pending" && !item.granted) setDialogRequest(item);
    }
  }, [collab, enabled, notifications, t]);

  useEffect(() => {
    announced.current.clear();
    setInbox([]);
    setDialogRequest(null);
    setOpenId(null);
    setView(null);
  }, [collab, enabled]);

  useEffect(() => {
    if (!collab || !enabled) return;
    void poll();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, ASSIST_POLL_MS);
    return () => clearInterval(timer);
  }, [collab, enabled, poll]);

  /** 打开一条请求：执行方看任务页，发起方看请求卡片。 */
  useEffect(() => {
    if (!collab || !openId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const request = await collab.assistRequest(openId);
        const executions = await collab.assistExecutions();
        if (cancelled) return;
        setView({ request, ...(executions.find((item) => item.requestId === openId) ? { execution: executions.find((item) => item.requestId === openId)! } : {}) });
      } catch {
        if (!cancelled) setView(null);
      }
    };
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, ASSIST_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [collab, openId]);

  const pendingCount = useMemo(
    () => inbox.filter((item) => item.status === "pending" || item.status === "confirm").length,
    [inbox]
  );

  if (!collab || !enabled) return null;

  return (
    <>
      <CollabAssistDialog
        open={dialogRequest !== null}
        request={dialogRequest}
        collab={collab}
        onDecided={async (decision) => {
          if (!dialogRequest) return;
          const decided = await collab.decideAssist(dialogRequest.id, decision);
          setDialogRequest(null);
          announced.current.add(decided.id);
          // 允许之后直接打开执行过程：她点完就能看到 Agent 在做什么。
          if (decision.action === "allow") setOpenId(decided.id);
          void poll();
        }}
        onClose={() => setDialogRequest(null)}
      />

      {pendingCount > 0 && !dialogRequest ? (
        <button
          type="button"
          className="fixed bottom-4 right-4 z-40 rounded-full bg-action-sky px-4 py-2 text-xs font-semibold text-white shadow-lg"
          onClick={() => setDialogRequest(inbox.find((item) => item.status === "pending" || item.status === "confirm") ?? null)}
        >
          {t("collab.assist.pendingBadge", { count: String(pendingCount) })}
        </button>
      ) : null}

      {view ? (
        <div className="fixed inset-0 z-30 flex flex-col bg-background-paper">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border-stone/30 px-4 text-[13px] text-text-ink/50">
            <span>{t("collab.assist.crumbsProject")}</span>
            <span>/</span>
            <span>{view.request.projectName}</span>
            <span>/</span>
            <strong className="font-semibold text-text-ink">{view.request.title}</strong>
            <span className="flex-1" />
            <button
              type="button"
              aria-label={t("common.close")}
              className="flex h-7 w-7 items-center justify-center rounded-[7px] text-text-ink/50 hover:bg-canvas-oat"
              onClick={() => {
                setOpenId(null);
                setView(null);
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          {view.request.mine ? (
            <div className="flex-1 overflow-auto px-6 py-5">
              <div className="mx-auto w-full max-w-[760px]">
                <CollabAssistRequestCard
                  request={view.request}
                  collab={collab}
                  onChanged={(request) => setView((current) => (current ? { ...current, request } : current))}
                />
              </div>
            </div>
          ) : (
            <CollabAssistTask
              request={view.request}
              {...(view.execution ? { execution: view.execution } : {})}
              collab={collab}
              onChanged={(request) => setView((current) => (current ? { ...current, request } : current))}
              onRevoked={() => void poll()}
            />
          )}
        </div>
      ) : null}
    </>
  );
}