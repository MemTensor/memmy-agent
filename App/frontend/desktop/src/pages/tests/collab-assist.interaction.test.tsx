// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistInboxItem, AssistRequest, AssistTaskView, AssistThread, CollabClient } from "../../api/collab-client.js";
import { consumeAssistFocus, getAssistFocus } from "../../app/collab-assist-focus.js";
import { loadCollabProjects, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabAssistConversation } from "../collab-assist-conversation.js";
import { CollabAssistRequestCard } from "../collab-assist-card.js";
import { AssistBoardRow } from "../collab-page.js";
import { CollabAssistDialog } from "../collab-assist-dialog.js";
import { CollabAssistHost } from "../collab-assist-host.js";
import { AssistMessageCard, parseAssistEnvelope } from "../collab-assist-message.js";
import { CollabAssistProjectSettings } from "../collab-assist-settings.js";
import { CollabAssistTaskBar, CollabAssistTaskDock } from "../collab-assist-task.js";
import { NotificationCenterProvider } from "../../components/notification-center.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUESTER = { userId: "2102247370314383361", name: "孙起", mine: false };
const ME = { userId: "2102247370314383362", name: "王雨", mine: true };

function request(overrides: Partial<AssistRequest> = {}): AssistRequest {
  return {
    id: "r1",
    projectId: "p1",
    projectName: "Memmy 内测反馈",
    threadId: "t1",
    attempt: 1,
    via: "Codex",
    title: "收集 Cursor 任务读取相关的信息",
    reason: "关联任务弹窗里看不到 Cursor 的任务",
    items: ["查看 Memmy、Cursor 与系统的版本"],
    status: "pending",
    agent: null,
    scope: null,
    grant: null,
    steps: [],
    reply: "",
    resultItems: [],
    files: [],
    failure: null,
    requester: REQUESTER,
    executor: ME,
    mine: false,
    createdAt: "2026-11-04T08:41:00Z",
    decidedAt: null,
    finishedAt: null,
    sourceTask: null,
    autoRun: false,
    decidedMinutes: null,
    deliveredAt: null,
    ...overrides
  };
}

const inbox: AssistInboxItem = {
  ...request(),
  granted: false,
  grantAgent: null,
  grantExpiresAt: null,
  lastAgent: null,
  conversationId: null
};

function thread(overrides: Partial<AssistThread> = {}, requests: AssistRequest[] = [request()]): AssistThread {
  const latest = requests[0]!;
  return {
    threadId: "t1",
    projectId: "p1",
    title: latest.title,
    via: latest.via,
    agent: latest.agent,
    scope: latest.scope,
    grant: latest.grant,
    status: latest.status,
    attempt: latest.attempt,
    requester: REQUESTER,
    executor: ME,
    mine: false,
    createdAt: latest.createdAt,
    lastActiveAt: latest.createdAt,
    requests,
    conversationId: null,
    ...overrides
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text);
}

function client(overrides: Partial<CollabClient> = {}): CollabClient {
  return {
    assistAgents: vi.fn().mockResolvedValue({
      agents: [
        { sourceId: "memmy", name: "Memmy", available: true, group: "used", lastActiveAt: null },
        { sourceId: "claude_code", name: "Claude Code", available: true, group: "used", lastActiveAt: null },
        { sourceId: "cursor", name: "Cursor", available: true, group: "other", lastActiveAt: null }
      ],
      defaultAgent: "memmy"
    }),
    decideAssist: vi.fn().mockResolvedValue(request({ status: "running" })),
    stopAssist: vi.fn().mockResolvedValue(request({ status: "stopped" })),
    noteAssist: vi.fn().mockResolvedValue(undefined),
    revokeAssistGrant: vi.fn().mockResolvedValue({ grants: [] }),
    ...overrides
  } as unknown as CollabClient;
}

describe("成员协助的授权弹窗", () => {
  it("默认选「仅这一次」，并预选一个可用的 Agent", async () => {
    const onDecided = vi.fn();
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistDialog open request={inbox} collab={client()} onDecided={onDecided} onClose={() => undefined} />
      </I18nProvider>
    ));

    // 原型：默认「仅这一次」，之后的请求还会先问她；执行方默认选她给这位成员选过的，没有就是 Memmy。
    expect(document.body.textContent).toContain("仅这一次");
    expect(document.body.textContent).toContain("孙起之后的请求还会先问你。");
    expect(document.body.textContent).toContain("由谁执行");
    expect(document.body.textContent).toContain("列出的是这台电脑上能运行的 Agent，执行时使用你在该 Agent 中的账号。");
    // 本项目没用过的 Agent 收起成一行。
    expect(document.body.textContent).toContain("使用其他 Agent（1）");
    expect(button("Cursor")).toBeUndefined();

    await act(async () => button("允许")?.click());
    expect(onDecided).toHaveBeenCalledWith({ action: "allow", agent: "memmy", scope: "once" });
  });

  it("选「一段时间内直接执行」时出现时长，默认 1 小时，选好的时长一起交上去", async () => {
    const onDecided = vi.fn();
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistDialog open request={inbox} collab={client()} onDecided={onDecided} onClose={() => undefined} />
      </I18nProvider>
    ));

    expect(document.body.textContent).not.toContain("2 小时");
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((item) => item.textContent?.includes("一段时间内直接执行"))?.click();
    });
    expect(document.body.textContent).toContain(
      "孙起在「Memmy 内测反馈」里的后续请求在这段时间内由 Memmy 直接执行，不再询问。到时自动结束，也可以随时在项目设置中结束。"
    );
    // 四档时长，默认 1 小时；没有永久，也没有 10 分钟。
    const options = [...document.querySelectorAll<HTMLButtonElement>("[role=radio]")];
    expect(options.map((item) => item.textContent)).toEqual(["30 分钟", "1 小时", "2 小时", "4 小时"]);
    expect(options.find((item) => item.getAttribute("aria-checked") === "true")?.textContent).toBe("1 小时");
    await act(async () => options.find((item) => item.textContent === "2 小时")?.click());
    await act(async () => button("允许")?.click());

    expect(onDecided).toHaveBeenCalledWith({ action: "allow", agent: "memmy", scope: "timed", minutes: 120 });
  });

  it("默认选中的 Agent 在第二层时自动展开", async () => {
    const onDecided = vi.fn();
    const collab = client({
      assistAgents: vi.fn().mockResolvedValue({
        agents: [
          { sourceId: "memmy", name: "Memmy", available: true, group: "used", lastActiveAt: null },
          { sourceId: "cursor", name: "Cursor", available: true, group: "other", lastActiveAt: null }
        ],
        defaultAgent: "cursor"
      })
    });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistDialog open request={inbox} collab={collab} onDecided={onDecided} onClose={() => undefined} />
      </I18nProvider>
    ));

    expect(collab.assistAgents).toHaveBeenCalledWith("p1", REQUESTER.userId);
    expect(button("Cursor")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("允许")?.click());
    expect(onDecided).toHaveBeenCalledWith({ action: "allow", agent: "cursor", scope: "once" });
  });

  it("拒绝时不带执行方", async () => {
    const onDecided = vi.fn();
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistDialog open request={inbox} collab={client()} onDecided={onDecided} onClose={() => undefined} />
      </I18nProvider>
    ));

    await act(async () => button("拒绝")?.click());
    expect(onDecided).toHaveBeenCalledWith({ action: "reject" });
  });
});

describe("执行方的协助任务", () => {
  it("面包屑下方的协助条写明是谁的请求与限时授权的到期时间，执行中可以停止，授权可以结束", async () => {
    const collab = client();
    const expiresAt = new Date(Date.now() + 42 * 60_000).toISOString();
    const grant = { minutes: 60, expiresAt, active: true, agent: null };
    const running = request({ status: "running", agent: "memmy", scope: "timed", grant });
    const view: AssistTaskView = { executing: { thread: thread({ scope: "timed", agent: "memmy", grant }, [running]), confirm: null }, requested: [] };
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistTaskBar view={view} collab={collab} onChanged={() => undefined} />
      </I18nProvider>
    ));

    const until = new Date(expiresAt);
    const clock = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
    expect(document.body.textContent).toContain(`孙起的 Codex 请求 · 1 小时内直接执行（到 ${clock}）`);
    await act(async () => button("停止")?.click());
    expect(collab.stopAssist).toHaveBeenCalledWith("r1");
    await act(async () => button("结束授权")?.click());
    expect(collab.revokeAssistGrant).toHaveBeenCalledWith("p1", REQUESTER.userId);
  });

  it("同一次排查的第二次请求在任务底部确认，沿用上一次的执行 Agent", async () => {
    const collab = client();
    const second = request({ id: "r2", status: "confirm", attempt: 2 });
    const first = request({ status: "done", agent: "memmy", scope: "once" });
    const view: AssistTaskView = {
      executing: { thread: thread({ agent: "memmy", scope: "once" }, [second, first]), confirm: { ...inbox, ...second, lastAgent: "memmy", conversationId: "chat-1" } },
      requested: []
    };
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistTaskDock view={view} collab={collab} onChanged={() => undefined} />
      </I18nProvider>
    ));

    expect(document.body.textContent).toContain("孙起发来第 2 次请求，需要你确认");
    expect(document.body.textContent).toContain("这次将由 Memmy 在同一个会话里继续执行");
    expect(button("不允许")).toBeTruthy();
    expect(button("限时直接执行")).toBeTruthy();
    // 候选与授权弹窗是同一份。
    expect(collab.assistAgents).toHaveBeenCalledWith("p1", REQUESTER.userId);
    await act(async () => button("允许这一次")?.click());
    expect(collab.decideAssist).toHaveBeenCalledWith("r2", { action: "allow", agent: "memmy", scope: "once" });
  });

  it("任务内确认选「限时直接执行」时带上时长，默认 1 小时", async () => {
    const collab = client();
    const second = request({ id: "r2", status: "confirm", attempt: 2 });
    const first = request({ status: "done", agent: "memmy", scope: "once" });
    const view: AssistTaskView = {
      executing: { thread: thread({ agent: "memmy", scope: "once" }, [second, first]), confirm: { ...inbox, ...second, lastAgent: "memmy", conversationId: "chat-1" } },
      requested: []
    };
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistTaskDock view={view} collab={collab} onChanged={() => undefined} />
      </I18nProvider>
    ));

    await act(async () => button("限时直接执行")?.click());
    expect(collab.decideAssist).toHaveBeenCalledWith("r2", { action: "allow", agent: "memmy", scope: "timed", minutes: 60 });
  });

  it("上一次的执行 Agent 已经不能运行时，确认改用候选的默认项", async () => {
    const collab = client();
    const second = request({ id: "r2", status: "confirm", attempt: 2 });
    const first = request({ status: "done", agent: "pi", scope: "once" });
    const view: AssistTaskView = {
      executing: { thread: thread({ agent: "pi", scope: "once" }, [second, first]), confirm: { ...inbox, ...second, lastAgent: "pi", conversationId: null } },
      requested: []
    };
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistTaskDock view={view} collab={collab} onChanged={() => undefined} />
      </I18nProvider>
    ));

    await act(async () => button("允许这一次")?.click());
    expect(collab.decideAssist).toHaveBeenCalledWith("r2", { action: "allow", agent: "memmy", scope: "once" });
  });

  it("结果发出后底部写明发给了谁，展开能看到发出去的内容", async () => {
    const done = request({
      status: "done",
      agent: "memmy",
      scope: "once",
      reply: "Memmy 1.2.6，**macOS 15.6**。",
      resultItems: [{ key: "版本", value: "Memmy 1.2.6" }]
    });
    const view: AssistTaskView = { executing: { thread: thread({}, [done]), confirm: null }, requested: [] };
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistTaskDock view={view} collab={client()} onChanged={() => undefined} />
      </I18nProvider>
    ));
    expect(document.body.textContent).toContain("结果已发给孙起");
    expect(document.body.textContent).not.toContain("Memmy 1.2.6，macOS 15.6。");
    await act(async () => [...document.querySelectorAll("button")].find((item) => item.textContent?.includes("结果已发给孙起"))?.click());
    expect(document.body.textContent).toContain("Memmy 1.2.6，macOS 15.6。");
    // 展开后的回复按 Markdown 渲染，不露出原样的符号。
    expect(document.body.textContent).not.toContain("**");
  });

  it("请求消息显示成卡片，看不到交给模型的格式要求", async () => {
    const content = [
      '<memmy_assist_request request="r1" from="孙起" via="Claude Code" attempt="2">',
      "孙起正在排查一个问题，需要这台电脑上的信息。",
      "起因：本机复现不了",
      "",
      "要做的事：查看系统与 Memmy 版本",
      "- 查看 Memmy 与 macOS 的版本",
      "</memmy_assist_request>"
    ].join("\n");
    const envelope = parseAssistEnvelope(content);
    expect(envelope?.kind).toBe("request");
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <AssistMessageCard envelope={envelope!} />
      </I18nProvider>
    ));
    expect(document.body.textContent).toContain("孙起的 Claude Code 请求· 第 2 次");
    expect(document.body.textContent).toContain("起因：本机复现不了");
    expect(document.body.textContent).toContain("查看 Memmy 与 macOS 的版本");
    expect(document.body.textContent).not.toContain("memmy_assist_request");
    expect(parseAssistEnvelope("普通的一句话")).toBeNull();
  });
});

describe("发起方在 Memmy 中", () => {
  it("结果还没送回时，任务底部显示请求卡片；送回后由消息里的结果卡片承接", async () => {
    const waiting = { ...request({ status: "running", agent: "memmy", mine: true, sourceTask: "chat-src" }), delivered: false };
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistTaskDock view={{ executing: null, requested: [waiting] }} collab={client()} onChanged={() => undefined} />
      </I18nProvider>
    ));
    expect(document.body.textContent).toContain("请求王雨协助");
    expect(document.body.textContent).toContain("执行中");

    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistTaskDock view={{ executing: null, requested: [{ ...waiting, status: "done", delivered: true }] }} collab={client()} onChanged={() => undefined} />
      </I18nProvider>
    ));
    expect(document.body.textContent).not.toContain("请求王雨协助");

    const result = parseAssistEnvelope([
      '<memmy_assist_result request="r1" short="R1" from="王雨" agent="Memmy" status="done" attempt="1" title="看磁盘占用">',
      "王雨的 Memmy 在王雨的电脑上完成了协助请求「看磁盘占用」（第 1 次）。",
      "",
      "结果：",
      "~/.memmy 一共 14G，主要是：",
      "- sessions：11G",
      "",
      "逐项：",
      "- 总大小：14G",
      "",
      "请结合这份结果，接着分析这条任务里的问题。",
      "</memmy_assist_result>"
    ].join("\n"));
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <AssistMessageCard envelope={result!} />
      </I18nProvider>
    ));
    expect(document.body.textContent).toContain("王雨的 Memmy 完成了协助");
    expect(document.body.textContent).toContain("总大小14G");
    // 正文里的列表留在正文里，不被当成逐项结果。
    expect(document.body.textContent).toContain("- sessions：11G");
    expect(document.body.textContent).toContain("以上内容来自王雨的电脑");
    expect(document.body.textContent).not.toContain("请结合这份结果");
  });
});

describe("看板上的协助会话", () => {
  function detail(requests: AssistRequest[], overrides: Partial<AssistThread> = {}) {
    return { thread: { ...thread(overrides, requests), sourceTask: null, ...overrides }, serverTime: new Date().toISOString() };
  }

  it("按轮次列出请求、决定、提示词、执行过程、回复与发起方收到的内容", async () => {
    const first = request({
      id: "r1", attempt: 1, status: "done", agent: "memmy", scope: "timed", decidedMinutes: 60,
      createdAt: "2026-11-05T01:00:00Z", decidedAt: "2026-11-05T01:00:10Z", finishedAt: "2026-11-05T01:01:00Z",
      prompt: "<memmy_assist_request>孙起正在排查一个问题</memmy_assist_request>",
      promptContext: "# 成员协助\n最后另起一段，以「结果：」开头。",
      transcript: [
        { kind: "text", text: "先看一下 **系统版本**。" },
        { kind: "tool", name: "运行命令 sw_vers", input: "sw_vers", output: "ProductName: macOS\nProductVersion: 15.6", status: "done" }
      ],
      reply: "版本是 **macOS 15.6**。",
      resultItems: [{ key: "系统", value: "macOS 15.6" }],
      delivery: "<memmy_assist_result>王雨的 Memmy 完成了协助</memmy_assist_result>",
      deliveryReply: "收到，接着看日志。",
      deliveredAt: "2026-11-05T01:01:05Z"
    });
    const second = request({
      id: "r2", attempt: 2, status: "done", agent: "memmy", scope: "timed", decidedMinutes: null,
      createdAt: "2026-11-05T01:05:00Z", decidedAt: "2026-11-05T01:05:05Z", finishedAt: "2026-11-05T01:06:00Z",
      transcript: [], reply: "日志正常。"
    });
    const collab = client({ assistThread: vi.fn().mockResolvedValue(detail([second, first])) });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation thread={thread({ agent: "memmy" }, [second, first])} collab={collab} onClose={() => undefined} />
      </I18nProvider>
    ));
    await act(async () => undefined);
    const text = document.body.textContent ?? "";
    expect(collab.assistThread).toHaveBeenCalledWith("p1", "t1");
    expect(text).toContain("孙起的 Codex 发出请求");
    expect(text).toContain("王雨允许，由 Memmy 执行 · 1 小时内直接执行（到");
    expect(text).toContain("按限时授权直接执行，由 Memmy 执行");
    expect(text).toContain("王雨的 Memmy 收到的提示词");
    expect(text).toContain("隐藏注入的格式要求（不在任务里显示）");
    expect(text).toContain("运行命令 sw_vers");
    expect(text).toContain("孙起的 Codex 收到的内容");
    expect(text).toContain("收到，接着看日志。");
    // 第二轮还没取回结果。
    expect(text).toContain("孙起还没有取回结果");
    // 回复与说明按 Markdown 渲染，不露出原样的符号。
    expect(text).not.toContain("**");
    expect(document.querySelector("[data-assist-part='reply'] strong")?.textContent).toBe("macOS 15.6");
    // 工具调用默认收起，展开后是命令与完整的多行输出。
    const tool = document.querySelector<HTMLDetailsElement>("details[data-assist-tool]");
    expect(tool?.open).toBe(false);
    expect(tool?.querySelector("[data-detail='result'] pre")?.textContent).toBe("ProductName: macOS\nProductVersion: 15.6");
    // 轮次按时间顺序：第 1 次在前。
    const rounds = [...document.querySelectorAll("[data-assist-round]")].map((node) => node.getAttribute("data-assist-round"));
    expect(rounds).toEqual(["1", "2"]);
  });

  it("旧请求没有会话内容时按已有内容显示", async () => {
    const old = request({ status: "done", agent: "claude_code", scope: "once", steps: [{ text: "运行命令 ls", output: "a.log" }], reply: "有一个日志。" });
    const collab = client({ assistThread: vi.fn().mockResolvedValue({ thread: { ...thread({ agent: "claude_code" }, [old]), sourceTask: null }, serverTime: null }) });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation thread={thread({ agent: "claude_code" }, [old])} collab={collab} onClose={() => undefined} />
      </I18nProvider>
    ));
    await act(async () => undefined);
    const text = document.body.textContent ?? "";
    expect(text).toContain("王雨允许，由 Claude Code 执行 · 仅这一次");
    expect(text).toContain("运行命令 ls");
    expect(text).toContain("有一个日志。");
    expect(text).not.toContain("收到的提示词");
  });

  it("发起人等待授权时可以撤回，并能回到发起的任务；执行方由 Memmy 执行时可以打开那条任务", async () => {
    const collab = client({
      cancelAssist: vi.fn().mockResolvedValue(request({ status: "cancelled" })),
      assistThread: vi.fn().mockResolvedValue({ thread: { ...thread({ mine: true, requester: { ...REQUESTER, mine: true }, executor: { ...ME, mine: false } }, [request({ mine: true, sourceTask: "chat-src" })]), sourceTask: "chat-src" }, serverTime: null })
    });
    const onOpenTask = vi.fn();
    const pending = request({ mine: true, requester: { ...REQUESTER, mine: true }, executor: { ...ME, mine: false }, sourceTask: "chat-src" });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation
          thread={thread({ mine: true, requester: { ...REQUESTER, mine: true }, executor: { ...ME, mine: false } }, [pending])}
          collab={collab}
          sourceTaskAvailable={(id) => id === "chat-src"}
          onOpenTask={onOpenTask}
          onClose={() => undefined}
        />
      </I18nProvider>
    ));
    await act(async () => undefined);
    expect(document.body.textContent).toContain("等待王雨授权");
    await act(async () => button("撤回请求")?.click());
    expect(collab.cancelAssist).toHaveBeenCalledWith("r1");
    await act(async () => button("打开发起的任务")?.click());
    expect(onOpenTask).toHaveBeenCalledWith("chat-src");

    const running = request({ status: "running", agent: "memmy", scope: "once" });
    const executing = client({ assistThread: vi.fn().mockResolvedValue({ thread: { ...thread({ agent: "memmy", conversationId: "chat-run" }, [running]), sourceTask: null }, serverTime: null }) });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation thread={thread({ agent: "memmy", conversationId: "chat-run" }, [running])} collab={executing} onOpenTask={onOpenTask} onClose={() => undefined} />
      </I18nProvider>
    ));
    await act(async () => undefined);
    expect(document.body.textContent).toContain("正在执行…");
    await act(async () => button("在 Memmy 中打开任务")?.click());
    expect(onOpenTask).toHaveBeenCalledWith("chat-run");
  });

  it("按限时授权会直接执行的请求，看板与发起方卡片都不写「等待授权」", async () => {
    const grant = { minutes: 60, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), active: true, agent: "memmy" };
    const waiting = request({ status: "pending", autoRun: true, grant, mine: true });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <ul><AssistBoardRow thread={thread({ status: "pending" }, [waiting])} selecting={false} onOpen={() => undefined} /></ul>
        <CollabAssistRequestCard request={waiting} collab={client()} />
      </I18nProvider>
    ));
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("等待授权");
    expect(text).not.toContain("等待王雨授权");
    expect(text).toContain("按限时授权执行");
    expect(text).toContain("王雨给你的限时授权到");
    expect(text).toContain("王雨的 Memmy 会直接执行");
  });
});


describe("成员协助的宿主", () => {
  it("允许由 Memmy 执行后，直接打开项目里的那条 Memmy 任务", async () => {
    const onOpenTask = vi.fn();
    const collab = client({
      assistInbox: vi.fn().mockResolvedValue({ requests: [inbox] }),
      decideAssist: vi.fn().mockResolvedValue(request({ status: "running", agent: "memmy", scope: "once" })),
      assistExecutions: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([{
          requestId: "r1",
          threadId: "t1",
          projectId: "p1",
          agent: "memmy",
          status: "running",
          steps: [],
          conversationId: "chat-1",
          startedAt: "2026-11-04T08:42:00Z",
          finishedAt: null,
          failure: null
        }])
    });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistHost collab={collab} enabled onOpenTask={onOpenTask} />
      </I18nProvider>
    ));
    // 收件箱里的待授权请求直接弹出授权弹窗，Memmy 是默认的执行方。
    expect(document.body.textContent).toContain("孙起请求你的电脑协助");

    await act(async () => button("允许")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });

    expect(collab.decideAssist).toHaveBeenCalledWith("r1", { action: "allow", agent: "memmy", scope: "once" });
    expect(onOpenTask).toHaveBeenCalledWith("chat-1");
    // 不再另开协助视图。
    expect(document.body.textContent).not.toContain("孙起请求你的电脑协助");
    expect(document.body.textContent).not.toContain("结束授权");
  });

  it("请求在别处处理掉之后，开着的授权弹窗自己关上", async () => {
    vi.useFakeTimers();
    try {
      const assistInbox = vi.fn()
        .mockResolvedValueOnce({ requests: [inbox] })
        .mockResolvedValue({ requests: [{ ...inbox, status: "running" }] });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      await act(async () => root.render(
        <I18nProvider language="zh-CN">
          <CollabAssistHost collab={client({ assistInbox })} enabled />
        </I18nProvider>
      ));
      expect(document.body.textContent).toContain("孙起请求你的电脑协助");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(document.body.textContent).not.toContain("孙起请求你的电脑协助");
    } finally {
      vi.useRealTimers();
    }
  });

  it("允许由外部 Agent 执行后，打开项目看板并展开这次协助", async () => {
    resetCollabProjectsStore();
    await loadCollabProjects({
      listProjects: vi.fn().mockResolvedValue({ projects: [{ id: "p1", name: "Memmy 内测反馈", localProjectId: "local-1" }] })
    } as unknown as CollabClient).catch(() => undefined);
    const onOpenBoard = vi.fn();
    const collab = client({
      assistInbox: vi.fn().mockResolvedValue({ requests: [inbox] }),
      decideAssist: vi.fn().mockResolvedValue(request({ status: "running", agent: "claude_code", scope: "once" }))
    });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistHost collab={collab} enabled onOpenBoard={onOpenBoard} />
      </I18nProvider>
    ));
    await act(async () => {
      [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("Claude Code"))?.click();
    });
    await act(async () => button("允许")?.click());

    expect(onOpenBoard).toHaveBeenCalledWith("local-1");
    expect(getAssistFocus()).toEqual({ projectId: "p1", threadId: "t1" });
    consumeAssistFocus();
    resetCollabProjectsStore();
  });

  it("请求在别处处理掉之后，对应的通知自动收起", async () => {
    vi.useFakeTimers();
    try {
      const assistInbox = vi.fn()
        .mockResolvedValueOnce({ requests: [{ ...inbox, granted: true, grantAgent: "memmy" }], dailyLimit: 20 })
        .mockResolvedValue({ requests: [], dailyLimit: 20 });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      await act(async () => root.render(
        <I18nProvider language="zh-CN">
          <NotificationCenterProvider>
            <CollabAssistHost collab={client({ assistInbox })} enabled />
          </NotificationCenterProvider>
        </I18nProvider>
      ));
      expect(document.body.textContent).toContain("选择 Agent 并授权");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(document.body.textContent).not.toContain("选择 Agent 并授权");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("项目设置的成员协助", () => {
  it("接收协助请求默认关闭，关闭时不列限时授权；打开后列出剩余时间", async () => {
    const expiresAt = new Date(Date.now() + 42 * 60_000 + 20_000).toISOString();
    const collab = client({
      assistReceiving: vi.fn().mockResolvedValue({ projectId: "p1", enabled: false }),
      setAssistReceiving: vi.fn().mockResolvedValue({ projectId: "p1", enabled: true }),
      assistGrants: vi.fn().mockResolvedValue({
        grants: [{
          projectId: "p1",
          projectName: "Memmy 内测反馈",
          grantee: REQUESTER,
          agent: "claude_code",
          active: true,
          minutes: 60,
          expiresAt,
          createdAt: null,
          revokedAt: null
        }],
        dailyLimit: 20
      })
    });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistProjectSettings client={collab} projectId="p1" />
      </I18nProvider>
    ));

    const toggle = document.querySelector<HTMLButtonElement>("[role=switch]");
    expect(document.body.textContent).toContain("接收协助请求");
    expect(document.body.textContent).toContain("开启后，项目里的其他成员可以请你电脑上的 Agent 执行任务，每次请求都会先问你。");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    expect(document.body.textContent).not.toContain("限时授权");

    await act(async () => toggle?.click());
    expect(collab.setAssistReceiving).toHaveBeenCalledWith("p1", true);
    expect(document.body.textContent).toContain("限时授权");
    expect(document.body.textContent).toContain("由 Claude Code 执行 · 还剩 43 分钟");
    // 每日次数上限已经取消：不再说「今天已执行」与「每天最多 20 次」。
    expect(document.body.textContent).not.toContain("今天已执行");
    expect(document.body.textContent).not.toContain("20 次");
    expect(button("结束授权")).toBeTruthy();
  });
});
