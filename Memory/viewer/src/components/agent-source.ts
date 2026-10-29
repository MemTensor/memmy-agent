const DISPLAY_NAMES: Record<string, string> = {
  memmy: "Memmy",
  memmy_agent: "Memmy",
  computer_history: "Memmy",
  cursor: "Cursor",
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  deepseek_harness: "DeepSeek Harness",
  workbuddy: "WorkBuddy",
  pi: "Pi",
  qwenwork: "QwenWork",
};

const KNOWN_AGENT_SOURCES = [
  "memmy-agent",
  "cursor",
  "claude_code",
  "codex",
  "opencode",
  "openclaw",
  "hermes",
  "deepseek_harness",
  "workbuddy",
  "pi",
  "qwenwork",
] as const;

export function normalizeAgentSource(sourceAgent: string): string {
  return sourceAgent.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

export function sourceAgentInitials(displayName: string): string {
  return displayName
    .split(/[\s-]+/u)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function mergeAgentSourceOptions(
  distribution: Array<{ source: string; count: number }>,
  discovered: Array<{ sourceId: string; displayName: string; builtin: boolean; available: boolean }>,
): Array<{ source: string; count: number; label: string }> {
  const options = new Map<string, { source: string; count: number; label: string }>();

  for (const sourceId of KNOWN_AGENT_SOURCES) {
    const source = normalizeAgentSource(sourceId);
    options.set(source, { source, count: 0, label: sourceAgentLabel(sourceId) });
  }
  for (const item of distribution) {
    const source = filterAgentSource(item.source);
    const current = options.get(source);
    options.set(source, { source, count: (current?.count ?? 0) + item.count, label: sourceAgentLabel(source) });
  }
  for (const item of discovered) {
    const source = filterAgentSource(item.sourceId);
    const current = options.get(source);
    let label = current?.label || sourceAgentLabel(item.sourceId);
    if (source === "memmy_agent") label = sourceAgentLabel(source);
    else if (!item.builtin) label = item.displayName || label;
    options.set(source, {
      source,
      count: current?.count ?? 0,
      label,
    });
  }

  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function sourceAgentLabel(sourceAgent: string): string {
  return DISPLAY_NAMES[normalizeAgentSource(sourceAgent)] ?? sourceAgent.trim();
}

function filterAgentSource(sourceAgent: string): string {
  const source = normalizeAgentSource(sourceAgent);
  return source === "memmy" || source === "computer_history" ? "memmy_agent" : source;
}

export function agentClass(sourceAgent: string): string {
  const normalized = normalizeAgentSource(sourceAgent);
  return normalized === "openclaw" || normalized === "hermes" ? normalized : "unknown";
}
