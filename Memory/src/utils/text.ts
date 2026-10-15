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

// Only source-protocol envelopes at the beginning of a message are recognized.
// Once ordinary prose, HTML, a quote or code starts, its contents stay literal.
const SOURCE_ENVELOPE = /^(?:[ \t]*\r?\n)* {0,3}<(timestamp|system_notification|system_reminder|image_files|in-app-browser-context|user_query)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>/i;

/** Remove whole injected blocks before selecting a line, without changing stored text. */
export function semanticUserText(value: string): string {
  let remaining = value;
  while (remaining) {
    const opening = SOURCE_ENVELOPE.exec(remaining);
    if (!opening) {
      // A truncated opening tag is also context, not a useful preview.
      return /^(?:[ \t]*\r?\n)* {0,3}<(timestamp|system_notification|system_reminder|image_files|in-app-browser-context|user_query)(?=[\s/>]|$)/i.test(remaining)
        ? "" : remaining;
    }
    const tag = opening[1]!.toLowerCase();
    if (/\/\s*>$/.test(opening[0])) {
      remaining = remaining.slice(opening[0].length);
      continue;
    }
    const tokens = new RegExp(`<(/?)${tag}(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
    tokens.lastIndex = opening[0].length;
    let depth = 1;
    let closing: RegExpExecArray | null;
    while ((closing = tokens.exec(remaining))) {
      if (closing[1]) depth -= 1;
      else if (!/\/\s*>$/.test(closing[0])) depth += 1;
      if (depth === 0) break;
    }
    // An incomplete envelope has no reliable boundary; never expose its payload.
    if (!closing) return "";
    remaining = tag === "user_query"
      ? remaining.slice(opening[0].length, closing.index)
      : remaining.slice(tokens.lastIndex);
  }
  return "";
}
