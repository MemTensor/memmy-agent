/**
 * 协作项目的「在其他 Agent 中使用」授权弹窗。
 *
 * 两个时机共用它：本人首次建立协作、引导结束后弹一次；加入别人项目的人在第一次打开看板时弹一次。
 * 选「暂不授权」只出一条提示，之后不再主动询问，只能从「设置 → 偏好 → 协作项目」授权。
 *
 * 两步：先讲授权后能做什么并列出要装的 Agent，点「授权」后原地换成逐个安装的结果页。
 */
import { useEffect, useState } from "react";
import { AlertCircle, Check, FileText, Link2, Loader2, MessageSquare } from "lucide-react";
import type { CollabAgentInstallResult, CollabClient } from "../api/collab-client.js";
import { Button } from "../components/button.js";
import { Memmy } from "../components/mascot/memmy.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceLogoUrl } from "./agent-source-logos.js";
import { CollabAgentChips, collabAgentParts } from "./collab-agent-chips.js";
import styles from "./collab-agent-access.module.css";

/** 弹窗里列出的一个 Agent。 */
export interface CollabAgentAccessCandidate {
  sourceId: string;
  name: string;
  enabled: boolean;
  added: boolean;
}

export function CollabAgentAccessDialog(props: {
  open: boolean;
  collab: CollabClient | null;
  /** 示例句里的项目名：让人知道那句话怎么说。 */
  projectName?: string;
  /**
   * 用户做完选择：`granted` 为 true 表示已授权（可能有个别 Agent 没装上）。
   * 调用方据此记下已经问过，并刷新看板或清单。
   */
  onDecided: (granted: boolean, results: CollabAgentInstallResult[]) => void;
  /** 关闭弹窗；未做选择时按「暂不授权」处理，由调用方记下已经问过。 */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<CollabAgentAccessCandidate[] | null>(null);
  const [disabledNames, setDisabledNames] = useState<string[]>([]);
  /** ask：先讲能做什么；installing / done：逐个安装与结果。 */
  const [phase, setPhase] = useState<"ask" | "installing" | "done">("ask");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<CollabAgentInstallResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { collab, open } = props;

  useEffect(() => {
    if (!open || !collab) return;
    let cancelled = false;
    setCandidates(null);
    setResults([]);
    setError(null);
    setBusy(false);
    setPhase("ask");
    void collab.getAgentAccess()
      .then((view) => {
        if (cancelled) return;
        setCandidates(view.agents
          .filter((agent) => agent.available)
          .map((agent) => ({ sourceId: agent.sourceId, name: agent.name, enabled: agent.enabled, added: agent.added })));
        setDisabledNames(view.agents.filter((agent) => agent.available && !agent.enabled).map((agent) => agent.name));
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [collab, open]);

  const installable = (candidates ?? []).filter((agent) => agent.enabled);
  const failed = results.filter((item) => !item.ok);
  const doneCount = results.filter((item) => item.ok).length;

  async function grant() {
    if (!collab || busy) return;
    setBusy(true);
    setError(null);
    setPhase("installing");
    try {
      const result = await collab.setAgentAccess(true);
      setResults(result.results);
      setPhase("done");
    } catch {
      setError(t("collab.access.failed"));
      setPhase("ask");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!collab || busy) return;
    setBusy(true);
    try {
      const pending = failed.map((item) => item.sourceId);
      const result = await collab.installAgentAccess(pending);
      setResults((current) => {
        const next = current.filter((item) => !pending.includes(item.sourceId));
        return [...next, ...result.results];
      });
    } catch {
      setError(t("collab.access.failed"));
    } finally {
      setBusy(false);
    }
  }

  /** 一个 Agent 现在的状态：安装结果按 sourceId 对上，没有结果的算还没开始。 */
  function statusOf(sourceId: string) {
    const result = results.find((item) => item.sourceId === sourceId);
    if (result) return result.ok ? "done" : "failed";
    return phase === "installing" ? "installing" : "pending";
  }

  const title = phase === "ask"
    ? t("collab.access.title")
    : busy
      ? t("collab.access.installingTitle")
      : failed.length
        ? t("collab.access.donePartialTitle", { done: String(doneCount), failed: String(failed.length) })
        : t("collab.access.doneTitle", { count: String(doneCount) });
  const lead = phase === "ask"
    ? t("collab.access.askLead")
    : busy
      ? t("collab.access.installingLead")
      : t("collab.access.doneLead");

  return (
    <Modal
      open={open}
      title={title}
      showHeader={false}
      onClose={busy ? undefined : props.onClose}
      closeLabel={t("common.close")}
      className={styles.dialog}
      /* Agent 可能很多（十几个都装过）：正文区单独滚动，底部按钮不被顶出窗口。 */
      bodyClassName={styles.body}
      footerClassName={styles.footer}
      backdropClassName={styles.backdrop}
      footer={phase === "ask" ? (
        <div className={styles.actions}>
          <Button variant="ghost" onClick={props.onClose}>{t("collab.access.decline")}</Button>
          <Button variant="primary" disabled={busy || candidates === null} onClick={() => void grant()}>
            {t("collab.access.grant")}
          </Button>
        </div>
      ) : (
        <div className={styles.actions}>
          {failed.length && !busy ? (
            <Button variant="ghost" onClick={() => void retry()}>{t("collab.access.retry")}</Button>
          ) : null}
          <Button variant="primary" disabled={busy} onClick={() => props.onDecided(true, results)}>
            {t("collab.access.done")}
          </Button>
        </div>
      )}
    >
      <div className={styles.top}>
        <Memmy
          pose={phase === "ask" ? "shield" : busy ? "connect" : "celebrate"}
          size={88}
          className={styles.mascot}
        />
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.lead}>{lead}</p>
      </div>

      {phase === "ask" ? (
        <>
          <div className={styles.caps}>
            <span className={styles.cap}><Link2 size={15} aria-hidden="true" />{t("collab.access.capPick")}</span>
            <span className={styles.cap}><MessageSquare size={15} aria-hidden="true" />{t("collab.access.capChat")}</span>
            <span className={styles.cap}><FileText size={15} aria-hidden="true" />{t("collab.access.capContext")}</span>
          </div>
          <p className={styles.head}>{t("collab.access.agentsHead")}</p>
          {candidates === null ? (
            <p className={styles.note}>{t("collab.access.loading")}</p>
          ) : installable.length ? (
            <CollabAgentChips agents={installable} />
          ) : (
            <p className={styles.note}>{t("collab.access.emptyAgents")}</p>
          )}
          {disabledNames.length ? (
            <p className={styles.note}>{t("collab.access.disabledAgents", { names: disabledNames.join("、") })}</p>
          ) : null}
          <p className={styles.note}>{t("collab.access.note")}</p>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </>
      ) : (
        <>
          <div className={styles.rows}>
            {installable.map((agent) => {
              const status = statusOf(agent.sourceId);
              return (
                <div key={agent.sourceId} className={styles.row}>
                  {agentSourceLogoUrl(agent.sourceId)
                    ? <img className={styles.rowLogo} src={agentSourceLogoUrl(agent.sourceId)} alt="" />
                    : <span className={styles.rowMark}>{Array.from(agent.name)[0] ?? "A"}</span>}
                  <span className={styles.rowName}>{agent.name}</span>
                  {status === "done" ? (
                    <span className={`${styles.status} ${styles.statusOk}`}>
                      <Check size={13} aria-hidden="true" />{t("collab.access.rowDone")}
                    </span>
                  ) : status === "failed" ? (
                    <span className={`${styles.status} ${styles.statusErr}`}>
                      <AlertCircle size={13} aria-hidden="true" />{t("collab.access.rowFailed")}
                    </span>
                  ) : status === "installing" ? (
                    <span className={`${styles.status} ${styles.statusWait}`}>
                      <Loader2 size={13} className={styles.spin} aria-hidden="true" />{t("collab.access.rowInstalling")}
                    </span>
                  ) : (
                    <span className={`${styles.status} ${styles.statusWait}`}>{t("collab.access.rowPending")}</span>
                  )}
                </div>
              );
            })}
          </div>
          {!busy ? (
            <>
              <div className={styles.example}>
                {t("collab.access.example", { agent: firstAgentName(installable, t("collab.access.exampleAgent")) })}
                <span className={styles.exampleAsk}>
                  {t("collab.access.exampleAsk", { project: props.projectName ?? "" })}
                </span>
              </div>
              <p className={styles.note}>
                {t("collab.access.doneNote")}
                {failed.length ? ` ${t("collab.access.failedNote", { names: failed.map((item) => item.name).join("、") })}` : ""}
              </p>
            </>
          ) : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </>
      )}
    </Modal>
  );
}

function firstAgentName(agents: readonly CollabAgentAccessCandidate[], fallback: string): string {
  const hooked = agents.find((agent) => collabAgentParts(agent.sourceId) === "hook");
  return hooked?.name ?? agents[0]?.name ?? fallback;
}
