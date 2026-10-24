/** Preserve the narrated summary instead of reusing the Markdown title as its summary. */
export function historyEvidenceSummary(markdown: string, description?: string | null): string | undefined {
  const normalized = markdown.replace(/\r\n/gu, "\n");
  const frontmatter = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)?.[1];
  const rawDescription = frontmatter?.match(/^description:[ \t]*(.+)$/mu)?.[1]?.trim();
  let narratedDescription = description?.trim();
  if (rawDescription?.startsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(rawDescription);
      if (typeof decoded === "string") narratedDescription = decoded.trim();
    } catch { /* Fall back to the already parsed History description. */ }
  }
  if (narratedDescription && narratedDescription !== "null" && narratedDescription !== "~") {
    return narratedDescription.slice(0, 2_000);
  }
  const heading = normalized.match(/^## Memory summary[ \t]*\n/mu);
  if (!heading) return undefined;
  const body = normalized.slice(heading.index! + heading[0].length);
  const boundary = body.search(/^#{1,3} /mu);
  const section = (boundary < 0 ? body : body.slice(0, boundary)).trim();
  return section ? section.slice(0, 2_000) : undefined;
}
