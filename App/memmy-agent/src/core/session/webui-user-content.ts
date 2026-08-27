const GOAL_CONTROL_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "help",
  "pause",
  "resume",
  "edit",
  "budget",
  "clear",
]);

export const GOAL_COMMAND_SUBCOMMANDS: ReadonlySet<string> = new Set([
  ...GOAL_CONTROL_SUBCOMMANDS,
  "create",
]);

type SessionMessageLike = {
  role?: unknown;
  content?: unknown;
  commandMessage?: unknown;
  internal_context?: unknown;
};

/** Returns the objective carried by a Goal creation command. */
export function goalObjectiveFromCommand(content: string): string | null {
  const match = /^\/goal(?:\s+(.*))?$/is.exec(content.trim());
  const args = match?.[1]?.trim() ?? "";
  if (!args) return null;

  const [first = "", ...remaining] = args.split(/\s+/);
  const command = first.toLowerCase();
  if (command === "create") return remaining.join(" ").trim() || null;
  if (GOAL_CONTROL_SUBCOMMANDS.has(command)) return null;
  return args;
}

/** Removes the Goal command wrapper from user-facing WebUI text. */
export function visibleWebuiUserContent(content: string): string {
  return goalObjectiveFromCommand(content) ?? content;
}

/** Returns user text that may participate in automatic WebUI title generation. */
export function webuiTitleUserText(message: SessionMessageLike): string | null {
  if (message.role !== "user" || message.internal_context === "goal_continuation") return null;
  const content = typeof message.content === "string" ? message.content.trim() : "";
  if (!content) return null;
  if (message.commandMessage === true) return goalObjectiveFromCommand(content);
  if (content.startsWith("/")) return null;
  return content;
}
