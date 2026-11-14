/**
 * 项目设置「协作」一组里的「接收协助请求」一行。
 *
 * 本人在这个项目里的「接收协助请求」开关，默认关闭：开启后，项目里的其他成员才能请她电脑上的 Agent
 * 执行任务。说明收在问号里。开启且有仍然有效的限时授权时，在这一行下面列出它们：剩余时间、由哪个 Agent 执行，
 * 可以换用或提前结束；没有授权时什么都不多写。关闭时云端结束她在这个项目里的限时授权，
 * 还在等待的请求以「某某已关闭接收协助请求」结束。
 *
 * 次数限制不做成设置项：同一时间一个、单次最长 15 分钟，由产品内置，在协助请求弹窗里说明。
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Loader2, LifeBuoy } from "lucide-react";
import { InfoHint } from "./collab-info-hint.js";
import type { AssistAgent, AssistGrant, CollabClient } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceLogoUrl } from "./agent-source-logos.js";
import { assistAgentName, grantRemaining } from "./collab-assist-view.js";
import frame from "./collab-page.module.css";

/** 剩余时间每 30 秒刷新一次：列表显示的是「还剩 42 分钟」这样的整分钟。 */
const REMAINING_TICK_MS = 30_000;

/** 项目设置的「成员协助」：接收协助请求的开关，开启时列出限时授权。 */
export function CollabAssistProjectSettings(props: {
  client: CollabClient | null;
  projectId: string;
  /** 开关被打开或被关掉之后告诉上层：新手引导在开启后立即关掉设置、去等演示成员的请求。 */
  onEnabledChange?: (enabled: boolean) => void;
  /** 新手引导的演示中：给开关加一个锚点，蒙版的描边落在它上面。 */
  demoAnchor?: boolean;
}) {
  const { t } = useTranslation();
  const { client, projectId } = props;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setEnabled(null);
    setError(null);
    // 读失败（含旧版本的本机接口）时按关闭显示，并说明没读到。
    void (async () => {
      try {
        const view = await client.assistReceiving(projectId);
        if (!cancelled) setEnabled(view.enabled);
      } catch {
        if (!cancelled) {
          setEnabled(false);
          setError(t("settings.assist.failed"));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, projectId, t]);

  async function toggle(next: boolean) {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await client.setAssistReceiving(projectId, next);
      setEnabled(saved.enabled);
      props.onEnabledChange?.(saved.enabled);
    } catch {
      setError(t("collab.settings.assist.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const on = enabled === true;
  // 这一行放在项目设置「协作」那一组里，外框由那一组提供。
  return (
    <div className={frame.settingsAssist} data-collab-assist-settings="">
      {/* 点整行任意位置都能切换（问号除外），开关自己不处理点击，避免切换两次 */}
      <div
        className={`${frame.settingsRow} ${frame.settingsRowAction}`}
        onClick={() => {
          if (!busy && client && enabled !== null) void toggle(!on);
        }}
      >
        <LifeBuoy size={16} aria-hidden="true" className={frame.settingsRowIcon} />
        <span className={frame.settingsRowLabel}>{t("collab.settings.assist.title")}</span>
        <span className={frame.settingsRowHint} onClick={(event) => event.stopPropagation()}>
          <InfoHint
            placement="above"
            label={t("collab.settings.assist.helpLabel")}
            text={t("collab.settings.assist.desc")}
          />
        </span>
        <span className={frame.settingsRowControl}>
          {busy ? <Loader2 size={13} className={frame.settingsSpinner} aria-hidden="true" /> : null}
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={t("collab.settings.assist.title")}
            data-demo-guide={props.demoAnchor ? "settings-assist-switch" : undefined}
            disabled={busy || !client || enabled === null}
            className={`${frame.settingsSwitch}${on ? ` ${frame.settingsSwitchOn}` : ""}`}
          />
        </span>
      </div>
      {on ? <CollabAssistGrants client={client} projectId={projectId} /> : null}
      {error ? <div className={frame.settingsRowError} role="alert">{error}</div> : null}
    </div>
  );
}

/** 本人在这个项目里给出的、仍然有效的限时授权：剩余时间、由哪个 Agent 执行，可换用或结束。 */
export function CollabAssistGrants(props: { client: CollabClient | null; projectId: string }) {
  const { t } = useTranslation();
  const { client, projectId } = props;
  const [grants, setGrants] = useState<AssistGrant[] | null>(null);
  const [agents, setAgents] = useState<AssistAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      // 「换用」与授权弹窗用同一份候选：这台电脑上能运行的 Agent。
      const [grantView, choice] = await Promise.all([client.assistGrants(projectId), client.assistAgents(projectId)]);
      setGrants(grantView.grants.filter((grant) => grant.active));
      setAgents(choice.agents);
    } catch {
      setGrants([]);
      setError(t("settings.assist.failed"));
    }
  }, [client, projectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // 到期的授权自动从列表里消失，剩余时间跟着走。
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), REMAINING_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  async function update(run: () => Promise<{ grants: AssistGrant[] }>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const view = await run();
      setGrants(view.grants.filter((item) => item.active));
    } catch {
      setError(t("settings.assist.failed"));
    } finally {
      setBusy(false);
    }
  }

  const live = grants?.filter((grant) => !grant.expiresAt || new Date(grant.expiresAt).getTime() > now.getTime()) ?? null;
  // 读中与没有授权时不占位置；有授权时贴在开关那一行下面，每位成员一行。
  return (
    <>
      {live?.length ? (
        <div className={frame.grantList} aria-label={t("collab.settings.assist.grantsTitle")}>
          {live.map((grant) => {
            const left = grantRemaining(grant.expiresAt, t, now);
            const changeLabel = t("settings.assist.changeAgentLabel", { name: grant.grantee.name });
            return (
              <div key={grant.grantee.userId} className={frame.grantRow}>
                <div className={frame.grantWho}>
                  <span className={frame.grantAvatar} aria-hidden="true">{initialOf(grant.grantee.name)}</span>
                  <div className={frame.grantText}>
                    <span className={frame.grantName}>{grant.grantee.name}</span>
                    {/* 由哪个 Agent 执行就是这一行里的下拉本身，不再在文字里重复一遍 */}
                    <span className={frame.grantDetail}>
                      <AgentMark sourceId={grant.agent} />
                      <span className={frame.grantSelectWrap}>
                        <select
                          className={frame.grantSelect}
                          value={grant.agent}
                          aria-label={changeLabel}
                          title={changeLabel}
                          disabled={busy || !client}
                          onChange={(event) => {
                            const agent = event.target.value;
                            if (client) void update(() => client.setAssistGrantAgent(projectId, grant.grantee.userId, agent));
                          }}
                        >
                          {agents.some((agent) => agent.sourceId === grant.agent) ? null : (
                            <option value={grant.agent}>{assistAgentName(grant.agent, grant.agent)}</option>
                          )}
                          {agents.map((agent) => (
                            <option key={agent.sourceId} value={agent.sourceId}>{agent.name}</option>
                          ))}
                        </select>
                        <ChevronDown size={12} aria-hidden="true" className={frame.grantSelectChevron} />
                      </span>
                      {left ? <span>· {left}</span> : null}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className={`${frame.settingsDangerSoft} ${frame.settingsDangerSoftCompact}`}
                  disabled={busy || !client}
                  onClick={() => {
                    if (client) void update(() => client.revokeAssistGrant(projectId, grant.grantee.userId));
                  }}
                >
                  {t("settings.assist.revoke")}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {error ? <div className={frame.settingsRowError} role="alert">{error}</div> : null}
    </>
  );
}

/** 头像上的第一个字：名字为空时退回一个中性符号，不空出一块。 */
function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "·";
}

function agentNameOf(agents: readonly AssistAgent[], sourceId: string): string {
  return agents.find((agent) => agent.sourceId === sourceId)?.name ?? assistAgentName(sourceId, sourceId);
}

function AgentMark(props: { sourceId: string | null }) {
  const url = props.sourceId ? agentSourceLogoUrl(props.sourceId) : null;
  if (!url) return null;
  return <img src={url} alt="" className={frame.grantLogo} />;
}
