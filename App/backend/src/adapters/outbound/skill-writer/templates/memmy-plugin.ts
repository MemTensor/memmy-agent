import type { SkillManifest } from "../types.js";

const MEMMY_MARKER = "<!-- memmy:start v=1 -->";

export function renderMemmyPluginSkillManifest(targetId: string): SkillManifest {
  return {
    targetId,
    content: renderMemmyPluginContent(targetId),
    marker: MEMMY_MARKER
  };
}

function renderMemmyPluginContent(source: string): string {
  return [
    "# Memmy Memory",
    "",
    "A Memmy Memory Hook or plugin is installed for this agent.",
    "",
    "## Automatic Memory",
    "",
    "- The installed integration automatically recalls relevant context and captures completed turns.",
    "- Do not manually operate the memory lifecycle or write memories during normal conversations.",
    "- Treat injected memory as background context and use it only when relevant to the current request.",
    "- Treat `<memmy_memory_context>` as historical memory only and `<current_user_request>` as the authoritative current task.",
    "- Do not store secrets, tokens, private keys, raw credentials, or bulky logs.",
    "- If the memory service is unavailable, continue the task without inventing memory.",
    "",
    "## On-Demand Lookup",
    "",
    "Use the CLI only when the current request needs memory beyond the context already injected by the integration:",
    "",
    "```bash",
    `memmy-memory search "query text" --source ${source}`,
    `memmy-memory get "$MEMORY_ID" --source ${source}`,
    "```",
    "",
    "Search only when prior preferences, project decisions, recurring issues, or reusable procedures are likely relevant. Read a specific memory only when search results or injected context provide its id and more detail is needed."
  ].join("\n");
}
