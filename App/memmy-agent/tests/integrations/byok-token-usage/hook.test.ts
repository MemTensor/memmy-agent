import { describe, expect, it, vi } from "vitest";
import { AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { ByokTokenUsageHook } from "../../../src/integrations/byok-token-usage/hook.js";
import type { ByokTokenUsageEvent } from "../../../src/integrations/byok-token-usage/types.js";

describe("ByokTokenUsageHook", () => {
  it("records stable model dimensions from the committed BYOK context", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const hook = new ByokTokenUsageHook({ client });
    const ctx = context("byok");

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

    expect(recordedEvent(client.recordEvent)).toMatchObject({
      kind: "agent_chat",
      source: "agent",
      presetId: "byok-agent",
      provider: "openai",
      model: "gpt-4.1-mini",
      capability: "agent",
      operationId: expect.any(String),
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      metadata: {
        sessionKey: "cli:direct",
        provider: "openai",
        modelId: "gpt-4.1-mini",
      },
    });
  });

  it("does not count platform-account usage as BYOK", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const hook = new ByokTokenUsageHook({ client });
    const ctx = context("account");
    await hook.beforeRun(ctx);
    await hook.afterRun(ctx, { usage: { prompt_tokens: 1 } });
    expect(client.recordEvent).not.toHaveBeenCalled();
  });

  it("does not infer BYOK provenance when the actual context is absent", async () => {
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => undefined) };
    const hook = new ByokTokenUsageHook({ client });
    const ctx = new AgentHookContext({ spec: { sessionKey: "cli:direct", model: "gpt-4.1-mini" } });
    await hook.beforeRun(ctx);
    await hook.afterRun(ctx, { usage: { prompt_tokens: 1 } });
    expect(client.recordEvent).not.toHaveBeenCalled();
  });

  it("does not throw when recording fails", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const client = { recordEvent: vi.fn(async (_event: ByokTokenUsageEvent) => { throw new Error("backend down"); }) };
    const hook = new ByokTokenUsageHook({ client });
    const ctx = context("byok");
    await hook.beforeRun(ctx);
    await expect(hook.afterRun(ctx, { usage: { prompt_tokens: 1 } })).resolves.toBeUndefined();
    expect(client.recordEvent).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });
});

function context(source: "account" | "byok"): AgentHookContext {
  return new AgentHookContext({
    spec: {
      sessionKey: "cli:direct",
      actualModelContext: {
        presetId: `${source}-agent`,
        provider: source === "byok" ? "openai" : "memmy_account",
        endpointId: "chat",
        protocol: source === "byok" ? "openai-chat-completions" : "memmy-account",
        model: "gpt-4.1-mini",
        source,
        ownerAccountId: source === "account" ? "owner-a" : null,
        capability: "agent",
        capabilities: ["agent"],
      },
    },
  });
}

function recordedEvent(recordEvent: ReturnType<typeof vi.fn<(event: ByokTokenUsageEvent) => Promise<void>>>): ByokTokenUsageEvent {
  const event = recordEvent.mock.calls[0]?.[0];
  if (!event) throw new Error("expected BYOK token usage event");
  return event;
}
