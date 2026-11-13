import { AlertTriangle, CircleAlert } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./credits-error-previews.module.css";

export function AgentCreditsLimitNotice() {
  const { language } = useTranslation();
  const cn = language.startsWith("zh");
  return <div className={`${styles.limitLine} w-full`} role="alert" aria-label={cn ? "Agent 任务积分不足" : "Agent task out of credits"}>
    <span className={styles.limitMessage}><CircleAlert size={16} aria-hidden="true" />
      {cn ? "积分不足，当前任务已暂停。已完成内容保留，积分恢复或切换自有模型后，请手动继续。" : "Not enough credits. This task is paused and completed work is saved. Resume manually after credits return or you switch to your own model."}
    </span>
  </div>;
}

export function MemoryCreditsPausedNotice() {
  const { language } = useTranslation();
  const cn = language.startsWith("zh");
  return <section className={`agent-model-error-notice ${styles.notice}`} role="alert" aria-label={cn ? "记忆服务暂停" : "Memory service paused"}>
    <AlertTriangle size={16} className="agent-model-error-notice__icon" aria-hidden="true" />
    <div className={styles.noticeBody}>
      <h2 className="agent-model-error-notice__title">{cn ? "积分不足，记忆加工已暂停" : "Memory processing paused: not enough credits"}</h2>
      <p className={styles.description}>{cn ? "原始内容和已完成记忆保留。积分恢复，或记忆服务改用已配置的自有 API Key 模型后，将自动继续。" : "Source material and completed memories are saved. Processing resumes automatically when credits return or the memory service switches to a configured own API key model."}</p>
    </div>
  </section>;
}
