const AGENT_TOOL_PROMPT_DEEPLINK_BUILDERS: Readonly<Record<string, (prompt: string) => string>> = {
  cursor: (prompt) => `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`,
  claude_code: (prompt) => `claude://claude.ai/new?q=${encodeURIComponent(prompt)}`,
  workbuddy: () => "workbuddy://"
};

const AGENT_TOOL_CLI_DEEPLINK_BUILDERS: Readonly<Record<string, (prompt: string) => string>> = {
  claude_code: (prompt) => `claude-cli://open?q=${encodeURIComponent(prompt)}`
};

export interface AgentToolLaunchRequest {
  sourceId: string;
  prompt: string;
}

export interface AgentToolDeepLinkOptions {
  homeDirectory?: string;
}

export function normalizeAgentToolLaunchRequest(rawSourceId: unknown, rawPrompt: unknown): AgentToolLaunchRequest | null {
  if (typeof rawSourceId !== "string" || typeof rawPrompt !== "string") {
    return null;
  }
  const sourceId = rawSourceId.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  const prompt = rawPrompt.trim();
  return sourceId && prompt ? { sourceId, prompt } : null;
}

export function buildAgentToolPromptDeepLink(
  rawSourceId: unknown,
  rawPrompt: unknown,
  options: AgentToolDeepLinkOptions = {}
): string | null {
  const request = normalizeAgentToolLaunchRequest(rawSourceId, rawPrompt);
  if (!request) {
    return null;
  }
  const homeDirectory = options.homeDirectory?.trim();
  if (request.sourceId === "codex") {
    const promptParameter = `prompt=${encodeURIComponent(request.prompt)}`;
    return homeDirectory
      ? `codex://threads/new?${promptParameter}&path=${encodeURIComponent(homeDirectory)}`
      : `codex://threads/new?${promptParameter}`;
  }
  if (request.sourceId === "opencode") {
    return homeDirectory
      ? `opencode://new-session?directory=${encodeURIComponent(homeDirectory)}&prompt=${encodeURIComponent(request.prompt)}`
      : null;
  }
  const buildDeepLink = AGENT_TOOL_PROMPT_DEEPLINK_BUILDERS[request.sourceId];
  return buildDeepLink ? buildDeepLink(request.prompt) : null;
}

export function buildAgentToolCliPromptDeepLink(rawSourceId: unknown, rawPrompt: unknown): string | null {
  const request = normalizeAgentToolLaunchRequest(rawSourceId, rawPrompt);
  if (!request) {
    return null;
  }
  const buildDeepLink = AGENT_TOOL_CLI_DEEPLINK_BUILDERS[request.sourceId];
  return buildDeepLink ? buildDeepLink(request.prompt) : null;
}
