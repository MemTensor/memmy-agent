/**
 * 邀请方的审核弹窗：有人通过我的邀请链接申请加入项目时，屏幕上直接弹出来。
 *
 * <p>挂在应用根部，账号模式下轮询云端。申请是对方在别的电脑上提交的，本机没有推送通道，
 * 所以与看板的「邀请」角标、成员弹窗用同一个办法：按固定间隔读一次，窗口在后台时跳过，
 * 切回来立刻补一次。</p>
 *
 * <p>一次只处理一条：多条待审核时先给最早的一条，处理完接着给下一条，标题旁说明还剩几条。
 * 关掉只收起当前这一条（本次运行不再打扰），申请本身还在项目成员列表里等着。</p>
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UserPlus, X } from "lucide-react";
import type { CollabClient, CollabManagedJoinRequest } from "../api/collab-client.js";
import { Button } from "../components/button.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import { memberColor } from "./collab-member-color.js";
import styles from "./collab-join-request.module.css";

/** 轮询间隔：比看板的「邀请」角标稍慢一点，够快也不至于一直打云端。 */
export const JOIN_REQUEST_POLL_MS = 15_000;

/** 一条申请的身份：同一个人在不同项目里是两条。 */
function requestKey(request: CollabManagedJoinRequest): string {
  return `${request.projectId}:${request.userId}`;
}

export function CollabJoinRequestHost(props: {
  collab: CollabClient | null;
  /** 只有账号模式且已登录才轮询：协作项目本身只在账号模式存在。 */
  enabled: boolean;
  /** 通过之后：调用方刷新项目列表，成员数随之更新。 */
  onApproved?: (request: CollabManagedJoinRequest) => void;
  /** 拒绝或通过后的提示文案，交给调用方统一弹提示。 */
  onNotice?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [requests, setRequests] = useState<CollabManagedJoinRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 本次运行里被关掉的那几条：申请还在，只是不再弹窗打扰。 */
  const dismissed = useRef(new Set<string>());
  const acting = useRef(false);
  acting.current = busy;

  const current = useMemo(
    () => requests.find((request) => !dismissed.current.has(requestKey(request))) ?? null,
    [requests]
  );
  const remaining = requests.filter((request) => !dismissed.current.has(requestKey(request))).length;

  const refresh = useCallback(async () => {
    if (!props.collab || acting.current) return;
    try {
      setRequests(await props.collab.joinRequests());
      setError(null);
    } catch {
      // 云端暂时不可用：保留上一份结果，下一轮再试。
    }
  }, [props.collab]);

  useEffect(() => {
    if (!props.enabled || !props.collab) {
      setRequests([]);
      return;
    }
    void refresh();
    const timer = setInterval(() => {
      if (document.hidden) return;
      void refresh();
    }, JOIN_REQUEST_POLL_MS);
    // 切回窗口时不必等下一个周期：审批通常发生在别人刚提交之后。
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [props.enabled, props.collab, refresh]);

  /** 审完一条就从列表里拿掉，并让下一轮读到的以云端为准。 */
  function settle(request: CollabManagedJoinRequest) {
    dismissed.current.delete(requestKey(request));
    setRequests((all) => all.filter((item) => requestKey(item) !== requestKey(request)));
  }

  async function decide(request: CollabManagedJoinRequest, approve: boolean) {
    if (!props.collab || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (approve) {
        await props.collab.approveRequest(request.projectId, request.userId);
        props.onApproved?.(request);
        props.onNotice?.(t("collab.requests.approved", { name: request.name, project: request.projectName }));
      } else {
        await props.collab.rejectRequest(request.projectId, request.userId);
        props.onNotice?.(t("collab.requests.rejected", { name: request.name }));
      }
      settle(request);
    } catch {
      // 别处已经处理过、或云端暂时不可用：重读一次，让列表反映真实状态。
      setError(t("collab.requests.failed"));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function dismiss(request: CollabManagedJoinRequest) {
    dismissed.current.add(requestKey(request));
    setError(null);
    // 列表本身不变，只是不再选它：重新读一次也会被 dismissed 挡住。
    setRequests((all) => [...all]);
  }

  if (!current) return null;

  const extra = remaining > 1 ? t("collab.requests.more", { count: String(remaining - 1) }) : null;

  return (
    <Modal
      open
      title={t("collab.requests.title", { project: current.projectName })}
      onClose={() => dismiss(current)}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      className={styles.dialog}
      backdropClassName={styles.backdrop}
      footerClassName={styles.footer}
      footer={(
        <>
          <span className={styles.hint}>{extra}</span>
          <span className={styles.actions}>
            <Button variant="ghost" disabled={busy} onClick={() => dismiss(current)}>
              {t("collab.requests.later")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void decide(current, false)}>
              {t("collab.requests.reject")}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void decide(current, true)}>
              {t("collab.requests.approve")}
            </Button>
          </span>
        </>
      )}
    >
      <div className={styles.person}>
        <span className={styles.avatar} style={{ background: memberColor(current.name) }} aria-hidden="true">
          {Array.from(current.name.trim())[0] ?? "?"}
        </span>
        <span className={styles.who}>
          <strong>{current.name}</strong>
          <span>{t("collab.requests.via", { inviter: current.inviterName })}</span>
        </span>
        <span className={styles.badge} aria-hidden="true"><UserPlus size={15} /></span>
      </div>
      <p className={styles.note}>{t("collab.requests.note")}</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </Modal>
  );
}
