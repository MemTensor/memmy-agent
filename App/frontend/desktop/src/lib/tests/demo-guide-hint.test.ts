// @vitest-environment node

/**
 * 新手引导第二步发出去的那句话带着一段给 Agent 的执行提示（命令行、参数、给模型的叮嘱）。
 * 提示必须发给 Agent，但人不该在任何地方读到它：自己的气泡、复制出来的文本、任务摘要、成员看到的副本。
 */
import { describe, expect, it } from "vitest";
import { isOnlyDemoGuideHint, withoutDemoGuideHint } from "../demo-guide-hint.js";

const ZH_HINT = "（执行提示：不要先反问。把上面这句话整理成标题与要做的事，写成请求文件，然后直接运行 memmy-project assist ask --project 当前项目 --member 2121180368077586434 --file 请求文件，向小饭团发起这次请求。）";
const EN_HINT = "(Execution note: do not ask back. Turn the sentence above into a title and the things to do, write them to a request file, then run memmy-project assist ask --project <current project> --member 1 --file <request file> to send it to Xiaofantuan.)";
const SENTENCE = "请小饭团查一下上次分享会一共来了多少人";

describe("the demo guide execution note", () => {
  it("drops the note and keeps the sentence the person actually sent", () => {
    expect(withoutDemoGuideHint(`${SENTENCE}\n\n${ZH_HINT}`)).toBe(SENTENCE);
  });

  it("recognises the note in both languages", () => {
    expect(withoutDemoGuideHint(`${SENTENCE}\n\n${EN_HINT}`)).toBe(SENTENCE);
  });

  it("leaves an ordinary message untouched", () => {
    const text = "帮我把这份复盘整理成三条结论";
    expect(withoutDemoGuideHint(text)).toBe(text);
    expect(withoutDemoGuideHint("")).toBe("");
  });

  it("marks a message that is nothing but the note", () => {
    // 只有提示的话气泡里什么都不剩：调用方据此不画气泡。
    expect(isOnlyDemoGuideHint(ZH_HINT)).toBe(true);
    expect(isOnlyDemoGuideHint(`${SENTENCE}\n\n${ZH_HINT}`)).toBe(false);
    expect(isOnlyDemoGuideHint(SENTENCE)).toBe(false);
  });

  it("keeps whatever the person added after the note", () => {
    // 提示总是追加在最后；后面还有内容说明这句话被人手工改过，截到提示为止更好读。
    expect(withoutDemoGuideHint(`${SENTENCE}\n\n${ZH_HINT}\n再补一句时间`)).toBe(SENTENCE);
  });

  it("does not eat trailing whitespace of the sentence", () => {
    expect(withoutDemoGuideHint(`  ${SENTENCE}  \n\n${ZH_HINT}\n`)).toBe(`  ${SENTENCE}`);
  });
});
