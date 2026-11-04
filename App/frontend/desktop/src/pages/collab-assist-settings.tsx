/**
 * 设置 → 偏好 → 协作项目里的成员协助：总开关、长期授权与协助记录。
 *
 * 位置紧接「在其他 Agent 中使用协作项目」，因为执行用的 Agent 来自那里：那一项是她自己用这些 Agent
 * 读写项目，这一项是别人调用她的 Agent，风险方向相反，所以两项授权分开记、分开结束。
 *
 * 次数限制不做成设置项：同一时间一个、单次最长 15 分钟、每位成员每天最多 20 次，由产品内置。
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { History, Loader2 } from "lucide-react";
import type { AssistGrant, AssistRecord, AssistSettings, CollabClient } from "../api/collab-client.js";
import {
  getCollabProjectsSnapshot,
  subscribeCollabProjects
} from "../app/collab-projects-store.js";
import { useTranslation } from "../i18n/use-translation.js";
import { agentSourceLogoUrl } from "./agent-source-logos.js";

/** 授权与记录都挂在项目上：优先用传进来的项目，没有时跟着侧栏选中的那个。 */
function useAssistProject(explicit?: { id: string; name: string }) {
  const snapshot = useSyncExternalStore(subscribeCollabProjects, getCollabProjectsSnapshot, getCollabProjectsSnapshot);
  const projects = snapshot.projects ?? [];
  return useMemo(
    () => explicit ?? projects.find((item) => item.localProjectId === snapshot.selectedId) ?? projects[0] ?? null,
    [explicit, projects, snapshot.selectedId]
  );
}

/** 总开关与长期授权：放在「在其他 Agent 中使用协作项目」之后。 */
export function CollabAssistSettings(props: { client?: CollabClient; project?: { id: string; name: string } }) {
  const { t } = useTranslation();
  const { client } = props;
  const project = useAssistProject(props.project);
  const [settings, setSettings] = useState<AssistSettings | null>(null);
  const [grants, setGrants] = useState<AssistGrant[]>([]);
  const [agents, setAgents] = useState<Array<{ sourceId: string; name: string; available: boolean }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      setSettings(await client.assistSettings());
      if (project) {
        const [grantView, list] = await Promise.all([
          client.assistGrants(project.id),
          client.assistAgents(project.id)
        ]);
        setGrants(grantView.grants.filter((grant) => grant.active));
        setAgents(list.filter((item) => item.available));
      }
    } catch {
      setError(t("settings.assist.failed"));
    }
  }, [client, project, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(allow: boolean) {
    if (!client || busy) return;
    setBusy(true);
    try {
      setSettings(await client.setAssistAllow(allow));
      if (!allow) setGrants([]);
      else await load();
    } catch {
      setError(t("settings.assist.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(grant: AssistGrant) {
    if (!client || busy || !project) return;
    setBusy(true);
    try {
      const view = await client.revokeAssistGrant(project.id, grant.grantee.userId);
      setGrants(view.grants.filter((item) => item.active));
    } catch {
      setError(t("settings.assist.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function changeAgent(grant: AssistGrant, agent: string) {
    if (!client || busy || !project) return;
    setBusy(true);
    try {
      const view = await client.setAssistGrantAgent(project.id, grant.grantee.userId, agent);
      setGrants(view.grants.filter((item) => item.active));
    } catch {
      setError(t("settings.assist.failed"));
    } finally {
      setBusy(false);
    }
  }

  const allow = settings?.allowAssist !== false;

  return (
    <div>
      <div className="flex items-center justify-between gap-4 border-t border-border-stone/30 py-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-text-ink/80">{t("settings.assist.row")}</div>
          <div className="mt-0.5 text-xs text-text-ink/50 leading-relaxed">{t("settings.assist.description")}</div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {busy ? <Loader2 size={13} className="animate-spin text-text-ink/40" /> : null}
          <button
            type="button"
            role="switch"
            aria-checked={allow}
            aria-label={t("settings.assist.row")}
            disabled={busy || !client}
            onClick={() => void toggle(!allow)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border-0 p-0 transition-colors ${allow ? "bg-action-sky" : "bg-border-stone"} disabled:opacity-60`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${allow ? "translate-x-[18px]" : "translate-x-0.5"}`} />
          </button>
        </div>
      </div>

      {allow ? (
        <div className="border-t border-border-stone/30 pt-3">
          <h3 className="text-[13.5px] font-semibold text-text-ink/80">{t("settings.assist.grantsTitle")}</h3>
          {grants.length ? grants.map((grant) => (
            <div key={grant.grantee.userId} className="flex items-center justify-between gap-4 py-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-action-sky/15 text-xs font-bold text-action-sky-hover">
                  {Array.from(grant.grantee.name)[0] ?? ""}
                </span>
                <div className="min-w-0">
                  <div className="text-sm text-text-ink/80">{grant.grantee.name} · {grant.projectName}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-text-ink/50">
                    <AgentMark sourceId={grant.agent} />
                    {t("settings.assist.grantDetail", { agent: agentNameOf(grant.agent), count: String(grant.usedToday) })}
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <select
                  className="rounded-btn border border-border-stone/60 bg-white px-2 py-1 text-xs text-text-ink/70"
                  value={grant.agent}
                  disabled={busy}
                  onChange={(event) => void changeAgent(grant, event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.sourceId} value={agent.sourceId}>
                      {t("settings.assist.changeAgent", { agent: agent.name })}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void revoke(grant)}
                  className="rounded-btn border border-status-error/35 bg-white px-2.5 py-1 text-xs text-status-error hover:bg-status-error/5 disabled:opacity-60"
                >
                  {t("settings.assist.revoke")}
                </button>
              </div>
            </div>
          )) : (
            <p className="py-2 text-xs text-text-ink/50 leading-relaxed">{t("settings.assist.noGrants")}</p>
          )}
          <p className="mt-1 text-xs text-text-ink/50 leading-relaxed">{t("settings.assist.limit")}</p>
        </div>
      ) : null}

      {error ? <div className="mt-1 text-xs text-status-error" role="alert">{error}</div> : null}
    </div>
  );
}

/** 协助记录：单独一节，保留 30 天。 */
export function CollabAssistRecords(props: { client?: CollabClient; project?: { id: string; name: string } }) {
  const { t } = useTranslation();
  const { client } = props;
  const project = useAssistProject(props.project);
  const [records, setRecords] = useState<AssistRecord[]>([]);
  /** 记录里的状态：用界面上的说法，不显示接口的枚举。 */
  const statusLabel = (status: AssistRecord["status"]) => {
    if (status === "done") return t("collab.assist.statusDone");
    if (status === "rejected") return t("collab.assist.statusNotAllowed");
    if (status === "stopped" || status === "failed") return t("collab.assist.statusFailed");
    if (status === "running") return t("collab.assist.statusRunning");
    return t("collab.assist.statusClosed");
  };
  const [retentionDays, setRetentionDays] = useState(30);

  useEffect(() => {
    if (!client || !project) return;
    let cancelled = false;
    void client.assistRecords(project.id)
      .then((view) => {
        if (cancelled) return;
        setRecords(view.records);
        setRetentionDays(view.retentionDays);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, project]);

  return (
    <div>
      <div className="mb-1 text-xs text-text-ink/40">{t("settings.assist.recordsRetention", { days: String(retentionDays) })}</div>
      {records.length ? (
        <table className="w-full border-collapse text-xs">
          <tbody>
            {records.map((record) => (
              <tr key={record.id}>
                <td className="w-16 border-t border-border-stone/30 py-2.5 align-top text-text-ink/40">{formatTime(record.createdAt)}</td>
                <td className="border-t border-border-stone/30 py-2.5 align-top">
                  <div className="text-text-ink/80">{record.title}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-text-ink/50">
                    <AgentMark sourceId={record.agent} />
                    {record.files
                      ? t("settings.assist.recordFiles", { name: record.memberName, status: statusLabel(record.status), count: String(record.files) })
                      : t("settings.assist.record", { name: record.memberName, status: statusLabel(record.status) })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="py-2 text-xs text-text-ink/50">{t("settings.assist.noGrants")}</p>
      )}
    </div>
  );
}

function AgentMark(props: { sourceId: string | null }) {
  const url = props.sourceId ? agentSourceLogoUrl(props.sourceId) : null;
  if (!url) return null;
  return <img src={url} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px]" />;
}

/** 执行方标识换成名字。 */
function agentNameOf(sourceId: string): string {
  const names: Record<string, string> = {
    memmy: "Memmy",
    claude_code: "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    opencode: "OpenCode",
    openclaw: "OpenClaw",
    hermes: "Hermes",
    workbuddy: "WorkBuddy",
    qwenwork: "QwenWork",
    deepseek_harness: "DeepSeek Harness",
    pi: "Pi"
  };
  return names[sourceId] ?? sourceId;
}

function formatTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 记录区标题上的「保留 30 天」由设置页的 Section 标题承接，这里只导出图标方便复用。 */
export const COLLAB_ASSIST_RECORDS_ICON = History;