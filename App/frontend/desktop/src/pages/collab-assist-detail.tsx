/**
 * 执行方的任务内确认卡片：同一次排查里她已经授权过、但现在没有生效中的限时授权时，后续请求在这里确认。
 *
 * 看板右侧原来的协助详情已由协助会话（collab-assist-conversation.tsx）取代；这张卡片在会话与执行方任务页底部共用，
 * 样式仍在 collab-assist-detail.module.css。
 */
import { useState } from "react";
import { AlertCircle } from "lucide-react";
import type { AssistGrantMinutes } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { DEFAULT_GRANT_MINUTES, GrantDurationPicker } from "./collab-assist-view.js";
import styles from "./collab-assist-detail.module.css";

/** 任务内确认的选择：不允许、允许这一次，或在一段时间内直接执行。 */
export type ConfirmDecision =
  | { action: "allow"; scope: "once" }
  | { action: "allow"; scope: "timed"; minutes: AssistGrantMinutes }
  | { action: "reject" };

/**
 * 同一次排查里她已经授权过、但现在没有生效中的限时授权时，后续请求需要执行方确认。三个选择与授权弹窗一致：
 * 不允许 / 允许这一次 / 限时直接执行（默认 1 小时）。由 Memmy 执行时这张卡片出现在那条任务的底部，
 * 外部 Agent 执行时出现在这里。
 */
export function ConfirmCard(props: {
  requesterName: string;
  attempt: number;
  agentName: string;
  busy: boolean;
  onDecide: (decision: ConfirmDecision) => void;
}) {
  const { t } = useTranslation();
  const [minutes, setMinutes] = useState<AssistGrantMinutes>(DEFAULT_GRANT_MINUTES);
  return (
    <div className={styles.confirm} role="group" aria-label={t("collab.assist.askTitle", { name: props.requesterName, attempt: String(props.attempt) })}>
      <div className={styles.confirmHead}>
        <AlertCircle size={15} aria-hidden="true" />
        {t("collab.assist.askTitle", { name: props.requesterName, attempt: String(props.attempt) })}
      </div>
      <div className={styles.confirmBody}>{t("collab.assist.askBody", { agent: props.agentName })}</div>
      <div className={styles.confirmDuration}>
        <span>{t("collab.assist.askTimedLabel")}</span>
        <GrantDurationPicker value={minutes} onChange={setMinutes} disabled={props.busy} label={t("collab.assist.askTimedLabel")} />
      </div>
      <div className={styles.confirmActions}>
        <button type="button" className={styles.button} disabled={props.busy} onClick={() => props.onDecide({ action: "reject" })}>
          {t("collab.assist.askDeny")}
        </button>
        <button type="button" className={styles.button} disabled={props.busy} onClick={() => props.onDecide({ action: "allow", scope: "once" })}>
          {t("collab.assist.askAllowOnce")}
        </button>
        <button type="button" className={`${styles.button} ${styles.buttonPrimary}`} disabled={props.busy} onClick={() => props.onDecide({ action: "allow", scope: "timed", minutes })}>
          {t("collab.assist.askTimed")}
        </button>
      </div>
    </div>
  );
}
