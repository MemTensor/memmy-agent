export type NicknameLanguage = "zh-CN" | "en-US" | "zh" | "en";

export const ZH_NICKNAME_PREFIXES = [
  "快乐", "幸运", "元气", "如意", "顺心", "知足",
  "悠然", "温暖", "明朗", "丰盈", "安然", "喜乐",
  "和顺", "灵动", "闪亮", "甜甜", "圆满", "锦绣",
] as const;

export const ZH_NICKNAME_CORES = [
  "锦鲤", "小鹿", "白鹤", "海豚", "松鼠", "云雀",
  "星辰", "暖阳", "清风", "团子", "汤圆", "年糕",
  "桂花", "橘子", "栗子", "棉花糖", "麦穗", "元宝",
] as const;

export const EN_NICKNAME_PREFIXES = [
  "Lucky", "Happy", "Sunny", "Bright", "Cozy", "Jolly",
  "Gentle", "Merry", "Golden", "Clever", "Swift", "Witty",
  "Breezy", "Chirpy", "Dapper", "Gleeful", "Plucky", "Snappy",
] as const;

export const EN_NICKNAME_CORES = [
  "Dolphin", "Sparrow", "Otter", "Panda", "Fox", "Owl",
  "Acorn", "Clover", "Breeze", "Maple", "Coral", "Pebble",
  "Mochi", "Waffle", "Biscuit", "Truffle", "Cocoa", "Nutmeg",
] as const;

export function randomNickname(language: NicknameLanguage = "zh-CN", random: () => number = Math.random): string {
  if (language === "en-US" || language === "en") {
    return `${pick(EN_NICKNAME_PREFIXES, random)} ${pick(EN_NICKNAME_CORES, random)}`;
  }
  return `${pick(ZH_NICKNAME_PREFIXES, random)}${pick(ZH_NICKNAME_CORES, random)}`;
}

/**
 * Pick a word from the word list using a random number.
 *
 * @param values the word list array.
 * @param random the random number function.
 * @returns the selected word.
 */
function pick<T>(values: readonly T[], random: () => number): T {
  const index = Math.min(values.length - 1, Math.floor(random() * values.length));
  return (values[index] ?? values[0]) as T;
}
