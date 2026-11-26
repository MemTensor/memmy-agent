// Layered summaries.
//
// A six-hour summary is built from the ten-minute summaries that cover it, not
// by re-reading every raw event in the window. That keeps the cost of looking
// back proportional to the number of summaries rather than the size of the
// event stream, and it is why the six-hour file cites the ten-minute files it
// reused instead of the segments underneath them.

import { MAX_EVIDENCE_CHARS } from "./summary-writer.js";

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
  /** Ready, completed ten-minute entries actually used by this rollup. */
  coveredHistoryIds: string[];
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
  return instantId(new Date(Math.floor(at.getTime() / windowMs) * windowMs));
}

/** The id for an instant that is already the start of its window. */
export function instantId(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace(/:/g, "-")}Z`;
}

/**
 * The start of the six-hour window containing `at`, on the local clock.
 *
 * A six-hour summary is read as a part of the day, so its window has to be one:
 * aligned to local midnight, the four windows are night, morning, afternoon and
 * evening. Aligned to the epoch instead, their boundaries fell at 02/08/14/20 in
 * UTC+8 — two windows began before noon and both read as "morning", and one
 * straddled midnight and belonged to two days.
 */
export function sixHourWindowStart(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), Math.floor(at.getHours() / 6) * 6);
}

/** Whether a six-hour summary's window starts where the local clock says it should. */
export function isLocalSixHourWindow(start: Date): boolean {
  return sixHourWindowStart(start).getTime() === start.getTime();
}

/** A rollup becomes final only after its complete local six-hour window has elapsed. */
export function isSixHourWindowClosed(start: Date, now = new Date()): boolean {
  return now.getTime() >= start.getTime() + SIX_HOUR_MS;
}

function frontmatterValue(markdown: string, key: string): string | null {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1];
  if (!frontmatter) return null;
  const match = frontmatter.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
  if (!match) return null;
  const raw = match[1].trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") return parsed || null;
  } catch {
    // Older summaries used unquoted YAML scalar values.
  }
  return raw.replace(/^["']|["']$/g, "") || null;
}

/** Exact membership of a rollup, including the citations written by older versions. */
export function rollupCoveredHistoryIds(markdown: string, historyId: string): string[] {
  const rollupId = historyId.replace(/\.md$/u, "");
  const start = instantFromId(rollupId);
  if (!start || `${instantId(start)}-6h-summary` !== rollupId) return [];
  const valid = (id: unknown): id is string => {
    if (typeof id !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-10min-summary$/u.test(id)) return false;
    const at = instantFromId(id);
    return at !== null && `${instantId(at)}-10min-summary` === id
      && at.getTime() % TEN_MINUTE_MS === 0
      && at.getTime() >= start.getTime() && at.getTime() < start.getTime() + SIX_HOUR_MS;
  };
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u)?.[1] ?? "";
  const explicit = frontmatter.match(/^covered_history_ids:[ \t]*(.*)$/mu);
  if (explicit) {
    // An explicit empty array is authoritative. Invalid metadata must not
    // silently acquire a different meaning from old citations either.
    try {
      const parsed: unknown = JSON.parse(explicit[1]);
      return Array.isArray(parsed) ? [...new Set(parsed.filter(valid))] : [];
    } catch { return []; }
  }
  const citations = (markdown.replace(/\r\n/gu, "\n").split(/^## Citations[ \t]*\n/mu)[1] ?? "")
    .split(/^## /mu)[0];
  return [...new Set([...citations.matchAll(/^- (\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-10min-summary)\.md[ \t]*$/gmu)]
    .map((match) => match[1]).filter(valid))];
}

export function isCompletedCapturedSummary(summary: SummaryInput): boolean {
  const source = frontmatterValue(summary.markdown, "source_type");
  return (source === "captured" || source === "human_computer_history")
    && frontmatterValue(summary.markdown, "summary_state") === "ready"
    && frontmatterValue(summary.markdown, "status") === "completed";
}

function sectionBody(markdown: string, heading: string): string {
  const normalized = markdown.replace(/\r\n/gu, "\n");
  const start = normalized.indexOf(`\n${heading}\n`);
  if (start === -1) return "";
  const rest = normalized.slice(start + heading.length + 2);
  // A recording can contain several activity arcs under ### headings. Keep
  // those, while stopping Memory summary before its contextual subsections.
  const end = rest.search(heading === "## Recording summary" ? /\n## /u : /\n#{2,3} /u);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

function excerpt(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 5) return value.slice(0, Math.max(0, limit));
  // Conclusions often occur at the end; a prefix alone systematically loses
  // them when a window or section has more evidence than the budget permits.
  const head = Math.ceil((limit - 5) * 0.6);
  const tail = limit - 5 - head;
  return `${value.slice(0, head)}\n...\n${tail ? value.slice(-tail) : ""}`;
}

/** Share a budget fairly, reallocating the space unused by shorter sections. */
function fitSections(sections: string[], limit: number): string {
  const present = sections.filter(Boolean);
  let remaining = Math.max(0, limit - Math.max(0, present.length - 1) * 2);
  const limits = new Map<number, number>();
  const shortestFirst = present.map((value, index) => ({ index, length: value.length }))
    .sort((left, right) => left.length - right.length);
  shortestFirst.forEach(({ index, length }, position) => {
    const allocated = Math.min(length, Math.floor(remaining / (present.length - position)));
    limits.set(index, allocated);
    remaining -= allocated;
  });
  return present.map((value, index) => excerpt(value, limits.get(index) ?? 0)).join("\n\n");
}

function summaryEvidence(summary: SummaryInput, limit: number): string {
  const title = frontmatterValue(summary.markdown, "title") ?? summary.name;
  const time = instantFromId(summary.name)?.toISOString().slice(11, 16) ?? "";
  const heading = `### ${time} UTC — ${excerpt(title.replace(/\s+/gu, " "), 80)}`;
  const description = frontmatterValue(summary.markdown, "description");
  const memory = sectionBody(summary.markdown, "## Memory summary");
  const recording = sectionBody(summary.markdown, "## Recording summary");
  const parts = [
    description ? `Description: ${description}` : "",
    memory ? `Memory: ${memory}` : "",
    recording ? `Activity: ${recording}` : "",
  ];
  // Older ready summaries can have plain prose instead of the named sections.
  if (!parts.some(Boolean)) {
    parts.push(summary.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "")
      .split(/^## Citations\s*$/mu)[0].trim());
  }
  return `${heading}\n\n${fitSections(parts, Math.max(0, limit - heading.length - 2))}`;
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
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-10min-summary\.md$/u.test(summary.name)) return false;
      const at = instantFromId(summary.name);
      return at !== null && at.getTime() % TEN_MINUTE_MS === 0 && at.getTime() >= start && at.getTime() < end;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildSixHourSummary(
  summaries: SummaryInput[],
  windowStart: Date,
): RollupResult | null {
  const covered = summariesInWindow(summaries, windowStart).filter(isCompletedCapturedSummary);
  if (!covered.length) return null;

  // The window is chosen by the caller on the local clock; re-aligning it to
  // the epoch here would undo that.
  const id = instantId(windowStart);
  const applications = uniqueLines(
    covered.flatMap((summary) => {
      const raw = frontmatterValue(summary.markdown, "applications") ?? "";
      return raw.replace(/^\[|\]$/g, "").split(",");
    }).map((value) => value.trim().replace(/^["']|["']$/g, "")),
  );
  const priorContext = uniqueLines(
    covered.flatMap((summary) => sectionBody(summary.markdown, "### Relevant prior context").split("\n")),
  );
  const nonObvious = uniqueLines(
    covered.flatMap((summary) => (
      sectionBody(summary.markdown, "### Important non-obvious context about the user")
      || sectionBody(summary.markdown, "### Important non-obvious context")
    ).split("\n")),
  );

  const citedSummaries = covered.map((summary) => summary.name);
  const coveredHistoryIds = citedSummaries.map((name) => name.slice(0, -3));
  const contextLimit = Math.min(800, Math.floor(MAX_EVIDENCE_CHARS / covered.length / 2));
  const introduction = [
    "## Memory summary",
    `本窗口由 ${covered.length} 份 10 分钟摘要汇总而来，覆盖 ${applications.length} 个应用。`,
    "### Relevant prior context",
    excerpt(priorContext.join("\n") || "（无）", contextLimit),
    "### Important non-obvious context about the user",
    excerpt(nonObvious.join("\n") || "（无）", contextLimit),
    "## Recording summary",
  ].join("\n\n");
  const citations = ["## Citations", citedSummaries.map((name) => `- ${name}`).join("\n")].join("\n\n");
  // Budget the complete evidence, including citations, before the writer's
  // global limit. Every ten-minute entry gets space, including the final one.
  const perSummaryLimit = Math.floor(
    (MAX_EVIDENCE_CHARS - introduction.length - citations.length - (covered.length + 1) * 2 - 1) / covered.length,
  );
  const evidence = [introduction, ...covered.map((summary) => summaryEvidence(summary, perSummaryLimit)), citations].join("\n\n");

  const windowEnd = new Date(windowStart.getTime() + SIX_HOUR_MS);
  const markdown = [
    "---",
    `title: "6h activity ${id}"`,
    `description: "Rolled up from ${covered.length} ten-minute summaries covering `
      + `${windowStart.toISOString()} to ${windowEnd.toISOString()}."`,
    `applications: [${applications.map((value) => JSON.stringify(value)).join(", ")}]`,
    "summary_window: 6h",
    `source_type: rollup`,
    "summary_state: pending",
    `covered_history_ids: ${JSON.stringify(coveredHistoryIds)}`,
    "---",
    "",
    evidence,
    "",
  ].join("\n");

  return { id, fileName: `${id}-6h-summary.md`, markdown, citedSummaries, coveredHistoryIds };
}
