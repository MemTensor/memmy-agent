import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { AgentLoop, TurnContext } from "../../../src/core/agent-runtime/loop.js";
import { AskQuestionTool, isAgentQuestionPending, respondToAgentQuestion } from "../../../src/core/agent-runtime/tools/ask-question.js";
import { RequestContext } from "../../../src/core/agent-runtime/tools/context.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { Config } from "../../../src/config/schema.js";
import { InboundMessage, MessageBus } from "../../../src/core/runtime-messages/index.js";
import { OUTBOUND_META_AGENT_UI } from "../../../src/core/runtime-messages/events.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

it("queues messages behind an unanswered card and resumes with only the explicitly steered message", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-question-queue-"));
  const chatId = "question-queue", sessionKey = `websocket:${chatId}`;
  const source = { kind: "gui", channel: "websocket" } as const;
  let release!: () => void;
  const finish = new Promise<void>((resolve) => { release = resolve; });
  class Provider extends LLMProvider {
    requests: any[] = [];
    getDefaultModel() { return "test-model"; }
    async chatWithRetry(args: any) {
      this.requests.push(structuredClone(args.messages));
      if (this.requests.length === 1) return new LLMResponse({ content: "", finishReason: "tool_calls", toolCalls: [
        new ToolCallRequest({ id: "ask", name: "ask_question", arguments: { questions: [
          { id: "scope", prompt: "请选择范围", allow_multiple: false, options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }
        ] } })
      ] });
      await finish;
      return new LLMResponse({ content: "按你的引导继续。" });
    }
    async chat(args: any) { return this.chatWithRetry(args); }
  }
  const provider = new Provider();
  const loop = new AgentLoop({ bus: new MessageBus(), config: new Config({ memmyMemory: { enabled: false } }),
    provider, workspace, model: "test-model" });
  loop.initializeRuntimeTools = vi.fn(async () => undefined);
  const session = loop.sessions.getOrCreate(sessionKey);
  let requestId = "";
  const question = new AskQuestionTool({ sendCallback: async (message) => {
    requestId = (message.metadata[OUTBOUND_META_AGENT_UI] as any).questionCard.requestId;
  } });
  const tools = new ToolRegistry(); tools.register(question);
  const started: string[] = [];
  loop.processMessageInternal = vi.fn(async (message, _key, options: any) => {
    started.push(message.content);
    if (message.content !== "original") {
      await new Promise<void>((resolve) => options.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
      return null;
    }
    question.setContext(new RequestContext({ channel: "websocket", chatId, sessionKey, metadata: { turn_id: options.turnId } }));
    session.addMessage("user", "original", { turn_id: options.turnId, turn_source: source });
    loop.sessions.save(session);
    const ctx = new TurnContext({ msg: message, sessionKey, session, turnId: options.turnId, slot: options.slot });
    ctx.initialMessages = [{ role: "system", content: "Follow instructions." }, { role: "user", content: "original" }];
    ctx.pendingQueue = options.pendingQueue; ctx.abortSignal = options.abortSignal;
    ctx.boundary = options.boundary; ctx.tools = tools; ctx.userPersistedEarly = true;
    await loop.stateRun(ctx); await loop.stateSave(ctx); return null;
  });
  const running = loop.run();
  try {
    await loop.bus.publishInbound(new InboundMessage({ channel: "websocket", chatId, content: "original", sessionKeyOverride: sessionKey, turnSource: source }));
    await vi.waitFor(() => expect(requestId).not.toBe(""));
    const turnId = (loop.turnSlots.get(sessionKey) as any[])[0].turnId;
    for (const [id, content] of [["first", "稍后再处理这条"], ["second", "先跳过当前问题"]]) {
      await loop.bus.publishInbound(new InboundMessage({ channel: "websocket", chatId, content, sessionKeyOverride: sessionKey, turnSource: source,
        metadata: { webui: true, client_request_id: id, webui_request_digest: id, webui_queue_surface: "chat_composer",
          webui_interrupt_pending_turn_id: turnId } }));
    }
    await vi.waitFor(async () => expect((await loop.getQueueSnapshot(sessionKey)).items).toHaveLength(2));
    expect(isAgentQuestionPending(requestId, chatId)).toBe(true);
    expect(started).toEqual(["original"]);
    expect(provider.requests).toHaveLength(1);
    await expect(loop.steerQueuedWebuiMessage(sessionKey, "second", turnId)).resolves.toMatchObject({ outcome: "steered" });
    expect(isAgentQuestionPending(requestId, chatId)).toBe(true);
    expect(respondToAgentQuestion({ chatId, response: { requestId, cancelled: true, answers: [] } })).toEqual({ ok: true });
    await vi.waitFor(() => expect(provider.requests).toHaveLength(2));
    expect(provider.requests[1].some((message: any) => message.role === "user" && message.content === "先跳过当前问题")).toBe(true);
    expect(provider.requests[1].some((message: any) => message.role === "user" && message.content === "稍后再处理这条")).toBe(false);
    expect((await loop.getQueueSnapshot(sessionKey)).items.map((item) => item.clientRequestId)).toEqual(["first"]);
    expect(started).toEqual(["original"]);
    expect(isAgentQuestionPending(requestId, chatId)).toBe(false);
  } finally {
    release(); loop.stop(); await loop.cancelActiveTasks(sessionKey); await running;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
