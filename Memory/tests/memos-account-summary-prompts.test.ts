import { describe, expect, it } from "vitest";
import {
  detectMemReaderPromptLanguage,
  renderMemReaderPrompt
} from "../src/service/evolution/memos-account-summary-prompts.js";

describe("account memory reader prompts", () => {
  it("detects the query language using the MemOS Chinese ratio", () => {
    expect(detectMemReaderPromptLanguage("memmy 在上周五发布了，你看看情况？")).toBe("zh");
    expect(detectMemReaderPromptLanguage("Please check whether Memmy shipped last Friday.")).toBe("en");
    expect(detectMemReaderPromptLanguage("https://example.com/very/long/path 中文内容")).toBe("zh");
  });

  it("renders the fixed chat prompts without unresolved placeholders", () => {
    const zh = renderMemReaderPrompt(
      "zh",
      "user: [2026-07-21T12:48:00.000Z]: 明天继续处理"
    );
    const en = renderMemReaderPrompt(
      "en",
      "user: [2026-07-21T12:48:00.000Z]: Continue tomorrow"
    );

    expect(zh).toMatch(/^您是记忆提取专家。/);
    expect(zh).toContain("对话：\nuser: [2026-07-21T12:48:00.000Z]: 明天继续处理");
    expect(en).toMatch(/^You are a memory extraction expert\./);
    expect(en).toContain("Conversation:\nuser: [2026-07-21T12:48:00.000Z]: Continue tomorrow");
    expect(`${zh}\n${en}`).not.toMatch(/\$\{(?:conversation|custom_tags_prompt)\}/);
  });

});
