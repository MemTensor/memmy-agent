import { describe, expect, it, vi } from "vitest";
import { AgentHookContext } from "../../../../src/core/agent-runtime/hook.js";
import { SubagentHook, SubagentStatus } from "../../../../src/core/agent-runtime/subagent.js";
import { MyTool } from "../../../../src/core/agent-runtime/tools/self.js";

function runtime(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    model: "anthropic/claude-sonnet",
    modelPreset: null,
    maxIterations: 40,
    contextWindowTokens: 200_000,
    workspace: "/tmp/workspace",
    providerRetryMode: "standard",
    maxToolResultChars: 16_000,
    currentIteration: 2,
    lastUsage: { prompt_tokens: 100, completion_tokens: 50 },
    runtimeVars: {},
    webConfig: { enable: true, search: { provider: "tavily", apiKey: "sk-secret", maxResults: 5 } },
    execConfig: { enable: true, sandbox: "" },
    subagents: { taskStatuses: new Map() },
    syncSubagentRuntimeLimits: vi.fn(),
    ...overrides,
  };
}

describe("MyTool runtime inspection", () => {
  it("summarizes key runtime fields and scratchpad values", async () => {
    const state = runtime({ runtimeVars: { task: "review" } });
    const result = await new MyTool({ runtimeState: state }).execute({ action: "check" });
    expect(result).toContain("maxIterations: 40");
    expect(result).toContain("contextWindowTokens: 200000");
    expect(result).toContain("providerRetryMode");
    expect(result).toContain("lastUsage");
    expect(result).toContain("scratchpad");
  });

  it("checks a simple runtime value", async () => {
    const result = await new MyTool({ runtimeState: runtime() }).execute({
      action: "check",
      key: "model",
    });

    expect(result).toContain("anthropic/claude-sonnet");
  });

  it("returns not found for missing runtime values", async () => {
    const result = await new MyTool({ runtimeState: runtime() }).execute({
      action: "check",
      key: "doesNotExist",
    });

    expect(result).toContain("not found");
  });

  it("reports an empty scratchpad distinctly", async () => {
    const result = await new MyTool({ runtimeState: runtime() }).execute({
      action: "check",
      key: "scratchpad",
    });

    expect(result).toBe("scratchpad is empty");
  });

  it("falls back to scratchpad values during inspection", async () => {
    const result = await new MyTool({ runtimeState: runtime({ runtimeVars: { note: "remember" } }) }).execute({
      action: "check",
      key: "note",
    });

    expect(result).toContain("remember");
  });

  it("shows current iteration in direct and summary inspection", async () => {
    const tool = new MyTool({ runtimeState: runtime({ currentIteration: 7 }) });

    expect(await tool.execute({ action: "check", key: "currentIteration" })).toContain("7");
    expect(await tool.execute({ action: "check" })).toContain("currentIteration");
  });

  it("omits last usage from summary when it is empty", async () => {
    const result = await new MyTool({ runtimeState: runtime({ lastUsage: {} }) }).execute({
      action: "check",
    });

    expect(result).not.toContain("lastUsage");
  });

  it("supports dot-path checks and redacts sensitive fields in objects", async () => {
    const tool = new MyTool({ runtimeState: runtime() });
    expect(await tool.execute({ action: "check", key: "lastUsage.prompt_tokens" })).toContain("100");
    const web = await tool.execute({ action: "check", key: "webConfig.search" });
    expect(web).toContain("tavily");
    expect(web).not.toContain("sk-secret");
    expect(web.toLowerCase()).not.toContain("apikey");
    expect(await tool.execute({ action: "check", key: "webConfig.search.apiKey" })).toContain("not accessible");
  });

  it("blocks protected internals and denied attributes", async () => {
    const tool = new MyTool({ runtimeState: runtime() });
    expect(await tool.execute({ action: "check", key: "bus" })).toContain("not accessible");
    expect(await tool.execute({ action: "set", key: "provider", value: null })).toContain("protected");
    expect(await tool.execute({ action: "set", key: "constructor", value: "evil" })).toContain("protected");
    expect(await tool.execute({ action: "set", key: "providerRetryMode.__proto__", value: {} })).toContain("not accessible");
  });

  it("blocks mutable loop routing internals", async () => {
    const tool = new MyTool({ runtimeState: runtime({ pendingQueues: {}, sessionLocks: {}, activeTasks: {}, running: true }) });

    for (const key of ["pendingQueues", "sessionLocks", "activeTasks", "running"]) {
      expect(await tool.execute({ action: "check", key })).toContain("not accessible");
      expect(await tool.execute({ action: "set", key, value: {} })).toContain("protected");
    }
  });

  it("redacts sensitive nested fields but allows non-sensitive siblings", async () => {
    const tool = new MyTool({ runtimeState: runtime({ service: { apiKey: "sk-secret", token: "tok", endpoint: "https://example.test" } }) });

    expect(await tool.execute({ action: "check", key: "service.apiKey" })).toContain("not accessible");
    expect(await tool.execute({ action: "check", key: "service.token" })).toContain("not accessible");
    expect(await tool.execute({ action: "check", key: "service.endpoint" })).toContain("https://example.test");
    expect(await tool.execute({ action: "set", key: "service.password", value: "pw" })).toContain("not accessible");
  });

  it("formats subagent status maps through read-only paths", async () => {
    const status = new SubagentStatus({
      taskId: "abc12345",
      label: "read logs",
      taskDescription: "Read the logs",
      phase: "awaitingTools",
      iteration: 3,
      toolEvents: [{ name: "grep", status: "ok", detail: "matched" }],
      usage: { prompt_tokens: 10 },
    });
    const state = runtime();
    state.subagents.taskStatuses.set("abc12345", status);
    const result = await new MyTool({ runtimeState: state }).execute({ action: "check", key: "subagents.taskStatuses.abc12345" });
    expect(result).toContain("read logs");
    expect(result).toContain("awaitingTools");
    expect(result).toContain("grep(ok)");
  });

  it("formats an empty subagent status map", async () => {
    const state = runtime();
    const result = await new MyTool({ runtimeState: state }).execute({
      action: "check",
      key: "subagents.taskStatuses",
    });

    expect(result).toContain("{}");
  });
});

describe("MyTool runtime modification", () => {
  it("validates restricted settings and syncs subagent limits", async () => {
    const state = runtime();
    const tool = new MyTool({ runtimeState: state });
    expect(await tool.execute({ action: "set", key: "maxIterations", value: "80" })).toContain("Set maxIterations = 80");
    expect(state.maxIterations).toBe(80);
    expect(state.syncSubagentRuntimeLimits).toHaveBeenCalled();
    expect(await tool.execute({ action: "set", key: "maxIterations", value: true })).toContain("Error");
    expect(await tool.execute({ action: "set", key: "maxIterations", value: 999 })).toContain("must be <=");
  });

  it("validates contextWindowTokens bounds and integer coercion", async () => {
    const state = runtime();
    const tool = new MyTool({ runtimeState: state });

    expect(await tool.execute({ action: "set", key: "contextWindowTokens", value: "8192" })).toContain(
      "Set contextWindowTokens = 8192",
    );
    expect(state.contextWindowTokens).toBe(8192);
    expect(await tool.execute({ action: "set", key: "contextWindowTokens", value: 100 })).toContain(
      "must be >=",
    );
  });

  it("validates model string updates", async () => {
    const state = runtime();
    const tool = new MyTool({ runtimeState: state });

    expect(await tool.execute({ action: "set", key: "model", value: "openai/gpt-4.1" })).toContain(
      'Set model = "openai/gpt-4.1"',
    );
    expect(state.model).toBe("openai/gpt-4.1");
    expect(await tool.execute({ action: "set", key: "model", value: "" })).toContain(
      "at least",
    );
  });

  it("allows workspace updates as a free-form string", async () => {
    const state = runtime();
    const result = await new MyTool({ runtimeState: state }).execute({
      action: "set",
      key: "workspace",
      value: "/tmp/next",
    });

    expect(result).toContain("Set workspace");
    expect(state.workspace).toBe("/tmp/next");
  });

  it("blocks modification of core runtime internals", async () => {
    const tool = new MyTool({ runtimeState: runtime() });

    expect(await tool.execute({ action: "set", key: "tools", value: {} })).toContain("protected");
    expect(await tool.execute({ action: "set", key: "subagents", value: {} })).toContain("read-only");
    expect(await tool.execute({ action: "set", key: "runner", value: {} })).toContain("protected");
    expect(await tool.execute({ action: "set", key: "sessions", value: {} })).toContain("protected");
    expect(await tool.execute({ action: "set", key: "consolidator", value: {} })).toContain("protected");
    expect(await tool.execute({ action: "set", key: "dream", value: {} })).toContain("protected");
    expect(await tool.execute({ action: "set", key: "context", value: {} })).toContain("protected");
    expect(await tool.execute({ action: "set", key: "commands", value: {} })).toContain("protected");
  });

  it("blocks modification of security-sensitive runtime config", async () => {
    const tool = new MyTool({ runtimeState: runtime({ restrictToWorkspace: true }) });

    expect(await tool.execute({ action: "set", key: "restrictToWorkspace", value: false })).toContain(
      "protected",
    );
    expect(await tool.execute({ action: "set", key: "execConfig.enabled", value: false })).toContain(
      "read-only",
    );
    expect(await tool.execute({ action: "set", key: "webConfig.search.provider", value: "x" })).toContain(
      "read-only",
    );
  });

  it("rejects unsafe free-form writes but stores JSON-safe scratchpad values", async () => {
    const state = runtime();
    const tool = new MyTool({ runtimeState: state });
    expect(await tool.execute({ action: "set", key: "providerRetryMode", value: 42 })).toContain("expects string");
    expect(await tool.execute({ action: "set", key: "notes", value: { a: [1, 2, 3] } })).toContain("scratchpad.notes");
    expect(state.runtimeVars.notes).toEqual({ a: [1, 2, 3] });
    expect(await tool.execute({ action: "set", key: "bad", value: new Date() })).toContain("unsupported type");
    expect(await tool.execute({ action: "set", key: "fn", value: () => null })).toContain("callable");
    expect(await tool.execute({ action: "set", key: "deep", value: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: "too deep" } } } } } } } } } } } })).toContain("nesting too deep");
  });

  it("accepts JSON-safe array and object scratchpad values", async () => {
    const state = runtime();
    const tool = new MyTool({ runtimeState: state });

    expect(await tool.execute({ action: "set", key: "items", value: ["a", 1, true] })).toContain(
      "scratchpad.items",
    );
    expect(await tool.execute({ action: "set", key: "settings", value: { ok: true } })).toContain(
      "scratchpad.settings",
    );
    expect(state.runtimeVars.items).toEqual(["a", 1, true]);
    expect(state.runtimeVars.settings).toEqual({ ok: true });
  });

  it("rejects nested scratchpad objects with unsupported values", async () => {
    const tool = new MyTool({ runtimeState: runtime() });

    expect(await tool.execute({ action: "set", key: "badNested", value: { child: new Date() } })).toContain(
      "unsupported type",
    );
  });

  it("enforces scratchpad capacity while allowing updates", async () => {
    const state = runtime({ runtimeVars: Object.fromEntries([...Array(64).keys()].map((i) => [`key${i}`, i])) });
    const tool = new MyTool({ runtimeState: state });
    expect(await tool.execute({ action: "set", key: "overflow", value: "x" })).toContain("full");
    expect(await tool.execute({ action: "set", key: "key0", value: "updated" })).toContain("scratchpad.key0");
    expect(state.runtimeVars.key0).toBe("updated");
  });

  it("honors read-only mode", async () => {
    const tool = new MyTool({ runtimeState: runtime(), modifyAllowed: false });
    expect(tool.description).toContain("READ-ONLY MODE");
    expect(await tool.execute({ action: "check", key: "maxIterations" })).toContain("40");
    expect(await tool.execute({ action: "set", key: "maxIterations", value: 80 })).toContain("disabled");
  });

  it("validates keys, unknown actions, and scratchpad capacity", async () => {
    const state = runtime({ runtimeVars: Object.fromEntries([...Array(64).keys()].map((i) => [`key${i}`, i])) });
    const tool = new MyTool({ runtimeState: state });

    expect(await tool.execute({ action: "wat" })).toContain("Unknown action");
    expect(await tool.execute({ action: "set", key: "   ", value: 1 })).toContain("cannot be empty");
    expect(await tool.execute({ action: "set", key: "overflow", value: "x" })).toContain("scratchpad is full");
    expect(await tool.execute({ action: "set", key: "key0", value: "updated" })).toContain("scratchpad.key0");
  });

  it("stores request context channel and chat id", () => {
    const tool = new MyTool({ runtimeState: runtime() });

    tool.setContext({ channel: "telegram", chatId: "123" });

    expect(tool.channel).toBe("telegram");
    expect(tool.chatId).toBe("123");
  });

  it("formats status maps and errors", () => {
    const status = new SubagentStatus({
      taskId: "abc123",
      label: "read logs",
      taskDescription: "Read the logs",
      phase: "running",
      iteration: 2,
      toolEvents: [{ name: "grep", status: "ok", detail: "matched" }],
      usage: { prompt_tokens: 10 },
      error: "boom",
    });

    const text = MyTool.formatValue(new Map([["abc123", status]]), "subagents");

    expect(text).toContain("read logs");
    expect(text).toContain("grep(ok)");
    expect(text).toContain("boom");
  });
});

describe("MyTool parity cases", () => {
  it("summary inspection shows all public runtime description keys", async () => {
    const result = await new MyTool({ runtimeState: runtime() }).execute({ action: "check" });

    for (const key of [
      "maxIterations",
      "contextWindowTokens",
      "model",
      "workspace",
      "providerRetryMode",
      "maxToolResultChars",
      "currentIteration",
      "webConfig",
      "execConfig",
      "subagents",
      "lastUsage",
    ]) {
      expect(result).toContain(key);
    }
  });

  it("blocks dunder inspection", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "__proto__" })).toContain(
      "not accessible",
    );
  });

  it("inspects readable config subfields by dot path", async () => {
    const result = await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "webConfig.enable" });

    expect(result).toContain("true");
  });

  it("blocks denied attributes inside dot paths", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "webConfig.__proto__" })).toContain(
      "not accessible",
    );
  });

  it("blocks inspection of tool internals", async () => {
    expect(await new MyTool({ runtimeState: runtime({ tools: { registered: [] } }) }).execute({ action: "check", key: "tools" })).toContain(
      "not accessible",
    );
  });

  it("accepts restricted maxIterations updates in range", async () => {
    const state = runtime();
    const result = await new MyTool({ runtimeState: state }).execute({ action: "set", key: "maxIterations", value: 80 });

    expect(result).toContain("Set maxIterations = 80");
    expect(state.maxIterations).toBe(80);
  });

  it("rejects restricted maxIterations below range", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "maxIterations", value: 0 })).toContain(
      "must be >=",
    );
  });

  it("rejects restricted maxIterations above range", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "maxIterations", value: 101 })).toContain(
      "must be <=",
    );
  });

  it("rejects non-integer maxIterations values", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "maxIterations", value: 1.5 })).toContain(
      "must be int",
    );
  });

  it("rejects boolean maxIterations values", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "maxIterations", value: true })).toContain(
      "got boolean",
    );
  });

  it("rejects null restricted integer values", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "maxIterations", value: null })).toContain(
      "must be int",
    );
  });

  it("coerces string integers for restricted integer settings", async () => {
    const state = runtime();
    await new MyTool({ runtimeState: state }).execute({ action: "set", key: "maxIterations", value: "70" });

    expect(state.maxIterations).toBe(70);
  });

  it("rejects callable scratchpad values", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "callback", value: () => null })).toContain(
      "callable",
    );
  });

  it("rejects complex scratchpad objects", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "date", value: new Date() })).toContain(
      "unsupported type",
    );
  });

  it("allows scratchpad array values", async () => {
    const state = runtime();
    await new MyTool({ runtimeState: state }).execute({ action: "set", key: "items", value: [1, "two"] });

    expect(state.runtimeVars.items).toEqual([1, "two"]);
  });

  it("allows scratchpad object values", async () => {
    const state = runtime();
    await new MyTool({ runtimeState: state }).execute({ action: "set", key: "meta", value: { step: 2 } });

    expect(state.runtimeVars.meta).toEqual({ step: 2 });
  });

  it("rejects whitespace scratchpad keys", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "   ", value: 1 })).toContain(
      "cannot be empty",
    );
  });

  it("rejects existing string attr type mismatches", async () => {
    expect(await new MyTool({ runtimeState: runtime({ custom: "old" }) }).execute({ action: "set", key: "custom", value: 3 })).toContain(
      "expects string",
    );
  });

  it("rejects existing integer attr type mismatches", async () => {
    expect(await new MyTool({ runtimeState: runtime({ customCount: 1 }) }).execute({ action: "set", key: "customCount", value: "bad" })).toContain(
      "expects number",
    );
  });

  it("blocks MCP server mutation", async () => {
    expect(await new MyTool({ runtimeState: runtime({ mcpServers: {} }) }).execute({ action: "set", key: "mcpServers", value: {} })).toContain(
      "protected",
    );
  });

  it("blocks MCP stack mutation", async () => {
    expect(await new MyTool({ runtimeState: runtime({ mcpStacks: {} }) }).execute({ action: "set", key: "mcpStacks", value: {} })).toContain(
      "protected",
    );
  });

  it("blocks background task mutation", async () => {
    expect(await new MyTool({ runtimeState: runtime({ backgroundTasks: {} }) }).execute({ action: "set", key: "backgroundTasks", value: {} })).toContain(
      "protected",
    );
  });

  it("blocks wrapped attribute mutation", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "__wrapped__", value: {} })).toContain(
      "protected",
    );
  });

  it("blocks closure attribute mutation", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "prototype", value: {} })).toContain(
      "protected",
    );
  });

  it("validates a single JSON-safe array", () => {
    expect(MyTool.validateJsonSafe([1, "two", true, null])).toBeNull();
  });

  it("validates deeply nested JSON values within the limit", () => {
    expect(MyTool.validateJsonSafe({ a: { b: { c: { d: "ok" } } } })).toBeNull();
  });

  it("shows modify warnings when writes are allowed", () => {
    const tool = new MyTool({ runtimeState: runtime() });

    expect(tool.description).toContain("IMPORTANT");
    expect(tool.description).not.toContain("READ-ONLY MODE");
  });

  it("checks runtime vars after setting them", async () => {
    const tool = new MyTool({ runtimeState: runtime() });
    await tool.execute({ action: "set", key: "userPrefersConcise", value: true });

    expect(await tool.execute({ action: "check", key: "userPrefersConcise" })).toContain("true");
  });

  it("checks string runtime vars", async () => {
    const tool = new MyTool({ runtimeState: runtime() });
    await tool.execute({ action: "set", key: "currentProject", value: "memmy" });

    expect(await tool.execute({ action: "check", key: "currentProject" })).toContain("memmy");
  });

  it("checks object runtime vars", async () => {
    const tool = new MyTool({ runtimeState: runtime() });
    await tool.execute({ action: "set", key: "taskMeta", value: { step: 2, total: 5 } });

    const result = await tool.execute({ action: "check", key: "taskMeta" });
    expect(result).toContain("step");
    expect(result).toContain("2");
  });

  it("blocks password subfield inspection", async () => {
    expect(await new MyTool({ runtimeState: runtime({ someConfig: { password: "hunter2" } }) }).execute({ action: "check", key: "someConfig.password" })).toContain(
      "not accessible",
    );
  });

  it("blocks secret subfield inspection", async () => {
    expect(await new MyTool({ runtimeState: runtime({ vault: { secret: "classified" } }) }).execute({ action: "check", key: "vault.secret" })).toContain(
      "not accessible",
    );
  });

  it("blocks token subfield inspection", async () => {
    expect(await new MyTool({ runtimeState: runtime({ authData: { token: "jwt" } }) }).execute({ action: "check", key: "authData.token" })).toContain(
      "not accessible",
    );
  });

  it("blocks top-level sensitive writes", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "apiKey", value: "evil" })).toContain(
      "protected",
    );
  });

  it("allows read-only exec config inspection", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "execConfig" })).not.toContain(
      "Error",
    );
  });

  it("allows read-only web config inspection", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "webConfig" })).not.toContain(
      "Error",
    );
  });

  it("blocks channelsConfig mutation", async () => {
    expect(await new MyTool({ runtimeState: runtime({ channelsConfig: {} }) }).execute({ action: "set", key: "channelsConfig", value: {} })).toContain(
      "protected",
    );
  });

  it("blocks current iteration mutation", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "currentIteration", value: 5 })).toContain(
      "read-only",
    );
  });

  it("shows last usage in summary when it has values", async () => {
    const result = await new MyTool({ runtimeState: runtime() }).execute({ action: "check" });

    expect(result).toContain("lastUsage");
    expect(result).toContain("prompt_tokens");
  });

  it("formats a single subagent status", () => {
    const status = new SubagentStatus({
      taskId: "abc12345",
      label: "read logs and summarize",
      taskDescription: "Read the log files",
      phase: "awaitingTools",
      iteration: 3,
      toolEvents: [
        { name: "read_file", status: "ok", detail: "read app.log" },
        { name: "exec", status: "error", detail: "timeout" },
      ],
      usage: { prompt_tokens: 4500, completion_tokens: 1200 },
    });

    const result = MyTool.formatValue(status);
    expect(result).toContain("abc12345");
    expect(result).toContain("read logs and summarize");
    expect(result).toContain("awaitingTools");
    expect(result).toContain("iteration: 3");
    expect(result).toContain("read_file(ok)");
    expect(result).toContain("exec(error)");
    expect(result).toContain("4500");
  });

  it("updates subagent status after runner iterations", async () => {
    const status = new SubagentStatus({ taskId: "test", label: "test", taskDescription: "test" });
    const hook = new SubagentHook("test", status);

    await hook.afterIteration(
      new AgentHookContext({
        iteration: 5,
        messages: [],
        toolEvents: [{ name: "read_file", status: "ok", detail: "ok" }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );

    expect(status.iteration).toBe(5);
    expect(status.toolEvents[0].name).toBe("read_file");
    expect(status.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50 });
  });

  it("stores subagent hook errors", async () => {
    const status = new SubagentStatus({ taskId: "test", label: "test", taskDescription: "test" });
    const hook = new SubagentHook("test", status);

    await hook.afterIteration(new AgentHookContext({ iteration: 1, messages: [], error: "something went wrong" }));

    expect(status.error).toBe("something went wrong");
  });

  it("does nothing when subagent hook has no status", async () => {
    const hook = new SubagentHook("test");

    await expect(hook.afterIteration(new AgentHookContext({ iteration: 1, messages: [] }))).resolves.toBeUndefined();
  });

  it("updates checkpoint phase and iteration using the subagent callback shape", async () => {
    const status = new SubagentStatus({ taskId: "cp", label: "test", taskDescription: "test" });
    const onCheckpoint = async (payload: Record<string, any>) => {
      status.phase = payload.phase ?? status.phase;
      status.iteration = payload.iteration ?? status.iteration;
    };

    await onCheckpoint({ phase: "awaitingTools", iteration: 2 });
    await onCheckpoint({ phase: "toolsCompleted", iteration: 3 });

    expect(status.phase).toBe("toolsCompleted");
    expect(status.iteration).toBe(3);
  });

  it("preserves checkpoint phase when payload omits it", async () => {
    const status = new SubagentStatus({ taskId: "cp", label: "test", taskDescription: "test", phase: "initializing" });
    const onCheckpoint = async (payload: Record<string, any>) => {
      status.phase = payload.phase ?? status.phase;
      status.iteration = payload.iteration ?? status.iteration;
    };

    await onCheckpoint({ iteration: 1 });

    expect(status.phase).toBe("initializing");
    expect(status.iteration).toBe(1);
  });
});

describe("MyTool one-to-one memmy self tool parity", () => {
  it("inspects current state", async () => {
    const result = await new MyTool({ runtimeState: runtime() }).execute({ action: "check" });
    expect(result).toContain("maxIterations: 40");
    expect(result).toContain("contextWindowTokens: 200000");
  });

  it("includes runtime vars while inspecting", async () => {
    const result = await new MyTool({ runtimeState: runtime({ runtimeVars: { task: "review" } }) }).execute({
      action: "check",
    });
    expect(result).toContain("task");
    expect(result).toContain("review");
  });

  it("inspects a simple value", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "maxIterations" })).toContain("40");
  });

  it("returns an error for blocked inspection", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "bus" })).toContain("not accessible");
  });

  it("returns not found for missing values", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "nonexistentAttrXyz" })).toContain(
      "not found",
    );
  });

  it("inspects object values through dot paths", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "lastUsage.prompt_tokens" })).toContain(
      "100",
    );
  });

  it("blocks provider modification", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "provider", value: null })).toContain(
      "protected",
    );
  });

  it("blocks running flag modification", async () => {
    expect(await new MyTool({ runtimeState: runtime({ running: true }) }).execute({ action: "set", key: "running", value: false })).toContain(
      "protected",
    );
  });

  it("stores new keys in runtime vars", async () => {
    const state = runtime();
    const result = await new MyTool({ runtimeState: state }).execute({ action: "set", key: "myCustomVar", value: "hello" });
    expect(result).toContain("myCustomVar");
    expect(state.runtimeVars.myCustomVar).toBe("hello");
  });

  it("rejects deeply nested values", async () => {
    const deep: Record<string, any> = { level: 0 };
    let current = deep;
    for (let i = 1; i < 15; i += 1) {
      current.child = { level: i };
      current = current.child;
    }
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "deep", value: deep })).toContain(
      "nesting too deep",
    );
  });

  it("rejects maps with non-string keys", async () => {
    const state = runtime();
    const result = await new MyTool({ runtimeState: state }).execute({ action: "set", key: "evil", value: new Map([[42, "value"]]) });
    expect(result).toContain("Error");
    expect(state.runtimeVars.evil).toBeUndefined();
  });

  it("blocks pending queue modification", async () => {
    expect(await new MyTool({ runtimeState: runtime({ pendingQueues: {} }) }).execute({ action: "set", key: "pendingQueues", value: {} })).toContain(
      "protected",
    );
  });

  it("blocks session lock modification", async () => {
    expect(await new MyTool({ runtimeState: runtime({ sessionLocks: {} }) }).execute({ action: "set", key: "sessionLocks", value: {} })).toContain(
      "protected",
    );
  });

  it("blocks active task modification", async () => {
    expect(await new MyTool({ runtimeState: runtime({ activeTasks: {} }) }).execute({ action: "set", key: "activeTasks", value: {} })).toContain(
      "protected",
    );
  });

  it("blocks MCP server inspection", async () => {
    expect(await new MyTool({ runtimeState: runtime({ mcpServers: {} }) }).execute({ action: "check", key: "mcpServers" })).toContain(
      "not accessible",
    );
  });

  it("blocks denied non-dunder keys", async () => {
    const tool = new MyTool({ runtimeState: runtime() });
    for (const key of ["prototype", "constructor"]) {
      expect(await tool.execute({ action: "set", key, value: "evil" })).toContain("protected");
    }
  });

  it("formats status dictionaries", () => {
    const status = new SubagentStatus({
      taskId: "abc12345",
      label: "task A",
      taskDescription: "Do task A",
      phase: "awaitingTools",
      iteration: 1,
    });
    const result = MyTool.formatValue({ abc12345: status });
    expect(result).toContain("1 subagent(s)");
    expect(result).toContain("abc12345");
    expect(result).toContain("task A");
  });

  it("formats empty status dictionaries", () => {
    expect(MyTool.formatValue({})).toContain("{}");
  });

  it("formats statuses with errors", () => {
    const status = new SubagentStatus({
      taskId: "err00001",
      label: "failing task",
      taskDescription: "A task that fails",
      phase: "error",
      error: "Connection refused",
    });
    expect(MyTool.formatValue(status)).toContain("error: Connection refused");
  });

  it("inspects task statuses", async () => {
    const status = new SubagentStatus({
      taskId: "abc12345",
      label: "read logs",
      taskDescription: "Read the log files",
      phase: "awaitingTools",
      iteration: 2,
      toolEvents: [{ name: "read_file", status: "ok", detail: "ok" }],
      usage: { prompt_tokens: 500, completion_tokens: 100 },
    });
    const state = runtime({ subagents: { taskStatuses: { abc12345: status } } });
    const result = await new MyTool({ runtimeState: state }).execute({ action: "check", key: "subagents.taskStatuses" });
    expect(result).toContain("abc12345");
    expect(result).toContain("read logs");
  });

  it("inspects a single subagent status", async () => {
    const status = new SubagentStatus({
      taskId: "xyz",
      label: "search code",
      taskDescription: "Search the codebase",
      phase: "done",
      iteration: 4,
      stopReason: "completed",
    });
    const state = runtime({ subagents: { taskStatuses: { xyz: status } } });
    const result = await new MyTool({ runtimeState: state }).execute({ action: "check", key: "subagents.taskStatuses.xyz" });
    expect(result).toContain("search code");
    expect(result).toContain("completed");
  });

  it("allows inspection in read-only mode", async () => {
    expect(await new MyTool({ runtimeState: runtime(), modifyAllowed: false }).execute({ action: "check", key: "maxIterations" })).toContain(
      "40",
    );
  });

  it("blocks modification in read-only mode", async () => {
    expect(await new MyTool({ runtimeState: runtime(), modifyAllowed: false }).execute({ action: "set", key: "maxIterations", value: 80 })).toContain(
      "disabled",
    );
  });

  it("describes read-only mode", () => {
    expect(new MyTool({ runtimeState: runtime(), modifyAllowed: false }).description).toContain("READ-ONLY MODE");
  });

  it("still returns not found for missing values", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "neverSetKeyXyz" })).toContain(
      "not found",
    );
  });

  it("blocks API key inspection", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "webConfig.search.apiKey" })).toContain(
      "not accessible",
    );
  });

  it("blocks API key modification", async () => {
    const result = await new MyTool({ runtimeState: runtime() }).execute({
      action: "set",
      key: "webConfig.search.apiKey",
      value: "evil",
    });
    expect(result === "read-only" || result.includes("read-only") || result.includes("not accessible")).toBe(true);
  });

  it("blocks password modification", async () => {
    expect(await new MyTool({ runtimeState: runtime({ someConfig: {} }) }).execute({ action: "set", key: "someConfig.password", value: "evil" })).toContain(
      "not accessible",
    );
  });

  it("allows non-sensitive subfield inspection", async () => {
    const result = await new MyTool({ runtimeState: runtime() }).execute({ action: "check", key: "webConfig.enable" });
    expect(result).toContain("true");
  });

  it("blocks restrict-to-workspace modification", async () => {
    expect(await new MyTool({ runtimeState: runtime({ restrictToWorkspace: false }) }).execute({ action: "set", key: "restrictToWorkspace", value: true })).toContain(
      "protected",
    );
  });

  it("blocks restrict-to-workspace inspection", async () => {
    expect(await new MyTool({ runtimeState: runtime({ restrictToWorkspace: false }) }).execute({ action: "check", key: "restrictToWorkspace" })).toContain(
      "not accessible",
    );
  });

  it("blocks exec config dot-path modification", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "execConfig.enable", value: false })).toContain(
      "read-only",
    );
  });

  it("blocks web config dot-path modification", async () => {
    expect(await new MyTool({ runtimeState: runtime() }).execute({ action: "set", key: "webConfig.enable", value: false })).toContain(
      "read-only",
    );
  });
});
