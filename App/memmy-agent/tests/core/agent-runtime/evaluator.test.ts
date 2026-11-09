import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../../../src/providers/anthropic-provider.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { evaluateResponse } from "../../../src/utils/evaluator.js";
import { redirectLibLogging, redirectedLoggers } from "../../../src/utils/logging-bridge.js";
import { renderTemplate } from "../../../src/utils/prompt-templates.js";
import {
  ensureNonemptyToolResult,
  externalLookupSignature,
  repeatedExternalLookupError,
  repeatedWorkspaceViolationError,
  workspaceViolationSignature,
} from "../../../src/utils/runtime.js";

class EvalProvider extends LLMProvider {
  response: LLMResponse;
  lastArgs: any = null;
  constructor(response: LLMResponse) {
    super();
    this.response = response;
  }
  async chat(args: any): Promise<LLMResponse> {
    this.lastArgs = args;
    return this.response;
  }
  getDefaultModel(): string {
    return "eval-model";
  }
}

describe("prompt templates and evaluator", () => {
  it.each(["catalog", "provider-fallback"] as const)("keeps %s capabilities on evaluator retries while retaining its explicit output limit", async (mode) => {
    const provider = new EvalProvider(new LLMResponse({ content: "ok" }));
    const modelCapabilities = Object.freeze({ mode, maxTokens: 16384, contextWindowTokens: 128000 });
    await evaluateResponse("Task result", "Task", provider, "gpt-4o", { provider, model: "gpt-4o", modelCapabilities });
    expect(provider.lastArgs.modelCapabilities).toMatchObject({ mode, maxTokens: 16384, taskMaxTokens: 256 });
    expect(modelCapabilities.maxTokens).toBe(16384);
  });
  it("uses the Anthropic notification verdict with always-on thinking and a short output allowance", async () => {
    const provider = new AnthropicProvider({ apiKey: "test", defaultModel: "claude-opus-4-7" });
    const create = vi.fn(async () => ({ content: [{ type: "tool_use", id: "eval", name: "evaluate_notification", input: { should_notify: false } }], stop_reason: "tool_use" }));
    provider.client = { messages: { create } };
    const modelCapabilities = { mode: "catalog" as const, maxTokens: 8192, thinkingEnabled: true, reasoningEffort: "high" };
    await expect(evaluateResponse("Routine result", "Task", provider, "claude-opus-4-7", { provider, model: "claude-opus-4-7", modelCapabilities })).resolves.toBe(false);
    expect(create).toHaveBeenCalledOnce();
    const body = (create.mock.calls[0] as unknown as [Record<string, any>])[0];
    expect(body.max_tokens).toBe(8192);
    expect(body.thinking.budget_tokens).toBe(8192 - 256);
  });
  it("renders evaluator template branches and variables", () => {
    const system = renderTemplate("agent/evaluator.md", { part: "system", strip: true });
    const user = renderTemplate("agent/evaluator.md", { part: "user", task_context: "check build", response: "all good" });

    expect(system).toContain("notification gate");
    expect(system).not.toContain("Original task");
    expect(user).toContain("check build");
    expect(user).toContain("all good");
  });

  it("uses evaluate_notification tool calls and defaults to notify on failures", async () => {
    const provider = new EvalProvider(
      new LLMResponse({
        content: "",
        toolCalls: [new ToolCallRequest({ id: "eval", name: "evaluate_notification", arguments: { should_notify: false } })],
      }),
    );

    await expect(evaluateResponse("nothing changed", "check task", provider, "model")).resolves.toBe(false);
    expect(provider.lastArgs.messages[0].content).toContain("notification gate");
    expect(provider.lastArgs.tools[0].function.name).toBe("evaluate_notification");

    await expect(evaluateResponse("important", "task", null, "model")).resolves.toBe(true);
  });
});

describe("runtime helpers", () => {
  it("fills empty tool results and builds goal continuation prompts", () => {
    expect(ensureNonemptyToolResult("shell", "")).toBe("(shell completed with no output)");
    expect(ensureNonemptyToolResult("read", [{ type: "text", text: "   " }])).toBe("(read completed with no output)");
    expect(ensureNonemptyToolResult("read", "ok")).toBe("ok");
  });

  it("throttles repeated external lookups and workspace violations by signature", () => {
    const seen: Record<string, number> = {};
    expect(externalLookupSignature("web_fetch", { url: "HTTPS://Example.com/A" })).toBe("web_fetch:https://example.com/a");
    expect(repeatedExternalLookupError("web_fetch", { url: "https://example.com/a" }, seen)).toBeNull();
    expect(repeatedExternalLookupError("web_fetch", { url: "https://example.com/a" }, seen)).toBeNull();
    expect(repeatedExternalLookupError("web_fetch", { url: "https://example.com/a" }, seen)).toContain("repeated external lookup blocked");

    const violations: Record<string, number> = {};
    const sig = workspaceViolationSignature("exec", { command: "cat /etc/passwd" });
    expect(sig).toContain("violation:/etc/passwd");
    expect(repeatedWorkspaceViolationError("exec", { command: "cat /etc/passwd" }, violations)).toBeNull();
    expect(repeatedWorkspaceViolationError("exec", { command: "cat /etc/passwd" }, violations)).toBeNull();
    expect(repeatedWorkspaceViolationError("exec", { command: "cat /etc/passwd" }, violations)).toContain("workspace-bypass");
  });
});

describe("logging bridge", () => {
  it("tracks redirected library loggers", () => {
    const bridge = redirectLibLogging("nio", "WARNING");
    expect(bridge.libName).toBe("nio");
    expect(redirectedLoggers()).toEqual(expect.objectContaining({ nio: "WARNING" }));
  });
});
