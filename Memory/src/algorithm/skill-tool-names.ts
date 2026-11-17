import { isRecord } from "../utils/json.js";

const SHELL_LIKE_TOOLS = new Set([
  "shell",
  "bash",
  "terminal",
  "exec_command",
  "run_command",
  "execute_command"
]);

const COMMAND_TOKEN = /^[a-z0-9][a-z0-9._+-]{1,63}$/;

export function toolCallName(call: unknown): string | undefined {
  if (!isRecord(call)) return undefined;
  const value = call.name ?? call.tool ?? call.toolName ?? call.tool_name;
  if (typeof value !== "string") return undefined;
  const name = normalizeToolName(value);
  return name && name !== "unknown" && name !== "unknown_tool" ? name : undefined;
}

export function extractToolEvidenceNames(calls: readonly unknown[] | undefined): string[] {
  const names = new Set<string>();
  for (const call of calls ?? []) {
    const name = toolCallName(call);
    if (!name) continue;
    names.add(name);
    const command = inferredCommandName(name, isRecord(call)
      ? call.input ?? call.arguments ?? call.args ?? call.params
      : undefined);
    if (command) names.add(command);
  }
  return [...names].sort();
}

export function normalizeToolName(value: string): string {
  return value.trim().toLowerCase();
}

function inferredCommandName(toolName: string, input: unknown): string | undefined {
  if (!SHELL_LIKE_TOOLS.has(normalizeToolName(toolName))) return undefined;

  let command: unknown = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    const parsed = parseJsonObject(trimmed);
    if (parsed) command = parsed.command ?? parsed.cmd;
  } else if (isRecord(input)) {
    command = input.command ?? input.cmd;
  }

  if (typeof command !== "string") return undefined;
  const first = command.trim().split(/\s+/)[0]?.toLowerCase();
  return first && COMMAND_TOKEN.test(first) ? first : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  if (!value.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
