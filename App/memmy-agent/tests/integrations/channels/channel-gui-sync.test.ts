import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../../src/config/schema.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { SessionManager } from "../../../src/core/session/manager.js";
import { GuiSessionProjection, toGuiChatId } from "../../../src/entrypoints/frontend-bridge/gui-session-projection.js";
import { GuiTranscriptMirror } from "../../../src/entrypoints/frontend-bridge/gui-transcript-sync.js";
import { readTranscriptLines } from "../../../src/entrypoints/frontend-bridge/transcript.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";
import { LLMResponse } from "../../../src/providers/base.js";

const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const roots: string[] = [];

function expectedAnswer(content: string): string {
  if (content.includes("IM C")) return "answer C";
  if (content.includes("GUI B")) return "answer B";
  return "answer A";
}

async function nextOutboundBefore(bus: MessageBus, deadline: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      bus.nextOutbound(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("timed out waiting for final outbound")),
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function nextFinalOutbound(
  bus: MessageBus,
  websocket: WebSocketChannel,
  observed: Record<string, any>[] = [],
): Promise<{ channel: string; chatId: string; content: string }> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const message = await nextOutboundBefore(bus, deadline);
    observed.push(message);
    if (message.channel === "websocket") await websocket.send(message);
    if (
      message.content
      && !message.metadata?.agentProgress
      && !message.metadata?.streamDelta
      && !message.metadata?.streamEnd
    ) {
      return message;
    }
  }
  throw new Error("timed out waiting for final outbound");
}

afterEach(() => {
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe.each([
  ["telegram", "chat-telegram"],
  ["feishu", "chat-feishu"],
  ["slack", "chat-slack"],
  ["weixin", "chat-weixin"],
])("%s canonical GUI synchronization", (channelName, chatId) => {
  it("keeps IM A, GUI B, and IM C in one canonical history with route-specific delivery", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-channel-gui-sync-"));
    roots.push(root);
    process.env.MEMMY_AGENT_DATA_DIR = root;
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const canonicalWorkspace = fs.realpathSync(workspace);
    const sessions = new SessionManager(path.join(workspace, "sessions"));
    const bus = new MessageBus();
    const modelCalls: string[] = [];
    const streamedModelCalls: string[] = [];
    const provider = {
      generation: { maxTokens: 256 },
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(async (args: any) => {
        const input = JSON.stringify(args.messages);
        if (input.includes("You write short, neutral chat titles")) {
          return new LLMResponse({ content: "Sync task" });
        }
        modelCalls.push(input);
        return new LLMResponse({ content: expectedAnswer(input) });
      }),
      chatStreamWithRetry: vi.fn(async (args: any) => {
        const input = JSON.stringify(args.messages);
        streamedModelCalls.push(input);
        const answer = expectedAnswer(input);
        await args.onContentDelta(answer.slice(0, 4));
        await args.onContentDelta(answer.slice(4));
        return new LLMResponse({ content: answer });
      }),
    };
    const loop = new AgentLoop({
      bus,
      config: new Config({
        fileMemory: { enabled: false },
        memmyMemory: { enabled: false },
      }),
      provider,
      workspace: canonicalWorkspace,
      sessionDir: sessions.root,
      sessionManager: sessions,
      model: "test-model",
      unifiedSession: true,
    });
    loop.guiTranscriptMirror = new GuiTranscriptMirror(sessions, canonicalWorkspace);
    const websocket = new WebSocketChannel(
      { allowFrom: ["*"] },
      bus,
      { sessionManager: sessions, workspacePath: canonicalWorkspace },
    );
    const sent: Record<string, any>[] = [];
    const connection = {
      remoteAddress: ["127.0.0.1"],
      send: async (raw: string) => {
        sent.push(JSON.parse(raw));
      },
    };
    const canonicalSessionKey = `${channelName}:${chatId}`;
    const guiChatId = toGuiChatId(canonicalSessionKey);
    const runTask = loop.run();

    await bus.publishInbound(new InboundMessage({
      channel: channelName,
      chatId,
      senderId: "user",
      content: "IM A",
    }));
    const answerA = await nextFinalOutbound(bus, websocket);
    expect(answerA).toMatchObject({ channel: channelName, chatId, content: "answer A" });

    await websocket.dispatchEnvelope(connection, "gui-client", {
      type: "message",
      chat_id: guiChatId,
      content: "GUI B",
      webui: true,
      client_request_id: "11111111-1111-4111-8111-111111111111",
    });
    const guiTurnOutbound: Record<string, any>[] = [];
    const answerB = await nextFinalOutbound(bus, websocket, guiTurnOutbound);
    expect(answerB).toMatchObject({
      channel: "websocket",
      chatId: guiChatId,
      content: "answer B",
    });

    await bus.publishInbound(new InboundMessage({
      channel: channelName,
      chatId,
      senderId: "user",
      content: "IM C",
    }));
    const answerC = await nextFinalOutbound(bus, websocket);
    expect(answerC).toMatchObject({ channel: channelName, chatId, content: "answer C" });

    loop.stop();
    await runTask;

    const session = sessions.reload(canonicalSessionKey);
    expect(session?.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "IM A"],
      ["assistant", "answer A"],
      ["user", "GUI B"],
      ["assistant", "answer B"],
      ["user", "IM C"],
      ["assistant", "answer C"],
    ]);
    expect(modelCalls).toHaveLength(2);
    expect(modelCalls[1]).toContain("GUI B");
    expect(modelCalls[1]).toContain("answer B");
    expect(streamedModelCalls).toHaveLength(1);
    expect(streamedModelCalls[0]).toContain("GUI B");
    expect(new GuiSessionProjection(sessions).resolve(guiChatId).canonicalSessionKey)
      .toBe(canonicalSessionKey);
    expect(sessions.has(`websocket:${guiChatId}`)).toBe(false);

    const transcript = readTranscriptLines(`websocket:${guiChatId}`);
    expect(transcript.filter((record) => record.event === "user").map((record) => record.text))
      .toEqual(["IM A", "GUI B", "IM C"]);
    expect(transcript.filter((record) => record.event === "delta").map((record) => record.text))
      .toEqual([]);
    expect(
      guiTurnOutbound
        .filter((message) => message.metadata?.streamDelta)
        .map((message) => message.content),
    ).toEqual(["answ", "er B"]);
    expect(sent.some((event) => event.event === "message_accepted" && event.chat_id === guiChatId))
      .toBe(true);
  });
});
