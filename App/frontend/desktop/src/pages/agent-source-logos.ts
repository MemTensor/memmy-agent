import claudeCodeLogoUrl from "../assets/agent-logos/claude-code.svg";
import codexLogoUrl from "../assets/agent-logos/codex.svg";
import cursorLogoUrl from "../assets/agent-logos/cursor.svg";
import hermesLogoUrl from "../assets/agent-logos/hermes.svg";
import openclawLogoUrl from "../assets/agent-logos/openclaw.svg";
import opencodeLogoUrl from "../assets/agent-logos/opencode.svg";
import workbuddyLogoUrl from "../assets/agent-logos/workbuddy.png";
import memmyRiceLogoUrl from "../assets/mascot/memmy-rice.png";

export const MEMORY_AGENT_SOURCE_VALUES = [
  "memmy-agent",
  "cursor",
  "claude_code",
  "codex",
  "opencode",
  "openclaw",
  "hermes",
  "workbuddy"
] as const;

const AGENT_SOURCE_DISPLAY_NAMES: Record<string, string> = {
  memmy: "Memmy",
  memmy_agent: "Memmy",
  cursor: "Cursor",
  claude_code: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  workbuddy: "WorkBuddy"
};

export const AGENT_SOURCE_LOGOS: Partial<Record<string, string>> = {
  cursor: cursorLogoUrl,
  claude_code: claudeCodeLogoUrl,
  codex: codexLogoUrl,
  opencode: opencodeLogoUrl,
  openclaw: openclawLogoUrl,
  hermes: hermesLogoUrl,
  workbuddy: workbuddyLogoUrl,
  memmy: memmyRiceLogoUrl,
  memmy_agent: memmyRiceLogoUrl
};

export function normalizeAgentSourceId(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

export function agentSourceDisplayName(value: string): string {
  return AGENT_SOURCE_DISPLAY_NAMES[normalizeAgentSourceId(value)] ?? value.trim();
}

export function agentSourceLogoUrl(value: string): string | undefined {
  return AGENT_SOURCE_LOGOS[normalizeAgentSourceId(value)];
}

export function isMemmyAgentSource(value: string): boolean {
  const sourceId = normalizeAgentSourceId(value);
  return sourceId === "memmy" || sourceId === "memmy_agent";
}
