import { describe, expect, it, vi } from "vitest";
import { ByokTokenUsageRecorder } from "../../../src/integrations/byok-token-usage/recorder.js";
import type { ByokTokenUsageEvent } from "../../../src/integrations/byok-token-usage/types.js";

describe("ByokTokenUsageRecorder", () => {
  it("records title usage as an existing agent_chat event", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const recorder = new ByokTokenUsageRecorder({
      client,
      resolveProviderName: () => "openai",
    });

    await expect(recorder.recordAgentChatUsage({
      usage: {
        prompt_tokens: 11,
        completion_tokens: 3,
        total_tokens: 14,
      },
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      modelId: "gpt-4.1-mini",
      operation: "session_title",
    })).resolves.toBe(true);

    expect(client.recordEvent).toHaveBeenCalledTimes(1);
    const event = recordedEvent(client.recordEvent);
    expect(event).toMatchObject({
      kind: "agent_chat",
      source: "agent",
      inputTokens: 11,
      outputTokens: 3,
      totalTokens: 14,
      metadata: {
        operation: "session_title",
        sessionKey: "websocket:chat-1",
        chatId: "chat-1",
        provider: "openai",
        modelId: "gpt-4.1-mini",
      },
    });
    expect(event.kind).not.toBe("title");
    expect(event.operationId).toEqual(expect.any(String));
  });

  it("keeps operation in metadata without adding a dedicated title kind", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const recorder = new ByokTokenUsageRecorder({ client });

    await recorder.recordAgentChatUsage({
      usage: { prompt_tokens: 1 },
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      provider: "anthropic",
      modelId: "claude-opus-4-5",
      operation: "session_title",
    });

    const event = recordedEvent(client.recordEvent);
    expect(event.kind).toBe("agent_chat");
    expect(event.source).toBe("agent");
    expect(event.metadata.operation).toBe("session_title");
  });

  it("does not record empty or zero-normalized usage", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const recorder = new ByokTokenUsageRecorder({ client });

    await expect(recorder.recordAgentChatUsage({
      usage: {},
      sessionKey: "websocket:chat-1",
      provider: "openai",
      modelId: "gpt-4.1-mini",
    })).resolves.toBe(false);
    await expect(recorder.recordAgentChatUsage({
      usage: null,
      sessionKey: "websocket:chat-1",
      provider: "openai",
      modelId: "gpt-4.1-mini",
    })).resolves.toBe(false);

    expect(client.recordEvent).not.toHaveBeenCalled();
  });

  it("skips memmy_account provider usage like the agent hook", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const recorder = new ByokTokenUsageRecorder({
      client,
      resolveProviderName: () => "memmy_account",
    });

    await expect(recorder.recordAgentChatUsage({
      usage: { prompt_tokens: 2 },
      sessionKey: "websocket:chat-1",
      modelId: "memmy_account/gpt-4.1-mini",
      operation: "session_title",
    })).resolves.toBe(false);

    expect(client.recordEvent).not.toHaveBeenCalled();
  });

  it("does not throw when the local API client fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => {
      throw new Error("backend down");
    }) };
    const recorder = new ByokTokenUsageRecorder({ client });

    await expect(recorder.recordAgentChatUsage({
      usage: { prompt_tokens: 2 },
      sessionKey: "websocket:chat-1",
      provider: "openai",
      modelId: "gpt-4.1-mini",
      operation: "session_title",
    })).resolves.toBe(false);

    expect(client.recordEvent).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

function recordedEvent(
  recordEvent: ReturnType<typeof vi.fn<(event: ByokTokenUsageEvent) => Promise<void>>>,
): ByokTokenUsageEvent {
  const event = recordEvent.mock.calls[0]?.[0];
  if (!event) throw new Error("expected BYOK token usage event");
  return event;
}
