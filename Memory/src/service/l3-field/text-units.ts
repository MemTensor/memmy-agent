const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * Length of an L3 item in "units": each CJK character counts as one, every
 * other whitespace-separated word counts as one, punctuation-only tokens
 * count as zero.
 */
export function countL3Units(text: string): number {
  const cjkCount = text.match(CJK_CHARACTER)?.length ?? 0;
  const words = text
    .replace(CJK_CHARACTER, " ")
    .split(/\s+/u)
    .filter((token) => WORD_CHARACTER.test(token));
  return cjkCount + words.length;
}
