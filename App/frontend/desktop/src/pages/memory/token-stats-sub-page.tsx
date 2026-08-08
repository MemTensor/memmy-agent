import { useEffect, useState } from "react";
import type {
  AgentTokenStatsDto,
  AgentTokenStatsResponse
} from "@memmy/local-api-contracts";
import type { AgentTokenStatsClient } from "../../api/agent-token-stats-client.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { Gauge } from "./memory-prototype-icons.js";
import { type RemoteData, toErrorMessage } from "./remote-state.js";

export interface TokenStatsSubPageProps {
  client: AgentTokenStatsClient | null;
}

export function TokenStatsSubPage(props: TokenStatsSubPageProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<RemoteData<AgentTokenStatsResponse>>({ status: "loading" });
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  useEffect(() => {
    if (!props.client) {
      setState({ status: "error", message: t("memory.clientNotReady") });
      return;
    }

    let active = true;
    setState({ status: "loading" });

    props.client
      .getStats()
      .then((data) => {
        if (!active) return;
        setState({ status: "ready", data });
        // Auto-select first project if none selected
        if (!selectedProject && data.projects.length > 0 && data.projects[0]) {
          setSelectedProject(data.projects[0].project);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({ status: "error", message: toErrorMessage(error) });
      });

    return () => {
      active = false;
    };
  }, [props.client, t, selectedProject]);

  if (state.status === "loading") {
    return (
      <section className="memory-page-section">
        <header className="mb-5">
          <h3 className="memory-page-content-title text-base text-text-ink gap-2">
            <Gauge size={18} className="text-text-ink/60" />
            {t("memory.tokenStats.title")}
          </h3>
          <p className="text-xs text-text-ink/60 mt-1">{t("memory.tokenStats.description")}</p>
        </header>
        <div className="text-sm text-text-ink/60">{t("memory.tokenStats.loading")}</div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="memory-page-section">
        <header className="mb-5">
          <h3 className="memory-page-content-title text-base text-text-ink gap-2">
            <Gauge size={18} className="text-text-ink/60" />
            {t("memory.tokenStats.title")}
          </h3>
          <p className="text-xs text-text-ink/60 mt-1">{t("memory.tokenStats.description")}</p>
        </header>
        <div className="text-sm text-red-600">{state.message}</div>
      </section>
    );
  }

  const { data } = state;
  const projects = data.projects;

  if (projects.length === 0) {
    return (
      <section className="memory-page-section">
        <header className="mb-5">
          <h3 className="memory-page-content-title text-base text-text-ink gap-2">
            <Gauge size={18} className="text-text-ink/60" />
            {t("memory.tokenStats.title")}
          </h3>
          <p className="text-xs text-text-ink/60 mt-1">{t("memory.tokenStats.description")}</p>
        </header>
        <div className="text-sm text-text-ink/60">{t("memory.tokenStats.empty")}</div>
      </section>
    );
  }

  // Find selected project or use first
  const currentProject = projects.find((p) => p.project === selectedProject) ?? projects[0];

  if (!currentProject) {
    return (
      <section className="memory-page-section">
        <header className="mb-5">
          <h3 className="memory-page-content-title text-base text-text-ink gap-2">
            <Gauge size={18} className="text-text-ink/60" />
            {t("memory.tokenStats.title")}
          </h3>
          <p className="text-xs text-text-ink/60 mt-1">{t("memory.tokenStats.description")}</p>
        </header>
        <div className="text-sm text-text-ink/60">{t("memory.tokenStats.empty")}</div>
      </section>
    );
  }

  return (
    <section className="memory-page-section">
      <header className="mb-5">
        <h3 className="memory-page-content-title text-base text-text-ink gap-2">
          <Gauge size={18} className="text-text-ink/60" />
          {t("memory.tokenStats.title")}
        </h3>
        <p className="text-xs text-text-ink/60 mt-1">{t("memory.tokenStats.description")}</p>
      </header>

      {/* Project selector */}
      {projects.length > 1 && (
        <div className="mb-5 flex items-center gap-3">
          <label htmlFor="project-select" className="text-sm text-text-ink/70">
            {t("memory.tokenStats.project")}:
          </label>
          <select
            id="project-select"
            value={currentProject.project}
            onChange={(e) => setSelectedProject(e.target.value)}
            className="px-3 py-1.5 text-sm border border-content-panel rounded-md bg-background-paper text-text-ink"
          >
            {projects.map((p) => (
              <option key={p.project} value={p.project}>
                {p.project}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Agent cards */}
      <div className="grid gap-4 mb-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))" }}>
        {currentProject.agents.map((agent) => (
          <AgentCard key={agent.agent} agent={agent} />
        ))}
      </div>

      {/* Combined totals */}
      <article className="bg-background-paper border-content-panel rounded-card p-5 mb-5">
        <h4 className="text-sm text-text-ink mb-4">{t("memory.tokenStats.combined")}</h4>
        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 144px), 1fr))" }}>
          <StatItem label={t("memory.tokenStats.inputTokens")} value={currentProject.combinedInputTokens} />
          <StatItem label={t("memory.tokenStats.outputTokens")} value={currentProject.combinedOutputTokens} />
          <StatItem label={t("memory.tokenStats.cacheRead")} value={currentProject.combinedCacheReadTokens} />
          <StatItem label={t("memory.tokenStats.total")} value={currentProject.combinedTotalTokens} highlight />
          {currentProject.estimatedCost !== undefined && (
            <StatItem label={t("memory.tokenStats.cost")} value={`$${currentProject.estimatedCost.toFixed(4)}`} />
          )}
        </div>
      </article>

      {/* Scan timestamp */}
      <div className="text-xs text-text-ink/45">
        Scanned at: {new Date(data.scannedAt).toLocaleString()}
      </div>
    </section>
  );
}

interface AgentCardProps {
  agent: AgentTokenStatsDto;
}

function AgentCard(props: AgentCardProps) {
  const { t } = useTranslation();
  const { agent } = props;

  const agentLabel =
    agent.agent === "pi"
      ? t("memory.tokenStats.pi")
      : agent.agent === "codex"
        ? t("memory.tokenStats.codex")
        : t("memory.tokenStats.claudeCode");

  const icon = <Gauge size={20} />;

  return (
    <article
      className={`bg-background-paper border-content-panel rounded-card p-4 ${!agent.available ? "opacity-50" : ""}`}
    >
      <div className="flex items-center gap-2 mb-3">
        {icon}
        <h4 className="text-sm font-semibold text-text-ink">{agentLabel}</h4>
      </div>

      {!agent.available ? (
        <div className="text-xs text-text-ink/60 italic">{t("memory.tokenStats.unavailable")}</div>
      ) : (
        <>
          <div className="flex gap-4 mb-3 text-xs text-text-ink/70">
            <span>
              {t("memory.tokenStats.sessions")}: <strong className="text-text-ink">{agent.sessions}</strong>
            </span>
            <span>
              {t("memory.tokenStats.apiCalls")}: <strong className="text-text-ink">{agent.apiCalls}</strong>
            </span>
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 120px), 1fr))" }}>
            <StatItem label={t("memory.tokenStats.inputTokens")} value={agent.inputTokens} />
            <StatItem label={t("memory.tokenStats.outputTokens")} value={agent.outputTokens} />
            <StatItem label={t("memory.tokenStats.cacheRead")} value={agent.cacheReadTokens ?? 0} />
            <StatItem label={t("memory.tokenStats.cacheWrite")} value={agent.cacheWriteTokens ?? 0} />
            {agent.reasoningTokens !== undefined && agent.reasoningTokens > 0 && (
              <StatItem label={t("memory.tokenStats.reasoning")} value={agent.reasoningTokens} />
            )}
            <StatItem label={t("memory.tokenStats.total")} value={agent.totalTokens} highlight />
            {agent.cost !== undefined && agent.cost > 0 && (
              <StatItem label={t("memory.tokenStats.cost")} value={`$${agent.cost.toFixed(4)}`} />
            )}
          </div>
        </>
      )}
    </article>
  );
}

interface StatItemProps {
  label: string;
  value: number | string;
  highlight?: boolean;
}

function StatItem(props: StatItemProps) {
  const displayValue = typeof props.value === "number" ? props.value.toLocaleString() : props.value;

  return (
    <div className="bg-background border border-content-panel/50 rounded px-3 py-2">
      <div className="text-[11px] text-text-ink/60 mb-1">{props.label}</div>
      <div className={`text-lg font-bold tabular-nums ${props.highlight ? "text-primary" : "text-text-ink"}`}>
        {displayValue}
      </div>
    </div>
  );
}
