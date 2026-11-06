/** Generated prose may contain identifiers, quoted code and product names in any locale. */
export function matchesGeneratedLanguage(text: string, language: string): boolean {
  if (language === "auto") return true;
  const locale = new Intl.Locale(language).maximize();
  const script = locale.script;
  if (!script) return true;
  const scripts = script === "Jpan" ? ["Han", "Hiragana", "Katakana"]
    : script === "Kore" ? ["Hangul", "Han"]
    : script === "Hans" || script === "Hant" ? ["Han"] : [script];
  const prose = text.replace(/`[^`]*`|https?:\/\/\S+|\b[\w-]+(?:[\\/_.][\w-]+)+\b|\b[A-Z][A-Z\d]+\b|\b\w*[a-z][A-Z]\w*\b/gu, " ");
  let nativeScript: RegExp;
  try {
    nativeScript = new RegExp(scripts.map(name => `\\p{Script=${name}}`).join("|"), "gu");
  } catch {
    // Some valid BCP 47 script tags have no Unicode property in this runtime.
    return true;
  }
  // Check an unquoted opening sentence on its own as well. Appending a
  // translated keyword after a sentence break should not mask foreign prose.
  const opening = prose.trimStart().match(/^(\p{L}[^;；。！？!?]*?)(?:[;；。！？!?]|\.(?=\s))\s*(?=\p{L})/u)?.[1];
  return matchesProse(prose, locale, nativeScript) && (!opening || matchesProse(opening, locale, nativeScript));
}

function matchesProse(prose: string, locale: Intl.Locale, nativeScript: RegExp): boolean {
  const nativeLetters = prose.match(nativeScript)?.length ?? 0;
  const letters = prose.match(/\p{L}/gu)?.length ?? 0;
  const latin = prose.match(/\p{Script=Latin}/gu)?.length ?? 0;
  const words = prose.match(/\b[a-z]{2,}\b/giu) ?? [];
  const foreignLetters = letters - latin;
  if (nativeLetters === 0 && foreignLetters >= 4) return false;
  const action = /\b(?:fix(?:ed)?|repair(?:ed)?|implement(?:ed)?|verif(?:y|ied)|updat(?:e|ed)|resolv(?:e|ed)|add(?:ed)?|remov(?:e|ed)|fail(?:ed|ure)?|reset|analy[sz]e)\b/iu.test(prose);
  const connector = /\b(?:the|and|with|was|were|before|after|for)\b/u.test(prose);
  if (locale.script === "Latn") {
    if (foreignLetters >= 4 && foreignLetters >= nativeLetters
      && (words.length <= 1 || foreignLetters >= nativeLetters * 2)) return false;
    return locale.language === "en" || !(action && connector && words.length >= 4);
  }

  // An auxiliary with a participle or a past verb modified by an adverb
  // identifies English prose even in a short or title-cased clause.
  const predicate = /\b(?:(?:has|have|had|is|are|was|were)\s+(?:already\s+|not\s+)?[a-z]+(?:ed|en|ing)|[a-z]+ed\s+[a-z]+ly)\b/iu.test(prose);
  const lowerWords = words.filter(word => word === word.toLowerCase()).length;
  if (nativeLetters === 0) {
    // Task descriptions often name the operation. A noun suffix alone also
    // matches product names ending in words such as "Vision" or "Foundation".
    const operation = /\b(?:exposure|invalidation|transformation|configuration|optimization|migration|installation|implementation)s?\b/iu.test(prose);
    return !(words.length >= 2 && (action || operation || predicate || lowerWords >= 2));
  }
  if (predicate && words.length >= nativeLetters) return false;
  return !(words.length >= 4 && lowerWords >= 2 && connector && words.length >= nativeLetters * 2);
}
