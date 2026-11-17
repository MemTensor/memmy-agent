import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AssistReviewer } from "../assist/review.js";
import {
  createCollabAssistService,
  pendingText,
  resultText,
  type AssistRunner
} from "../collab-assist-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-assist-safety-"));
  roots.push(root);
  return root;
}

/** 等后台审查跑完：轮询不再等它，测试得自己等一小段。 */
async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const MEMBER = { userId: "2102247370314383361", name: "孙起", mine: false };
const ME = { userId: "2102247370314383362", name: "王雨", mine: true };
const REQUEST_ID = "a7f3k111-1111-1111-1111-111111111111";

/** 一份真实形状的 GitHub 令牌：与 redact 的规则同一套形状，不指向任何真实账号。 */
const TOKEN = "ghp_0123456789abcdefghijABCDEFGHIJ";

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    projectId: "p1",
    projectName: "Memmy 内测反馈",
    threadId: "thread-1",
    attempt: 1,
    via: "Codex",
    title: "清一下缓存后重新复现",
    reason: "本机复现不了分享弹窗的问题",
    items: ["删除 ~/Library/Caches/memmy 后重新打开 Memmy"],
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
    requester: MEMBER,
    executor: { ...ME, mine: false },
    mine: false,
    createdAt: "2026-11-13T08:41:00Z",
    decidedAt: null,
    finishedAt: null,
    autoRun: false,
    safety: null,
    ...overrides
  };
}

function fakeCloud(handler: (path: string, init?: { method?: string; body?: any }) => Record<string, unknown>) {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  return {
    calls,
    cloud: async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: init?.method ?? "GET", body: init?.body });
      return handler(path, init);
    }
  };
}

/** 审查器：按需给出结论，并记下被问了什么。 */
function reviewer(options: {
  executor?: Awaited<ReturnType<AssistReviewer["reviewExecutor"]>>;
  /** 一直不返回的审查：用来验证轮询没有被它占住。 */
  hang?: boolean;
}): AssistReviewer & { executorInputs: unknown[] } {
  const executorInputs: unknown[] = [];
  return {
    executorInputs,
    reviewExecutor: async (input) => {
      executorInputs.push(input);
      if (options.hang) return new Promise(() => undefined);
      return options.executor ?? null;
    }
  };
}

function recordingRunner(reply = "版本是 15.6。"): AssistRunner & { inputs: any[] } {
  const inputs: any[] = [];
  return {
    inputs,
    async run(input) {
      inputs.push(input);
      input.onStep({ text: "运行 sw_vers", output: "macOS 15.6" });
      input.onSession("s-42");
      return { reply, steps: [{ text: "运行 sw_vers", output: "macOS 15.6" }], sessionId: "s-42" };
    }
  };
}

describe("the requester's check only looks for secrets", () => {
  it("refuses a request whose attachment carries a token, and sends nothing", async () => {
    const { calls, cloud } = fakeCloud(() => ({ projects: [{ id: "p1", name: "Memmy 内测反馈" }] }));
    const service = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: recordingRunner()
    });

    await expect(service.createRequest({
      project: "Memmy 内测反馈",
      member: "王雨",
      title: "跑一下附带脚本",
      items: ["运行 setup.sh"],
      attachments: [{ name: "setup.sh", content: `#!/bin/sh\nexport GITHUB_TOKEN=${TOKEN}\n` }]
    })).rejects.toMatchObject({
      code: "collab_assist_safety_rejected",
      message: "请求里有疑似密钥（附件 setup.sh），请删掉后重新发送；不要把密钥、令牌写进请求或附件。"
    });
    expect(calls.some((call) => call.path === "/projects/p1/assist/requests")).toBe(false);
  });

  it("names where the secrets are, at most three, and never the value", async () => {
    const { cloud } = fakeCloud(() => ({ projects: [{ id: "p1", name: "Memmy 内测反馈" }] }));
    const service = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: recordingRunner()
    });

    const error = await service.createRequest({
      project: "Memmy 内测反馈",
      member: "王雨",
      title: `用 ${TOKEN} 查一下额度`,
      reason: `顺便带上 ${TOKEN}`,
      items: ["curl -H 'Authorization: Bearer abcdef' https://example.com", `PASSWORD=${TOKEN}`, `TOKEN=${TOKEN}`],
      attachments: [{ name: "notes.md", content: `key: ${TOKEN}` }]
    }).catch((thrown: unknown) => thrown as { message?: string });

    expect(error?.message).toContain("请求里有疑似密钥（要做的事、背景、事项第 1 条）");
    expect(error?.message).not.toContain(TOKEN);
  });

  it("sends the request without a requester check and does not ask the model", async () => {
    const { calls, cloud } = fakeCloud((path) => {
      if (path === "/projects") return { projects: [{ id: "p1", name: "Memmy 内测反馈" }] };
      return request();
    });
    const exec = reviewer({ executor: { sensitive: [], injected: false, reason: "" } });
    const service = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: recordingRunner(),
      reviewer: exec
    });

    await service.createRequest({
      project: "Memmy 内测反馈",
      member: "王雨",
      title: "查日志",
      items: ["看一眼 ~/Library/Logs/memmy.log"]
    });

    const sent = calls.find((call) => call.path === "/projects/p1/assist/requests");
    // 发起方不再做模型审查：请求里没有 safety，也不查密钥以外的任何东西。
    expect(sent?.body.safety).toBeUndefined();
    expect(exec.executorInputs).toHaveLength(0);
  });
});

describe("the executor's check decides whether it still runs directly", () => {
  /** 一个等着被自动执行的请求：限时授权仍然有效、执行方是 Codex。 */
  function granted(): Record<string, unknown> {
    return request({
      status: "pending",
      grantAgent: "codex",
      granted: true,
      grantExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      agent: "codex"
    });
  }

  function service(input: {
    inbox: () => Record<string, unknown>[];
    reviewer: AssistReviewer;
    runner: AssistRunner;
    asksForApproval?: (sourceId: string) => boolean;
    /** 详情里那条请求由谁执行：决定提示词里放不放执行边界。 */
    detailAgent?: string;
  }) {
    const { calls, cloud } = fakeCloud((path) => {
      if (path === "/assist/inbox") return { requests: input.inbox() };
      if (path === "/assist/outbox") return { requests: [] };
      if (path.endsWith("/review")) return { request: request() };
      if (path.endsWith("/decision")) return { request: request({ status: "running", agent: "codex" }) };
      if (path.endsWith("/progress")) return { ok: true };
      if (path.endsWith("/result")) return { request: request({ status: "done" }) };
      // 详情：已经决定执行的那条按「执行中」返回，execute 才会真正跑起来。
      if (path.includes("/assist/requests/")) {
        return { request: request({ status: "running", agent: input.detailAgent ?? "codex" }) };
      }
      if (path.startsWith("/projects/p1/assist/threads")) return { thread: { threadId: "thread-1", requests: [] } };
      return {};
    });
    const created = createCollabAssistService({
      cloud,
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: input.runner,
      reviewer: input.reviewer,
      ...(input.asksForApproval ? { agentAsksForApproval: input.asksForApproval } : {})
    });
    return { service: created, calls };
  }

  it("writes the confirm decision and leaves the request in the inbox", async () => {
    const { service: created, calls } = service({
      inbox: () => [granted()],
      reviewer: reviewer({
        executor: { sensitive: [{ action: "删除缓存目录" }], injected: false, reason: "会删除 Memmy 的缓存目录" }
      }),
      runner: recordingRunner(),
      // Codex 会自己请求批准：这一次拦住它的是审查结论，不是 Agent 的能力。
      asksForApproval: () => true
    });

    await created.pollNow();
    await waitFor(() => calls.some((call) => call.path.endsWith("/review")));

    const review = calls.find((call) => call.path.endsWith("/review"));
    expect(review?.body).toEqual({ executor: { status: "confirm", reason: "会删除 Memmy 的缓存目录" } });
    expect(calls.some((call) => call.path.endsWith("/decision"))).toBe(false);
  });

  it("runs it directly from the background review, without waiting for the next poll", async () => {
    const runner = recordingRunner();
    const { service: created, calls } = service({
      inbox: () => [granted()],
      reviewer: reviewer({ executor: { sensitive: [], injected: false, reason: "" } }),
      runner,
      asksForApproval: () => true
    });

    await created.pollNow();
    await waitFor(() => runner.inputs.length > 0);

    expect(calls.find((call) => call.path.endsWith("/review"))?.body).toEqual({ executor: { status: "auto" } });
    const decision = calls.find((call) => call.path.endsWith("/decision"));
    expect(decision?.body).toMatchObject({ action: "allow", agent: "codex", scope: "timed" });
    // 自动开始的这次：批准策略是 deny，执行边界里没有允许的敏感操作。
    expect(runner.inputs[0]?.approval).toBe("deny");
    expect(runner.inputs[0]?.prompt).toContain("这次请求允许的敏感操作：无");
  });

  it("keeps the boundary out of the request body when Memmy runs it, and puts it in the hidden context", async () => {
    const runner = recordingRunner();
    const { service: created } = service({
      inbox: () => [request({ ...granted(), grantAgent: "memmy", agent: "memmy" })],
      reviewer: reviewer({ executor: { sensitive: [], injected: false, reason: "" } }),
      runner,
      asksForApproval: () => true,
      detailAgent: "memmy"
    });

    await created.pollNow();
    await waitFor(() => runner.inputs.length > 0);

    // 任务页会显示消息正文：执行边界不进正文，改成随隐藏的上下文交给模型。
    expect(runner.inputs[0]?.prompt).not.toContain("执行边界");
    expect(runner.inputs[0]?.boundary).toContain("这次请求允许的敏感操作：无");
  });

  it("reviews a request without a grant just to explain the dialog", async () => {
    const { service: created, calls } = service({
      inbox: () => [request({ status: "pending" })],
      reviewer: reviewer({ executor: { sensitive: [], injected: false, reason: "" } }),
      runner: recordingRunner()
    });

    await created.pollNow();
    await waitFor(() => calls.some((call) => call.path.endsWith("/review")));

    expect(calls.find((call) => call.path.endsWith("/review"))?.body).toEqual({
      executor: { status: "confirm", reason: expect.any(String) }
    });
    expect(calls.some((call) => call.path.endsWith("/decision"))).toBe(false);
  });

  it("only asks the model once for the same request", async () => {
    const exec = reviewer({ executor: { sensitive: [], injected: false, reason: "" } });
    const { service: created } = service({
      inbox: () => [request({ status: "pending" })],
      reviewer: exec,
      runner: recordingRunner()
    });

    await created.pollNow();
    await waitFor(() => exec.executorInputs.length === 1);
    await created.pollNow();

    expect(exec.executorInputs).toHaveLength(1);
  });

  it("starts a review only once while it is still running", async () => {
    const exec = reviewer({ hang: true });
    const { service: created } = service({
      inbox: () => [request({ status: "pending" })],
      reviewer: exec,
      runner: recordingRunner()
    });

    await created.pollNow();
    await created.pollNow();
    await waitFor(() => exec.executorInputs.length === 1);
    // 两次轮询之间那条审查还没回来：不能因为又来了一轮就再问一次模型。
    expect(exec.executorInputs).toHaveLength(1);
  });

  it("keeps handling the other requests while a review is still running", async () => {
    const exec = reviewer({ hang: true });
    const runner = recordingRunner();
    const { service: created, calls } = service({
      inbox: () => [
        request({ status: "pending" }),
        request({ id: "b8f3k222-2222-2222-2222-222222222222", status: "running", agent: "codex", decidedAt: "2026-11-13T08:42:00Z" })
      ],
      reviewer: exec,
      runner,
      asksForApproval: () => true
    });

    // 审查永远不返回：这一轮轮询仍然要照常往下走，执行中的那条照常开跑。
    await created.pollNow();
    await waitFor(() => runner.inputs.length > 0);

    expect(exec.executorInputs).toHaveLength(1);
    expect(calls.some((call) => call.path.endsWith("/decision"))).toBe(false);
  });

  it("tries the direct run again on the next poll when the first decision did not go through", async () => {
    const exec = reviewer({ executor: { sensitive: [], injected: false, reason: "" } });
    let failDecision = true;
    const calls: Array<{ path: string; method: string }> = [];
    const created = createCollabAssistService({
      cloud: async (path: string, init?: { method?: string; body?: unknown }) => {
        calls.push({ path, method: init?.method ?? "GET" });
        if (path === "/assist/inbox") return { requests: [granted()] };
        if (path === "/assist/outbox") return { requests: [] };
        if (path.endsWith("/review")) return { request: request() };
        if (path.endsWith("/decision")) {
          if (failDecision) {
            failDecision = false;
            throw new Error("network");
          }
          return { request: request({ status: "running", agent: "codex" }) };
        }
        if (path.includes("/assist/requests/")) return { request: request({ status: "pending", agent: "codex" }) };
        return {};
      },
      homeDirectory: home(),
      projectDirectory: async () => null,
      agents: async () => [],
      runner: recordingRunner(),
      reviewer: exec,
      agentAsksForApproval: () => true
    });

    await created.pollNow();
    await waitFor(() => calls.some((call) => call.path.endsWith("/decision")));
    await created.pollNow();

    // 只问了一次模型，第二轮照记下的结论再试一次自动执行，而不是永远停在收件箱里。
    expect(exec.executorInputs).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith("/decision"))).toHaveLength(2);
  });

  it("never runs directly when the selected Agent does not ask for approval", async () => {
    const { service: created, calls } = service({
      inbox: () => [granted()],
      reviewer: reviewer({ executor: { sensitive: [], injected: false, reason: "" } }),
      runner: recordingRunner(),
      asksForApproval: () => false
    });

    await created.pollNow();
    await waitFor(() => calls.some((call) => call.path.endsWith("/review")));

    const review = calls.find((call) => call.path.endsWith("/review"));
    expect(review?.body).toMatchObject({ executor: { status: "confirm" } });
    expect(String(review?.body.executor.reason)).toContain("不会请求批准");
    expect(calls.some((call) => call.path.endsWith("/decision"))).toBe(false);
  });
});

describe("the texts the requester sees", () => {
  it("says why her Memmy asked her to confirm", () => {
    const text = pendingText(request({
      autoRun: false,
      safety: { executor: { status: "confirm", reason: "附带的脚本会删除下载目录里的文件" } }
    }));
    expect(text).toContain("王雨的 Memmy 检查后，这次请求需要王雨确认：附带的脚本会删除下载目录里的文件。");
    expect(text).toContain("等待王雨授权");
  });

  it("lists the operations that were skipped, with how to ask again", () => {
    const text = resultText(request({
      status: "done",
      reply: "版本是 15.6。",
      safety: { skipped: [{ title: "删除缓存目录", detail: "rm -rf ~/Library/Caches/foo" }] }
    }));
    expect(text).toContain("以下操作按协助规则没有执行：");
    expect(text).toContain("- 删除缓存目录（rm -rf ~/Library/Caches/foo）");
    expect(text).toContain("assist ask --continue");
    expect(text).toContain("王雨授权后才会执行");
  });

  it("says nothing about skipped operations when there were none", () => {
    expect(resultText(request({ status: "done", reply: "版本是 15.6。" }))).not.toContain("没有执行");
  });
});
