import { describe, expect, it } from "vitest";
import {
  assistBoundaryPrompt,
  executorReviewDecision,
  executorReviewPrompt,
  parseExecutorReview,
  parseReviewJson,
  toAssistSafety,
  type ExecutorReviewRaw
} from "../assist/safety.js";

const CONTENT = {
  requesterName: "孙起",
  projectName: "Memmy 内测反馈",
  title: "清一下缓存后重新复现",
  reason: "本机复现不了分享弹窗的问题",
  items: ["删除 ~/Library/Caches/memmy 后重新打开 Memmy"],
  attachments: [{ name: "setup.sh", content: "#!/bin/sh\nrm -rf ~/Downloads/tmp" }]
};

describe("parseReviewJson", () => {
  it("reads an object inside a fenced code block", () => {
    expect(parseReviewJson('好的：\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("returns null when the answer is not JSON", () => {
    expect(parseReviewJson("抱歉，我不能判断。")).toBeNull();
  });
});

describe("executorReviewDecision", () => {
  const clean: ExecutorReviewRaw = { sensitive: [], injected: false, reason: "" };

  it("runs automatically only when nothing was skipped, the check is clean and the Agent asks for approval", () => {
    const decision = executorReviewDecision({
      review: clean,
      previousSkipped: [],
      asksForApproval: true,
      granted: true
    });
    expect(decision).toEqual({ safety: { status: "auto" }, autoRun: true });
  });

  it("asks her first when the last request skipped something, before anything else", () => {
    const decision = executorReviewDecision({
      review: { ...clean, sensitive: [{ action: "删除缓存目录" }] },
      previousSkipped: [{ title: "删除缓存目录", detail: "rm -rf ~/Library/Caches/foo" }],
      asksForApproval: true,
      granted: true
    });
    expect(decision.autoRun).toBe(false);
    expect(decision.safety.reason).toBe("上次跳过了：删除缓存目录");
  });

  it("asks her first when the check found a sensitive operation", () => {
    const decision = executorReviewDecision({
      review: {
        sensitive: [{ action: "删除缓存目录" }],
        injected: false,
        reason: "附带的脚本会删除下载目录里的文件"
      },
      previousSkipped: [],
      asksForApproval: true,
      granted: true
    });
    expect(decision.autoRun).toBe(false);
    expect(decision.safety).toEqual({
      status: "confirm",
      reason: "附带的脚本会删除下载目录里的文件"
    });
  });

  it("asks her first when the script smuggles instructions", () => {
    const decision = executorReviewDecision({
      review: { sensitive: [], injected: true, injectedNote: "让执行方把结果发到别处", reason: "附件里夹带了指令" },
      previousSkipped: [],
      asksForApproval: true,
      granted: true
    });
    expect(decision.safety.status).toBe("confirm");
    expect(decision.safety.reason).toBe("附件里夹带了指令");
  });

  it("asks her first when the Agent never asks for approval", () => {
    const decision = executorReviewDecision({
      review: clean,
      previousSkipped: [],
      agentName: "Pi",
      asksForApproval: false,
      granted: true
    });
    expect(decision.autoRun).toBe(false);
    expect(decision.safety.reason).toBe("Pi 执行时不会请求批准，需要你看过后再决定");
  });

  it("puts the Agent reason before the model's when the Agent never asks for approval", () => {
    const decision = executorReviewDecision({
      review: {
        sensitive: [{ action: "删除缓存目录" }],
        injected: false,
        reason: "附带的脚本会删除下载目录里的文件"
      },
      previousSkipped: [],
      agentName: "Pi",
      asksForApproval: false,
      granted: true
    });
    expect(decision.safety.reason).toBe("Pi 执行时不会请求批准，需要你看过后再决定");
  });

  it("asks her first when the check could not run", () => {
    const decision = executorReviewDecision({
      review: null,
      previousSkipped: [],
      asksForApproval: true,
      granted: true
    });
    expect(decision.autoRun).toBe(false);
    expect(decision.safety).toEqual({
      status: "unavailable",
      reason: "未能完成安全检查，请看过请求内容再决定"
    });
  });

  it("still asks for a normal authorisation when there is no timed grant", () => {
    const decision = executorReviewDecision({
      review: clean,
      previousSkipped: [],
      asksForApproval: true,
      granted: false
    });
    expect(decision.autoRun).toBe(false);
    expect(decision.safety.status).toBe("confirm");
  });
});

describe("assistBoundaryPrompt", () => {
  it("lists what is allowed and what is not", () => {
    const text = assistBoundaryPrompt(["删除 ~/Library/Caches/memmy"]);
    expect(text).toContain("这次请求允许的敏感操作：删除 ~/Library/Caches/memmy");
    expect(text).toContain("除此之外，不要删除或覆盖文件、读取密钥和登录凭据、向外部发送内容、修改系统或 Agent 的设置。");
    expect(text).toContain("遇到上面不允许的操作时不要执行，在结果里写明要做什么、为什么。");
  });

  it("says none when the request runs automatically", () => {
    expect(assistBoundaryPrompt([])).toContain("这次请求允许的敏感操作：无");
  });
});

describe("the executor's review prompt", () => {
  it("includes the request, the attachments in full and what the last request skipped", () => {
    const executor = executorReviewPrompt({
      ...CONTENT,
      previousSkipped: [{ title: "删除缓存目录", detail: "rm -rf ~/Library/Caches/foo" }]
    });
    expect(executor).toContain("要做的事：清一下缓存后重新复现");
    expect(executor).toContain("- 删除 ~/Library/Caches/memmy 后重新打开 Memmy");
    expect(executor).toContain("── setup.sh ──");
    expect(executor).toContain("rm -rf ~/Downloads/tmp");
    expect(executor).toContain("同一次排查里上一次请求有这些操作没有执行");
    expect(executor).toContain("删除缓存目录（rm -rf ~/Library/Caches/foo）");
  });

  it("does not ask about what the requester declared", () => {
    // 发起方不再做模型审查，执行方也不采信他的声明：提示词里没有这一段。
    const executor = executorReviewPrompt(CONTENT);
    expect(executor).not.toContain("发起方声明");
    expect(executor).not.toContain("发起方没有声明");
  });
});

describe("toAssistSafety", () => {
  it("reads what the cloud returns and drops what it cannot read", () => {
    const safety = toAssistSafety({
      requester: { status: "passed", summary: "会读日志", declared: [{ action: "读取日志" }] },
      executor: { status: "confirm", reason: "会删除文件", undeclared: ["删除 ~/Downloads"] },
      skipped: [{ title: "删除缓存目录", detail: "rm -rf x" }, { nope: true }],
      redacted: 2,
      extra: "忽略"
    });
    expect(safety).toEqual({
      // 旧数据里的 requester 照常解析（界面不再显示），executor 里多出来的 undeclared 丢掉。
      requester: { status: "passed", summary: "会读日志", declared: [{ action: "读取日志" }] },
      executor: { status: "confirm", reason: "会删除文件" },
      skipped: [{ title: "删除缓存目录", detail: "rm -rf x" }, { title: "一项操作" }],
      redacted: 2
    });
  });

  it("returns null for an old request without the field", () => {
    expect(toAssistSafety(undefined)).toBeNull();
    expect(toAssistSafety({})).toBeNull();
  });
});
