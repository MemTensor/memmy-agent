/**
 * Agent source ids are written by many producers ("memmy-agent", "memmy-onboarding",
 * "claude", "claude-code", ...). The panel collapses the related ones into a single
 * displayed Agent, so filters have to accept the same family or a memory shows a
 * "Memmy" badge while the "Memmy" filter hides it.
 *
 * "manual" is deliberately not a family: custom Agents are registered as "manual_<name>"
 * and stay separate Agents in the panel.
 */
const AGENT_SOURCE_FAMILIES = [
  "claude_code",
  "opencode",
  "codex",
  "cursor",
  "openclaw",
  "hermes",
  "memmy"
] as const;

const AGENT_SOURCE_FAMILY_ALIASES: Record<string, string> = {
  claude: "claude_code",
  open_code: "opencode"
};

export function normalizeAgentIdKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

/** Canonical family key ("memmy-onboarding" -> "memmy"), or undefined for custom Agents. */
export function agentSourceFamily(value: string): string | undefined {
  const key = normalizeAgentIdKey(value);
  if (!key) return undefined;
  for (const [alias, family] of Object.entries(AGENT_SOURCE_FAMILY_ALIASES)) {
    if (key === alias || key.startsWith(`${alias}_`)) return family;
  }
  return AGENT_SOURCE_FAMILIES.find((family) => key === family || key.startsWith(`${family}_`));
}

/** Every normalized id prefix that belongs to the family of `value`, for filter matching. */
export function agentSourceFamilyRoots(value: string): string[] {
  const family = agentSourceFamily(value);
  if (!family) return [];
  return [
    family,
    ...Object.entries(AGENT_SOURCE_FAMILY_ALIASES)
      .filter(([, target]) => target === family)
      .map(([alias]) => alias)
  ];
}
