/**
 * 项目设置里的「成员协助」一节。
 *
 * 第一行是本人在这个项目里的「接收协助请求」开关，默认关闭：开启后，项目里的其他成员才能请她电脑上的 Agent
 * 执行任务。开启时下面列出她给出的、仍然有效的限时授权：剩余时间、由哪个 Agent 执行，可以换用或提前结束。
 * 关闭时云端结束她在这个项目里的限时授权，还在等待的请求以「某某已关闭接收协助请求」结束。
 *
 * 次数限制不做成设置项：同一时间一个、单次最长 15 分钟、每位成员每天最多 20 次，由产品内置。
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { AssistAgent, AssistGrant, CollabClient } from "../api/collab-client.js";
import { useTranslation } from "../i18n/use-translation.js";
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
    <div className={`${frame.settingsRow} ${frame.settingsRowStack}`} data-collab-assist-settings="">
      <div className={frame.settingsRowReceive}>
        <div className={frame.settingsRowText}>
          <div className={frame.settingsRowTitle}>{t("collab.settings.assist.title")}</div>
          <div className={frame.settingsRowDesc}>{t("collab.settings.assist.desc")}</div>
        </div>
        <div className={frame.settingsRowControl}>
          {busy ? <Loader2 size={13} className="animate-spin text-text-ink/40" aria-hidden="true" /> : null}
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
      {error ? <div className="text-xs text-status-error" role="alert">{error}</div> : null}
      {on ? <CollabAssistGrants client={client} projectId={projectId} /> : null}
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
  return (
    <div className="mt-2 border-t border-border-stone/30 pt-2">
      <div className="text-xs font-semibold text-text-ink/55">{t("collab.settings.assist.grantsTitle")}</div>
      {live === null ? (
        <p className="py-2 text-xs text-text-ink/50">{t("collab.loading")}</p>
      ) : live.length ? live.map((grant) => (
        <div key={grant.grantee.userId} className="flex items-center justify-between gap-4 py-2.5">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-action-sky/15 text-xs font-bold text-action-sky-hover">
              {Array.from(grant.grantee.name)[0] ?? ""}
            </span>
            <div className="min-w-0">
              <div className="text-sm text-text-ink/80">{grant.grantee.name}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-text-ink/50">
                <AgentMark sourceId={grant.agent} />
                {t("settings.assist.grantDetail", {
                  agent: agentNameOf(agents, grant.agent),
                  left: grantRemaining(grant.expiresAt, t, now)
                })}
              </div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <select
              className="rounded-btn border border-border-stone/60 bg-white px-2 py-1 text-xs text-text-ink/70"
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
            <button
              type="button"
              disabled={busy || !client}
              onClick={() => {
                if (client) void update(() => client.revokeAssistGrant(projectId, grant.grantee.userId));
              }}
              className="rounded-btn border border-status-error/30 bg-white px-2.5 py-1 text-xs text-status-error hover:bg-status-error/5 disabled:opacity-60"
            >
              {t("settings.assist.revoke")}
            </button>
          </div>
        </div>
      )) : (
        <p className="py-2 text-xs text-text-ink/50 leading-relaxed">{t("settings.assist.noGrants")}</p>
      )}
      <p className="mt-1 text-xs text-text-ink/45 leading-relaxed">{t("settings.assist.limit")}</p>
      {error ? <div className="mt-1 text-xs text-status-error" role="alert">{error}</div> : null}
    </div>
  );
}

function agentNameOf(agents: readonly AssistAgent[], sourceId: string): string {
  return agents.find((agent) => agent.sourceId === sourceId)?.name ?? assistAgentName(sourceId, sourceId);
}

function AgentMark(props: { sourceId: string | null }) {
  const url = props.sourceId ? agentSourceLogoUrl(props.sourceId) : null;
  if (!url) return null;
  return <img src={url} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px]" />;
}
