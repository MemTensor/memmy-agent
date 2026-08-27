import { describe, expect, it } from "vitest";
import {
  EN_NICKNAME_CORES,
  EN_NICKNAME_PREFIXES,
  ZH_NICKNAME_CORES,
  ZH_NICKNAME_PREFIXES,
  randomNickname
} from "../nickname.js";

describe("randomNickname", () => {
  it("中文界面从中文修饰词和吉物词生成无空格昵称", () => {
    const nickname = randomNickname("zh-CN", fixedRandom([0, 0]));

    expect(nickname).toBe(`${ZH_NICKNAME_PREFIXES[0]}${ZH_NICKNAME_CORES[0]}`);
    expect(nickname).toBe("快乐锦鲤");
    expect(nickname).not.toContain(" ");
  });

  it("英文界面从英文修饰词和吉物词生成带空格昵称", () => {
    const nickname = randomNickname("en-US", fixedRandom([0, 0]));

    expect(nickname).toBe(`${EN_NICKNAME_PREFIXES[0]} ${EN_NICKNAME_CORES[0]}`);
    expect(nickname).toBe("Lucky Dolphin");
    expect(nickname).toContain(" ");
  });

  it("词库保留原型里的中英文样例并满足 32 字限制", () => {
    expect(ZH_NICKNAME_PREFIXES).toContain("幸运");
    expect(ZH_NICKNAME_CORES).toContain("锦鲤");
    expect(EN_NICKNAME_PREFIXES).toContain("Sunny");
    expect(EN_NICKNAME_CORES).toContain("Acorn");

    const longestZh = longest(ZH_NICKNAME_PREFIXES) + longest(ZH_NICKNAME_CORES);
    const longestEn = `${longest(EN_NICKNAME_PREFIXES)} ${longest(EN_NICKNAME_CORES)}`;
    expect(longestZh.length).toBeLessThanOrEqual(32);
    expect(longestEn.length).toBeLessThanOrEqual(32);
  });
});

/**
 * Creates a fixed random number generator.
 *
 * @param values The 0-to-1 random values returned in order.
 * @returns A random function that can be injected into randomNickname.
 */
function fixedRandom(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

/**
 * Reads the longest item in a string array.
 *
 * @param values The word-list array to inspect.
 * @returns The longest word in the word list.
 */
function longest(values: readonly string[]): string {
  return values.reduce((current, value) => (value.length > current.length ? value : current), "");
}
