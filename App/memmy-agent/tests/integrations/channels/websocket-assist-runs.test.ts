import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { OutboundMessage } from "../../../src/core/runtime-messages/events.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";
import { ProjectStore } from "../../../src/entrypoints/frontend-bridge/projects.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";
import { AssistRunRecorder, TRANSCRIPT_PART_BYTES, describeToolEvent } from "../../../src/integrations/channels/webui-assist-run.js";
import { SystemPromptBuildContext } from "../../../src/core/agent-runtime/hook.js";
import { createAssistRequestHook } from "../../../src/assist-request/index.js";

const tmpDirs: string[] = [];
const localConnection = { remoteAddress: "127.0.0.1" };

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-assist-run-"));
  tmpDirs.push(root);
  return root;
}

function responseJson(response: { body: Buffer | string } | null): Record<string, any> {
  if (!response) throw new Error("no response");
  return JSON.parse(Buffer.isBuffer(response.body) ? response.body.toString("utf8") : String(response.body));
}

function setup() {
  const root = tmpRoot();
  const workspace = path.join(root, "project");
  fs.mkdirSync(workspace, { recursive: true });
  const sessions = new SessionManager(path.join(root, "sessions"));
  const projectStore = new ProjectStore({ filePath: path.join(root, "projects.json") });
  const project = projectStore.add(workspace, "existing", "Memmy 内测反馈");
  const bus = new MessageBus();
  const channel = new WebSocketChannel(
    { enabled: true, allowFrom: ["*"], host: "127.0.0.1", port: 0, path: "/", websocketRequiresToken: false },
    bus,
    { sessionManager: sessions, projectStore, workspacePath: root, standaloneTaskRoot: path.join(root, "tasks") },
  );
  channel.apiTokens.set("admin-token", Date.now() / 1000 + 60);
  const headers = { Authorization: "Bearer admin-token", "Content-Type": "application/json" };
  const request = (method: string, url: string, body?: unknown) => channel.dispatchHttp(localConnection, {
    method,
    path: url,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { root, workspace, sessions, project, bus, channel, request };
}

describe("AssistRunRecorder", () => {
  it("ignores events before its own message is accepted, then records steps and the reply", () => {
    const recorder = new AssistRunRecorder({ chatId: "c1", clientRequestId: "r1" });
    // 订阅时推过来的旧内容不算这一轮的。
    recorder.consume({ event: "message", text: "上一轮的回答" });
    recorder.consume({ event: "turn_end" });
    expect(recorder.status).toBe("starting");

    recorder.consume({ event: "message_accepted", client_request_id: "r1" });
    recorder.consume({ event: "run_status", status: "running", turn_id: "t1" });
    recorder.consume({
      event: "message",
      kind: "progress",
      turn_id: "t1",
      tool_events: [{ phase: "start", ui_tool_call_id: "u1", name: "exec", arguments: { command: "sw_vers" } }],
    });
    expect(recorder.snapshot().steps).toEqual([{ text: "运行命令 sw_vers", status: "running" }]);

    recorder.consume({
      event: "message",
      kind: "progress",
      turn_id: "t1",
      tool_events: [{ phase: "end", ui_tool_call_id: "u1", name: "exec", arguments: { command: "sw_vers" }, result: "ProductVersion:\t15.6\n" }],
    });
    recorder.consume({ event: "message", turn_id: "t1", text: "macOS 15.6。\n\n结果：\n- 系统：macOS 15.6" });
    recorder.consume({ event: "turn_end", turn_id: "t1" });

    const snapshot = recorder.snapshot();
    expect(snapshot.status).toBe("done");
    expect(snapshot.steps).toEqual([{ text: "运行命令 sw_vers", output: "ProductVersion: 15.6", status: "done" }]);
    expect(snapshot.reply).toContain("结果：");
    expect(snapshot.finished_at).not.toBeNull();
  });

  it("fails when dispatch is rejected and when the model errors without an answer", () => {
    const rejected = new AssistRunRecorder({ chatId: "c1", clientRequestId: "r1" });
    rejected.consume({ event: "error", detail: "session_binding_rejected", reason: "project_removed" });
    expect(rejected.snapshot()).toMatchObject({ status: "failed", error: "project_removed" });

    const failed = new AssistRunRecorder({ chatId: "c1", clientRequestId: "r1" });
    failed.consume({ event: "message_accepted", client_request_id: "r1" });
    failed.consume({ event: "message", text: "", model_error: { category: "quota_exhausted" } });
    failed.consume({ event: "turn_end" });
    expect(failed.snapshot()).toMatchObject({ status: "failed", error: "quota_exhausted" });
  });

  it("settles running steps when the turn is stopped", () => {
    const recorder = new AssistRunRecorder({ chatId: "c1", clientRequestId: "r1" });
    recorder.consume({ event: "message_accepted", client_request_id: "r1" });
    recorder.consume({ event: "message", kind: "progress", tool_events: [{ phase: "start", call_id: "a", name: "read_file", arguments: { path: "/tmp/a.log" } }] });
    recorder.consume({ event: "stop_result", stopped: 1 });
    expect(recorder.snapshot()).toMatchObject({ status: "stopped", steps: [{ text: "读取 /tmp/a.log", status: "failed" }] });
  });

  it("keeps the full transcript: explanations in order and multi-line tool output", () => {
    const recorder = new AssistRunRecorder({ chatId: "c1", clientRequestId: "r1" });
    recorder.consume({ event: "message_accepted", client_request_id: "r1" });
    recorder.consume({ event: "run_status", status: "running", turn_id: "t1" });
    recorder.consume({ event: "stream_end", turn_id: "t1", text: "先看一下系统版本。" });
    recorder.consume({ event: "message", kind: "tool_hint", turn_id: "t1", text: "sw_vers", tool_events: [{ phase: "start", ui_tool_call_id: "u1", name: "exec", arguments: { command: "sw_vers" } }] });
    recorder.consume({ event: "message", kind: "progress", turn_id: "t1", tool_events: [{ phase: "end", ui_tool_call_id: "u1", name: "exec", result: "ProductName:\tmacOS\nProductVersion:\t15.6\n" }] });
    recorder.consume({ event: "stream_end", turn_id: "t1", text: "macOS 15.6。" });
    // 同一段回答经由 message 再送一次：不重复记。
    recorder.consume({ event: "message", turn_id: "t1", text: "macOS 15.6。" });
    recorder.consume({ event: "turn_end", turn_id: "t1" });

    expect(recorder.snapshot().transcript).toEqual([
      { kind: "text", text: "先看一下系统版本。" },
      { kind: "tool", name: "运行命令 sw_vers", input: "sw_vers", output: "ProductName:\tmacOS\nProductVersion:\t15.6\n", status: "done" },
      { kind: "text", text: "macOS 15.6。" }
    ]);
    // 摘要照旧只留一行。
    expect(recorder.snapshot().steps[0]).toMatchObject({ output: "ProductName: macOS ProductVersion: 15.6" });
  });

  it("cuts a long tool output at 16KB and says so", () => {
    const recorder = new AssistRunRecorder({ chatId: "c1", clientRequestId: "r1" });
    recorder.consume({ event: "message_accepted", client_request_id: "r1" });
    recorder.consume({ event: "message", kind: "progress", tool_events: [{ phase: "start", call_id: "a", name: "exec", arguments: { command: "cat big.log" } }] });
    recorder.consume({ event: "message", kind: "progress", tool_events: [{ phase: "end", call_id: "a", name: "exec", result: "行\n".repeat(20_000) }] });
    const tool = recorder.snapshot().transcript[0] as { output: string; truncated?: boolean };
    expect(new TextEncoder().encode(tool.output).length).toBeLessThanOrEqual(TRANSCRIPT_PART_BYTES);
    expect(tool.output.endsWith("（已截断）")).toBe(true);
    expect(tool.truncated).toBe(true);
  });

  it("describes tool calls in plain words", () => {
    expect(describeToolEvent({ name: "list_dir", arguments: '{"path":"~/.memmy"}' })).toBe("查看目录 ~/.memmy");
    expect(describeToolEvent({ name: "web_fetch", arguments: { url: "https://example.com" } })).toBe("打开 https://example.com");
    expect(describeToolEvent({ name: "custom_tool", arguments: {} })).toBe("custom_tool");
    expect(describeToolEvent({ name: "exec", display_text: "运行 python3 hello.py" })).toBe("运行 python3 hello.py");
  });
});

describe("WebUI assist runs", () => {
  it("creates a titled project task, dispatches the request like the WebUI and reports the turn", async () => {
    const { workspace, sessions, project, bus, channel, request } = setup();

    const started = await request("POST", "/api/webui/assist/runs", {
      project_id: project.id,
      title: "收集 Memmy 与系统的版本信息",
      content: "孙起正在排查一个问题，需要这台电脑上的信息。",
      assist: { requestId: "req-1", threadId: "th-1", requesterName: "孙起", via: "Claude Code", attempt: 1, ignored: "x" },
    });
    expect(started?.status).toBe(202);
    const run = responseJson(started);
    expect(run.status).toBe("starting");
    const chatId = run.chat_id as string;

    // 任务已经在项目下，标题用请求标题，模型不会另起。
    const session = sessions.get(`websocket:${chatId}`)!;
    expect(session.metadata).toMatchObject({
      webui: true,
      webuiProjectId: project.id,
      webuiWorkspaceCwd: fs.realpathSync(workspace),
      title: "收集 Memmy 与系统的版本信息",
      titleUserEdited: true,
      assistRequest: { requestId: "req-1", threadId: "th-1", requesterName: "孙起", via: "Claude Code", attempt: 1 },
    });
    expect(session.metadata.assistRequest).not.toHaveProperty("ignored");

    // 派发出去的就是一条普通的 WebUI 消息。
    const inbound = await bus.consumeInbound();
    expect(inbound.chatId).toBe(chatId);
    expect(inbound.content).toBe("孙起正在排查一个问题，需要这台电脑上的信息。");
    expect(inbound.metadata).toMatchObject({ webui: true });
    const clientRequestId = inbound.metadata.client_request_id as string;
    expect(clientRequestId).toMatch(/^[0-9a-f-]{36}$/u);

    // 运行时按正常顺序推事件：接受、开始、一步工具、回答、结束。
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId,
      content: "",
      metadata: { webuiMessageAccepted: true, clientRequestId, webuiRequestSessionKey: `websocket:${chatId}` },
    }));
    await channel.sendRunStatus(chatId, "running", { startedAt: Date.now() / 1000, turnId: "turn-1" });
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId,
      content: "",
      metadata: {
        agentProgress: true,
        turn_id: "turn-1",
        toolEvents: [{ phase: "end", ui_tool_call_id: "u1", name: "exec", arguments: { command: "sw_vers" }, result: "15.6" }],
      },
    }));
    const midway = responseJson(await request("GET", `/api/webui/assist/runs/${chatId}`));
    expect(midway).toMatchObject({ status: "running", steps: [{ text: "运行命令 sw_vers", output: "15.6", status: "done" }] });

    await channel.send(new OutboundMessage({ channel: "websocket", chatId, content: "系统是 macOS 15.6。", metadata: { turn_id: "turn-1" } }));
    await channel.sendTurnEnd(chatId, { turnId: "turn-1" });
    const finished = responseJson(await request("GET", `/api/webui/assist/runs/${chatId}`));
    expect(finished).toMatchObject({ status: "done", reply: "系统是 macOS 15.6。", turn_id: "turn-1" });

    // 这一轮结束后，服务端连接退订，不再占着这条任务。
    expect([...(channel.subscriptions.get(chatId) ?? [])]).toHaveLength(0);
  });

  it("continues the same task for a follow-up request and refuses while a turn is still running", async () => {
    const { sessions, project, bus, request } = setup();
    const first = responseJson(await request("POST", "/api/webui/assist/runs", {
      project_id: project.id,
      title: "第一次",
      content: "先看版本",
      assist: { requestId: "req-1", attempt: 1 },
    }));
    await bus.consumeInbound();

    const busy = await request("POST", "/api/webui/assist/runs", {
      chat_id: first.chat_id,
      content: "再看日志",
      assist: { requestId: "req-2", attempt: 2 },
    });
    expect(busy?.status).toBe(409);

    await request("POST", `/api/webui/assist/runs/${first.chat_id}/stop`);
    const next = await request("POST", "/api/webui/assist/runs", {
      chat_id: first.chat_id,
      content: "再看日志",
      assist: { requestId: "req-2", attempt: 2 },
    });
    expect(next?.status).toBe(202);
    expect(responseJson(next).chat_id).toBe(first.chat_id);
    expect((await bus.consumeInbound()).content).toBe("再看日志");
    // 标题保持第一次的，协助标记换成这一次的请求。
    const session = sessions.get(`websocket:${first.chat_id}`)!;
    expect(session.metadata.title).toBe("第一次");
    expect(session.metadata.assistRequest).toMatchObject({ requestId: "req-2", attempt: 2 });
  });

  it("stops a run that has not started and reports a missing project", async () => {
    const { project, bus, request } = setup();
    const run = responseJson(await request("POST", "/api/webui/assist/runs", {
      project_id: project.id,
      content: "看一下",
    }));
    await bus.consumeInbound();
    const stopped = responseJson(await request("POST", `/api/webui/assist/runs/${run.chat_id}/stop`));
    expect(stopped.status).toBe("stopped");

    const missing = await request("POST", "/api/webui/assist/runs", {
      project_id: "6f0b0c3e-1111-4222-8333-444455556666",
      content: "看一下",
    });
    expect(missing?.status).toBe(404);
    expect(responseJson(missing)).toEqual({ error: "project_not_found" });

    expect((await request("GET", "/api/webui/assist/runs/6f0b0c3e-1111-4222-8333-444455556666"))?.status).toBe(404);
  });

  it("keeps the result format out of the task and hands it to the model through the assist hook", async () => {
    const { sessions, project, bus, request } = setup();
    const run = responseJson(await request("POST", "/api/webui/assist/runs", {
      project_id: project.id,
      content: "<memmy_assist_request request=\"req-1\">看一下版本</memmy_assist_request>",
      assist: { requestId: "req-1", attempt: 1, context: "最后另起一段，以「结果：」开头。" },
    }));
    expect((await bus.consumeInbound()).content).not.toContain("结果：");
    const key = `websocket:${run.chat_id}`;
    expect(sessions.get(key)!.metadata.assistRequest.context).toBe("最后另起一段，以「结果：」开头。");
    // 实际注入系统提示词的那段随开始的回应返回，协助会话里与提示词分开显示。
    expect(run.prompt_context).toContain("# 成员协助");
    expect(run.prompt_context).toContain("最后另起一段，以「结果：」开头。");

    const ctx = new SystemPromptBuildContext({ sessionKey: key });
    createAssistRequestHook(() => sessions).onBuildSystemPrompt(ctx);
    expect(ctx.render()).toContain("最后另起一段，以「结果：」开头。");
    const other = new SystemPromptBuildContext({ sessionKey: "websocket:other" });
    createAssistRequestHook(() => sessions).onBuildSystemPrompt(other);
    expect(other.render()).not.toContain("成员协助");
  });

  it("delivers a result into an existing task without touching its assist mark, and never creates one", async () => {
    const { sessions, project, bus, request } = setup();
    const source = new Session({ key: "websocket:6f0b0c3e-aaaa-4222-8333-444455556666" });
    source.metadata.webui = true;
    source.metadata.webuiProjectId = project.id;
    source.metadata.webuiWorkspaceCwd = fs.realpathSync(path.dirname(sessions.sessionsDir));
    source.metadata.title = "排查分享弹窗";
    sessions.save(source);

    const delivered = await request("POST", "/api/webui/assist/runs", {
      chat_id: "6f0b0c3e-aaaa-4222-8333-444455556666",
      content: "<memmy_assist_result request=\"req-1\">结果</memmy_assist_result>",
      mode: "deliver",
    });
    expect(delivered?.status).toBe(202);
    const inbound = await bus.consumeInbound();
    expect(inbound.chatId).toBe("6f0b0c3e-aaaa-4222-8333-444455556666");
    expect(inbound.content).toContain("memmy_assist_result");
    expect(sessions.get(source.key)!.metadata.assistRequest).toBeUndefined();
    expect(sessions.get(source.key)!.metadata.title).toBe("排查分享弹窗");

    const missing = await request("POST", "/api/webui/assist/runs", {
      chat_id: "6f0b0c3e-bbbb-4222-8333-444455556666",
      content: "结果",
      mode: "deliver",
    });
    expect(missing?.status).toBe(404);
    expect(responseJson(missing)).toEqual({ error: "chat_not_found" });
  });

  it("requires the API token", async () => {
    const { channel } = setup();
    const response = await channel.dispatchHttp(localConnection, {
      method: "POST",
      path: "/api/webui/assist/runs",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(response?.status).toBe(401);
  });

  it("falls back to the last answer saved in the task when no message event carried it", async () => {
    const { sessions, project, bus, channel, request } = setup();
    const run = responseJson(await request("POST", "/api/webui/assist/runs", { project_id: project.id, content: "看一下" }));
    const inbound = await bus.consumeInbound();
    const clientRequestId = inbound.metadata.client_request_id as string;
    await channel.send(new OutboundMessage({
      channel: "websocket",
      chatId: run.chat_id,
      content: "",
      metadata: { webuiMessageAccepted: true, clientRequestId, webuiRequestSessionKey: `websocket:${run.chat_id}` },
    }));
    const session = sessions.get(`websocket:${run.chat_id}`) as Session;
    session.addMessage("user", "看一下");
    session.addMessage("assistant", "已经看过了。");
    sessions.save(session);
    await channel.sendTurnEnd(run.chat_id);
    expect(responseJson(await request("GET", `/api/webui/assist/runs/${run.chat_id}`))).toMatchObject({ status: "done", reply: "已经看过了。" });
  });
});
