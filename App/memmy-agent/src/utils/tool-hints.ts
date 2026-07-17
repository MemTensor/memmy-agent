import { abbreviatePath } from "./path.js";

const TOOL_FORMATS: Record<string, [string[], string, boolean, boolean]> = {
  read_file: [["path", "file_path"], "read {}", true, false],
  write_file: [["path", "file_path"], "write {}", true, false],
  edit_file: [["file_path", "path"], "edit {}", true, false],
  edit: [["file_path", "path"], "edit {}", true, false],
  find_files: [["query", "glob", "path"], "find {}", false, false],
  grep: [["pattern"], 'grep "{}"', false, false],
  exec: [["command", "cmd"], "$ {}", false, true],
  list_exec_sessions: [[], "exec sessions", false, false],
  web_search: [["query"], 'search "{}"', false, false],
  web_fetch: [["url"], "fetch {}", true, false],
  list_dir: [["path"], "ls {}", true, false],
};

const PATH_IN_CMD_RE =
  /"(?<double>(?:[A-Za-z]:[/\\]|~\/|\/)[^"]+)"|'(?<single>(?:[A-Za-z]:[/\\]|~\/|\/)[^']+)'|(?<bare>(?:[A-Za-z]:[/\\]|~\/|(?<=\s)\/)[^\s;&|<>"']+)/g;

function argsOf(toolCall: any): Record<string, any> {
  const args = toolCall?.arguments;
  if (Array.isArray(args)) return args[0] && typeof args[0] === "object" ? args[0] : {};
  return args && typeof args === "object" ? args : {};
}

function extractArg(toolCall: any, keys: string[]): string | null {
  const args = argsOf(toolCall);
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  for (const value of Object.values(args)) if (typeof value === "string" && value) return value;
  return null;
}

function abbreviateCommand(command: string, maxLen: number): string {
  const pathMax = Math.max(Math.floor(maxLen / 2), 25);
  const abbreviated = command.replace(
    PATH_IN_CMD_RE,
    (...replaceArgs) => {
      const match = String(replaceArgs[0]);
      const groups = replaceArgs.at(-1) as Record<string, string | undefined> | undefined;
      if (groups?.double != null) return `"${abbreviatePath(groups.double, pathMax)}"`;
      if (groups?.single != null) return `'${abbreviatePath(groups.single, pathMax)}'`;
      if (groups?.bare != null) return abbreviatePath(groups.bare, pathMax);
      return match;
    },
  );
  return abbreviated.length <= maxLen
    ? abbreviated
    : `${abbreviated.slice(0, Math.max(0, maxLen - 1))}…`;
}

function knownHint(
  toolCall: any,
  fmt: [string[], string, boolean, boolean],
  maxLength: number,
): string {
  if (!fmt[0].length && !fmt[1].includes("{}")) return fmt[1];
  let value = extractArg(toolCall, fmt[0]);
  if (value == null) return toolCall?.name ?? "";
  if (fmt[2]) value = abbreviatePath(value, maxLength);
  if (fmt[3]) value = abbreviateCommand(value, maxLength);
  return fmt[1].replace("{}", value);
}

function mcpHint(toolCall: any, maxLength: number): string {
  const name = String(toolCall?.name ?? "");
  let server = "";
  let tool = "";
  if (name.includes("__")) {
    const index = name.indexOf("__");
    server = name.slice(0, index).replace(/^mcp_/, "");
    tool = name.slice(index + 2);
  } else {
    const rest = name.replace(/^mcp_/, "");
    const index = rest.indexOf("_");
    server = index >= 0 ? rest.slice(0, index) : rest;
    tool = index >= 0 ? rest.slice(index + 1) : "";
  }
  if (!tool) return name;
  const value = Object.values(argsOf(toolCall)).find((item) => typeof item === "string" && item) as
    | string
    | undefined;
  return value ? `${server}::${tool}("${abbreviatePath(value, maxLength)}")` : `${server}::${tool}`;
}

function fallbackHint(toolCall: any, maxLength: number): string {
  const name = String(toolCall?.name ?? "");
  const value = Object.values(argsOf(toolCall))[0];
  if (typeof value !== "string") return name;
  return value.length > maxLength
    ? `${name}("${abbreviatePath(value, maxLength)}")`
    : `${name}("${value}")`;
}

export function formatToolHints(toolCalls: any[] | string[] | string, maxLength = 40): string {
  if (typeof toolCalls === "string") return toolCalls;
  if (!Array.isArray(toolCalls) || !toolCalls.length) return "";
  if (typeof toolCalls[0] === "string") return (toolCalls as string[]).join("\n");
  const formatted = toolCalls.map((call) => {
    const name = String(call?.name ?? call?.function?.name ?? "");
    const fmt = TOOL_FORMATS[name];
    if (fmt) return knownHint(call, fmt, maxLength);
    if (name.startsWith("mcp_")) return mcpHint(call, maxLength);
    return fallbackHint(call, maxLength);
  });
  const collapsed: Array<[string, number]> = [];
  for (const hint of formatted) {
    const last = collapsed.at(-1);
    if (last?.[0] === hint) last[1] += 1;
    else collapsed.push([hint, 1]);
  }
  return collapsed.map(([hint, count]) => (count > 1 ? `${hint} × ${count}` : hint)).join(", ");
}
