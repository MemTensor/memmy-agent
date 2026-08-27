import { describe, expect, it, vi } from "vitest";
import { ByokTokenUsageRecorder } from "../../../src/integrations/byok-token-usage/recorder.js";
import type { ByokTokenUsageEvent } from "../../../src/integrations/byok-token-usage/types.js";

describe("ByokTokenUsageRecorder", () => {
  it("records auxiliary Agent usage only with a committed BYOK model context", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const recorder = new ByokTokenUsageRecorder({ client });

    await expect(recorder.recordAgentChatUsage({
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      sessionKey: "websocket:chat-1",
      chatId: "chat-1",
      operation: "session_title",
      actualModelContext: byokContext(),
    })).resolves.toBe(true);

    expect(recordedEvent(client.recordEvent)).toMatchObject({
      kind: "agent_chat",
      source: "agent",
      presetId: "byok-agent",
      provider: "openai",
      model: "gpt-4.1-mini",
      capability: "agent",
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
  });

  it("skips account contexts and missing model provenance", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const recorder = new ByokTokenUsageRecorder({ client });
    const common = { usage: { prompt_tokens: 2 }, sessionKey: "websocket:chat-1" };

    await expect(recorder.recordAgentChatUsage({ ...common, actualModelContext: accountContext() })).resolves.toBe(false);
    await expect(recorder.recordAgentChatUsage(common)).resolves.toBe(false);
    expect(client.recordEvent).not.toHaveBeenCalled();
  });

  it("does not record empty usage", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const recorder = new ByokTokenUsageRecorder({ client });
    await expect(recorder.recordAgentChatUsage({
      usage: {},
      sessionKey: "websocket:chat-1",
      actualModelContext: byokContext(),
    })).resolves.toBe(false);
    expect(client.recordEvent).not.toHaveBeenCalled();
  });

  it("does not throw when the local API client fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => { throw new Error("backend down"); }) };
    const recorder = new ByokTokenUsageRecorder({ client });

    await expect(recorder.recordAgentChatUsage({
      usage: { prompt_tokens: 2 },
      sessionKey: "websocket:chat-1",
      actualModelContext: byokContext(),
    })).resolves.toBe(false);
    expect(client.recordEvent).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});

function byokContext() {
  return {
    presetId: "byok-agent",
    source: "byok" as const,
    provider: "openai",
    model: "gpt-4.1-mini",
    capability: "agent" as const,
  };
}

function accountContext() {
  return { ...byokContext(), presetId: "account-agent", source: "account" as const, provider: "memmy_account" };
}

function recordedEvent(recordEvent: ReturnType<typeof vi.fn<(event: ByokTokenUsageEvent) => Promise<void>>>): ByokTokenUsageEvent {
  const event = recordEvent.mock.calls[0]?.[0];
  if (!event) throw new Error("expected BYOK token usage event");
  return event;
}
