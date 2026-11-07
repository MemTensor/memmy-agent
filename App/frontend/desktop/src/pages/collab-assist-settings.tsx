/**
 * 项目设置里的「成员协助」一节。
 *
 * 第一行是本人在这个项目里的「接收协助请求」开关，默认关闭：开启后，项目里的其他成员才能请她电脑上的 Agent
 * 执行任务。开启时下面列出她给出的、仍然有效的限时授权：剩余时间、由哪个 Agent 执行，可以换用或提前结束。
 * 关闭时云端结束她在这个项目里的限时授权，还在等待的请求以「某某已关闭接收协助请求」结束。
 *
 * 次数限制不做成设置项：同一时间一个、单次最长 15 分钟、每位成员每天最多 20 次，由产品内置。
 * 这一节自己带「协助」这张卡片（卡片头 + 卡片内的行），项目设置弹窗与预览页看到的是同一套排布。
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, LifeBuoy } from "lucide-react";
import type { AssistAgent, AssistGrant, CollabClient } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
import { Button } from "../components/button.js";
import { agentSourceLogoUrl } from "./agent-source-logos.js";
import { assistAgentName, grantRemaining } from "./collab-assist-view.js";
import frame from "./collab-page.module.css";

/** 剩余时间每 30 秒刷新一次：列表显示的是「还剩 42 分钟」这样的整分钟。 */
const REMAINING_TICK_MS = 30_000;

/** 项目设置的「成员协助」：接收协助请求的开关，开启时列出限时授权。 */
export function CollabAssistProjectSettings(props: { client: CollabClient | null; projectId: string }) {
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
      setEnabled((await client.setAssistReceiving(projectId, next)).enabled);
    } catch {
      setError(t("collab.settings.assist.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const on = enabled === true;
  return (
    <section className={frame.settingsCard} data-collab-assist-settings="">
      <div className={frame.settingsCardHead}>
        <span className={frame.settingsCardChip}><LifeBuoy size={14} aria-hidden="true" /></span>
        <h3 className={frame.settingsCardTitle}>{t("collab.settings.groupAssist")}</h3>
      </div>
      <div className={frame.settingsCardRow}>
        <div className={frame.settingsCardText}>
          <span className={frame.settingsCardRowTitle}>{t("collab.settings.assist.title")}</span>
          <span className={frame.settingsCardRowDesc}>{t("collab.settings.assist.desc")}</span>
        </div>
        <div className={frame.settingsCardControl}>
          {busy ? <Loader2 size={13} className={frame.settingsSpinner} aria-hidden="true" /> : null}
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={t("collab.settings.assist.title")}
            disabled={busy || !client || enabled === null}
            onClick={() => void toggle(!on)}
            className={`${frame.settingsSwitch}${on ? ` ${frame.settingsSwitchOn}` : ""}`}
          />
        </div>
      </div>
      {error ? <div className={frame.settingsCardError} role="alert">{error}</div> : null}
      {on ? <CollabAssistGrants client={client} projectId={projectId} /> : null}
    </section>
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
  // 读中、有授权、没有授权这三种：读中与无授权是「标题 + 一行说明」，有授权时标题在上、列表在下。
  const title = t("collab.settings.assist.grantsTitle");
  return (
    <>
      {live === null ? (
        <div className={frame.settingsCardRow}>
          <div className={frame.settingsCardText}>
            <span className={frame.settingsCardRowTitle}>{title}</span>
            <span className={frame.settingsCardRowDesc}>{t("collab.loading")}</span>
          </div>
        </div>
      ) : live.length ? (
        <div className={`${frame.settingsCardRow} ${frame.settingsCardRowStack}`}>
          <div className={frame.settingsCardText}>
            <span className={frame.settingsCardRowTitle}>{title}</span>
            <div className={frame.grantList}>
              {live.map((grant) => (
                <div key={grant.grantee.userId} className={frame.grantRow}>
                  <div className={frame.grantWho}>
                    <span className={frame.grantAvatar} aria-hidden="true">{initialOf(grant.grantee.name)}</span>
                    <div className={frame.grantText}>
                      <span className={frame.grantName}>{grant.grantee.name}</span>
                      <span className={frame.grantDetail}>
                        <AgentMark sourceId={grant.agent} />
                        {t("settings.assist.grantDetail", {
                          agent: agentNameOf(agents, grant.agent),
                          left: grantRemaining(grant.expiresAt, t, now)
                        })}
                      </span>
                    </div>
                  </div>
                  <div className={frame.grantActions}>
                    <select
                      className={frame.grantSelect}
                      value={grant.agent}
                      aria-label={t("settings.assist.changeAgentLabel", { name: grant.grantee.name })}
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
                    <Button
                      size="sm"
                      variant="secondary"
                      className={`${frame.settingsButton} ${frame.settingsDangerButton} ${frame.settingsButtonCompact}`}
                      disabled={busy || !client}
                      onClick={() => {
                        if (client) void update(() => client.revokeAssistGrant(projectId, grant.grantee.userId));
                      }}
                    >
                      {t("settings.assist.revoke")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className={frame.settingsCardRow}>
          <div className={frame.settingsCardText}>
            <span className={frame.settingsCardRowTitle}>{title}</span>
            <span className={frame.settingsCardRowDesc}>{t("settings.assist.noGrants")}</span>
          </div>
        </div>
      )}
      {error ? <div className={frame.settingsCardError} role="alert">{error}</div> : null}
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
