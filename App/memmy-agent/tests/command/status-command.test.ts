import { describe, expect, it, vi } from "vitest";
import { cmdStatus } from "../../src/command/builtin.js";
import { CommandContext } from "../../src/command/router.js";
import { InboundMessage } from "../../src/core/runtime-messages/events.js";
import {
  persistedModelSelection,
  type ResolvedModelSelection,
} from "../../src/providers/model-catalog.js";

function resolvedSelection(input: {
  preset?: string;
  provider?: string;
  model?: string;
  source?: "account" | "byok";
  contextWindowTokens?: number;
  snapshotProvider?: any;
} = {}): ResolvedModelSelection {
  const preset = input.preset ?? "gpt-5.5";
  const provider = input.provider ?? "openai";
  const model = input.model ?? "gpt-5.5";
  const source = input.source ?? "byok";
  return {
    preset,
    presetId: preset,
    provider,
    endpointId: "chat",
    protocol: "openai-chat-completions",
    model,
    source,
    ownerAccountId: source === "account" ? "account-1" : null,
    capability: "agent",
    capabilities: ["agent"],
    providerConfig: {} as any,
    snapshot: {
      provider: input.snapshotProvider ?? { spec: { name: provider } },
      model,
      contextWindowTokens: input.contextWindowTokens ?? 200_000,
      signature: [preset, model],
    } as any,
  };
}

function statusContext(
  session: any,
  loop: any,
  chatId = "status-chat",
): CommandContext {
  const msg = new InboundMessage({
    channel: "websocket",
    senderId: "user",
    chatId,
    content: "/status",
    metadata: { webui_ephemeral_command: "status" },
  });
  return new CommandContext({
    msg,
    session,
    key: msg.sessionKey,
    raw: "/status",
    loop,
  });
}

function statusLoop(input: {
  selection: ResolvedModelSelection | null;
  session: any;
  estimate?: number | Error;
  usage?: Record<string, number> | null;
}): {
  loop: any;
  scopedEstimate: ReturnType<typeof vi.fn>;
  globalEstimate: ReturnType<typeof vi.fn>;
  withProviderSnapshot: ReturnType<typeof vi.fn>;
} {
  const scopedEstimate = vi.fn(() => {
    if (input.estimate instanceof Error) throw input.estimate;
    return [input.estimate ?? 19_124, "test"];
  });
  const globalEstimate = vi.fn(() => [999_999, "wrong"]);
  const withProviderSnapshot = vi.fn(() => ({
    estimateSessionPromptTokens: scopedEstimate,
  }));
  const usageBySession = new Map<string, Record<string, number>>();
  if (input.usage) usageBySession.set("websocket:status-chat", input.usage);
  const loop = {
    model: "agent_chat",
    contextWindowTokens: 1,
    sessions: {
      get: vi.fn(() => input.session),
      getOrCreate: vi.fn(() => input.session),
    },
    resolveTurnModelSelection: vi.fn(() => input.selection),
    consolidator: {
      estimateSessionPromptTokens: globalEstimate,
      withProviderSnapshot,
    },
    lastUsageBySession: usageBySession,
    startTime: Date.now() / 1000 - 60,
    activeTasks: new Map([["websocket:status-chat", [{ done: () => false }]]]),
    subagents: { getRunningCountBySession: vi.fn(() => 2) },
  };
  return { loop, scopedEstimate, globalEstimate, withProviderSnapshot };
}

describe("status command", () => {
  it("uses the committed session model and its scoped context estimator", async () => {
    const snapshotProvider = { spec: { name: "openai" } };
    const selection = resolvedSelection({ snapshotProvider });
    const session = {
      metadata: { modelSelection: persistedModelSelection(selection) },
      messages: [
        { role: "user", content: "ordinary text" },
        { role: "assistant", content: "answer", tool_calls: [{ id: "call-1" }] },
        { role: "tool", content: "tool result" },
        { role: "user", content: "", media: [{ type: "image" }] },
        { role: "user", content: "/goal create ship it", commandMessage: true },
        { role: "user", content: "/status", commandMessage: true },
        { role: "user", content: "continue", internal_context: "goal_continuation" },
        { role: "user", content: "  " },
      ],
    };
    const runtime = statusLoop({
      selection,
      session,
      usage: { prompt_tokens: 19_124, completion_tokens: 820, cached_tokens: 11_857 },
    });

    const response = await cmdStatus(statusContext(session, runtime.loop));

    expect(response.content).toContain("Model: openai / gpt-5.5");
    expect(response.content).not.toContain("agent_chat");
    expect(response.content).toContain("Last run tokens: 19124 in / 820 out (62% cached)");
    expect(response.content).toContain("Context: ~19k / 200k");
    expect(response.content).toContain("Conversation: 3 user turns");
    expect(response.content).not.toMatch(/Tasks:|Goal:|Queue:|Subagent/i);
    expect(response.metadata).toMatchObject({
      renderAs: "text",
      webui_ephemeral_command: "status",
    });
    expect(runtime.loop.resolveTurnModelSelection).toHaveBeenCalledWith({
      committedSelection: expect.objectContaining({
        presetId: "gpt-5.5",
        provider: "openai",
        model: "gpt-5.5",
      }),
    });
    expect(runtime.withProviderSnapshot).toHaveBeenCalledWith(
      snapshotProvider,
      "gpt-5.5",
      200_000,
    );
    expect(runtime.scopedEstimate).toHaveBeenCalledWith(session);
    expect(runtime.globalEstimate).not.toHaveBeenCalled();
    expect(runtime.loop.subagents.getRunningCountBySession).not.toHaveBeenCalled();
  });

  it("uses the account model display name and counts beyond the replay window", async () => {
    const selection = resolvedSelection({
      preset: "platform",
      provider: "memmy_account",
      model: "agent_chat",
      source: "account",
    });
    const session = {
      metadata: { modelSelection: persistedModelSelection(selection) },
      messages: Array.from({ length: 131 }, (_, index) => ({
        role: "user",
        content: `message ${index}`,
      })),
      getHistory: vi.fn(() => Array.from({ length: 120 }, () => ({ role: "user" }))),
    };
    const runtime = statusLoop({ selection, session, usage: null });

    const response = await cmdStatus(statusContext(session, runtime.loop));

    expect(response.content).toContain("Model: memmy_account / General text");
    expect(response.content).toContain("Last run tokens: unavailable");
    expect(response.content).toContain("Conversation: 131 user turns");
    expect(session.getHistory).not.toHaveBeenCalled();
  });

  it("reports model and context errors without substituting process defaults", async () => {
    const session = { metadata: {}, messages: [{ role: "user", content: "hello" }] };
    const runtime = statusLoop({ selection: null, session, usage: null });

    const response = await cmdStatus(statusContext(session, runtime.loop));

    expect(response.content).toContain("Model: error (session model selection cannot be resolved)");
    expect(response.content).toContain("Context: error (session model selection cannot be resolved)");
    expect(response.content).not.toContain("agent_chat");
    expect(runtime.withProviderSnapshot).not.toHaveBeenCalled();
  });

  it("reports an invalid session-model context window without estimating", async () => {
    const selection = resolvedSelection({ contextWindowTokens: 0 });
    const session = {
      metadata: { modelSelection: persistedModelSelection(selection) },
      messages: [],
    };
    const runtime = statusLoop({ selection, session, usage: null });

    const response = await cmdStatus(statusContext(session, runtime.loop));

    expect(response.content).toContain("Context: error (invalid model context window)");
    expect(runtime.withProviderSnapshot).not.toHaveBeenCalled();
  });

  it("does not fall back to last-run input tokens when context estimation fails", async () => {
    const selection = resolvedSelection();
    const session = {
      metadata: { modelSelection: persistedModelSelection(selection) },
      messages: [{ role: "user", content: "hello" }],
    };
    const runtime = statusLoop({
      selection,
      session,
      estimate: new Error("estimate failed"),
      usage: { prompt_tokens: 9999, completion_tokens: 8 },
    });

    const response = await cmdStatus(statusContext(session, runtime.loop));

    expect(response.content).toContain("Last run tokens: 9999 in / 8 out");
    expect(response.content).toContain("Context: error (token estimation failed)");
    expect(response.content).not.toContain("Context: ~9k");
  });

  it("isolates status usage by session key", async () => {
    const selection = resolvedSelection();
    const session = {
      metadata: { modelSelection: persistedModelSelection(selection) },
      messages: [],
    };
    const runtime = statusLoop({
      selection,
      session,
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    runtime.loop.lastUsageBySession.set("websocket:other", {
      prompt_tokens: 999,
      completion_tokens: 888,
    });

    const response = await cmdStatus(statusContext(session, runtime.loop));

    expect(response.content).toContain("Last run tokens: 12 in / 3 out");
    expect(response.content).not.toContain("999 in / 888 out");
  });

  it("keeps model, context and usage isolated across two sessions", async () => {
    const selectionA = resolvedSelection({
      preset: "model-a",
      model: "model-a",
      contextWindowTokens: 128_000,
      snapshotProvider: { id: "provider-a" },
    });
    const selectionB = resolvedSelection({
      preset: "model-b",
      model: "model-b",
      contextWindowTokens: 256_000,
      snapshotProvider: { id: "provider-b" },
    });
    const sessionA = {
      metadata: { modelSelection: persistedModelSelection(selectionA) },
      messages: [{ role: "user", content: "a" }],
    };
    const sessionB = {
      metadata: { modelSelection: persistedModelSelection(selectionB) },
      messages: [{ role: "user", content: "b" }, { role: "user", content: "b2" }],
    };
    const lastUsageBySession = new Map([
      ["websocket:chat-a", { prompt_tokens: 101, completion_tokens: 11 }],
      ["websocket:chat-b", { prompt_tokens: 202, completion_tokens: 22 }],
    ]);
    const selections = new Map([
      ["model-a", selectionA],
      ["model-b", selectionB],
    ]);
    const loop = {
      sessions: {
        getOrCreate: vi.fn((key: string) => key.endsWith("chat-a") ? sessionA : sessionB),
      },
      resolveTurnModelSelection: vi.fn((input: any) => (
        selections.get(input.committedSelection?.presetId) ?? null
      )),
      consolidator: {
        withProviderSnapshot: vi.fn((_provider: any, model: string) => ({
          estimateSessionPromptTokens: vi.fn(() => [model === "model-a" ? 12_345 : 67_890, "test"]),
        })),
      },
      lastUsageBySession,
      startTime: Date.now() / 1000,
    };

    const responseA = await cmdStatus(statusContext(sessionA, loop, "chat-a"));
    const responseB = await cmdStatus(statusContext(sessionB, loop, "chat-b"));

    expect(responseA.content).toContain("Model: openai / model-a");
    expect(responseA.content).toContain("Last run tokens: 101 in / 11 out");
    expect(responseA.content).toContain("Context: ~12k / 128k");
    expect(responseA.content).toContain("Conversation: 1 user turn");
    expect(responseA.content).not.toContain("model-b");
    expect(responseB.content).toContain("Model: openai / model-b");
    expect(responseB.content).toContain("Last run tokens: 202 in / 22 out");
    expect(responseB.content).toContain("Context: ~67k / 256k");
    expect(responseB.content).toContain("Conversation: 2 user turns");
    expect(responseB.content).not.toContain("model-a");
  });
});
