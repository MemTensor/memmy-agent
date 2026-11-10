// Ignore embedded literals when checking the surrounding sentences.
const LITERAL = /https?:\/\/[\w/:?#@!$&()*+,=%~.\-]+|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"/gu;
const SENTENCE_BREAK = /[。！？!?;；\r\n]+|\.(?=\s|$|\p{Script=Han})/u;

/** Catch wrong-script prose without classifying product names or translating identifiers. */
export function matchesGeneratedLanguage(text: string, language: string): boolean {
  if (language === "auto") return true;
  const script = new Intl.Locale(language).maximize().script;
  if (!script) return true;
  let expected: RegExp;
  switch (script) {
    case "Hans":
    case "Hant": expected = /\p{Script=Han}/u; break;
    case "Jpan": expected = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u; break;
    case "Kore": expected = /[\p{Script=Hangul}\p{Script=Han}]/u; break;
    default:
      try { expected = new RegExp(`\\p{Script=${script}}`, "u"); }
      catch { return true; } // Not every BCP 47 script tag has a Unicode property.
  }
  const narrative = text.replace(LITERAL, " ");
  const prose = /\p{L}/u.test(narrative) ? narrative : text;
  return expected.test(prose) && prose.split(SENTENCE_BREAK).every(
    sentence => !/\p{L}/u.test(sentence) || expected.test(sentence)
  );
}
