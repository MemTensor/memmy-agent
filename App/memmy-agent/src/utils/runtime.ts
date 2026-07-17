import path from "node:path";

export const EMPTY_FINAL_RESPONSE_MESSAGE =
  "I completed the tool steps but couldn't produce a final answer. Please try again or narrow the task.";
export const FINALIZATION_RETRY_PROMPT = "Please provide your response to the user based on the conversation above.";
export const LENGTH_RECOVERY_PROMPT =
  "Output limit reached. Continue exactly where you left off - no recap, no apology. Break remaining work into smaller steps if needed.";
export const SUSTAINED_GOAL_CONTINUE_PROMPT =
  "You have an active sustained goal. Please continue working toward the objective using your tools, or call complete_goal if the work is truly finished.";

const MAX_REPEAT_EXTERNAL_LOOKUPS = 2;
const MAX_REPEAT_WORKSPACE_VIOLATIONS = 2;
const OUTSIDE_PATH_PATTERN = /(?:^|[\s|>'"])((?:\/[^\s"'>;|<]+)|(?:~[^\s"'>;|<]+))/;

export function emptyToolResultMessage(toolName: string): string {
  return `(${toolName} completed with no output)`;
}

export function ensureNonemptyToolResult(toolName: string, content: any): any {
  if (content == null) return emptyToolResultMessage(toolName);
  if (typeof content === "string" && !content.trim()) return emptyToolResultMessage(toolName);
  if (Array.isArray(content)) {
    if (!content.length) return emptyToolResultMessage(toolName);
    const text = stringifyTextBlocks(content);
    if (text != null && !text.trim()) return emptyToolResultMessage(toolName);
  }
  return content;
}

export function isBlankText(content: string | null | undefined): boolean {
  return content == null || !content.trim();
}

export function isEmptyFinalResponse(value: string | null | undefined): boolean {
  return !value || !value.trim() || value.trim() === EMPTY_FINAL_RESPONSE_MESSAGE;
}

export function buildFinalizationRetryMessage(): Record<string, string> {
  return { role: "user", content: FINALIZATION_RETRY_PROMPT };
}

export function buildLengthRecoveryMessage(): Record<string, string> {
  return { role: "user", content: LENGTH_RECOVERY_PROMPT };
}

export function buildGoalContinueMessage(custom: string | null = null): Record<string, string> {
  return { role: "user", content: custom || SUSTAINED_GOAL_CONTINUE_PROMPT };
}

export function externalLookupSignature(toolName: string, args: Record<string, any>): string | null {
  if (toolName === "web_fetch") {
    const url = String(args.url ?? "").trim();
    if (url) return `web_fetch:${url.toLowerCase()}`;
  }
  if (toolName === "web_search") {
    const query = String(args.query ?? args.search_term ?? "").trim();
    if (query) return `web_search:${query.toLowerCase()}`;
  }
  return null;
}

export function repeatedExternalLookupError(toolName: string, args: Record<string, any>, seenCounts: Record<string, number>): string | null {
  const signature = externalLookupSignature(toolName, args);
  if (!signature) return null;
  const count = (seenCounts[signature] ?? 0) + 1;
  seenCounts[signature] = count;
  if (count <= MAX_REPEAT_EXTERNAL_LOOKUPS) return null;
  return "Error: repeated external lookup blocked. Use the results you already have to answer, or try a meaningfully different source.";
}

export function workspaceViolationSignature(toolName: string, args: Record<string, any>): string | null {
  for (const key of ["path", "file_path", "target", "source", "destination"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return normalizeViolationTarget(value.trim());
  }
  if (toolName === "exec" || toolName === "shell") {
    const command = String(args.command ?? "").trim();
    const match = command.match(OUTSIDE_PATH_PATTERN);
    if (match) return normalizeViolationTarget(match[1]);
    const cwd = String(args.working_dir ?? "").trim();
    if (cwd) return normalizeViolationTarget(cwd);
  }
  return null;
}

export function repeatedWorkspaceViolationError(toolName: string, args: Record<string, any>, seenCounts: Record<string, number>): string | null {
  const signature = workspaceViolationSignature(toolName, args);
  if (!signature) return null;
  const count = (seenCounts[signature] ?? 0) + 1;
  seenCounts[signature] = count;
  if (count <= MAX_REPEAT_WORKSPACE_VIOLATIONS) return null;
  const target = signature.includes("violation:") ? signature.split("violation:", 2)[1] : signature;
  return (
    "Error: refusing repeated workspace-bypass attempts.\n" +
    `You have tried to access '${target}' (or an equivalent path) ${count} times in this turn. This is a hard policy boundary -- stop retrying and ask how they want to proceed.`
  );
}

function normalizeViolationTarget(raw: string): string {
  const expanded = raw === "~" || raw.startsWith("~/") ? path.join(process.env.HOME || "", raw.slice(2)) : raw;
  return `violation:${path.resolve(expanded).replace(/\\/g, "/")}`.toLowerCase();
}

function stringifyTextBlocks(content: any[]): string | null {
  const texts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") texts.push(item);
    else if (item && typeof item === "object" && item.type === "text") texts.push(String(item.text ?? ""));
    else return null;
  }
  return texts.join("");
}
