/**
 * 成员协助的授权弹窗。
 *
 * 执行方收到别人的请求时看到它，弹窗回答三件事：谁在请求、要做什么，以及由哪个 Agent 执行、允许到什么程度。
 * 可选的执行方是这台电脑上能运行的 Agent，分两层：这个项目里用过的（Memmy 固定第一个）直接列出，
 * 其余收起成一行「使用其他 Agent（N）」。默认选中她给这位成员选过的 Agent，没有就是 Memmy。
 *
 * 「仅这一次」是默认项：之后的请求还会先问她。「一段时间内直接执行」记一条限时授权（30 分钟到 4 小时，默认 1 小时），
 * 到时自动结束，也可以在项目设置里提前结束。
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Folder } from "lucide-react";
import type {
  AssistAgent,
  AssistGrantMinutes,
  AssistInboxItem,
  AssistRequest,
  AssistSafety,
  AssistScope,
  CollabClient
} from "../api/collab-client.js";
import { Button } from "../components/button.js";
import { Memmy } from "../components/mascot/memmy.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceSquareLogoUrl } from "./agent-source-logos.js";
import { AssistAttachments } from "./collab-assist-attachments.js";
import { AssistItems } from "./collab-assist-items.js";
import { DEFAULT_GRANT_MINUTES, GrantDurationPicker, assistReviewLine, assistWaitedText } from "./collab-assist-view.js";
import styles from "./collab-assist-dialog.module.css";

export function CollabAssistDialog(props: {
  open: boolean;
  /** 收到的那条请求：谁发的、要做的事、来自哪个项目。 */
  request: AssistInboxItem | null;
  /**
   * 这条请求最新的安全检查：宿主每次轮询收件箱都传进来。审查在弹窗打开之后才完成时，
   * 原因行靠它出现；`request` 对象保持不变，她在这里做的选择不会被重置。
   */
  safety?: AssistSafety | null;
  collab: CollabClient | null;
  /** 她做完选择：允许时带上 Agent 与授权方式（限时带时长），拒绝时只有 action。 */
  onDecided: (decision: { action: "allow" | "reject"; agent?: string; scope?: AssistScope; minutes?: AssistGrantMinutes }) => Promise<void> | void;
  /** 新手引导的演示中：弹窗是亮区、「允许」是描边目标，弹窗自己的遮罩让给引导遮罩。 */
  demoAnchor?: boolean;
  /** 关闭弹窗，等于这次先不做选择：请求仍在收件箱里等她。 */
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AssistAgent[] | null>(null);
  const [agent, setAgent] = useState<string | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const [scope, setScope] = useState<AssistScope>("once");
  const [minutes, setMinutes] = useState<AssistGrantMinutes>(DEFAULT_GRANT_MINUTES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 收件箱不带附件正文：拿到带正文的详情后替换显示用的请求。 */
  const [detail, setDetail] = useState<AssistRequest | null>(null);
  const durationRef = useRef<HTMLDivElement | null>(null);
  const { collab, open, request } = props;

  // 选了「一段时间内直接执行」后，时长出现在这一项里面；弹窗正文较长时把它滚进可见区域。
  useEffect(() => {
    if (scope === "timed") durationRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [scope]);

  useEffect(() => {
    if (!open || !collab || !request) return;
    let cancelled = false;
    setAgents(null);
    setAgent(null);
    setShowOthers(false);
    setScope("once");
    setMinutes(DEFAULT_GRANT_MINUTES);
    setBusy(false);
    setError(null);
    void collab.assistAgents(request.projectId, request.requester.userId)
      .then((choice) => {
        if (cancelled) return;
        const usable = choice.agents.filter((item) => item.available);
        setAgents(usable);
        // 默认选中她给这位成员选过的 Agent；它在「其他」那一层时自动展开，让她看得到选的是谁。
        const preferred = usable.find((item) => item.sourceId === choice.defaultAgent) ?? usable[0] ?? null;
        setAgent(preferred?.sourceId ?? null);
        setShowOthers(preferred?.group === "other");
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [collab, open, request]);

  // 收件箱里的请求不带附件正文：弹窗打开时按需拉一次详情。拉不到就不显示附件区，不弹错误打扰她。
  useEffect(() => {
    setDetail(null);
    if (!open || !collab || !request || request.attachments !== null) return;
    let cancelled = false;
    void collab.assistRequest(request.id, { withAttachments: true })
      .then((full) => {
        if (!cancelled) setDetail(full);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [collab, open, request]);

  if (!request) return null;
  const shown = detail && detail.id === request.id ? detail : request;
  const attachments = shown.attachments ?? [];
  const requester = request.requester.name;
  // 发起方用的 Agent 写在请求里（如 Codex、Memmy）；旧请求没有或为空时退回「Agent」，弹窗里能看出这次是谁发起的。
  const via = request.via?.trim() || t("collab.assist.executorFallback");
  const chosen = agents?.find((item) => item.sourceId === agent) ?? null;
  const agentName = chosen?.name ?? t("collab.assist.executorFallback");
  const waited = assistWaitedText(request.waitingSeconds, t);
  // 她的 Memmy 检查过之后认为需要她确认：标题下用一行说明为什么，不加块、不加边框。
  // 宿主传进来的是最新的一份，详情是为附件拉的、可能比收件箱晚一步：哪份有结论就用哪份。
  const safety = props.safety?.executor ? props.safety : shown.safety;
  const reviewLine = assistReviewLine({ safety }, t);
  const others = agents?.filter((item) => item.group === "other") ?? [];

  async function submit(action: "allow" | "reject") {
    if (busy) return;
    if (action === "allow" && !agent) return;
    setBusy(true);
    setError(null);
    try {
      await props.onDecided({
        action,
        ...(action === "allow" && agent ? { agent, scope, ...(scope === "timed" ? { minutes } : {}) } : {})
      });
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
      bodyClassName={styles.body}
      footerClassName={styles.footer}
      backdropClassName={props.demoAnchor ? `${styles.backdrop} ${styles.backdropYield}` : styles.backdrop}
      demoGuideAnchor={props.demoAnchor ? "assist-dialog" : undefined}
      footer={(
        <div className={styles.actions}>
          <Button variant="ghost" disabled={busy} onClick={() => void submit("reject")}>
            {t("collab.assist.reject")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !agent}
            data-demo-guide={props.demoAnchor ? "assist-allow" : undefined}
            onClick={() => void submit("allow")}
          >
            {t("collab.assist.allow")}
          </Button>
        </div>
      )}
    >
      <div className={styles.top}>
        <Memmy pose="shield" size={56} className={styles.mascot} />
        <h2 className={styles.title}>{t("collab.assist.title", { name: requester })}</h2>
        {reviewLine ? (
          <p className={styles.review}>
            <AlertTriangle size={14} className={styles.reviewIcon} aria-hidden="true" />
            <span>{reviewLine}</span>
          </p>
        ) : null}
        {/* 标题下面直接是背景：谁在请求已在标题里，为什么请求由背景说明，不再加一句复述的引导语。 */}
        {shown.reason ? (
          <p className={styles.reason}>
            <span className={styles.reasonKey}>{t("collab.assist.reasonKey")}</span>
            {shown.reason}
          </p>
        ) : null}
      </div>

      <div className={styles.sect}>
        <div className={styles.sectKey}>
          <Folder size={13} aria-hidden="true" />
          {/* 请求等了一段时间才被看到（比如她刚上线）：写明多久前发起，旧了她可以直接拒绝。 */}
          {waited
            ? t("collab.assist.fromProjectWaited", { name: requester, via, project: request.projectName, waited })
            : t("collab.assist.fromProject", { name: requester, via, project: request.projectName })}
        </div>
        <div className={styles.todo}>
          {/* 这次排查的一句话标题：编号事项只列步骤，先让她知道这次到底要做什么。 */}
          {shown.title ? <p className={styles.todoTitle}>{shown.title}</p> : null}
          <AssistItems items={shown.items} />
        </div>
      </div>

      {/* 随请求附带的文本与脚本：在「由谁执行」之前，让她先看要跑的是什么 */}
      {attachments.length ? (
        <div className={styles.sect}>
          <div className={styles.sectKey}>{t("collab.assist.attachments")}</div>
          <AssistAttachments attachments={attachments} />
        </div>
      ) : null}

      <div className={styles.sect}>
        <div className={styles.sectKey}>{t("collab.assist.byWhom")}</div>
        {agents === null ? (
          <p className={styles.listNote}>{t("collab.assist.loading")}</p>
        ) : agents.length ? (
          <>
            <AgentGrid agents={agents.filter((item) => item.group !== "other")} selected={agent} onSelect={setAgent} />
            {others.length ? (
              <>
                <button
                  type="button"
                  className={styles.moreToggle}
                  aria-expanded={showOthers}
                  onClick={() => setShowOthers((value) => !value)}
                >
                  {showOthers ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
                  {t("collab.assist.otherAgents", { count: String(others.length) })}
                </button>
                {showOthers ? <AgentGrid agents={others} selected={agent} onSelect={setAgent} /> : null}
              </>
            ) : null}
          </>
        ) : (
          <p className={styles.listNote}>{t("collab.assist.noAgents")}</p>
        )}
        <p className={styles.listNote}>{t("collab.assist.agentsNote")}</p>
      </div>

      <div className={styles.sect}>
        <div className={styles.sectKey}>{t("collab.assist.scopeTitle")}</div>
        <div className={`${styles.opt} ${scope === "once" ? styles.optOn : ""}`}>
          <button type="button" className={styles.optHead} aria-pressed={scope === "once"} onClick={() => setScope("once")}>
            <span className={styles.radio} aria-hidden="true" />
            <span className={styles.optBody}>
              <span className={styles.optTitle}>{t("collab.assist.scopeOnce")}</span>
              <span className={styles.optDesc}>{t("collab.assist.scopeOnceDesc", { name: requester })}</span>
            </span>
          </button>
        </div>
        <div className={`${styles.opt} ${scope === "timed" ? styles.optOn : ""}`}>
          <button type="button" className={styles.optHead} aria-pressed={scope === "timed"} onClick={() => setScope("timed")}>
            <span className={styles.radio} aria-hidden="true" />
            <span className={styles.optBody}>
              <span className={styles.optTitle}>{t("collab.assist.scopeTimed")}</span>
              <span className={styles.optDesc}>
                {t("collab.assist.scopeTimedDesc", {
                  name: requester,
                  project: request.projectName,
                  agent: agentName
                })}
              </span>
            </span>
          </button>
          {scope === "timed" ? (
            <div ref={durationRef} className={styles.optExtra}>
              <GrantDurationPicker value={minutes} onChange={setMinutes} disabled={busy} />
            </div>
          ) : null}
        </div>
      </div>

      <p className={styles.notice}>{t("collab.assist.notice")}</p>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </Modal>
  );
}

/** 一层执行方：两列，每个 Agent 一格。 */
function AgentGrid(props: { agents: AssistAgent[]; selected: string | null; onSelect: (sourceId: string) => void }) {
  if (!props.agents.length) return null;
  return (
    <div className={styles.agents}>
      {props.agents.map((item) => (
        <button
          key={item.sourceId}
          type="button"
          className={`${styles.agent} ${props.selected === item.sourceId ? styles.agentOn : ""}`}
          aria-pressed={props.selected === item.sourceId}
          onClick={() => props.onSelect(item.sourceId)}
        >
          <span className={styles.radio} aria-hidden="true" />
          <span className={styles.agentLogo}>
            {agentSourceSquareLogoUrl(item.sourceId)
              ? <img src={agentSourceSquareLogoUrl(item.sourceId)} alt="" />
              : <span className={styles.agentMark}>{Array.from(item.name)[0] ?? "A"}</span>}
          </span>
          <span className={styles.agentName}>{item.name}</span>
        </button>
      ))}
    </div>
  );
}
