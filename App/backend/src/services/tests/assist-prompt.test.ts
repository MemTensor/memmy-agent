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
    expect(prompt).toContain("背景：关联任务弹窗里看不到 Cursor 的任务");
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

/**
 * 与界面的往返：`assistPrompt` 写出的正文，界面用 `readAssistRequestBody` 读回来要逐字相等。
 * 正文放宽到每条 4000 字、保留换行之后，多行事项与多行背景全靠「续行缩进两个空格」这条约定，
 * 任何一侧改动都要在这里对齐。
 */
describe("assistPrompt 与界面解析的往返", () => {
  it("keeps multi-line items and a multi-line reason byte-for-byte", async () => {
    const { parseAssistEnvelope, readAssistRequestBody } = await import(
      "../../../../frontend/desktop/src/pages/collab-assist-protocol.js"
    );
    const items = [
      "先原样跑 scan-probe.sh，不要改写内容",
      "再看 cases.json 里的两个会话是否都读到会话头\n- composer-1 应该是新键\n- composer-2 可能是旧键",
      "把结果贴回本次协助"
    ];
    const reason = "孙起本机复现不了分享弹窗的问题\n已经确认不是账号权限，剩下要在你的电脑上跑一遍同一份脚本";
    const prompt = assistPrompt(
      { requesterName: "孙起", projectName: "Memmy 内测反馈", title: "对齐两边版本", reason, items },
      { envelope: { requestId: "req-1", via: "Memmy", attempt: 1 } }
    );

    const envelope = parseAssistEnvelope(prompt);
    expect(envelope?.kind).toBe("request");
    const body = readAssistRequestBody(envelope!.lines);
    expect(body.items).toEqual(items);
    expect(body.reason).toBe(reason);
    expect(body.title).toBe("对齐两边版本");
  });

  it("says what each attachment is and how to use it, without turning them into items", async () => {
    const { readAssistRequestBody } = await import(
      "../../../../frontend/desktop/src/pages/collab-assist-protocol.js"
    );
    const prompt = assistPrompt({
      requesterName: "孙起",
      projectName: "Memmy 内测反馈",
      title: "原样跑一遍脚本",
      items: ["跑 scan-probe.sh"],
      earlier: ["第一次：版本是 1.2.8"],
      attachments: [
        {
          name: "scan-probe.sh",
          path: "/Users/sunq/.memmy/media/assist/runs/r-5/scan-probe.sh",
          note: "排查脚本，在终端用 bash 运行，把完整输出贴回结果",
          executable: true
        },
        { name: "cases.json", path: "/Users/sunq/.memmy/media/assist/runs/r-5/cases.json", note: "scan-probe.sh 读取的会话清单，不需要单独处理。" }
      ],
      attachmentsDirectory: "/Users/sunq/.memmy/media/assist/runs/r-5"
    });

    expect(prompt).toContain("随请求附带的 2 个文件已放在 /Users/sunq/.memmy/media/assist/runs/r-5：");
    // 脚本：发起方写的用途，再加一句原样运行。
    expect(prompt).toContain(
      "- scan-probe.sh：排查脚本，在终端用 bash 运行，把完整输出贴回结果。运行时直接用这个文件，不要改写内容，也不要另写一份代替它。"
    );
    // 文本：只有用途；说明自带句号时不再补一个。
    expect(prompt).toContain("- cases.json：scan-probe.sh 读取的会话清单，不需要单独处理。\n");
    // 附件紧跟在要做的事后面，前面几次的结论放在最后。
    expect(prompt.indexOf("随请求附带的")).toBeLessThan(prompt.indexOf("同一次排查里"));
    const body = readAssistRequestBody(prompt.split("\n"));
    expect(body.items).toEqual(["跑 scan-probe.sh"]);
  });

  it("falls back to a generic line when an older request has no note", () => {
    const prompt = assistPrompt({
      requesterName: "孙起",
      projectName: "P",
      title: "原样跑一遍脚本",
      items: ["跑脚本"],
      attachments: [
        { name: "probe.sh", path: "/tmp/r-1/probe.sh", executable: true },
        { name: "notes.md", path: "/tmp/r-1/notes.md" }
      ],
      attachmentsDirectory: "/tmp/r-1"
    });

    expect(prompt).toContain("- probe.sh：发起方附带的脚本，用法见上面要做的事。运行时直接用这个文件，不要改写内容，也不要另写一份代替它。");
    expect(prompt).toContain("- notes.md：发起方附带的资料，用法见上面要做的事。");
  });
});
