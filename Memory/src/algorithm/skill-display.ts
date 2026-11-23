import { matchesGeneratedLanguage } from "./generated-language.js";
import { clip } from "../utils/text.js";

/** Pick human-readable text before rendering the guide and its list/detail projections. */
export function generatedSkillTitle(language: string, identifiers: unknown[], ...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const title = clip(candidate, 100);
    if (title && !identifiers.includes(title) && !/^[a-z\d]+(?:[_-][a-z\d]+)+$/i.test(title)
      && matchesGeneratedLanguage(title, language)) return title;
  }
  throw new Error(`generated Skill needs a display title in ${language}`);
}
