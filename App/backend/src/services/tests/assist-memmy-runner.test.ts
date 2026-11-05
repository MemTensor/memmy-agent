import { describe, expect, it } from "vitest";
import type { AssistRunSnapshot, AssistRunStartInput } from "../../adapters/outbound/memmy-agent-admin-client/index.js";
import { AcpError, type AssistStep } from "../assist/acp-client.js";
import { createMemmyAssistRunner, failureText } from "../assist/memmy-runner.js";
import { toAssistRequest } from "../collab-assist-service.js";

const REQUEST = toAssistRequest({
  id: "req-1",
  projectId: "cloud-p1",
  projectName: "Memmy 内测反馈",
  threadId: "thread-1",
  attempt: 1,
  via: "Claude Code",
  title: "收集版本信息",
  items: ["查看系统版本"],
  status: "running",
  agent: "memmy",
  requester: { userId: "2102247370314383361", name: "孙起", mine: false },
  executor: { userId: "2117953314485960706", name: "孙落", mine: true }
});

function snapshot(overrides: Partial<AssistRunSnapshot> = {}): AssistRunSnapshot {
  return { chatId: "chat-1", status: "running", steps: [], reply: "", error: null, ...overrides };
}

function fakeClient(sequence: Array<AssistRunSnapshot | null>, start: AssistRunSnapshot = snapshot({ status: "starting" })) {
  const started: AssistRunStartInput[] = [];
  const stopped: string[] = [];
  let index = 0;
  return {
    started,
    stopped,
    client: {
      async startAssistRun(input: AssistRunStartInput) {
        started.push(input);
        return start;
      },
      async readAssistRun() {
        const next = sequence[Math.min(index, sequence.length - 1)]!;
        index += 1;
        return next;
      },
      async stopAssistRun(chatId: string) {
        stopped.push(chatId);
        return snapshot({ status: "stopped" });
      }
    }
  };
}

function run(runner: ReturnType<typeof createMemmyAssistRunner>, options: { sessionId?: string; signal?: AbortSignal } = {}) {
  const steps: AssistStep[][] = [];
  const sessions: string[] = [];
  const result = runner.run({
    agent: "memmy",
    cwd: "/tmp",
    prompt: "孙起正在排查一个问题",
    request: REQUEST,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    signal: options.signal ?? new AbortController().signal,
    onStep: () => undefined,
    onSteps: (next) => steps.push(next),
    onSession: (id) => sessions.push(id)
  });
  return { result, steps, sessions };
}

describe("createMemmyAssistRunner", () => {
  it("starts a task in the local project, follows its steps and returns the answer", async () => {
    const { client, started } = fakeClient([
      snapshot({ steps: [{ text: "运行命令 sw_vers", status: "running" }] }),
      snapshot({ steps: [{ text: "运行命令 sw_vers", output: "15.6", status: "done" }] }),
      snapshot({ status: "done", steps: [{ text: "运行命令 sw_vers", output: "15.6", status: "done" }], reply: "macOS 15.6" })
    ]);
    const runner = createMemmyAssistRunner({ client, localProjectId: async (id) => (id === "cloud-p1" ? "local-p1" : null), pollIntervalMs: 1 });

    const { result, steps, sessions } = run(runner, { sessionId: "chat-0" });
    await expect(result).resolves.toEqual({ reply: "macOS 15.6", steps: [{ text: "运行命令 sw_vers", output: "15.6" }], transcript: [], sessionId: "chat-1" });

    expect(started[0]).toMatchObject({
      projectId: "local-p1",
      chatId: "chat-0",
      title: "收集版本信息",
      content: "孙起正在排查一个问题",
      assist: { requestId: "req-1", threadId: "thread-1", cloudProjectId: "cloud-p1", requesterName: "孙起", via: "Claude Code", attempt: 1 }
    });
    expect(sessions).toEqual(["chat-1"]);
    // 同一份步骤没变化时不重复推送。
    expect(steps).toEqual([
      [],
      [{ text: "运行命令 sw_vers" }],
      [{ text: "运行命令 sw_vers", output: "15.6" }]
    ]);
  });

  it("reports a stop made inside the task as cancelled, and stops the task when asked to", async () => {
    const insideTask = createMemmyAssistRunner({
      client: fakeClient([snapshot({ status: "stopped" })]).client,
      localProjectId: async () => "local-p1",
      pollIntervalMs: 1
    });
    await expect(run(insideTask).result).rejects.toMatchObject({ kind: "cancelled", message: "执行方在任务里停止了这次执行" });

    const fake = fakeClient([snapshot(), snapshot({ status: "stopped" })]);
    const controller = new AbortController();
    const asked = createMemmyAssistRunner({ client: fake.client, localProjectId: async () => "local-p1", pollIntervalMs: 5 });
    const pending = run(asked, { signal: controller.signal }).result;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled", message: "已停止当前执行" });
    expect(fake.stopped).toEqual(["chat-1"]);
  });

  it("fails clearly when the runtime forgot the run or rejected it at once", async () => {
    const forgot = createMemmyAssistRunner({ client: fakeClient([null]).client, localProjectId: async () => null, pollIntervalMs: 1 });
    await expect(run(forgot).result).rejects.toThrow("Memmy 在执行中重新启动了，这次没有完成");

    const rejected = createMemmyAssistRunner({
      client: fakeClient([], snapshot({ status: "failed", error: "project_not_found" })).client,
      localProjectId: async () => "local-p1",
      pollIntervalMs: 1
    });
    await expect(run(rejected).result).rejects.toThrow("执行方的电脑上找不到这个项目");
  });

  it("says Memmy needs updating when the runtime has no assist entry", async () => {
    const runner = createMemmyAssistRunner({ client: {}, localProjectId: async () => null });
    const error = await run(runner).result.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AcpError);
    expect((error as AcpError).kind).toBe("unavailable");
  });

  it("turns runtime reasons into sentences both sides can read", () => {
    expect(failureText("model_selection_unavailable")).toBe("执行方的 Memmy 没有可用的模型");
    expect(failureText("quota_exhausted")).toBe("执行方的 Memmy 模型额度已用完");
    expect(failureText("something_else")).toBe("Memmy 执行失败：something_else");
  });
});
