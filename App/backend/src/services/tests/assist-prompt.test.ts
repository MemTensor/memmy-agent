import { describe, expect, it } from "vitest";
import { assistPrompt, parseResultItems, replyWithoutItems } from "../assist/prompt.js";

describe("assistPrompt", () => {
  it("names who is asking, the project and every item", () => {
    const prompt = assistPrompt({
      requesterName: "孙起",
      projectName: "Memmy 内测反馈",
      title: "收集 Cursor 任务读取相关的信息",
      reason: "关联任务弹窗里看不到 Cursor 的任务",
      items: ["查看 Memmy、Cursor 与系统的版本", "在 Memmy 后台日志里找出与 Cursor 记录相关的最近记录"]
    });

    expect(prompt).toContain("孙起正在排查一个问题");
    expect(prompt).toContain("协作项目「Memmy 内测反馈」");
    expect(prompt).toContain("起因：关联任务弹窗里看不到 Cursor 的任务");
    expect(prompt).toContain("- 查看 Memmy、Cursor 与系统的版本");
    expect(prompt).toContain("- 在 Memmy 后台日志里找出与 Cursor 记录相关的最近记录");
    // 约定最后一段逐项结果，执行方的 Memmy 靠它填「结果」表格。
    expect(prompt).toContain("以「结果：」开头");
  });

  it("tells the agent this is the same investigation, without repeating what was already done", () => {
    const prompt = assistPrompt({
      requesterName: "孙起",
      projectName: "Memmy 内测反馈",
      title: "查会话头存储位置",
      items: ["查这 37 个会话的会话头存在哪些键下"],
      earlier: ["已拿到版本：Cursor 2.1.4"]
    });

    expect(prompt).toContain("前面已经完成的几次");
    expect(prompt).toContain("- 已拿到版本：Cursor 2.1.4");
    expect(prompt).toContain("不必重复前面的步骤");
  });
});

describe("parseResultItems", () => {
  it("reads the items under the result heading", () => {
    const reply = [
      "这 37 个会话的会话头都存在新键下。",
      "",
      "结果：",
      "- 版本：Memmy 1.2.6 · Cursor 2.1.4 · macOS 15.6",
      "- 日志：最近 24 小时 37 条 cursor composer skipped: empty conversation"
    ].join("\n");

    expect(parseResultItems(reply)).toEqual([
      { key: "版本", value: "Memmy 1.2.6 · Cursor 2.1.4 · macOS 15.6" },
      { key: "日志", value: "最近 24 小时 37 条 cursor composer skipped: empty conversation" }
    ]);
  });

  it("keeps at most twenty items so a chatty answer cannot flood the card", () => {
    const reply = ["结果：", ...Array.from({ length: 30 }, (_, index) => `- 项${index + 1}：值`)].join("\n");
    expect(parseResultItems(reply)).toHaveLength(20);
  });

  it("returns nothing when the agent wrote no result section", () => {
    // 没有那一段也能用：整条回答就是结果正文，不硬造表格。
    expect(parseResultItems("版本是 2.1.4，日志里有 37 条空会话。")).toEqual([]);
  });
});

describe("replyWithoutItems", () => {
  it("drops the itemized block so the prose is not repeated as a table", () => {
    const reply = ["会话头都换到新键下了。", "", "结果：", "- 会话头位置：composerConvHeaders"].join("\n");
    expect(replyWithoutItems(reply)).toBe("会话头都换到新键下了。");
  });

  it("leaves an answer without a result section alone", () => {
    expect(replyWithoutItems("只用了一句话回答。")).toBe("只用了一句话回答。");
  });
});

describe("assistPrompt for a Memmy-run request", () => {
  it("wraps the request for the task page and leaves the result format to the hidden context", async () => {
    const { ASSIST_RESULT_FORMAT } = await import("../assist/prompt.js");
    const prompt = assistPrompt(
      { requesterName: "孙起", projectName: "Memmy 内测反馈", title: "查看版本", reason: "本机复现不了", items: ["查看 Memmy 与 macOS 的版本"] },
      { envelope: { requestId: "req-1", via: "Claude Code", attempt: 2 } }
    );
    expect(prompt.startsWith('<memmy_assist_request request="req-1" from="孙起" via="Claude Code" attempt="2">')).toBe(true);
    expect(prompt.endsWith("</memmy_assist_request>")).toBe(true);
    expect(prompt).toContain("- 查看 Memmy 与 macOS 的版本");
    expect(prompt).not.toContain("结果：");
    expect(ASSIST_RESULT_FORMAT).toContain("以「结果：」开头");
  });
});
