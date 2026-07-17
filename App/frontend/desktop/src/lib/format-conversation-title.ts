const ELLIPSIS = "…";
const DEFAULT_CONVERSATION_TITLE_MAX_LEN = 52;

export function formatConversationTitleForDisplay(
  title: string,
  maxLen: number = DEFAULT_CONVERSATION_TITLE_MAX_LEN
): string {
  const normalized = title.trim();
  if (!normalized || normalized.length <= maxLen) return normalized;
  if (maxLen <= 1) return ELLIPSIS.slice(0, maxLen);
  return `${normalized.slice(0, maxLen - 1)}${ELLIPSIS}`;
}
