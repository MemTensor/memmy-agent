/**
 * Normalize a concrete language tag for generated content independently of the
 * desktop's translated UI catalogs. Adding an App locale must not require a
 * second whitelist in the History/Memory/Skill output pipeline.
 */
export function normalizeOutputLanguage(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (value.trim().toLowerCase() === "system") return undefined;
  try {
    const canonical = Intl.getCanonicalLocales(value.trim())[0];
    if (!canonical) return undefined;
    const locale = new Intl.Locale(canonical);
    // Settings sentinels, unknown/multiple languages, private language codes and
    // pseudo-locales are not a concrete language in which to write memories.
    if (!/^[a-z]{2,3}$/u.test(locale.language)
      || /^(?:und|mul|mis|zxx|qps)$/u.test(locale.language)
      || /^q[a-t][a-z]$/u.test(locale.language)
      || locale.region === "XA" || locale.region === "XB") return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}
