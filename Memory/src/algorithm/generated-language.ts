const QUOTED_TEXT = /“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|(?<![\p{Script=Latin}\d])'[^'\n]*'(?![\p{Script=Latin}\d])/gu;
const CLAUSE_BREAK = /[。！？!?;；\r\n]+|\.(?=\s|$|\p{Script=Han})/u;
const TASK_SUBJECT = /^(?:account|application|authentication|backup|build|cache|client|code|connection|data|database|dependency|disk|document|file|local|log|memory|network|parser|password|schema|security|server|service|session|spreadsheet|system|task|test|token|user|workflow)$/iu;
const OPERATION_NOUN = /^(?:exposure|invalidation|transformation|optimi[sz]ation|migration|installation|implementation|synchroni[sz]ation|rotation)s?$/iu;
const ACTION = /\b(?:fix(?:ed)?|repair(?:ed)?|implement(?:ed)?|verif(?:y|ied)|updat(?:e|ed)|resolv(?:e|ed)|add(?:ed)?|remov(?:e|ed)|fail(?:ed|ure)?|reset|analy[sz]e)\b/iu;

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
  // Quoted UI text can be verbatim inside a localized explanation. When the
  // quote is the entire output, its contents still have to pass validation.
  const unquoted = prose.replace(QUOTED_TEXT, " ");
  const narrative = unquoted.search(nativeScript) >= 0 ? unquoted : prose;
  const clauses = narrative.split(CLAUSE_BREAK);
  if (clauses.length > 1 && !matchesProse(narrative, locale, nativeScript)) return false;
  return clauses.every(clause => matchesProse(clause, locale, nativeScript));
}

function matchesProse(prose: string, locale: Intl.Locale, nativeScript: RegExp): boolean {
  const nativeLetters = prose.match(nativeScript)?.length ?? 0;
  const letters = prose.match(/\p{L}/gu)?.length ?? 0;
  const latin = prose.match(/\p{Script=Latin}/gu)?.length ?? 0;
  const words = prose.match(/\b[a-z]{2,}\b/giu) ?? [];
  const foreignLetters = letters - latin;
  if (nativeLetters === 0 && foreignLetters >= 4) return false;
  const action = ACTION.test(prose);
  const connector = /\b(?:the|and|with|was|were|before|after|for)\b/u.test(prose);
  if (locale.script === "Latn") {
    if (foreignLetters >= 4 && foreignLetters >= nativeLetters
      && (words.length <= 1 || foreignLetters >= nativeLetters * 2)) return false;
    return locale.language === "en" || !(action && connector && words.length >= 4);
  }

  // An auxiliary and its complement also cover irregular forms like "was lost".
  const predicate = /\b(?:(?:has|have|had|is|are|was|were)\s+[a-z]+|[a-z]+ed\s+[a-z]+ly)\b/iu.test(prose);
  const lowerWords = words.filter(word => word === word.toLowerCase()).length;
  if (nativeLetters === 0) {
    // For noun phrases, look for a task subject and an operation at the end.
    // A word like "Configuration" is also common in proper names.
    if (words.length < 2) return true;
    const first = words[0]!;
    const last = words.at(-1)!;
    const taskDescription = TASK_SUBJECT.test(first) && (action || /(?:ation|sion|osure)s?$/iu.test(last));
    const namedOperation = OPERATION_NOUN.test(first) || OPERATION_NOUN.test(last) || /^configuration$/iu.test(first);
    const outcome = /^(?:failed|fixed|resolved|removed|verified|updated)$/iu.test(last);
    return !(taskDescription || namedOperation || ACTION.test(first) || outcome || predicate || lowerWords >= 2);
  }
  if (predicate && words.length >= nativeLetters) return false;
  return !(words.length >= 4 && lowerWords >= 2 && connector && words.length >= nativeLetters * 2);
}
