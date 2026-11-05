/**
 * 成员协助在消息流里的两张卡片。
 *
 * 协助相关的两条消息由 Memmy 自己写进任务，正文包在标签里：
 * - `<memmy_assist_request>`：执行方任务的第一条消息（及同一次排查的后续请求），显示成请求卡片——
 *   谁的哪个 Agent 请求、第几次、起因、要做的事。交给模型的格式要求不在这条消息里。
 * - `<memmy_assist_result>`：结果回来后送回发起方任务的那条消息，显示成结果卡片。
 *
 * 模型读到的是完整原文；界面只把它换成卡片，不改写消息本身。
 */
import { useState } from "react";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import { AssistAgentLogo, assistAgentName } from "./collab-assist-view.js";
import { readAssistRequestBody, readAssistResultBody, type AssistEnvelope } from "./collab-assist-protocol.js";

export { parseAssistEnvelope, type AssistEnvelope } from "./collab-assist-protocol.js";
import styles from "./collab-assist-task.module.css";

export function AssistMessageCard(props: { envelope: AssistEnvelope }) {
  return props.envelope.kind === "request"
    ? <AssistRequestMessage envelope={props.envelope} />
    : <AssistResultMessage envelope={props.envelope} />;
}

function AssistRequestMessage(props: { envelope: AssistEnvelope }) {
  const { t } = useTranslation();
  const { attrs, lines } = props.envelope;
  const body = readAssistRequestBody(lines);
  const name = attrs.from ?? "";
  const attempt = Number.parseInt(attrs.attempt ?? "1", 10) || 1;
  return (
    <div className={styles.request} data-collab-assist-request="">
      <div className={styles.requestHead}>
        <span className={styles.avatar} style={{ background: "var(--color-action-sky, #5cbfae)" }}>{Array.from(name)[0] ?? ""}</span>
        <strong>{t("collab.assist.requestFrom", { name, via: attrs.via ?? "Memmy" })}</strong>
        {attempt > 1 ? <span>· {t("collab.assist.attemptLabel", { attempt: String(attempt) })}</span> : null}
      </div>
      <div className={styles.requestBody}>
        {body.reason ? <p>{t("collab.assist.detail.reason", { reason: body.reason })}</p> : null}
        <div className={styles.requestKey}>{t("collab.assist.cardTodo")}</div>
        {body.title ? <p>{body.title}</p> : null}
        {body.items.length ? <ol>{body.items.map((item) => <li key={item}>{item}</li>)}</ol> : null}
      </div>
    </div>
  );
}

/** 正文超过这么多字时先收起：逐项结果已经给出要点，正文按需展开。 */
const REPLY_PREVIEW_CHARS = 280;

function AssistResultMessage(props: { envelope: AssistEnvelope }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { attrs, lines } = props.envelope;
  const done = attrs.status === "done";
  const body = readAssistResultBody(lines);
  const name = attrs.from ?? "";
  const agent = attrs.agent ?? "";
  const sourceId = agentSourceIdOf(agent);
  return (
    <div className={styles.request} data-collab-assist-result="">
      <div className={styles.requestHead}>
        {done ? <CheckCircle2 size={14} aria-hidden="true" /> : <CircleAlert size={14} aria-hidden="true" />}
        {agent ? (
          <AssistAgentLogo agent={sourceId} name={agent} className={styles.agentLogo} markClassName={styles.agentMark} />
        ) : null}
        <strong>
          {done
            ? t("collab.assist.resultDone", { name, agent: agent || assistAgentName(null, t("collab.assist.executorFallback")) })
            : t("collab.assist.resultNotDone", { name })}
        </strong>
        <span className={styles.grow} />
        <span>{attrs.title}</span>
      </div>
      <div className={styles.requestBody}>
        {body.reply ? (
          <p className={styles.resultText}>
            {open || body.reply.length <= REPLY_PREVIEW_CHARS ? body.reply : `${body.reply.slice(0, REPLY_PREVIEW_CHARS)}…`}
            {body.reply.length > REPLY_PREVIEW_CHARS ? (
              <button type="button" className={styles.inlineToggle} onClick={() => setOpen((value) => !value)}>
                {open ? t("collab.assist.collapse") : t("collab.assist.detail.expand")}
              </button>
            ) : null}
          </p>
        ) : null}
        {body.items.length ? (
          <dl className={styles.resultRows}>
            {body.items.map((item) => (
              <div key={`${item.key}-${item.value}`}>
                <dt>{item.key}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {done ? <div className={styles.requestKey}>{t("collab.assist.resultSource", { name })}</div> : null}
      </div>
    </div>
  );
}

/** 结果里写的是 Agent 的名字：换回标识以便取图标。 */
function agentSourceIdOf(name: string): string | null {
  const ids: Record<string, string> = {
    Memmy: "memmy",
    "Claude Code": "claude_code",
    Codex: "codex",
    Cursor: "cursor",
    OpenCode: "opencode",
    OpenClaw: "openclaw",
    Hermes: "hermes",
    WorkBuddy: "workbuddy",
    QwenWork: "qwenwork",
    "DeepSeek Harness": "deepseek_harness",
    Pi: "pi"
  };
  return ids[name] ?? null;
}
