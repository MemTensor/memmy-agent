import { useMemo } from "react";
import { Bot, Ellipsis } from "lucide-react";
import { Select } from "../../components/Select.js";
import {
  agentSourceDisplayName,
  agentSourceLogoUrl,
  isMemmyAgentSource,
  MEMORY_AGENT_SOURCE_VALUES
} from "../agent-source-logos.js";

export const OTHER_MEMORY_SOURCE_AGENT = "__other__";
export const MEMORY_SOURCE_AGENT_EXCLUSIONS = [...MEMORY_AGENT_SOURCE_VALUES];
const ALL_AGENT_ICON_SOURCES = ["memmy-agent", "codex", "claude_code"] as const;

export interface MemoryAgentFilterProps {
  id: string;
  value: string;
  onValueChange: (value: string) => void;
  label: string;
  allLabel: string;
  otherLabel: string;
}

export function MemoryAgentFilter(props: MemoryAgentFilterProps) {
  const options = useMemo(() => [
    {
      value: "",
      label: props.allLabel,
      icon: <AllAgentsIcon />
    },
    ...MEMORY_AGENT_SOURCE_VALUES.map((value) => ({
      value,
      label: agentSourceDisplayName(value),
      icon: <SourceAgentLogo sourceAgent={value} />
    })),
    {
      value: OTHER_MEMORY_SOURCE_AGENT,
      label: props.otherLabel,
      icon: <Ellipsis size={15} strokeWidth={2} className="memory-source-filter__icon memory-source-filter__icon--other" />
    }
  ], [props.allLabel, props.otherLabel]);

  return (
    <Select
      id={props.id}
      label={props.label}
      labelClassName="sr-only"
      value={props.value}
      onValueChange={props.onValueChange}
      options={options}
      className="memory-source-filter"
      buttonClassName="memory-source-filter__button"
      menuClassName="memory-source-filter__menu"
    />
  );
}

function AllAgentsIcon() {
  return (
    <span className="memory-source-filter__all-icon">
      {ALL_AGENT_ICON_SOURCES.map((sourceAgent) => (
        <span className="memory-source-filter__all-avatar" key={sourceAgent}>
          <SourceAgentLogo sourceAgent={sourceAgent} />
        </span>
      ))}
    </span>
  );
}

function SourceAgentLogo(props: { sourceAgent: string }) {
  const logoUrl = agentSourceLogoUrl(props.sourceAgent);
  if (!logoUrl) {
    return <Bot size={15} strokeWidth={1.8} className="memory-source-filter__icon" />;
  }
  return (
    <img
      src={logoUrl}
      alt=""
      className={`memory-source-filter__logo${isMemmyAgentSource(props.sourceAgent) ? " memory-source-filter__logo--memmy" : ""}`}
    />
  );
}
