import { Icon } from "./Icon";
import { AgentSourceSelect } from "./AgentSourceSelect";

interface AgentSearchBarProps {
  query: string;
  placeholder: string;
  sourceAgent: string;
  onQueryChange: (value: string) => void;
  onSourceAgentChange: (value: string) => void;
}

export function AgentSearchBar({
  query,
  placeholder,
  sourceAgent,
  onQueryChange,
  onSourceAgentChange,
}: AgentSearchBarProps) {
  return (
    <div class="agent-search-control">
      <label class="input-search">
        <Icon name="search" size={16} />
        <input
          class="input input--search"
          type="search"
          autoComplete="off"
          spellcheck={false}
          placeholder={placeholder}
          value={query}
          onInput={(event) => onQueryChange((event.target as HTMLInputElement).value)}
        />
      </label>
      <AgentSourceSelect value={sourceAgent} onChange={onSourceAgentChange} />
    </div>
  );
}
