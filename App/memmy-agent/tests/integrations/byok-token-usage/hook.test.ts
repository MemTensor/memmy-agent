import { describe, expect, it, vi } from "vitest";
import { AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { ByokTokenUsageHook } from "../../../src/integrations/byok-token-usage/hook.js";
import type { ByokTokenUsageEvent } from "../../../src/integrations/byok-token-usage/types.js";

describe("ByokTokenUsageHook", () => {
  it("records one normalized usage event after a run", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const hook = new ByokTokenUsageHook({
      client,
      resolveProviderName: () => "openai",
    });
    const ctx = new AgentHookContext({
      spec: {
        sessionKey: "cli:direct",
        model: "gpt-4.1-mini",
      },
    });

    await hook.beforeRun(ctx);
    await hook.afterRun(ctx, {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20,
        total_tokens: 30,
        cached_tokens: 4,
        cache_creation_input_tokens: 2,
      },
    });

    expect(client.recordEvent).toHaveBeenCalledTimes(1);
    const event = recordedEvent(client.recordEvent);
    expect(event).toMatchObject({
      kind: "agent_chat",
      source: "agent",
      operationId: expect.any(String),
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 4,
      cacheCreationInputTokens: 2,
      rawUsage: {
        prompt_tokens: 10,
        completion_tokens: 20,
      },
      metadata: {
        sessionKey: "cli:direct",
        provider: "openai",
        modelId: "gpt-4.1-mini",
      },
    });
    expect(event.id).toEqual(expect.any(String));
    expect(event.createdAt).toEqual(expect.any(String));
  });

  it("uses provider spec name before the config resolver", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const hook = new ByokTokenUsageHook({
      client,
      resolveProviderName: () => "openai",
    });
    const ctx = new AgentHookContext({
      spec: {
        sessionKey: "cli:direct",
        provider: {
          spec: { name: "anthropic" },
          getDefaultModel: () => "claude-opus-4-5",
        },
      },
    });

    await hook.beforeRun(ctx);
    await hook.afterRun(ctx, {
      usage: {
        prompt_tokens: 1,
      },
    });

    expect(recordedEvent(client.recordEvent).metadata).toMatchObject({
      provider: "anthropic",
      modelId: "claude-opus-4-5",
    });
  });

  it("does not record account-mode usage", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const hook = new ByokTokenUsageHook({
      client,
      resolveProviderName: () => "memmy_account",
    });
    const ctx = new AgentHookContext({
      spec: {
        sessionKey: "cli:direct",
        model: "memmy_account/gpt-4.1-mini",
      },
    });

    await hook.beforeRun(ctx);
    await hook.afterRun(ctx, {
      usage: {
        prompt_tokens: 1,
      },
    });

    expect(client.recordEvent).not.toHaveBeenCalled();
  });

  it("does not record when usage normalizes to zero", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const hook = new ByokTokenUsageHook({
      client,
      resolveProviderName: () => "openai",
    });
    const ctx = new AgentHookContext({
      spec: { sessionKey: "cli:direct", model: "gpt-4.1-mini" },
    });

    await hook.beforeRun(ctx);
    await hook.afterRun(ctx, { usage: {} });

    expect(client.recordEvent).not.toHaveBeenCalled();
  });

  it("does not throw when recording fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => {
      throw new Error("backend down");
    }) };
    const hook = new ByokTokenUsageHook({
      client,
      resolveProviderName: () => "openai",
    });
    const ctx = new AgentHookContext({
      spec: { sessionKey: "cli:direct", model: "gpt-4.1-mini" },
    });

    await hook.beforeRun(ctx);
    await expect(hook.afterRun(ctx, { usage: { prompt_tokens: 1 } })).resolves.toBeUndefined();

    expect(client.recordEvent).toHaveBeenCalledTimes(1);
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
