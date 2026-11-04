/**
 * 成员协助的授权弹窗。
 *
 * 执行方收到别人的请求时看到它，弹窗回答三件事：谁在请求、要做什么，以及由哪个 Agent 执行、允许到什么程度。
 * 可选的执行方就是她在「在其他 Agent 中使用协作项目」里已关联的 Agent；这里不另做检测，也不替她挑。
 *
 * 「仅这一次」是默认项：之后的请求还会先问她。「以后都直接执行」记一条长期授权，可以在设置里结束。
 */
import { useEffect, useState } from "react";
import { Folder } from "lucide-react";
import type { AssistAgent, AssistInboxItem, AssistScope, CollabClient } from "../api/collab-client.js";
import { Button } from "../components/button.js";
import { Memmy } from "../components/mascot/memmy.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceLogoUrl } from "./agent-source-logos.js";
import styles from "./collab-assist-dialog.module.css";

export function CollabAssistDialog(props: {
  open: boolean;
  /** 收到的那条请求：谁发的、要做的事、来自哪个项目。 */
  request: AssistInboxItem | null;
  collab: CollabClient | null;
  /** 她做完选择：允许时带上 Agent 与授权方式，拒绝时只有 action。 */
  onDecided: (decision: { action: "allow" | "reject"; agent?: string; scope?: AssistScope }) => Promise<void> | void;
  /** 关闭弹窗，等于这次先不做选择：请求仍在收件箱里等她。 */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AssistAgent[] | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [scope, setScope] = useState<AssistScope>("once");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { collab, open, request } = props;

  useEffect(() => {
    if (!open || !collab || !request) return;
    let cancelled = false;
    setAgents(null);
    setAgent(null);
    setScope("once");
    setBusy(false);
    setError(null);
    void collab.assistAgents(request.projectId)
      .then((list) => {
        if (cancelled) return;
        const usable = list.filter((item) => item.available);
        setAgents(usable);
        // 默认选中第一个可用的：让她一眼看到「允许」会由谁来执行。
        setAgent(usable[0]?.sourceId ?? null);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [collab, open, request]);

  if (!request) return null;
  const requester = request.requester.name;
  const chosen = agents?.find((item) => item.sourceId === agent) ?? null;
  const agentName = chosen?.name ?? t("collab.assist.executorFallback");

  async function submit(action: "allow" | "reject") {
    if (busy) return;
    if (action === "allow" && !agent) return;
    setBusy(true);
    setError(null);
    try {
      await props.onDecided({ action, ...(action === "allow" && agent ? { agent, scope } : {}) });
    } catch {
      setError(t("collab.assist.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={t("collab.assist.title", { name: requester })}
      showHeader={false}
      onClose={busy ? undefined : props.onClose}
      closeLabel={t("common.close")}
      className={styles.dialog}
      backdropClassName={styles.backdrop}
      footer={(
        <div className={styles.actions}>
          <Button variant="ghost" disabled={busy} onClick={() => void submit("reject")}>
            {t("collab.assist.reject")}
          </Button>
          <Button variant="primary" disabled={busy || !agent} onClick={() => void submit("allow")}>
            {t("collab.assist.allow")}
          </Button>
        </div>
      )}
    >
      <div className={styles.top}>
        <Memmy pose="shield" size={56} className={styles.mascot} />
        <h2 className={styles.title}>{t("collab.assist.title", { name: requester })}</h2>
        <p className={styles.lead}>
          {t("collab.assist.lead", { name: requester, issue: request.reason, via: request.via })}
        </p>
      </div>

      <div className={styles.sect}>
        <div className={styles.sectKey}>
          <Folder size={13} aria-hidden="true" />
          {t("collab.assist.fromProject", { project: request.projectName })}
        </div>
        <div className={styles.todo}>
          <ol>
            {request.items.map((item) => <li key={item}>{item}</li>)}
          </ol>
        </div>
      </div>

      <div className={styles.sect}>
        <div className={styles.sectKey}>{t("collab.assist.byWhom")}</div>
        {agents === null ? (
          <p className={styles.listNote}>{t("collab.assist.loading")}</p>
        ) : agents.length ? (
          <div className={styles.agents}>
            {agents.map((item) => (
              <button
                key={item.sourceId}
                type="button"
                className={`${styles.agent} ${agent === item.sourceId ? styles.agentOn : ""}`}
                onClick={() => setAgent(item.sourceId)}
              >
                <span className={styles.radio} aria-hidden="true" />
                <span className={styles.agentLogo}>
                  {agentSourceLogoUrl(item.sourceId)
                    ? <img src={agentSourceLogoUrl(item.sourceId)} alt="" />
                    : <span className={styles.agentMark}>{Array.from(item.name)[0] ?? "A"}</span>}
                </span>
                <span className={styles.agentName}>{item.name}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className={styles.listNote}>{t("collab.assist.noAgents")}</p>
        )}
        <p className={styles.listNote}>{t("collab.assist.agentsNote")}</p>
      </div>

      <div className={styles.sect}>
        <div className={styles.sectKey}>{t("collab.assist.scopeTitle")}</div>
        <button
          type="button"
          className={`${styles.opt} ${scope === "once" ? styles.optOn : ""}`}
          onClick={() => setScope("once")}
        >
          <span className={styles.radio} aria-hidden="true" />
          <span className={styles.optBody}>
            <span className={styles.optTitle}>{t("collab.assist.scopeOnce")}</span>
            <span className={styles.optDesc}>{t("collab.assist.scopeOnceDesc", { name: requester })}</span>
          </span>
        </button>
        <button
          type="button"
          className={`${styles.opt} ${scope === "always" ? styles.optOn : ""}`}
          onClick={() => setScope("always")}
        >
          <span className={styles.radio} aria-hidden="true" />
          <span className={styles.optBody}>
            <span className={styles.optTitle}>{t("collab.assist.scopeAlways", { name: requester })}</span>
            <span className={styles.optDesc}>
              {t("collab.assist.scopeAlwaysDesc", {
                name: requester,
                project: request.projectName,
                agent: agentName
              })}
            </span>
          </span>
        </button>
      </div>

      <p className={styles.notice}>{t("collab.assist.notice")}</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </Modal>
  );
}