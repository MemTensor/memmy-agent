import claudeCodeLogoUrl from "../assets/agent-logos/claude-code.svg";
import codexLogoUrl from "../assets/agent-logos/codex.svg";
import cursorLogoUrl from "../assets/agent-logos/cursor.svg";
import deepseekHarnessLogoUrl from "../assets/agent-logos/deepseek-harness.svg";
import hermesLogoUrl from "../assets/agent-logos/hermes.svg";
import openclawLogoUrl from "../assets/agent-logos/openclaw.svg";
import opencodeLogoUrl from "../assets/agent-logos/opencode.svg";
import piLogoUrl from "../assets/agent-logos/pi.svg";
import qwenworkLogoUrl from "../assets/agent-logos/qwenwork.svg";
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
  "deepseek_harness",
  "workbuddy",
  "pi",
  "qwenwork"
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
  deepseek_harness: "DeepSeek Harness",
  workbuddy: "WorkBuddy",
  pi: "Pi",
  qwenwork: "QwenWork"
};

export const AGENT_SOURCE_LOGOS: Partial<Record<string, string>> = {
  cursor: cursorLogoUrl,
  claude_code: claudeCodeLogoUrl,
  codex: codexLogoUrl,
  opencode: opencodeLogoUrl,
  openclaw: openclawLogoUrl,
  hermes: hermesLogoUrl,
  deepseek_harness: deepseekHarnessLogoUrl,
  workbuddy: workbuddyLogoUrl,
  pi: piLogoUrl,
  qwenwork: qwenworkLogoUrl,
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
