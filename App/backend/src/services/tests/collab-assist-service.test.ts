import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCollabAssistService, resultText, shortId, toAssistRequest, type AssistRunner } from "../collab-assist-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-assist-"));
  roots.push(root);
  return root;
}

const MEMBER = { userId: "2102247370314383361", name: "孙起", mine: false };
const ME = { userId: "2102247370314383362", name: "王雨", mine: true };

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: "a7f3k111-1111-1111-1111-111111111111",
    projectId: "p1",
    projectName: "Memmy 内测反馈",
    threadId: "thread-1",
    attempt: 1,
    via: "Codex",
    title: "收集 Cursor 任务读取相关的信息",
    reason: "关联任务弹窗里看不到 Cursor 的任务",
    items: ["查看 Memmy、Cursor 与系统的版本"],
    status: "running",
    agent: "claude_code",
    scope: "once",
    steps: [],
    reply: "",
    resultItems: [],
    files: [],
    failure: null,
    requester: MEMBER,
    executor: ME,
    mine: false,
    createdAt: "2026-11-04T08:41:00Z",
    decidedAt: null,
    finishedAt: null,
    ...overrides
  };
}

/** 记下云端收到的每一次调用，并按路径回一份固定的数据。 */
function fakeCloud(handler: (path: string, init?: { method?: string; body?: unknown }) => Record<string, unknown>) {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  return {
    calls,
    cloud: async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body });
      return handler(path, init);
    }
  };
}

function runner(reply = "版本是 15.6。\n\n结果：\n- 版本：macOS 15.6"): AssistRunner {
  return {
    async run(input) {
      input.onStep({ text: "运行 sw_vers", output: "macOS 15.6" });
      input.onSession("s-42");
      return { reply, steps: [{ text: "运行 sw_vers", output: "macOS 15.6" }], sessionId: "s-42" };
    }
  };
}

describe("createCollabAssistService", () => {
  it("sends what to do, who asks and which agent asked", async () => {
    const { calls, cloud } = fakeCloud((path) => {
      if (path === "/projects") return { projects: [{ id: "p1", name: "Memmy 内测反馈" }] };
      // 创建接口的响应是平铺的一条请求：与云端 update 之后的视图一致。
      return request({ status: "pending", agent: null, scope: null });
    });
    const service = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: runner()
    });

    const created = await service.createRequest({
      project: "Memmy 内测反馈",
      member: "王雨",
      title: "收集 Cursor 任务读取相关的信息",
      reason: "关联任务弹窗里看不到 Cursor 的任务",
      items: ["查看 Memmy、Cursor 与系统的版本"],
      via: "Codex"
    });

    const sent = calls.find((call) => call.path === "/projects/p1/assist/requests");
    expect(sent?.method).toBe("POST");
    expect(sent?.body).toMatchObject({
      member: "王雨",
      title: "收集 Cursor 任务读取相关的信息",
      reason: "关联任务弹窗里看不到 Cursor 的任务",
      items: ["查看 Memmy、Cursor 与系统的版本"],
      via: "Codex"
    });
    // 命令行拿到的请求标识是短的：够区分，也不必让人抄一整串 uuid。
    expect(created.text).toContain(shortId(created.request.id));
    expect(created.threadId).toBe("thread-1");
  });

  it("runs a request that already has a standing permission, then reports the result", async () => {
    const { calls, cloud } = fakeCloud((path) => {
      if (path === "/assist/inbox") {
        return {
          requests: [{ ...request({ status: "pending", scope: null }), granted: true, grantAgent: "claude_code", usedToday: 2 }],
          dailyLimit: 20
        };
      }
      return { request: request() };
    });
    const service = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => "/tmp",
      agents: async () => [{ sourceId: "claude_code", name: "Claude Code", available: true }],
      runner: runner()
    });

    await service.pollNow();
    // 执行是后台跑的：等它把结果写回去。
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 长期授权在：不必再问她，直接按她当时选定的 Agent 执行。
    const decision = calls.find((call) => call.path.endsWith("/decision"));
    expect(decision?.body).toMatchObject({ action: "allow", agent: "claude_code", scope: "always" });
    const reported = calls.find((call) => call.path.endsWith("/result"));
    expect(reported?.body).toMatchObject({ status: "DONE" });
    expect(reported?.body).toHaveProperty("reply", "版本是 15.6。");
    expect(reported?.body).toHaveProperty("items", [{ key: "版本", value: "macOS 15.6" }]);
  });

  it("gives the requester the items and the executor's name", async () => {
    const relative = toAssistRequest(request({
      status: "done",
      reply: "版本：Memmy 1.2.6",
      resultItems: [{ key: "版本", value: "Memmy 1.2.6" }],
      files: [{ name: "backend-cursor.log", size: "200 行" }]
    }));
    const text = resultText(relative);

    expect(text).toContain("已完成：由王雨的 Claude Code 执行。");
    expect(text).toContain("版本：Memmy 1.2.6");
    expect(text).toContain("文件：backend-cursor.log（200 行）");
  });

  it("stops polling when she turns receiving off", async () => {
    const { calls, cloud } = fakeCloud(() => ({ requests: [], dailyLimit: 20 }));
    const service = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: runner()
    });

    await service.setAllowAssist(false);
    await service.pollNow();

    expect(calls.some((call) => call.path === "/assist/inbox")).toBe(false);
    expect(service.settings().allowAssist).toBe(false);
  });

  it("refuses to work in API Key mode, where there is no account to share through", async () => {
    const service = createCollabAssistService({
      cloud: async () => ({}),
      userMode: () => "byok",
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: runner()
    });

    await expect(service.inbox()).rejects.toThrow(/登录 Memmy 账号/u);
  });
});