import { describe, expect, it } from "vitest";
import { readAssistRequestBody } from "../collab-assist-protocol.js";

/**
 * 请求正文的协议解析：正文放宽到每条 4000 字、保留换行之后，多行事项靠两个空格缩进表达。
 * 这些用例对着本机后端 `assistPrompt` 写出的格式逐字校验（往返测试在
 * `App/backend/src/services/tests/assist-prompt.test.ts`）。
 */
describe("readAssistRequestBody", () => {
  it("reads a single-line item as before", () => {
    const body = readAssistRequestBody([
      "孙起正在排查一个问题，需要这台电脑上的信息。",
      "",
      "要做的事：查看系统版本",
      "- 跑 sw_vers",
      "- 读 Cursor 的版本"
    ]);

    expect(body.title).toBe("查看系统版本");
    expect(body.items).toEqual(["跑 sw_vers", "读 Cursor 的版本"]);
  });

  it("merges the two-space continuation lines back into one multi-line item", () => {
    const body = readAssistRequestBody([
      "要做的事：原样跑一遍脚本",
      "- 先原样跑 scan-probe.sh",
      "- 再看 cases.json 里的两个会话",
      "  - composer-1 应该是新键",
      "  - composer-2 可能是旧键"
    ]);

    // 缩进的 `- ` 也算续行：嵌套列表不会被拆成同级事项。
    expect(body.items).toEqual([
      "先原样跑 scan-probe.sh",
      "再看 cases.json 里的两个会话\n- composer-1 应该是新键\n- composer-2 可能是旧键"
    ]);
  });

  it("keeps a multi-line item byte-for-byte, including blank lines and deeper indentation", () => {
    const item = "第一行\n\n    缩进四个空间的第二段\n最后一行";
    const body = readAssistRequestBody([
      "要做的事：多行事项",
      `- ${item.split("\n")[0]}`,
      ...item.split("\n").slice(1).map((line) => `  ${line}`)
    ]);

    expect(body.items).toEqual([item]);
  });

  it("merges a multi-line reason", () => {
    const body = readAssistRequestBody([
      "起因：孙起本机复现不了分享弹窗的问题",
      "  已经确认不是账号权限",
      "  剩下要在你的电脑上跑一遍同一份脚本",
      "",
      "要做的事：对齐两边版本",
      "- 跑脚本"
    ]);

    expect(body.reason).toBe("孙起本机复现不了分享弹窗的问题\n已经确认不是账号权限\n剩下要在你的电脑上跑一遍同一份脚本");
    expect(body.items).toEqual(["跑脚本"]);
  });

  it("读得懂新的「背景：」，也读得懂旧消息里的「起因：」", () => {
    // 现在写的是「背景：」；已经写进任务里的旧消息还是「起因：」，两种都要能读。
    expect(readAssistRequestBody(["背景：孙起本机复现不了", "要做的事：看版本", "- 跑脚本"]).reason)
      .toBe("孙起本机复现不了");
    expect(readAssistRequestBody(["起因：孙起本机复现不了", "要做的事：看版本", "- 跑脚本"]).reason)
      .toBe("孙起本机复现不了");
  });

  it("does not count anything after the earlier-attempts section as an item", () => {
    const body = readAssistRequestBody([
      "要做的事：接着上次继续",
      "- 看日志",
      "",
      "同一次排查里，前面已经完成的几次：",
      "- 已拿到版本：Cursor 2.1.4",
      "这次接着上次的结果继续，不必重复前面的步骤。"
    ]);

    expect(body.items).toEqual(["看日志"]);
    expect(body.reason).toBe("");
  });

  it("does not count the attachment list as items", () => {
    const body = readAssistRequestBody([
      "要做的事：原样跑一遍脚本",
      "- 跑 scan-probe.sh",
      "",
      "随请求附带的 2 个文件已放在 /Users/sunq/.memmy/media/assist/runs/r-5：",
      "- scan-probe.sh：排查脚本，在终端用 bash 运行，把完整输出贴回结果。运行时直接用这个文件，不要改写内容，也不要另写一份代替它。",
      "- cases.json：scan-probe.sh 读取的会话清单，不需要单独处理。"
    ]);

    expect(body.items).toEqual(["跑 scan-probe.sh"]);
  });

  it("still reads the older attachment lines, which carried the sha256", () => {
    // 附件段的前缀没变，但每条后面的写法变了；早先写进任务里的消息还要能读。
    const body = readAssistRequestBody([
      "要做的事：原样跑一遍脚本",
      "- 跑 scan-probe.sh",
      "随请求附带的 2 个文件已放在 /Users/sunq/.memmy/media/assist/runs/r-5：",
      "- scan-probe.sh（sha256 9f2c…），这是要原样执行的脚本，不要改写内容",
      "- cases.json"
    ]);

    expect(body.items).toEqual(["跑 scan-probe.sh"]);
  });
});