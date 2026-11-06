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
  let nativeLetters = 0;
  try {
    for (const name of scripts) nativeLetters += prose.match(new RegExp(`\\p{Script=${name}}`, "gu"))?.length ?? 0;
  } catch {
    // Some valid BCP 47 script tags have no Unicode property in this runtime.
    return true;
  }
  const letters = prose.match(/\p{L}/gu)?.length ?? 0;
  const latin = prose.match(/\p{Script=Latin}/gu)?.length ?? 0;
  const words = prose.match(/\b[a-z]{2,}\b/giu) ?? [];
  const foreignLetters = letters - latin;
  if (nativeLetters === 0 && foreignLetters >= 4) return false;
  if (script === "Latn" && foreignLetters >= 4 && foreignLetters >= nativeLetters
    && (words.length <= 1 || foreignLetters >= nativeLetters * 2)) return false;

  // An action, outcome or grammatical connector distinguishes prose from names
  // such as "Microsoft Visual Studio Code". Capitalization alone cannot do that.
  const action = /\b(?:fix(?:ed)?|repair(?:ed)?|implement(?:ed)?|verif(?:y|ied)|updat(?:e|ed)|resolv(?:e|ed)|add(?:ed)?|remov(?:e|ed)|fail(?:ed|ure)?|reset|analy[sz]e)\b/iu.test(prose);
  const describesProcess = words.some(word => /(?:ation|sion|osure)s?$/iu.test(word));
  const connector = /\b(?:the|and|with|was|were|before|after|for)\b/u.test(prose);
  const lowerWords = words.filter(word => word === word.toLowerCase()).length;
  if (script === "Latn") return locale.language === "en" || !(action && connector && words.length >= 4);
  if (nativeLetters === 0) return !(words.length >= 2 && (action || describesProcess || lowerWords >= 2));
  // A technical term in a sentence is fine; one native term in foreign prose
  // should not turn the entire sentence into a match.
  return !(words.length >= 4 && lowerWords >= 2 && connector && words.length >= nativeLetters * 2);
}
