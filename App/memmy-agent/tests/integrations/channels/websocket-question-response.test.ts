import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import {
  AskQuestionTool,
  pendingAgentQuestionCount,
} from "../../../src/core/agent-runtime/tools/ask-question.js";
import { RequestContext } from "../../../src/core/agent-runtime/tools/context.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";

function createConnection() {
  return {
    send: vi.fn(async (_payload: string) => undefined),
    remoteAddress: ["127.0.0.1"],
  };
}

function sent(connection: ReturnType<typeof createConnection>): Record<string, unknown>[] {
  return connection.send.mock.calls.map((call) => JSON.parse(String(call[0])));
}

describe("WebSocket agent question responses", () => {
  it("resolves the pending tool call and broadcasts the persisted response event", async () => {
    const cards: any[] = [];
    const tool = new AskQuestionTool({ sendCallback: async (message) => { cards.push(message); } });
    tool.setContext(new RequestContext({ channel: "websocket", chatId: "chat-1" }));
    const pending = tool.execute({
      questions: [{
        id: "choice",
        prompt: "Continue?",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      }],
    });
    await vi.waitFor(() => expect(cards).toHaveLength(1));
    const requestId = cards[0].metadata.agentUi.questionCard.requestId;
    expect(pendingAgentQuestionCount()).toBe(1);

    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = createConnection();
    channel.attachConnection(ws, "chat-1");
    await channel.dispatchEnvelope(ws, "client-1", {
      type: "agent_question_response",
      chat_id: "chat-1",
      request_id: requestId,
      answers: [{
        question_id: "choice",
        selected_option_ids: ["yes"],
      }],
    });

    await expect(pending).resolves.toContain('"status":"answered"');
    expect(sent(ws)).toContainEqual({
      event: "agent_question_response",
      chat_id: "chat-1",
      request_id: requestId,
      answers: [{
        questionId: "choice",
        selectedOptionIds: ["yes"],
      }],
    });
    expect(sent(ws)).toContainEqual({
      event: "agent_question_response_result",
      chat_id: "chat-1",
      request_id: requestId,
      ok: true,
    });
  });

  it("rejects responses from a connection not attached to the chat", async () => {
    const channel = new WebSocketChannel({}, new MessageBus());
    const ws = createConnection();

    await channel.dispatchEnvelope(ws, "client-1", {
      type: "agent_question_response",
      chat_id: "chat-1",
      request_id: "11111111-1111-4111-8111-111111111111",
      answers: [{
        question_id: "choice",
        selected_option_ids: ["yes"],
      }],
    });

    expect(sent(ws)).toEqual([{
      event: "agent_question_response_result",
      chat_id: "chat-1",
      request_id: "11111111-1111-4111-8111-111111111111",
      ok: false,
      error: "invalid_request",
    }]);
  });
});
