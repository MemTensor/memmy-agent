/** The @ menu's text logic: when it opens, what it inserts, and what the agent is told. */
import { describe, expect, it } from "vitest";
import { applyMention, mentionEmptyLabelKey, mentionQueryFromInput, mentionSessionLine } from "../collab-session-mention.js";

describe("mention query", () => {
  it("opens on an @ that starts a word", () => {
    expect(mentionQueryFromInput("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryFromInput("看下 @智能", 6)).toEqual({ start: 3, query: "智能" });
  });

  it("stays closed inside an address or after the mention ended", () => {
    expect(mentionQueryFromInput("sunq@outlook.com", 16)).toBeNull();
    expect(mentionQueryFromInput("@智能 家居", 7)).toBeNull();
  });

  it("reads only what was typed before the caret", () => {
    // The caret sits after「智能」, so the rest of the sentence does not narrow the list.
    expect(mentionQueryFromInput("@智能家居 补充说明", 3)).toEqual({ start: 0, query: "智能" });
    expect(mentionQueryFromInput("@智能家居 补充说明", 5)).toEqual({ start: 0, query: "智能家居" });
    expect(mentionQueryFromInput("@智能家居", 0)).toBeNull();
  });
});

describe("what the menu says when it has nothing to offer", () => {
  it("names the project when it exists but holds no sessions", () => {
    expect(mentionEmptyLabelKey({ projectName: "MemOS产品" })).toEqual({ key: "home.mention.empty", values: { project: "MemOS产品" } });
  });

  it("explains that the task is outside an online project", () => {
    expect(mentionEmptyLabelKey({ projectName: null })).toEqual({ key: "home.mention.noProject" });
  });
});

describe("what a row tells the person", () => {
  it("names the member before the session's opening question", () => {
    expect(mentionSessionLine({ memberName: "快乐团子", lastQuestion: "竞品有没有做类似项目记忆的？" })).toBe("快乐团子 · 竞品有没有做类似项目记忆的？");
  });

  it("leaves the project out, since every offer is already in the task's project", () => {
    expect(mentionSessionLine({ memberName: "快乐团子", lastQuestion: "" })).toBe("快乐团子");
  });
});

describe("applying a mention", () => {
  it("replaces the typed token and keeps the rest of the message", () => {
    const input = "看下 @智能 后面还有话";
    const mention = { start: 3, query: "智能" };
    expect(applyMention(input, mention, "引用标记")).toBe("看下 引用标记 后面还有话");
  });

  it("drops a leading space in the remainder so the reference is not duplicated", () => {
    expect(applyMention("@智能   补充", { start: 0, query: "智能" }, "引用标记")).toBe("引用标记 补充");
  });

  it("leaves no trailing space when the mention is the whole message", () => {
    expect(applyMention("@智能", { start: 0, query: "智能" }, "引用标记")).toBe("引用标记");
  });
});
