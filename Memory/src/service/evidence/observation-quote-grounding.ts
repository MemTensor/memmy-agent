/** Resolve a display quotation to one continuous span of the retained source.
 * Formatting tolerance never changes the evidence saved in the memory. */
export function resolveObservationQuote(fragments: readonly string[], quote: string): string | undefined {
  const rawQuote = normalizedView(quote, false).text, displayQuote = normalizedView(quote, true).text;
  if (!rawQuote) return undefined;
  for (const [fragmentIndex, fragment] of fragments.entries()) {
    // Keep the original exact/whitespace-normalized behavior first, including
    // valid quotations that start or end inside an emphasis span.
    // A retained tail may start inside code after its opening fence was cut.
    // Only the original head has enough context for formatting tolerance.
    for (const stripEmphasis of fragmentIndex === 0 ? [false, true] : [false]) {
      const wanted = stripEmphasis ? displayQuote : rawQuote;
      if (!wanted) continue;
      const source = normalizedView(fragment, stripEmphasis);
      for (let exact = source.text.indexOf(wanted); exact >= 0; exact = source.text.indexOf(wanted, exact + 1)) {
        const span = originalSpan(fragment, source, exact, exact + wanted.length);
        if (span && span.text.length <= MAX_QUOTE_LENGTH) return span.text;
      }
      const pieces = wanted.split(/\s*\.{3,}\s*/u).filter(Boolean);
      if (!pieces.length || pieces.some((piece) => piece.length < 4)) continue;
      for (let start = source.text.indexOf(pieces[0]!); start >= 0; start = source.text.indexOf(pieces[0]!, start + 1)) {
        let end = start + pieces[0]!.length;
        const gaps: Array<{ start: number; end: number }> = [];
        let found = true;
        for (const piece of pieces.slice(1)) {
          const at = source.text.indexOf(piece, end);
          if (at < 0 || at - end > MAX_SINGLE_LINE_GAP) { found = false; break; }
          gaps.push({ start: end, end: at });
          end = at + piece.length;
        }
        if (!found) continue;
        const span = originalSpan(fragment, source, start, end);
        if (!span || span.text.length > MAX_QUOTE_LENGTH) continue;
        if (!/[\r\n]/u.test(span.text)
          && gaps.every((gap) => gap.end - gap.start <= MAX_SINGLE_LINE_GAP)) return span.text;
      }
    }
  }
  return undefined;
}

const MAX_QUOTE_LENGTH = 800;
const MAX_SINGLE_LINE_GAP = 40;
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
type Emphasis = { start: number; contentStart: number; contentEnd: number; end: number };
type NormalizedView = { text: string; starts: number[]; ends: number[]; emphasis: Emphasis[] };
type Line = { start: number; end: number; text: string; code: boolean };

function lines(value: string): Line[] {
  const result: Line[] = [];
  let offset = 0, fence: { character: string; length: number } | undefined;
  for (const raw of value.split("\n")) {
    const text = raw.replace(/\r$/u, "");
    const marker = /^[ \t]*(`{3,}|~{3,})/u.exec(text)?.[1];
    const indentedCode = /^(?: {4}|\t)/u.test(text) && !/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/u.test(text);
    const code = Boolean(fence || marker || indentedCode);
    if (fence) {
      if (marker?.[0] === fence.character && marker.length >= fence.length
        && new RegExp(`^[ \\t]*${fence.character}{${fence.length},}\\s*$`, "u").test(text)) fence = undefined;
    } else if (marker) fence = { character: marker[0]!, length: marker.length };
    result.push({ start: offset, end: offset + raw.length, text, code });
    offset += raw.length + 1;
  }
  return result;
}

function escaped(value: string, at: number): boolean {
  let count = 0;
  while (at > 0 && value[--at] === "\\") count += 1;
  return count % 2 === 1;
}

/** Only explicit Markdown labels and complete table cells permit optional
 * bold markers. Ordinary prose and exponent operators remain exact text. */
function emphasisSpans(value: string): Emphasis[] {
  const result: Emphasis[] = [];
  for (const line of lines(value)) {
    if (line.code) continue;
    const protectedCode = new Uint8Array(line.text.length);
    for (let at = 0; at < line.text.length; at += 1) {
      if (line.text[at] !== "`" || escaped(line.text, at)) continue;
      let after = at + 1;
      while (line.text[after] === "`") after += 1;
      const marker = line.text.slice(at, after);
      let close = line.text.indexOf(marker, after);
      while (close >= 0 && (line.text[close - 1] === "`" || line.text[close + marker.length] === "`")) {
        close = line.text.indexOf(marker, close + marker.length);
      }
      const end = close < 0 ? line.text.length : close + marker.length;
      protectedCode.fill(1, at, end);
      at = end - 1;
    }
    for (let at = 0; at < line.text.length - 1; at += 1) {
      if (line.text.slice(at, at + 2) !== "**" || protectedCode[at] || escaped(line.text, at)
        || line.text[at - 1] === "*" || line.text[at + 2] === "*"
        || !line.text[at + 2] || /\s/u.test(line.text[at + 2]!)
        || (at > 0 && /[\p{L}\p{N}_]/u.test(line.text[at - 1]!))) continue;
      let close = line.text.indexOf("**", at + 2);
      while (close >= 0 && (protectedCode[close] || escaped(line.text, close)
        || line.text[close - 1] === "*" || line.text[close + 2] === "*"
        || /\s/u.test(line.text[close - 1]!)
        || (line.text[close + 2] && /[\p{L}\p{N}_]/u.test(line.text[close + 2]!)))) {
        close = line.text.indexOf("**", close + 2);
      }
      if (close < 0) continue;
      const label = /[:：]/u.test(line.text[close + 2] ?? "");
      const leftCell = line.text.lastIndexOf("|", at), rightCell = line.text.indexOf("|", close + 2);
      const tableCell = line.text.trim().startsWith("|") && line.text.trim().endsWith("|")
        && leftCell >= 0 && rightCell >= 0 && !escaped(line.text, leftCell) && !escaped(line.text, rightCell)
        && !line.text.slice(leftCell + 1, at).trim() && !line.text.slice(close + 2, rightCell).trim();
      if (!label && !tableCell) continue;
      result.push({ start: line.start + at, contentStart: line.start + at + 2,
        contentEnd: line.start + close, end: line.start + close + 2 });
      at = close + 1;
    }
  }
  return result;
}

function normalizedView(value: string, stripEmphasis: boolean): NormalizedView {
  const emphasis = emphasisSpans(value), removed = new Uint8Array(value.length);
  for (const pair of stripEmphasis ? emphasis : []) {
    removed.fill(1, pair.start, pair.contentStart);
    removed.fill(1, pair.contentEnd, pair.end);
  }
  let text = "", pendingSpace: { start: number; end: number } | undefined;
  const starts: number[] = [], ends: number[] = [];
  for (const part of graphemes.segment(value)) {
    if (removed[part.index]) continue;
    const end = part.index + part.segment.length;
    for (const character of part.segment.normalize("NFKC")) {
      if (/\s/u.test(character)) {
        if (text) pendingSpace = { start: pendingSpace?.start ?? part.index, end };
        continue;
      }
      if (pendingSpace) {
        text += " "; starts.push(pendingSpace.start); ends.push(pendingSpace.end); pendingSpace = undefined;
      }
      text += character;
      // Search indices are UTF-16 offsets, including supplementary characters.
      for (let unit = 0; unit < character.length; unit += 1) { starts.push(part.index); ends.push(end); }
    }
  }
  return { text, starts, ends, emphasis };
}

function originalSpan(value: string, view: NormalizedView, from: number, to: number):
  { start: number; end: number; text: string } | undefined {
  let start = view.starts[from], end = view.ends[to - 1];
  if (start === undefined || end === undefined) return undefined;
  for (const pair of view.emphasis) {
    if (start <= pair.contentStart && end >= pair.contentEnd) {
      start = Math.min(start, pair.start); end = Math.max(end, pair.end);
    }
  }
  return { start, end, text: value.slice(start, end) };
}
