// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistInboxItem, AssistRequest, AssistTaskView, AssistThread, CollabClient } from "../../api/collab-client.js";
import { ApiRequestError } from "../../api/http.js";
import { consumeAssistFocus, getAssistFocus } from "../../app/collab-assist-focus.js";
import { loadCollabProjects, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ASSIST_PANEL_WIDTH_STORAGE_KEY, CollabAssistConversation } from "../collab-assist-conversation.js";
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
    attachments: null,
    status: "pending",
    agent: null,
    scope: null,
    grant: null,
    steps: [],
    reply: "",
    resultItems: [],
    files: [],
    failure: null,
    stoppedBy: null,
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

/** 等读取限时授权的两三个请求落地并重画。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

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
    // 弹窗打开时拉一次详情拿附件正文：默认返回没有附件的那一份。
    assistRequest: vi.fn().mockResolvedValue(request()),
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
    // 底部只说清执行过程在哪里看、可以随时停：次数与时长属于设置里的规则，不在授权弹窗里重复。
    expect(document.body.textContent).toContain("执行过程会显示在 Memmy 项目的协助里，可以随时停止。");
    expect(document.body.textContent).not.toContain("单次最长 15 分钟");

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

  it("收件箱不带附件正文时，打开弹窗拉一次详情：附件与长事项都看得到", async () => {
    const items = ["第一条", "第二条", "第三条", "第四条", "第五条"];
    const detailed = request({
      items,
      attachments: [{ name: "scan-probe.sh", content: "#!/bin/sh\necho hi", sha256: "9f2c" }]
    });
    const collab = client({ assistRequest: vi.fn().mockResolvedValue(detailed) });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistDialog open request={{ ...inbox, items }} collab={collab} onDecided={() => undefined} onClose={() => undefined} />
      </I18nProvider>
    ));
    await flush();

    // 弹窗拿到的是收件箱里的那份（attachments 为 null），按需拉一次带附件正文的详情。
    expect(collab.assistRequest).toHaveBeenCalledWith("r1", { withAttachments: true });
    expect(document.body.textContent).toContain("scan-probe.sh");
    // 默认只看前三条，其余收起。
    expect(document.body.textContent).toContain("第一条");
    expect(document.body.textContent).not.toContain("第四条");
    await act(async () => button("展开其余 2 条")?.click());
    expect(document.body.textContent).toContain("第四条");
    // 预览展开的是附件原文。
    await act(async () => button("预览")?.click());
    expect(document.body.textContent).toContain("#!/bin/sh");
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
    expect(document.body.textContent).toContain("背景本机复现不了");
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

describe("发起方停下执行中的请求", () => {
  const running = (overrides: Partial<AssistRequest> = {}) => request({
    status: "running",
    agent: "memmy",
    scope: "once",
    mine: true,
    requester: { ...REQUESTER, mine: true },
    executor: { ...ME, mine: false },
    decidedAt: "2026-11-05T01:00:10Z",
    ...overrides
  });

  it("卡片在执行中给出「停止」，点完变成已停止并写明是你停的", async () => {
    const onChanged = vi.fn();
    const collab = client({ cancelAssist: vi.fn().mockResolvedValue(running({ status: "stopped", stoppedBy: "requester" })) });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistRequestCard request={running()} collab={collab} onChanged={onChanged} />
      </I18nProvider>
    ));
    expect(document.body.textContent).toContain("正在执行");
    // 执行中也能自己停：位置与样式同等待授权时的「撤回」。
    await act(async () => button("停止")?.click());
    expect(collab.cancelAssist).toHaveBeenCalledWith("r1");
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: "stopped" }));

    // 卡片由持有请求的那一层重画：换成停下的这一份后，按钮消失、写明是你停的。
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistRequestCard request={running({ status: "stopped", stoppedBy: "requester" })} collab={collab} onChanged={onChanged} />
      </I18nProvider>
    ));
    expect(button("停止")).toBeUndefined();
    expect(document.body.textContent).toContain("你停止了这次执行");
  });

  it("停止后的卡片写「你停止了这次执行」，对方停的写名字", async () => {
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistRequestCard request={running({ status: "stopped", stoppedBy: "requester" })} collab={client()} />
        <CollabAssistRequestCard request={running({ status: "stopped", stoppedBy: "executor" })} collab={client()} />
      </I18nProvider>
    ));
    const text = document.body.textContent ?? "";
    expect(text).toContain("你停止了这次执行");
    expect(text).toContain("王雨停止了这次执行");
  });

  it("刚好在对方跑完时停止：不报错，改成显示最新的一次", async () => {
    const done = running({ status: "done", reply: "版本是 macOS 15.6" });
    const collab = client({
      cancelAssist: vi.fn().mockRejectedValue(new ApiRequestError("这次请求已经处理过了", 409, "conflict")),
      assistRequest: vi.fn().mockResolvedValue(done)
    });
    const onChanged = vi.fn();
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistRequestCard request={running()} collab={collab} onChanged={onChanged} />
      </I18nProvider>
    ));
    await act(async () => button("停止")?.click());
    expect(collab.assistRequest).toHaveBeenCalledWith("r1");
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }));
  });

  it("协助会话里发起人在执行中也有「停止」", async () => {
    const collab = client({
      cancelAssist: vi.fn().mockResolvedValue(running({ status: "stopped", stoppedBy: "requester" })),
      assistThread: vi.fn().mockResolvedValue({ thread: thread({ mine: true, requester: { ...REQUESTER, mine: true }, executor: { ...ME, mine: false } }, [running()]), sourceTask: null })
    });
    const mineThread = thread({ mine: true, requester: { ...REQUESTER, mine: true }, executor: { ...ME, mine: false } }, [running()]);
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation thread={mineThread} collab={collab} onClose={() => undefined} />
      </I18nProvider>
    ));
    await act(async () => undefined);
    await act(async () => button("停止")?.click());
    expect(collab.cancelAssist).toHaveBeenCalledWith("r1");
  });

  it("两边几乎同时停止时，后到的那一下不显示错误", async () => {
    const collab = client({
      cancelAssist: vi.fn().mockRejectedValue(new ApiRequestError("这次请求已经处理过了", 409, "conflict")),
      assistThread: vi.fn().mockResolvedValue({ thread: thread({ mine: true, requester: { ...REQUESTER, mine: true }, executor: { ...ME, mine: false } }, [running()]), sourceTask: null })
    });
    const mineThread = thread({ mine: true, requester: { ...REQUESTER, mine: true }, executor: { ...ME, mine: false } }, [running()]);
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation thread={mineThread} collab={collab} onClose={() => undefined} />
      </I18nProvider>
    ));
    await act(async () => undefined);
    await act(async () => button("停止")?.click());
    expect(document.body.textContent).not.toContain("这次操作没有完成");
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

  it("有发起方记录时按链展示：发起方的对话 → 请求 → 执行方 → 发起方收到的结果与之后的过程", async () => {
    const done = request({
      status: "done", agent: "memmy", scope: "once", via: "DeepSeek Harness",
      transcript: [{ kind: "thinking", text: "先看版本。" }, { kind: "tool", name: "运行命令 sw_vers", input: "sw_vers", output: "15.6", status: "done" }],
      reply: "macOS 15.6。",
      delivery: "已完成：王雨的 Memmy……",
      origin: [
        { kind: "user", text: "请王雨看一下 **版本**" },
        { kind: "thinking", text: "需要王雨电脑上的信息。\n先写请求文件。" },
        { kind: "tool", name: "发起协助请求", input: "memmy-project assist ask --file /tmp/r.json", output: "已发送协助请求 A7F3K1。", status: "done" },
        { kind: "tool", name: "等待协助结果", input: "memmy-project assist wait A7F3K1", output: "还没结束：王雨的 Memmy 正在执行", status: "done" }
      ],
      followup: [
        { kind: "tool", name: "等待协助结果", input: "memmy-project assist wait A7F3K1", output: "已完成：版本是 15.6", status: "done", delivery: true },
        { kind: "text", text: "王雨那边是 macOS 15.6。" }
      ]
    });
    const collab = client({ assistThread: vi.fn().mockResolvedValue(detail([done], { via: "DeepSeek Harness" })) });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation thread={thread({ agent: "memmy", via: "DeepSeek Harness" }, [done])} collab={collab} onClose={() => undefined} />
      </I18nProvider>
    ));
    await act(async () => undefined);
    const text = document.body.textContent ?? "";
    expect(text).toContain("发起方 · 孙起的 DeepSeek Harness");
    expect(text).toContain("执行方 · 王雨的 Memmy");
    // 链上的顺序：发起方的对话在请求之前，收到后的过程在最后。
    const parts = [...document.querySelectorAll("[data-assist-part]")].map((node) => node.getAttribute("data-assist-part"));
    expect(parts.indexOf("origin")).toBeLessThan(parts.indexOf("request"));
    expect(parts.indexOf("reply")).toBeLessThan(parts.indexOf("followup"));
    // 有发起方记录时不再单列「收到的内容」。
    expect(parts).not.toContain("delivery");
    // 用户的话按 Markdown；思考默认收起，只露第一行。
    expect(document.querySelector("[data-assist-item='user'] strong")?.textContent).toBe("版本");
    const thinking = [...document.querySelectorAll<HTMLDetailsElement>("details[data-assist-item='thinking']")];
    expect(thinking).toHaveLength(2);
    expect(thinking.every((node) => !node.open)).toBe(true);
    expect(text).toContain("等待协助结果");
    // 拿到结果的那一步单独突出。
    const received = document.querySelector("[data-assist-part='followup'] [data-assist-item='received']");
    expect(received?.textContent).toContain("收到的结果");
    expect(received?.textContent).toContain("已完成：版本是 15.6");
    expect(text).toContain("王雨那边是 macOS 15.6。");
  });

  it("Memmy 发起时收到的结果显示成结果卡片；收到后的记录还没同步时说明一句", async () => {
    const message = '<memmy_assist_result request="r1" from="王雨" agent="Memmy" status="done" attempt="1" title="查版本">\n王雨的 Memmy 完成了协助请求。\n\n结果：\nmacOS 15.6\n</memmy_assist_result>';
    const first = request({
      id: "r1", attempt: 1, status: "done", agent: "memmy", scope: "once", via: "Memmy", reply: "macOS 15.6",
      createdAt: "2026-11-05T01:00:00Z",
      origin: [{ kind: "user", text: "请王雨看版本" }],
      followup: [{ kind: "user", text: message, delivery: true }, { kind: "text", text: "好的，版本一致。" }]
    });
    const second = request({
      id: "r2", attempt: 2, status: "done", agent: "memmy", scope: "timed", via: "Memmy", reply: "日志正常",
      // 刚刚结束：发起方还在补传收到后的记录。
      createdAt: "2026-11-05T01:05:00Z", finishedAt: new Date().toISOString(),
      delivery: message,
      origin: [{ kind: "thinking", text: "再问一次。" }],
      followup: null
    });
    const collab = client({ assistThread: vi.fn().mockResolvedValue(detail([second, first], { via: "Memmy" })) });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation thread={thread({ agent: "memmy", via: "Memmy" }, [second, first])} collab={collab} onClose={() => undefined} />
      </I18nProvider>
    ));
    await act(async () => undefined);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("<memmy_assist_result");
    expect(document.querySelector("[data-assist-part='followup'] [data-collab-assist-result]")).not.toBeNull();
    expect(text).toContain("好的，版本一致。");
    // 第二轮：收到后的记录还没同步，先显示收到的内容（也是卡片）。
    expect(text).toContain("孙起的 Memmy 收到结果之后的记录还在同步。");
    expect(document.querySelector("[data-assist-part='delivery'] [data-collab-assist-result]")).not.toBeNull();
  });

  it("请求结束后面板继续重读：发起方后来补传的记录自己出现，30 分钟后不再重读", async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      const base = request({
        id: "r1", attempt: 1, status: "done", agent: "memmy", scope: "once", via: "DeepSeek Harness", reply: "macOS 15.6",
        createdAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date().toISOString(),
        origin: [{ kind: "user", text: "请王雨看版本" }],
        followup: null
      });
      const synced = {
        ...base,
        delivery: "已完成：版本是 15.6",
        followup: [
          { kind: "tool" as const, name: "等待协助结果", input: "memmy-project assist wait A7F3K1", output: "已完成：版本是 15.6", status: "done" as const, delivery: true },
          { kind: "text" as const, text: "王雨那边是 macOS 15.6，和我这边一致。" }
        ]
      };
      // 云端每次返回的都是当时的时间。
      let reads = 0;
      const assistThread = vi.fn().mockImplementation(async () => {
        reads += 1;
        return detail([reads === 1 ? base : synced], { via: "DeepSeek Harness" });
      });
      const summary = thread({ agent: "memmy", via: "DeepSeek Harness" }, [base]);
      await act(async () => root.render(
        <I18nProvider language="zh-CN">
          <CollabAssistConversation thread={summary} collab={client({ assistThread })} onClose={() => undefined} />
        </I18nProvider>
      ));
      await act(async () => undefined);
      expect(document.body.textContent).toContain("收到结果之后的记录还在同步。");

      // 看板那一行没有变，面板自己重读到发起方补传的内容。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      const text = document.body.textContent ?? "";
      expect(text).toContain("王雨那边是 macOS 15.6，和我这边一致。");
      expect(text).not.toContain("还在同步");

      // 30 分钟之后不会再有新内容，停止重读。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31 * 60_000);
      });
      const calls = assistThread.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(assistThread.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("结束超过 30 分钟仍没有收到后的记录时，不再说「还在同步」", async () => {
    const old = request({
      id: "r1", attempt: 1, status: "done", agent: "memmy", scope: "once", via: "DeepSeek Harness", reply: "macOS 15.6",
      createdAt: "2026-11-05T01:00:00Z", finishedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
      origin: [{ kind: "user", text: "请王雨看版本" }],
      followup: null
    });
    const collab = client({ assistThread: vi.fn().mockResolvedValue(detail([old], { via: "DeepSeek Harness" })) });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation thread={thread({ agent: "memmy", via: "DeepSeek Harness" }, [old])} collab={collab} onClose={() => undefined} />
      </I18nProvider>
    ));
    await act(async () => undefined);
    const text = document.body.textContent ?? "";
    expect(text).toContain("没有读到孙起的 DeepSeek Harness 收到结果之后的记录。");
    expect(text).not.toContain("还在同步");
  });

  it("左边缘往左拖可以把面板拉宽，宽度记在本机，下次打开沿用", async () => {
    window.localStorage.removeItem(ASSIST_PANEL_WIDTH_STORAGE_KEY);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
    const done = request({ status: "done", agent: "memmy", reply: "macOS 15.6", finishedAt: "2026-11-05T01:00:00Z" });
    const collab = client({ assistThread: vi.fn().mockResolvedValue(detail([done])) });
    const render = (value: AssistThread | null) => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation thread={value} collab={collab} onClose={() => undefined} />
      </I18nProvider>
    );
    const panel = () => document.querySelector<HTMLElement>("[data-collab-assist-conversation]");
    const handle = () => document.querySelector<HTMLElement>("[data-collab-assist-conversation] [role='separator']")!;
    try {
      await act(async () => render(thread({ agent: "memmy" }, [done])));
      await act(async () => undefined);
      expect(panel()?.style.width).toBe("520px");
      expect(handle().getAttribute("aria-label")).toBe("调整协助会话宽度");

      // 按住左边缘往左拖 300：变宽 300。
      await act(async () => {
        handle().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 1000 }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 700 }));
        window.dispatchEvent(new PointerEvent("pointerup", { clientX: 700 }));
      });
      expect(panel()?.style.width).toBe("820px");
      expect(window.localStorage.getItem(ASSIST_PANEL_WIDTH_STORAGE_KEY)).toBe("820");

      // 再拖也给看板留出一截：窗口 1600 时最宽 1600 - 48 - 240。
      await act(async () => {
        handle().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 700 }));
      });
      await act(async () => {
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 0 }));
        window.dispatchEvent(new PointerEvent("pointerup", { clientX: 0 }));
      });
      expect(panel()?.style.width).toBe("1312px");

      // 键盘：右方向键变窄。
      await act(async () => {
        handle().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      });
      expect(panel()?.style.width).toBe("1296px");

      // 关掉再打开：沿用上次的宽度。
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => render(thread({ agent: "memmy" }, [done])));
      expect(panel()?.style.width).toBe("1296px");

      // 窗口变窄：只收窄显示的宽度，记下的宽度不变。
      await act(async () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 1000 });
        window.dispatchEvent(new Event("resize"));
      });
      expect(panel()?.style.width).toBe("712px");
      expect(window.localStorage.getItem(ASSIST_PANEL_WIDTH_STORAGE_KEY)).toBe("1296");

      // 很窄的窗口里面板铺满，不再能拖。
      await act(async () => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 700 });
        window.dispatchEvent(new Event("resize"));
      });
      expect(panel()?.style.width).toBe("");
      expect(document.querySelector("[data-collab-assist-conversation] [role='separator']")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
      window.localStorage.removeItem(ASSIST_PANEL_WIDTH_STORAGE_KEY);
    }
  });

  it("关闭时还在路上的读取返回后，面板不会重新出现", async () => {
    const done = request({ status: "done", agent: "memmy", reply: "macOS 15.6", finishedAt: new Date().toISOString() });
    let resolveLate: ((value: ReturnType<typeof detail>) => void) | null = null;
    const assistThread = vi.fn()
      .mockResolvedValueOnce(detail([done]))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveLate = resolve;
      }));
    const collab = client({ assistThread });
    const summary = thread({ agent: "memmy" }, [done]);
    const render = (value: AssistThread | null) => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistConversation thread={value} collab={collab} onClose={() => undefined} />
      </I18nProvider>
    );
    await act(async () => render(summary));
    await act(async () => undefined);
    // 看板那一行变了：再读一次，这次还没返回。
    await act(async () => render({ ...summary, lastActiveAt: "2026-11-05T02:00:00Z" }));
    expect(assistThread).toHaveBeenCalledTimes(2);
    // 关掉面板，之后那次读取才返回。
    await act(async () => render(null));
    expect(document.querySelector("[data-collab-assist-conversation]")).toBeNull();
    await act(async () => {
      resolveLate?.(detail([done]));
    });
    expect(document.querySelector("[data-collab-assist-conversation]")).toBeNull();
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

  it("does not count requests of the project that is open on the board", async () => {
    resetCollabProjectsStore();
    await loadCollabProjects({
      listProjects: vi.fn().mockResolvedValue({ projects: [{ id: "p1", name: "Memmy 内测反馈", localProjectId: "local-1" }] })
    } as unknown as CollabClient).catch(() => undefined);
    // 有生效中的限时授权：不会弹授权弹窗，角标才会出现，正好用来看它是否被排除。
    const granted = { ...inbox, granted: true, grantAgent: "memmy" as const };
    const collab = client({ assistInbox: vi.fn().mockResolvedValue({ requests: [granted] }) });

    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistHost collab={collab} enabled boardProjectId="local-1" />
      </I18nProvider>
    ));
    expect(document.body.textContent).not.toContain("有 1 条协助请求待处理");

    // 不在这个项目的看板上时照旧计入角标。
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistHost collab={collab} enabled boardProjectId={null} />
      </I18nProvider>
    ));
    expect(document.body.textContent).toContain("有 1 条协助请求待处理");
    resetCollabProjectsStore();
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
    expect(document.body.textContent).toContain("成员可以请你电脑上的 Agent 执行任务，每次都会先问你");
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
    // 次数与时长限制移到协助请求弹窗里说明，设置这一节不再重复。
    expect(document.body.textContent).not.toContain("单次最长 15 分钟");
  });

  it("限时授权一行：首字头像、成员名、换用下拉与结束授权按钮", async () => {
    const collab = client({
      assistReceiving: vi.fn().mockResolvedValue({ projectId: "p1", enabled: true }),
      assistGrants: vi.fn().mockResolvedValue({
        grants: [{
          projectId: "p1",
          projectName: "Memmy 内测反馈",
          grantee: REQUESTER,
          agent: "claude_code",
          active: true,
          minutes: 60,
          expiresAt: new Date(Date.now() + 42 * 60_000).toISOString(),
          createdAt: null,
          revokedAt: null
        }],
        dailyLimit: 20
      }),
      assistAgents: vi.fn().mockResolvedValue({
        agents: [{ sourceId: "claude_code", name: "Claude Code", available: true, group: "used", lastActiveAt: null }],
        defaultAgent: "claude_code"
      })
    });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistProjectSettings client={collab} projectId="p1" />
      </I18nProvider>
    ));
    await flush();

    // 整张卡片自带「协助」标题，不依赖外面的弹窗。
    expect(document.body.textContent).toContain("协助");
    expect(document.body.textContent).toContain("孙起");
    // 头像上只有首字，名字单独一行。
    expect(document.body.textContent).toContain("孙");
    expect(document.querySelector("select[aria-label='孙起的请求由哪个 Agent 执行']")).toBeTruthy();
    const revoke = button("结束授权")!;
    expect(revoke.tagName).toBe("BUTTON");
    expect(revoke.className).toContain("settingsDangerButton");
  });

  it("读取协助设置失败时，错误贴在卡片内那一行下面", async () => {
    const collab = client({
      assistReceiving: vi.fn().mockRejectedValue(new Error("boom")),
      assistGrants: vi.fn().mockResolvedValue({ grants: [], dailyLimit: 20 }),
      assistAgents: vi.fn().mockResolvedValue({ agents: [], defaultAgent: "memmy" })
    });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistProjectSettings client={collab} projectId="p1" />
      </I18nProvider>
    ));
    await flush();

    const alert = document.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("读取成员协助的设置没有完成");
    expect(alert?.className).toContain("settingsCardError");
  });

  it("没有限时授权时只写「暂无」，不列任何授权行", async () => {
    const collab = client({
      assistReceiving: vi.fn().mockResolvedValue({ projectId: "p1", enabled: true }),
      assistGrants: vi.fn().mockResolvedValue({ grants: [], dailyLimit: 20 }),
      assistAgents: vi.fn().mockResolvedValue({ agents: [], defaultAgent: "memmy" })
    });
    await act(async () => root.render(
      <I18nProvider language="zh-CN">
        <CollabAssistProjectSettings client={collab} projectId="p1" />
      </I18nProvider>
    ));
    await flush();

    expect(document.body.textContent).toContain("限时授权");
    expect(document.body.textContent).toContain("暂无");
    expect(button("结束授权")).toBeUndefined();
    expect(document.body.textContent).not.toContain("暂无限时授权。");
    // 无授权时行内只给说明，右侧没有控件。
    expect(document.querySelector("select")).toBeNull();
  });
});
