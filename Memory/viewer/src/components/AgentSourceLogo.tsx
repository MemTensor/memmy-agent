import claudeCodeLogoUrl from "../../../../App/frontend/desktop/src/assets/agent-logos/claude-code.svg";
import codexLogoUrl from "../../../../App/frontend/desktop/src/assets/agent-logos/codex.svg";
import cursorLogoUrl from "../../../../App/frontend/desktop/src/assets/agent-logos/cursor.svg";
import deepseekHarnessLogoUrl from "../../../../App/frontend/desktop/src/assets/agent-logos/deepseek-harness.svg";
import hermesLogoUrl from "../../../../App/frontend/desktop/src/assets/agent-logos/hermes.svg";
import openclawLogoUrl from "../../../../App/frontend/desktop/src/assets/agent-logos/openclaw.svg";
import opencodeLogoUrl from "../../../../App/frontend/desktop/src/assets/agent-logos/opencode.svg";
import piLogoUrl from "../../../../App/frontend/desktop/src/assets/agent-logos/pi.svg";
import qwenworkLogoUrl from "../../../../App/frontend/desktop/src/assets/agent-logos/qwenwork.svg";
import workbuddyLogoUrl from "../../../../App/frontend/desktop/src/assets/agent-logos/workbuddy.png";
import memmyRiceLogoUrl from "../../../../App/frontend/desktop/src/assets/mascot/memmy-rice.png";
import { normalizeAgentSource, sourceAgentInitials } from "./agent-source";

const AGENT_SOURCE_LOGOS: Partial<Record<string, string>> = {
  memmy: memmyRiceLogoUrl,
  memmy_agent: memmyRiceLogoUrl,
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
};

interface AgentSourceLogoProps {
  sourceId: string;
  displayName: string;
  compact?: boolean;
}

export function AgentSourceLogo({ sourceId, displayName, compact = false }: AgentSourceLogoProps) {
  const logoUrl = AGENT_SOURCE_LOGOS[normalizeAgentSource(sourceId)];
  const compactClass = compact ? " agent-source-logo--compact" : "";

  return (
    <span class={`agent-source-logo${compactClass}`} aria-hidden="true">
      {logoUrl ? (
        <img class="agent-source-logo__image" src={logoUrl} alt="" />
      ) : (
        <span class="agent-source-logo__initials">{sourceAgentInitials(displayName)}</span>
      )}
    </span>
  );
}
