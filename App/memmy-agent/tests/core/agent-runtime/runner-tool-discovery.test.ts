import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { ToolDiscovery, definitionName } from "../../../src/core/agent-runtime/tool-discovery.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { Tool } from "../../../src/core/agent-runtime/tools/base.js";
import { createManagedExecutionScope, withManagedExecution } from "../../../src/core/agent-runtime/managed-execution.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { estimatePromptTokens } from "../../../src/utils/helpers.js";
import { convertTools } from "../../../src/providers/openai-responses/converters.js";
import { AnthropicProvider } from "../../../src/providers/anthropic-provider.js";

class CalendarTool extends Tool {
  get name() { return "calendar_events"; }
  get description() { return "Search calendar meetings 日历会议"; }
  get parameters() { return { type: "object", properties: { day: { type: "string" } }, required: ["day"] }; }
  execute = vi.fn(async () => "meeting at noon");
}
function call(name: string, args: Record<string, any>) {
  return new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: crypto.randomUUID(), name, arguments: args })] });
}
function setup(responses: LLMResponse[]) {
  const registry = new ToolRegistry();
  const calendar = new CalendarTool();
  registry.register(calendar);
  const requests: Record<string, any>[] = [];
  let lastEstimatedTools: any;
  const provider = {
    estimatePromptTokens: vi.fn((messages, tools) => {
      lastEstimatedTools = tools;
      return [estimatePromptTokens(messages, tools), "test"];
    }),
    chatWithRetry: vi.fn(async args => {
      expect(args.tools).toBe(lastEstimatedTools);
      requests.push(args);
      return responses.shift() ?? new LLMResponse({ content: "done" });
    }),
  };
  const spec = new AgentRunSpec({ tools: registry, provider: provider as any,
    messages: [{ role: "user", content: "Find tomorrow's meetings" }],
    maxIterations: 6, contextWindowTokens: 32_000, maxTokens: 100 });
  return { registry, calendar, requests, provider, spec };
}

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("runner tool discovery", () => {
  it("searches, exposes a complete schema in the next request, and executes through the existing registry", async () => {
    const { calendar, requests, spec } = setup([
      call("tool_search", { query: "日历会议", limit: 1 }),
      call("calendar_events", { day: "tomorrow" }),
    ]);
    const result = await new AgentRunner().run(spec);
    expect(result.stopReason).toBe("completed");
    expect(requests[0].tools.map(definitionName)).toEqual(["tool_search"]);
    expect(requests[1].tools.map(definitionName)).toEqual(["tool_search", "calendar_events"]);
    expect(requests[2].tools).toEqual(requests[1].tools);
    expect(requests[1].tools[1].function.parameters.required).toEqual(["day"]);
    expect(calendar.execute).toHaveBeenCalledOnce();
    const output = requests[1].messages.find((message: any) => message.role === "tool");
    expect(output.content).not.toContain('"parameters"');
    for (const request of requests) {
      expect(convertTools(request.tools).map(tool => tool.name)).toEqual(request.tools.map(definitionName));
      expect(AnthropicProvider.convertTools(request.tools)?.map(tool => tool.name)).toEqual(request.tools.map(definitionName));
    }
  });

  it("clears activated schemas after compaction and supports discovering them again", async () => {
    const { requests, spec } = setup([
      call("tool_search", { query: "calendar_events", limit: 1 }),
      call("tool_search", { query: "calendar_events", limit: 1 }),
      call("calendar_events", { day: "tomorrow" }),
    ]);
    spec.currentTurnMessageStartIndex = 0;
    spec.beforeFollowupModelRequest = async context => context.iteration === 1
      ? { messages: [{ role: "system", content: "Compacted prior context" }, ...context.currentTurnMessages] } : null;
    await new AgentRunner().run(spec);
    expect(requests[1].tools.map(definitionName)).toEqual(["tool_search"]);
    expect(requests[1].tools[0].function.description).toContain("After context compaction");
    expect(requests[2].tools.map(definitionName)).toContain("calendar_events");
  });

  it("keeps independent concurrent runs isolated", async () => {
    const a = setup([call("tool_search", { query: "calendar_events" })]);
    const b = setup([]);
    await Promise.all([new AgentRunner().run(a.spec), new AgentRunner().run(b.spec)]);
    expect(a.requests[1].tools.map(definitionName)).toContain("calendar_events");
    expect(b.requests[0].tools.map(definitionName)).not.toContain("calendar_events");
  });

  it("allows known calls without discovery but validates parameters before execution", async () => {
    const { calendar, requests, spec } = setup([call("calendar_events", {}), call("calendar_events", { day: "today" })]);
    await new AgentRunner().run(spec);
    expect(calendar.execute).toHaveBeenCalledOnce();
    expect(requests[1].messages.at(-1).content).toContain("tool_search");
    expect(requests[0].tools.map(definitionName)).not.toContain("calendar_events");
  });

  it("searches Host definitions locally and still sends business calls to Host for approval", async () => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    const fetch = vi.fn(async () => Response.json({ decision: "deny", reason: "denied_by_policy" }));
    vi.stubGlobal("fetch", fetch);
    const { calendar, requests, spec } = setup([
      call("tool_search", { query: "host_invoice", limit: 1 }),
      call("host_invoice", { id: "invoice-1" }),
    ]);
    const scope = createManagedExecutionScope({ protocol: 2, url: "http://127.0.0.1:12345/authorize", token: "a".repeat(64),
      tools: [{ name: "host_invoice", description: "Read invoices", inputSchema: { type: "object", properties: { id: { type: "string" } } } }],
    }, new AbortController().signal);
    await withManagedExecution(scope, () => new AgentRunner().run(spec));
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).toolName).toBe("host_invoice");
    expect(requests[1].tools.map(definitionName)).toEqual(["tool_search", "host_invoice"]);
    expect(requests[2].messages.at(-1).content).toContain("denied_by_policy");
    expect(calendar.execute).not.toHaveBeenCalled();
  });

  it("prunes removed active tools on the next request", async () => {
    const { registry, requests, spec } = setup([call("tool_search", { query: "calendar_events" })]);
    spec.toolDiscovery = new ToolDiscovery();
    spec.currentTurnMessageStartIndex = 0;
    spec.beforeFollowupModelRequest = async () => { registry.unregister("calendar_events"); return null; };
    await new AgentRunner().run(spec);
    expect(requests[1].tools).toEqual([]);
  });
});
