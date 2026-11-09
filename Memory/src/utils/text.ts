export function clip(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 3)}...`;
}

export function firstLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

export function firstSemanticUserLine(value: string): string {
  return firstLine(semanticUserText(value));
}

// Only known source prefixes at the start of a message are protocol metadata.
const SOURCE_TAGS = "timestamp|system_notification|system_reminder|system-reminder|image_files|manually_attached_skills|attached_files|external_links|in-app-browser-context|pasted_content|chat_selection|user_query";
const PREFIX_SPACE = String.raw`^(?:[ \t]*\r?\n)* {0,3}`;
const SOURCE_START = new RegExp(`${PREFIX_SPACE}<(${SOURCE_TAGS})(?=[\\s/>]|$)`, "i");
const TAG_ATTRIBUTES = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*>`;
const SOURCE_OPEN = new RegExp(`${PREFIX_SPACE}<(${SOURCE_TAGS})(?=[\\s/>])${TAG_ATTRIBUTES}`, "i");

type SourceBlock = { start: number; end: number; contentEnd: number; query: boolean };

function leadingSourceBlock(value: string): SourceBlock | undefined {
  // A standalone image marker may be user prose. Only consume the marker when
  // the next block is an explicit attachment or user-query protocol envelope.
  const image = /^(?:[ \t]*\r?\n)* {0,3}\[Image\][ \t]*\r?\n(?=(?:[ \t]*\r?\n)* {0,3}<(?:image_files|attached_files|user_query)(?=[\s/>]))/.exec(value);
  if (image) return { start: image[0].length, end: image[0].length, contentEnd: image[0].length, query: false };
  // chat_selection is the source's explicit fence label, not an arbitrary
  // Markdown language. Other code fences and quoted examples remain literal.
  const fence = /^(?:[ \t]*\r?\n)* {0,3}(`{3,}|~{3,})chat_selection[ \t]*\r?\n/.exec(value);
  if (fence) {
    const closing = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}[ \\t]*(?:\\r?\\n|$)`, "gm");
    closing.lastIndex = fence[0].length;
    const end = closing.exec(value);
    return { start: fence[0].length, end: end ? closing.lastIndex : value.length, contentEnd: end?.index ?? value.length, query: false };
  }
  const opening = SOURCE_OPEN.exec(value);
  if (!opening) {
    return SOURCE_START.test(value) ? { start: value.length, end: value.length, contentEnd: value.length, query: false } : undefined;
  }
  const tag = opening[1]!.toLowerCase();
  if (/\/\s*>$/.test(opening[0])) return { start: opening[0].length, end: opening[0].length, contentEnd: opening[0].length, query: false };
  // Scan every markup token so a matching tag inside another tag's attribute
  // or a comment cannot alter source nesting or the import role boundaries.
  const tokens = /<!--|<!\[CDATA\[|<[!?]|<(\/?)([a-z][\w:-]*)(?=[\s/>])/gi;
  tokens.lastIndex = opening[0].length;
  let depth = 1;
  let token: RegExpExecArray | null;
  while ((token = tokens.exec(value))) {
    const delimiter = token[0] === "<!--" ? "-->" : token[0].toUpperCase() === "<![CDATA[" ? "]]>" : undefined;
    if (delimiter) {
      const end = value.indexOf(delimiter, tokens.lastIndex);
      if (end < 0) break;
      tokens.lastIndex = end + delimiter.length;
      continue;
    }
    let end = tokens.lastIndex;
    let quote = "";
    for (; end < value.length; end += 1) {
      const char = value[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        break;
      }
    }
    if (end === value.length) break;
    tokens.lastIndex = end + 1;
    if (token[2]?.toLowerCase() !== tag) continue;
    if (token[1]) depth -= 1;
    else if (!/\/\s*>$/.test(value.slice(token.index, tokens.lastIndex))) depth += 1;
    if (depth === 0) {
      return { start: opening[0].length, contentEnd: token.index, end: tokens.lastIndex, query: tag === "user_query" };
    }
  }
  // Missing closing boundaries must not expose payload as a user request.
  return { start: value.length, contentEnd: value.length, end: value.length, query: false };
}

/** Protect role headings inside leading source blocks without changing raw text. */
export function sourceEnvelopePrefixLength(value: string): number {
  let offset = value.startsWith("\uFEFF") ? 1 : 0;
  while (offset < value.length) {
    const block = leadingSourceBlock(value.slice(offset));
    if (!block) break;
    offset += block.end;
  }
  return offset;
}

/** Remove whole injected blocks before selecting a line, without changing stored text. */
export function semanticUserText(value: string): string {
  let remaining = value.replace(/^\uFEFF/, "");
  while (remaining) {
    const block = leadingSourceBlock(remaining);
    if (!block) return remaining;
    remaining = block.query ? remaining.slice(block.start, block.contentEnd) : remaining.slice(block.end);
  }
  return "";
}
