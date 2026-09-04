import { useEffect, useState } from "preact/hooks";
import { api } from "../api/client";
import { t } from "../stores/i18n";
import { AgentSourceLogo } from "./AgentSourceLogo";
import { Select } from "./Select";
import { mergeAgentSourceOptions } from "./agent-source";

export { agentClass, sourceAgentLabel } from "./agent-source";

interface AgentSourceOption {
  source: string;
  count: number;
  label: string;
}

interface OverviewResponse {
  sourceDistribution?: Array<{ source: string; count: number }>;
}

interface AgentSourcesResponse {
  sources?: Array<{
    sourceId: string;
    displayName: string;
    builtin: boolean;
    available: boolean;
  }>;
}

interface AgentSourceSelectProps {
  value: string;
  onChange: (value: string) => void;
}

const ALL_AGENT_ICON_SOURCES = [
  { sourceId: "memmy-agent", displayName: "Memmy" },
  { sourceId: "codex", displayName: "Codex" },
  { sourceId: "claude_code", displayName: "Claude Code" },
] as const;

export function AgentSourceSelect({ value, onChange }: AgentSourceSelectProps) {
  const [options, setOptions] = useState<AgentSourceOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<OverviewResponse>("/api/v1/overview"),
      api.get<AgentSourcesResponse>("/api/v1/agent-sources"),
    ])
      .then(([overview, discovered]) => {
        if (!cancelled) {
          setOptions(mergeAgentSourceOptions(overview.sourceDistribution ?? [], discovered.sources ?? []));
        }
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div class="agent-source-select">
      <Select
        className="select--agent-source"
        value={value}
        width="auto"
        ariaLabel={t("memories.filter.agentSource")}
        options={[
          {
            value: "",
            label: t("memories.filter.agentSource.all"),
            icon: <AllAgentsIcon />,
          },
          ...options.map((option) => ({
            value: option.source,
            label: option.label,
            title: t("memories.filter.agentSource.count", { n: option.count }),
            icon: <AgentSourceLogo sourceId={option.source} displayName={option.label} compact />,
          })),
        ]}
        onChange={onChange}
      />
    </div>
  );
}

function AllAgentsIcon() {
  return (
    <span class="agent-source-all-icon" aria-hidden="true">
      {ALL_AGENT_ICON_SOURCES.map((agent) => (
        <span class="agent-source-all-icon__avatar" key={agent.sourceId}>
          <AgentSourceLogo
            sourceId={agent.sourceId}
            displayName={agent.displayName}
            compact
          />
        </span>
      ))}
    </span>
  );
}

export function appendSourceAgentParam(qs: URLSearchParams, sourceAgent: string): void {
  if (sourceAgent) qs.set("sourceAgent", sourceAgent);
}
