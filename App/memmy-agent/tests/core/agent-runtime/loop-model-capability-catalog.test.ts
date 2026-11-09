import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { AnthropicProvider } from "../../../src/providers/anthropic-provider.js";
import { createRuntimeModelCapabilityCatalog } from "../../../src/providers/model-capability-catalog.js";
import { InboundMessage } from "../../../src/core/runtime-messages/events.js";

const catalog = {
  catalogVersion: 21,
  models: { "gpt-6-sol": {
    inputModalities: ["text", "image"], contextWindowTokens: 1050000, maxTokens: 128000,
    thinking: { switchable: true, defaultEnabled: true, levels: ["low", "medium", "high"], defaultLevel: "medium" },
  } },
};

describe("AgentLoop model capability catalog boundaries", () => {
  let directory: string;
  let catalogPath: string;
  const calls: any[] = [];
  const fetchImpl = vi.fn<typeof fetch>();
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-catalog-"));
    catalogPath = path.join(directory, "models.json");
    calls.length = 0;
    fetchImpl.mockReset();
    fs.writeFileSync(path.join(directory, "runtime.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:18999", localToken: "test-token" }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function loop(chat = async (_args: any) => new LLMResponse({ content: "ok" })) {
    const provider = {
      generation: { maxTokens: 4096, reasoningEffort: null }, spec: { name: "openai" },
      getDefaultModel: () => "gpt-6-sol",
      chat: vi.fn(async (args: any) => { calls.push(args); return chat(args); }),
    };
    const modelCapabilityCatalog = createRuntimeModelCapabilityCatalog({ catalogPath, runtimeConfigPath: path.join(directory, "runtime.json"), fetchImpl });
    const agent = new AgentLoop({
      provider, model: "gpt-6-sol", workspace: directory, sessionDir: path.join(directory, "sessions"),
      config: new Config({ agents: { defaults: { provider: "openai", model: "gpt-6-sol" } }, memmyMemory: { enabled: false } }),
      modelCapabilityCatalog,
    });
    return { agent, provider, modelCapabilityCatalog };
  }
  const save = (value: unknown) => fs.writeFileSync(catalogPath, JSON.stringify(value));

  it("keeps capabilities fixed across tool requests and uses a new version on the next turn", async () => {
    save(catalog);
    fs.writeFileSync(path.join(directory, "sample.txt"), "sample");
    const { agent } = loop(async () => {
      if (calls.length === 1) {
        save({ ...catalog, catalogVersion: 22, models: { "gpt-6-sol": { ...catalog.models["gpt-6-sol"], maxTokens: 64000,
          thinking: { switchable: true, defaultEnabled: true, levels: ["high"], defaultLevel: "high" } } } });
        return new LLMResponse({ content: null, finishReason: "tool_calls", toolCalls: [new ToolCallRequest({ id: "read-1", name: "read_file", arguments: { path: path.join(directory, "sample.txt") } })] });
      }
      return new LLMResponse({ content: "ok" });
    });
    expect((await agent.processDirect("Read sample.txt", { sessionKey: "cli:catalog" }))?.content).toBe("ok");
    expect(calls.length).toBe(2);
    expect(calls.map((args) => [args.maxTokens, args.reasoningEffort, args.modelCapabilities.catalogVersion]))
      .toEqual([[128000, "medium", 21], [128000, "medium", 21]]);
    await agent.processDirect("Again", { sessionKey: "cli:catalog" });
    expect(calls[2]).toMatchObject({ maxTokens: 64000, reasoningEffort: "high", modelCapabilities: { catalogVersion: 22 } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("coordinates synchronization before sending the first Provider request", async () => {
    fetchImpl.mockImplementationOnce(async () => {
      expect(calls).toHaveLength(0);
      save(catalog);
      return Response.json({ status: "synced", hasValidCatalog: true, catalogVersion: 21 });
    });
    const { agent } = loop();
    await agent.processDirect("hello", { sessionKey: "cli:catalog" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ maxTokens: 128000, reasoningEffort: "medium" });
  });

  it.each([true, false])("prepares background titles with a short output limit and honors switchable=%s", async (switchable) => {
    save({ ...catalog, models: { "gpt-6-sol": { ...catalog.models["gpt-6-sol"], thinking: {
      ...catalog.models["gpt-6-sol"].thinking, switchable
    } } } });
    const { agent, provider } = loop();
    const captured = agent.llmRuntime();
    const prepared = await captured.prepare!({ maxTokens: 96, thinkingEnabled: false });
    expect(prepared.provider).toBe(provider);
    expect(prepared.modelCapabilities).toMatchObject({ maxTokens: 128000, taskMaxTokens: 96, catalogVersion: 21,
      thinkingEnabled: !switchable, reasoningEffort: switchable ? "none" : "medium" });
    save({ ...catalog, catalogVersion: 22 });
    expect((await agent.llmRuntime().prepare!()).modelCapabilities?.catalogVersion).toBe(22);
    expect(prepared.modelCapabilities?.catalogVersion).toBe(21);
  });

  it("reserves thinking and short title output inside the prepared Anthropic model limit", async () => {
    save({ ...catalog, models: { "gpt-6-sol": { ...catalog.models["gpt-6-sol"], maxTokens: 8192,
      thinking: { switchable: false, defaultEnabled: true, levels: ["high"], defaultLevel: "high" } } } });
    const { agent } = loop();
    const prepared = await agent.llmRuntime().prepare!({ maxTokens: 96, thinkingEnabled: false });
    const provider = new AnthropicProvider({ apiKey: "test", defaultModel: "claude-opus-4-7" });
    const body = provider.buildKwargs({ messages: [{ role: "user", content: "Generate title" }], modelCapabilities: prepared.modelCapabilities });
    expect(body.max_tokens).toBe(8192);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 - 96 });
  });

  it.each([false, true])("prepares idle archives before modifying a session; coordination failure=%s", async (fails) => {
    if (!fails) save(catalog);
    else fetchImpl.mockRejectedValue(new Error("Local Backend unavailable"));
    const { agent, provider } = loop();
    (provider as any).chatWithRetry = provider.chat;
    agent.consolidator.summaryMode = "text";
    const key = "cli:idle-catalog";
    const session = agent.sessions.getOrCreate(key);
    for (let index = 0; index < 12; index++) session.addMessage(index % 2 ? "assistant" : "user", `message ${index}`);
    agent.sessions.save(session);
    const before = JSON.stringify(session.messages);
    await agent.autoCompact.archiveExpiredSession(key);
    if (fails) {
      expect(calls).toHaveLength(0);
      expect(JSON.stringify(agent.sessions.loadSession(key)?.messages)).toBe(before);
    } else {
      expect(calls[0]).toMatchObject({ model: "gpt-6-sol", modelCapabilities: { catalogVersion: 21, maxTokens: 128000 } });
      expect(agent.sessions.loadSession(key)?.messages.length).toBeLessThan(12);
    }
  });

  it.each(["cli", "system"])("passes the frozen turn snapshot to %s compaction", async (channel) => {
    save(catalog);
    const { agent } = loop();
    const scope = vi.spyOn(agent.consolidator, "withProviderSnapshot");
    await agent.processMessage(new InboundMessage({ channel, chatId: "catalog", content: "hello" }));
    expect(scope).toHaveBeenCalledOnce();
    const scoped = scope.mock.results[0].value;
    expect(scoped.modelCapabilities).toBe(calls[0].modelCapabilities);
    expect(scoped.capabilityCatalogState).toBe(calls[0].capabilityCatalogState);
    expect(scoped.maxCompletionTokens).toBe(128000);
    expect(scoped.contextWindowTokens).toBe(1050000);
  });

  it("calls the current Provider without optional defaults after explicit retry exhaustion", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ status: "retries-exhausted", hasValidCatalog: false }));
    const { agent } = loop();
    expect((await agent.processDirect("hello", { sessionKey: "cli:catalog" }))?.content).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("gpt-6-sol");
    expect(calls[0]).not.toHaveProperty("maxTokens");
    expect(calls[0]).not.toHaveProperty("reasoningEffort");
    expect(calls[0].modelCapabilities).toEqual({ mode: "provider-fallback" });
  });

  it("marks a fallback failure and preserves the actual Provider detail", async () => {
    fetchImpl.mockResolvedValueOnce(Response.json({ status: "retries-exhausted", hasValidCatalog: false }));
    const { agent } = loop(async () => new LLMResponse({
      content: "actual upstream error", finishReason: "error", errorCategory: "quota_exhausted", errorShouldRetry: false,
    }));
    const result = await agent.processDirect("hello", { sessionKey: "cli:catalog" });
    expect(result?.metadata?.modelErrorContext).toMatchObject({ origin: "model_catalog_fallback" });
    expect(result?.metadata?.modelErrorDetail).toBe("actual upstream error");
  });

  it("leaves an ordinary directory-mode failure unmarked", async () => {
    save(catalog);
    const { agent } = loop(async () => new LLMResponse({ content: "actual upstream error", finishReason: "error", errorCategory: "quota_exhausted", errorShouldRetry: false }));
    const result = await agent.processDirect("hello", { sessionKey: "cli:catalog" });
    expect(result?.metadata?.modelErrorContext).not.toHaveProperty("origin");
  });

  it("takes the same catalog path for internal system turns", async () => {
    save(catalog);
    const { agent } = loop();
    await agent.processMessage(new InboundMessage({ channel: "system", chatId: "cli:catalog", content: "Background follow-up" }));
    expect(calls[0]).toMatchObject({ maxTokens: 128000, modelCapabilities: { catalogVersion: 21 } });
  });

  it("reads the catalog during startup before runtime tools initialize", async () => {
    save(catalog);
    const { agent, modelCapabilityCatalog } = loop();
    const load = vi.spyOn(modelCapabilityCatalog, "load");
    vi.spyOn(agent, "initializeRuntimeTools").mockImplementation(async () => { expect(load).toHaveBeenCalledTimes(1); agent.running = false; });
    await agent.run();
    expect(load).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });
});
