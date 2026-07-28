export const OPENCLAW_TERMINAL_SCRIPT = [
  "on run argv",
  "  set binaryPath to item 1 of argv",
  "  set relayPrompt to item 2 of argv",
  "  set launchCommand to \"exec \" & quoted form of binaryPath & \" tui --message \" & quoted form of relayPrompt",
  "  tell application \"Terminal\"",
  "    activate",
  "    do script launchCommand",
  "  end tell",
  "end run"
].join("\n");

/** Label used when Memmy opens a fresh OpenClaw Control UI session for the relay prompt. */
export const OPENCLAW_RELAY_SESSION_LABEL = "Memmy relay";

export const DIRECT_PROMPT_TERMINAL_SCRIPT = [
  "on run argv",
  "  set binaryPath to item 1 of argv",
  "  set relayPrompt to item 2 of argv",
  "  set launchCommand to \"exec \" & quoted form of binaryPath & \" \" & quoted form of relayPrompt",
  "  tell application \"Terminal\"",
  "    activate",
  "    do script launchCommand",
  "  end tell",
  "end run"
].join("\n");

export const CLAUDE_CODE_TERMINAL_SCRIPT = DIRECT_PROMPT_TERMINAL_SCRIPT;

export const OPENCODE_TERMINAL_SCRIPT = [
  "on run argv",
  "  set binaryPath to item 1 of argv",
  "  set relayPrompt to item 2 of argv",
  "  set workingDirectory to item 3 of argv",
  "  set launchCommand to \"exec \" & quoted form of binaryPath & \" \" & quoted form of workingDirectory & \" --prompt \" & quoted form of relayPrompt",
  "  tell application \"Terminal\"",
  "    activate",
  "    do script launchCommand",
  "  end tell",
  "end run"
].join("\n");

export const HERMES_TERMINAL_SCRIPT = [
  "on run argv",
  "  set binaryPath to item 1 of argv",
  "  set relayPrompt to item 2 of argv",
  "  set quotedBinary to quoted form of binaryPath",
  "  set launchCommand to quotedBinary & \" chat -q \" & quoted form of relayPrompt & \"; exec \" & quotedBinary & \" --tui --continue\"",
  "  tell application \"Terminal\"",
  "    activate",
  "    do script launchCommand",
  "  end tell",
  "end run"
].join("\n");

export function openClawBinaryCandidates(homeDirectory: string): string[] {
  return [`${homeDirectory}/.openclaw/bin/openclaw`, `${homeDirectory}/.local/bin/openclaw`, "/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"];
}

export function extractOpenClawDashboardUrl(output: string): string | null {
  const candidates = output.match(/https?:\/\/[^\s]+/gu) ?? [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/u, ""));
      if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        return url.href;
      }
    } catch {
      // Ignore malformed output and let the caller fall back to the terminal.
    }
  }
  return null;
}

/** Parses `openclaw gateway call sessions.create --json` output into a session key. */
export function extractOpenClawSessionKey(output: string): string | null {
  const trimmed = output.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { key?: unknown };
    return typeof parsed.key === "string" && parsed.key.trim() ? parsed.key.trim() : null;
  } catch {
    // Gateway CLI may wrap JSON with logs; recover the first object that carries a key.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1)) as { key?: unknown };
    return typeof parsed.key === "string" && parsed.key.trim() ? parsed.key.trim() : null;
  } catch {
    return null;
  }
}

/** Points the Control UI at a specific dashboard session while preserving auth fragments. */
export function appendOpenClawSessionToDashboardUrl(dashboardUrl: string, sessionKey: string): string {
  const url = new URL(dashboardUrl);
  url.searchParams.set("session", sessionKey);
  return url.href;
}

export function claudeCodeBinaryCandidates(homeDirectory: string): string[] {
  return [`${homeDirectory}/.local/bin/claude`, `${homeDirectory}/.claude/local/claude`, "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}

export function cursorAgentBinaryCandidates(homeDirectory: string): string[] {
  return [
    `${homeDirectory}/.local/bin/cursor-agent`,
    `${homeDirectory}/.cursor/bin/cursor-agent`,
    "/opt/homebrew/bin/cursor-agent",
    "/usr/local/bin/cursor-agent"
  ];
}

export function codexBinaryCandidates(homeDirectory: string): string[] {
  return [`${homeDirectory}/.local/bin/codex`, `${homeDirectory}/.codex/bin/codex`, "/Applications/ChatGPT.app/Contents/Resources/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"];
}

export function opencodeBinaryCandidates(homeDirectory: string): string[] {
  return [`${homeDirectory}/.opencode/bin/opencode`, `${homeDirectory}/.local/bin/opencode`, "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"];
}

export function hermesBinaryCandidates(homeDirectory: string): string[] {
  return [`${homeDirectory}/.hermes/bin/hermes`, `${homeDirectory}/.local/bin/hermes`, "/opt/homebrew/bin/hermes", "/usr/local/bin/hermes"];
}
