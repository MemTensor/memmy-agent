import { parse as parseYaml } from "yaml";
import { isRecord } from "../../utils/json.js";

/** Select a useful summary without treating the guide title or YAML as prose. */
export function skillInjectionDescription(input: {
  name: string;
  guide: string;
  retrievalBlurb?: string;
  triggerContext?: string;
  maxChars: number;
}): string {
  const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
  const usable = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const text = normalize(value);
    return text && text !== normalize(input.name) ? text : undefined;
  };
  let description = usable(input.retrievalBlurb) ?? usable(input.triggerContext);
  let body = input.guide.replace(/^\uFEFF/u, "").trim();
  if (!description) {
    const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u);
    if (frontmatter) {
      body = body.slice(frontmatter[0].length).trim();
      try {
        const parsed: unknown = parseYaml(frontmatter[1]!, { maxAliasCount: 0 });
        if (isRecord(parsed)) description = usable(parsed.description);
      } catch {
        // A malformed header must not become the description or hide valid prose.
      }
    } else if (/^---(?:\r?\n|$)/u.test(body)) {
      // An unterminated header has no safe prose boundary.
      body = "";
    }
  }
  if (!description) {
    const lines = body.split(/\r?\n/u);
    const paragraph: string[] = [];
    let fence: string | undefined;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      const marker = line.match(/^(`{3,}|~{3,})/u)?.[1];
      if (marker) {
        if (!fence) fence = marker[0];
        else if (marker[0] === fence) fence = undefined;
        continue;
      }
      if (fence) continue;
      const isHeading = /^#{1,6}(?:\s|$)/u.test(line)
        || /^(?:=+|-+)\s*$/u.test(lines[index + 1]?.trim() ?? "")
        || /^(?:=+|-+)$/u.test(line)
        || /^\*\*[^*]+\*\*:?$/u.test(line);
      if (!line || isHeading) {
        if (paragraph.length) break;
        continue;
      }
      if (!paragraph.length && !usable(line)) continue;
      paragraph.push(line);
    }
    description = usable(paragraph.join(" "));
  }
  if (!description) return "(not provided)";
  const limit = Math.max(1, Math.floor(input.maxChars));
  return description.length <= limit ? description : `${description.slice(0, limit - 1)}…`;
}
