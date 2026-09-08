// Layered summaries.
//
// A six-hour summary is built from the ten-minute summaries that cover it, not
// by re-reading every raw event in the window. That keeps the cost of looking
// back proportional to the number of summaries rather than the size of the
// event stream, and it is why the six-hour file cites the ten-minute files it
// reused instead of the segments underneath them.

export const TEN_MINUTE_MS = 10 * 60 * 1000;
export const SIX_HOUR_MS = 6 * 60 * 60 * 1000;

export interface SummaryInput {
  /** File name, e.g. `2026-09-08T03-30-00Z-10min-summary.md`. */
  name: string;
  markdown: string;
}

export interface RollupResult {
  id: string;
  fileName: string;
  markdown: string;
  citedSummaries: string[];
}

/** Parses the aligned UTC instant encoded in a summary or segment id. */
export function instantFromId(id: string): Date | null {
  const match = id.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const value = Date.UTC(
    Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second),
  );
  return Number.isNaN(value) ? null : new Date(value);
}

export function alignedId(at: Date, windowMs: number): string {
  const aligned = new Date(Math.floor(at.getTime() / windowMs) * windowMs);
  return `${aligned.toISOString().slice(0, 19).replace(/:/g, "-")}Z`;
}

function frontmatterValue(markdown: string, key: string): string | null {
  const match = markdown.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return null;
  return match[1].trim().replace(/^["']|["']$/g, "") || null;
}

function sectionBody(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n${heading}\n`);
  if (start === -1) return "";
  const rest = markdown.slice(start + heading.length + 2);
  const end = rest.search(/\n#{2,3} /);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function uniqueLines(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** Returns the ten-minute summaries whose window falls inside `windowStart`. */
export function summariesInWindow(summaries: SummaryInput[], windowStart: Date): SummaryInput[] {
  const start = windowStart.getTime();
  const end = start + SIX_HOUR_MS;
  return summaries
    .filter((summary) => {
      if (!summary.name.includes("-10min-")) return false;
      const at = instantFromId(summary.name);
      return at !== null && at.getTime() >= start && at.getTime() < end;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildSixHourSummary(
  summaries: SummaryInput[],
  windowStart: Date,
): RollupResult | null {
  const covered = summariesInWindow(summaries, windowStart);
  if (!covered.length) return null;

  const id = alignedId(windowStart, SIX_HOUR_MS);
  const applications = uniqueLines(
    covered.flatMap((summary) => {
      const raw = frontmatterValue(summary.markdown, "applications") ?? "";
      return raw.replace(/^\[|\]$/g, "").split(",");
    }).map((value) => value.trim().replace(/^["']|["']$/g, "")),
  );
  const titles = uniqueLines(covered.map(
    (summary) => frontmatterValue(summary.markdown, "title") ?? summary.name,
  ));
  const priorContext = uniqueLines(
    covered.flatMap((summary) => sectionBody(summary.markdown, "### Relevant prior context").split("\n")),
  );
  const nonObvious = uniqueLines(
    covered.flatMap((summary) => sectionBody(summary.markdown, "### Important non-obvious context").split("\n")),
  );

  const windowEnd = new Date(windowStart.getTime() + SIX_HOUR_MS);
  const markdown = [
    "---",
    `title: "6h activity ${id}"`,
    `description: "Rolled up from ${covered.length} ten-minute summaries covering `
      + `${windowStart.toISOString()} to ${windowEnd.toISOString()}."`,
    `applications: [${applications.map((value) => `"${value}"`).join(", ")}]`,
    "summary_window: 6h",
    `source_type: rollup`,
    "---",
    "",
    "## Memory summary",
    "",
    `本窗口由 ${covered.length} 份 10 分钟摘要汇总而来，覆盖 ${applications.length} 个应用。`,
    "",
    "### Relevant prior context",
    "",
    ...(priorContext.length ? priorContext : ["（无）"]),
    "",
    "### Important non-obvious context",
    "",
    ...(nonObvious.length ? nonObvious : ["（无）"]),
    "",
    "## Recording summary",
    "",
    ...titles.map((title) => `- ${title}`),
    "",
    "## Citations",
    "",
    // Citing the reused summaries rather than the raw segments is the point of
    // the layer: a reader can follow one level down, not all the way down.
    ...covered.map((summary) => `- ${summary.name}`),
    "",
  ].join("\n");

  return { id, fileName: `${id}-6h-summary.md`, markdown, citedSummaries: covered.map((s) => s.name) };
}
