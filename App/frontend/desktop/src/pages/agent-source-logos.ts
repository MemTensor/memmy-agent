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
import memmyAppIconUrl from "../assets/memmy-app-icon.png";
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
  memmy_agent: memmyRiceLogoUrl,
  computer_history: memmyRiceLogoUrl
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

/**
 * 方块槽位里用的标志：Agent 列表里每个 Agent 都是一枚方块标志（22px 的圆角白底、15px 的图），
 * 而 Memmy 在 {@link AGENT_SOURCE_LOGOS} 里是水彩插画（512×308 的横图，给记忆页那些宽槽位用），
 * 塞进方块会被压成一条。这种槽位改用应用图标，与标题栏、启动卡上的 Memmy 一致。
 */
export function agentSourceSquareLogoUrl(value: string): string | undefined {
  return isMemmyAgentSource(value) ? memmyAppIconUrl : agentSourceLogoUrl(value);
}

export function isMemmyAgentSource(value: string): boolean {
  const sourceId = normalizeAgentSourceId(value);
  return sourceId === "memmy" || sourceId === "memmy_agent" || sourceId === "computer_history";
}
