export const MEMMY_MEMORY_CONTEXT_TAG = "memmy_memory_context";
export const CURRENT_USER_REQUEST_TAG = "current_user_request";

const MEMORY_CONTEXT_TAGS = [
  MEMMY_MEMORY_CONTEXT_TAG,
  "memos_context",
  "memory_context",
] as const;

export function sanitizeMemmyProtocolText(value: string): string {
  return normalizeProtocolWhitespace(unwrapCurrentUserRequestBlocks(stripMemoryContextBlocks(value)));
}

export function sanitizeMemmyProtocolValue<T>(value: T): T {
  if (typeof value === "string") return sanitizeMemmyProtocolText(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeMemmyProtocolValue(item)) as T;
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = sanitizeMemmyProtocolValue(item);
  }
  return output as T;
}

export function stripMemoryContextBlocks(value: string): string {
  let text = value;
  for (const tag of MEMORY_CONTEXT_TAGS) {
    text = replaceTaggedBlocks(text, tag, () => "", { removeUnclosedTail: true });
  }
  return text;
}

export function unwrapCurrentUserRequestBlocks(value: string): string {
  return replaceTaggedBlocks(value, CURRENT_USER_REQUEST_TAG, (inner) => inner);
}

export function isMemmyRecallToolName(name: unknown): boolean {
  return name === "memmy_memory_search" || name === "memmy_memory_get";
}

export function memmyRecallToolPlaceholder(name: unknown): string {
  const toolName = isMemmyRecallToolName(name) ? String(name) : "memmy_memory";
  return `[memmy memory result omitted from capture: ${toolName}]`;
}

function replaceTaggedBlocks(
  value: string,
  tag: string,
  replace: (inner: string, openTag: string, closeTag: string) => string,
  options: { removeUnclosedTail?: boolean } = {},
): string {
  let text = value;
  for (;;) {
    const openMatch = new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>`, "i").exec(text);
    if (!openMatch) return text;
    const openStart = openMatch.index;
    const openEnd = openStart + openMatch[0].length;
    const closeMatch = new RegExp(`</${escapeRegExp(tag)}>`, "i").exec(text.slice(openEnd));
    if (!closeMatch) {
      if (!options.removeUnclosedTail) return text;
      text = text.slice(0, openStart).trimEnd();
      continue;
    }
    const closeStart = openEnd + closeMatch.index;
    const closeEnd = closeStart + closeMatch[0].length;
    const inner = text.slice(openEnd, closeStart);
    text = `${text.slice(0, openStart)}${replace(inner, openMatch[0], closeMatch[0])}${text.slice(closeEnd)}`;
  }
}

function normalizeProtocolWhitespace(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
