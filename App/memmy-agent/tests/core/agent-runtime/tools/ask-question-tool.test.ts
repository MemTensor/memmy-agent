import { describe, expect, it, vi } from "vitest";
import {
  AskQuestionTool,
  pendingAgentQuestionCount,
  respondToAgentQuestion,
} from "../../../../src/core/agent-runtime/tools/ask-question.js";
import { RequestContext } from "../../../../src/core/agent-runtime/tools/context.js";
import type { OutboundMessage } from "../../../../src/core/runtime-messages/events.js";

describe("AskQuestionTool", () => {
  it("sends a persistent structured question to the active conversation", async () => {
    const sent: OutboundMessage[] = [];
    const tool = new AskQuestionTool({ sendCallback: async (message) => { sent.push(message); } });
    tool.setContext(new RequestContext({
      channel: "websocket",
      chatId: "chat-1",
      metadata: { webui: true, turn_id: "turn-1" },
    }));

    const resultPromise = tool.execute({
      title: "继续前请确认",
      questions: [{
        id: "uploads",
        prompt: "还有其他文件需要上传吗？",
        options: [
          { id: "more", label: "继续上传" },
          { id: "done", label: "已全部上传" },
        ],
        allow_other: true,
      }],
    });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: "websocket",
      chatId: "chat-1",
      buttons: [["继续上传", "已全部上传"]],
      metadata: {
        webui: true,
        turn_id: "turn-1",
        recordChannelDelivery: true,
        agentUi: {
          questionCard: {
            version: 1,
            title: "继续前请确认",
            questions: [{
              id: "uploads",
              prompt: "还有其他文件需要上传吗？",
              allowMultiple: false,
              allowOther: true,
            }],
          },
        },
      },
    });
    expect(sent[0]!.metadata.agentUi.questionCard.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const requestId = sent[0]!.metadata.agentUi.questionCard.requestId;
    expect(pendingAgentQuestionCount()).toBe(1);
    expect(respondToAgentQuestion({
      chatId: "chat-1",
      response: {
        requestId,
        answers: [{ questionId: "uploads", selectedOptionIds: ["done"] }],
      },
    })).toEqual({ ok: true });
    await expect(resultPromise).resolves.toSatisfy((result) => (
      JSON.parse(result).status === "answered"
      && JSON.parse(result).answers[0].selectedOptionIds[0] === "done"
    ));
    expect(pendingAgentQuestionCount()).toBe(0);
  });

  it("rejects duplicate question and option ids", async () => {
    const tool = new AskQuestionTool({ sendCallback: async () => undefined });
    tool.setContext(new RequestContext({ channel: "websocket", chatId: "chat-1" }));

    await expect(tool.execute({
      questions: [
        { id: "same", prompt: "A?", options: [{ id: "1", label: "1" }, { id: "2", label: "2" }] },
        { id: "same", prompt: "B?", options: [{ id: "3", label: "3" }, { id: "4", label: "4" }] },
      ],
    })).resolves.toBe("Error: question ids must be unique");

    await expect(tool.execute({
      questions: [{
        id: "unique",
        prompt: "A?",
        options: [{ id: "same", label: "1" }, { id: "same", label: "2" }],
      }],
    })).resolves.toBe("Error: option ids must be unique within question 'unique'");
  });

  it("is only enabled when the runtime can deliver a card", () => {
    expect(AskQuestionTool.enabled({ messageSendCallback: null })).toBe(false);
    expect(AskQuestionTool.enabled({ messageSendCallback: async () => undefined })).toBe(true);
    expect(AskQuestionTool.enabled({
      messageSendCallback: null,
      bus: { publishOutbound: async () => undefined },
    })).toBe(true);
  });

  it("cancels a pending question when its turn is interrupted", async () => {
    const controller = new AbortController();
    const tool = new AskQuestionTool({ sendCallback: async () => undefined });
    tool.setContext(new RequestContext({ channel: "websocket", chatId: "chat-cancel" }));

    const result = tool.execute({
      questions: [{
        id: "q",
        prompt: "Continue?",
        options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }],
      }],
    }, { abortSignal: controller.signal });
    await vi.waitFor(() => expect(pendingAgentQuestionCount()).toBe(1));
    controller.abort();

    await expect(result).rejects.toThrow("turn was interrupted");
    expect(pendingAgentQuestionCount()).toBe(0);
  });
});
