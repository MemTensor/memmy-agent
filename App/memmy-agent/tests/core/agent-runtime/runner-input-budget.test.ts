import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunSpec, AgentRunner } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { convertMessages } from "../../../src/providers/openai-responses/converters.js";
import { estimatePromptTokens } from "../../../src/utils/helpers.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1QAAAAASUVORK5CYII=";
const roots: string[] = [];

function isolateMedia(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-runner-image-budget-"));
  roots.push(root);
  vi.stubEnv("MEMMY_AGENT_DATA_DIR", root);
  return root;
}

function exchange(id: string, content: any, name = "inspect"): Record<string, any>[] {
  return [
    { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", tool_call_id: id, name, content },
  ];
}

function provider() {
  return {
    chatWithRetry: vi.fn(async () => new LLMResponse({ content: "done" })),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentRunner model input budget", () => {
  it("fits a large current turn without dropping the user, newest screenshot or a multi-call exchange", async () => {
    const screenshot = { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } };
    const messages: Record<string, any>[] = [
      { role: "system", content: "Follow the user's authorization and preserve privacy boundaries." },
      { role: "user", content: "Inspect the browser and explain the result without submitting anything." },
      ...Array.from({ length: 8 }, (_, index) => exchange(`old-${index}`, `Observation ${index}: ${"page details ".repeat(1200)}`)).flat(),
      {
        role: "assistant", content: null,
        tool_calls: [
          { id: "latest-image", type: "function", function: { name: "browser_take_screenshot", arguments: "{}" } },
          { id: "latest-status", type: "function", function: { name: "browser_snapshot", arguments: "{}" } },
        ],
      },
      { role: "tool", name: "browser_take_screenshot", tool_call_id: "latest-image", content: [screenshot] },
      { role: "tool", name: "browser_snapshot", tool_call_id: "latest-status", content: "Latest browser status" },
      ...exchange("last-result", "Ready to explain the result"),
    ];
    const original = structuredClone(messages);
    const llm = provider();
    const result = await new AgentRunner(llm as any).run(new AgentRunSpec({
      messages, provider: llm as any, model: "gpt-4.1", maxIterations: 1,
      contextWindowTokens: 20_000, maxTokens: 100, contextBlockLimit: 6_000,
    }));

    expect(estimatePromptTokens(messages)).toBeGreaterThan(6_000);
    expect(result.stopReason).toBe("completed");
    expect(llm.chatWithRetry).toHaveBeenCalledOnce();
    const request = (llm.chatWithRetry.mock.calls[0] as unknown as [any])[0].messages;
    expect(estimatePromptTokens(request)).toBeLessThanOrEqual(6_000);
    expect(request).toContainEqual(original[1]);
    expect(request).toContainEqual(original.find((message) => message.tool_call_id === "latest-image"));
    expect(request).toContainEqual(original.find((message) => message.tool_call_id === "latest-status"));
    expect(request).toContainEqual(original.at(-1));
    const declared = request.flatMap((message: any) => message.tool_calls?.map((call: any) => call.id) ?? []);
    const fulfilled = request.filter((message: any) => message.role === "tool").map((message: any) => message.tool_call_id);
    expect(fulfilled.sort()).toEqual(declared.sort());
    expect(request.length).toBeLessThan(messages.length);
    expect(messages).toEqual(original);
    expect(result.messages.slice(0, messages.length)).toEqual(original);
    const [instructions] = convertMessages(request);
    expect(instructions).toContain(original[0].content);
    expect(instructions).toContain("omitted to fit the model input budget");
  });

  it.each(["user", "system", "tools"])("rejects an irreducible oversized %s input before calling the provider", async (largePart) => {
    const large = "Required input content ".repeat(2000);
    const llm = provider();
    const tools = { getDefinitions: () => largePart === "tools" ? [{ type: "function", function: { name: "inspect", description: large } }] : [] };
    const messages = [
      { role: "system", content: largePart === "system" ? large : "system" },
      { role: "user", content: largePart === "user" ? large : "Inspect this" },
    ];
    const result = await new AgentRunner(llm as any).run(new AgentRunSpec({
      messages, provider: llm as any, tools: tools as any, model: "gpt-4.1", maxIterations: 5,
      contextWindowTokens: 10_000, maxTokens: 100, contextBlockLimit: 1_000,
    }));
    expect(result.stopReason).toBe("error");
    expect(result.content).toContain("too large to send safely");
    expect(result.response).toMatchObject({ errorCode: "context_length_exceeded", errorShouldRetry: false });
    expect(llm.chatWithRetry).not.toHaveBeenCalled();
  });

  it("keeps the latest screenshot and blocks a request when that required image alone cannot fit", async () => {
    const llm = provider();
    const messages = [
      { role: "user", content: "Describe the latest screenshot" },
      ...exchange("screenshot", [{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }], "browser_take_screenshot"),
    ];
    const result = await new AgentRunner(llm as any).run(new AgentRunSpec({
      messages, provider: llm as any, model: "gpt-4.1", maxIterations: 1,
      contextWindowTokens: 10_000, maxTokens: 100, contextBlockLimit: 1_000,
    }));
    expect(llm.chatWithRetry).not.toHaveBeenCalled();
    expect(result.response.errorCode).toBe("context_length_exceeded");
    expect(result.messages.slice(0, messages.length)).toEqual(messages);
  });

  it("normalizes legacy screenshots even after a governance failure and caches artifacts across iterations", async () => {
    const root = isolateMedia();
    const rawImage = { type: "image", mimeType: "image/png", data: PNG };
    const messages = [{ role: "user", content: "Continue inspecting" }, ...exchange("legacy", [rawImage], "browser_take_screenshot")];
    const original = structuredClone(messages);
    const llm = provider();
    llm.chatWithRetry.mockResolvedValueOnce(new LLMResponse({
      content: "checking", toolCalls: [new ToolCallRequest({ id: "followup", name: "inspect", arguments: {} })],
    }));
    const runner = new AgentRunner(llm as any);
    vi.spyOn(runner, "snipHistory").mockImplementation(() => { throw new Error("governance unavailable"); });
    const result = await runner.run(new AgentRunSpec({
      messages, provider: llm as any, model: "unlisted-vision-model", maxIterations: 3,
      actualModelContext: { source: "byok" } as any,
      tools: { getDefinitions: () => [], execute: async () => "current status" } as any,
    }));
    expect(result.content).toBe("done");
    expect(llm.chatWithRetry).toHaveBeenCalledTimes(2);
    for (const [args] of llm.chatWithRetry.mock.calls as unknown as [any][]) {
      const imageResult = args.messages.find((message: any) => message.tool_call_id === "legacy");
      expect(imageResult.content[0]).toMatchObject({ type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } });
      expect(imageResult.content.some((block: any) => block.type === "image")).toBe(false);
    }
    expect(fs.readdirSync(path.join(root, "media", "tool-results"))).toHaveLength(1);
    expect(messages).toEqual(original);
    expect(result.messages.slice(0, messages.length)).toEqual(original);
  });

  it("routes a legacy screenshot through the account text-only image fallback before the main model", async () => {
    isolateMedia();
    const imageFallback = vi.fn(async () => new LLMResponse({ content: "A browser page showing the selected product." }));
    const llm = { ...provider(), supportsAccountImageTextFallback: () => true, runAccountImageTextFallback: imageFallback };
    const result = await new AgentRunner(llm as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Describe this" }, ...exchange("legacy", [{ type: "image", mimeType: "image/png", data: PNG }])],
      provider: llm as any, model: "deepseek-v4-pro", actualModelContext: { source: "account", provider: "memmy_account", model: "deepseek-v4-pro" } as any,
      contextWindowTokens: 10_000, maxTokens: 100, contextBlockLimit: 1_000,
    }));
    expect(result.content).toBe("done");
    expect(imageFallback).toHaveBeenCalledOnce();
    expect(llm.chatWithRetry).toHaveBeenCalledOnce();
    const mainRequest = (llm.chatWithRetry.mock.calls[0] as unknown as [any])[0].messages;
    expect(JSON.stringify(mainRequest)).not.toContain(PNG);
    expect(JSON.stringify(mainRequest)).toContain("selected product");
  });

  it("checks the appended max-iterations finalization prompt before sending another request", async () => {
    const llm = provider();
    llm.chatWithRetry.mockResolvedValueOnce(new LLMResponse({
      content: "checking", toolCalls: [new ToolCallRequest({ id: "last-tool", name: "inspect", arguments: {} })],
    }));
    const result = await new AgentRunner(llm as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "Inspect this" }], provider: llm as any,
      model: "gpt-4.1", maxIterations: 1, maxIterationsFinalPrompt: "Required finalization instructions ".repeat(2000),
      contextWindowTokens: 10_000, maxTokens: 100, contextBlockLimit: 1_000,
      tools: { getDefinitions: () => [], execute: async () => "current status" } as any,
    }));
    expect(llm.chatWithRetry).toHaveBeenCalledOnce();
    expect(result.stopReason).toBe("error");
    expect(result.response.errorCode).toBe("context_length_exceeded");
    expect(result.content).toContain("too large to send safely");
  });

  it("blocks an empty-answer finalization retry if its appended prompt exceeds the remaining budget", async () => {
    const llm = provider();
    llm.chatWithRetry.mockResolvedValue(new LLMResponse({ content: "" }));
    const messages = [{ role: "user", content: "Explain this" }];
    const result = await new AgentRunner(llm as any).run(new AgentRunSpec({
      messages, provider: llm as any, model: "gpt-4.1", maxIterations: 5,
      contextWindowTokens: 10_000, maxTokens: 100, contextBlockLimit: estimatePromptTokens(messages),
    }));
    expect(llm.chatWithRetry).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe("error");
    expect(result.response.errorCode).toBe("context_length_exceeded");
  });
});
