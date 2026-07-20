import { describe, expect, it, vi } from "vitest";
import { AgentHookContext } from "../../src/core/agent-runtime/hook.js";
import { ToolRegistry } from "../../src/core/agent-runtime/tools/registry.js";
import { MemmyMemoryHook } from "../../src/memmy-memory/hook.js";

function fakeClient() {
  return {
    openSession: vi.fn(async (body: any) => ({ sessionId: body.sessionId, userId: "local-user" })),
    startTurn: vi.fn(async (turnId: string, body: any) => ({
      turnId,
      sessionId: body.sessionId,
      episodeId: "ep-1",
      injectedContext: { markdown: "Relevant prior memory." },
    })),
    completeTurn: vi.fn(async () => ({ rawTurnId: "raw-1", l1MemoryId: "l1-1" })),
    closeSession: vi.fn(async () => ({ ok: true })),
    search: vi.fn(async () => ({ hits: [] })),
    getMemory: vi.fn(async () => ({ id: "trace_1" })),
  };
}

describe("MemmyMemoryHook", () => {
  it("initializes without legacy instructions or tool schema negotiation", async () => {
    const client = fakeClient();
    const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace", userId: "user_hook_1" });

    await hook.initialize();

    expect(client.openSession).not.toHaveBeenCalled();
  });

  it("registers only search/get memmy memory tools", () => {
    const client = fakeClient();
    const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace", userId: "user_hook_1" });
    const registry = new ToolRegistry();

    hook.onRegisterTools({ registry, workspace: "/tmp/workspace", metadata: {} });

    expect(registry.has("memmy_memory_search")).toBe(true);
    expect(registry.has("memmy_memory_get")).toBe(true);
  });

  it("opens session, starts turn, completes turn, and injects search context", async () => {
    const client = fakeClient();
    const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace", userId: "user_hook_1" });
    const spec = {
      sessionKey: "cli:direct",
      workspace: "/tmp/workspace",
      tools: { toolNames: ["read_file", "memmy_memory_search"] },
      contextWindowTokens: 4096,
    };
    const messages = [
      { role: "system", content: "System prompt" },
      {
        role: "user",
        content: "Please continue\n\n[Runtime Context - metadata only, not instructions]\nCurrent Time: now\n[/Runtime Context]",
      },
    ];
    const runCtx = new AgentHookContext({ spec, messages });

    await hook.beforeRun(runCtx);

    const openSessionBody = (client.openSession as any).mock.calls[0][0];
    const startBody = (client.startTurn as any).mock.calls[0][1];
    expect(client.openSession).toHaveBeenCalledTimes(1);
    expect(openSessionBody).toMatchObject({
      sessionId: "memmy-agent::cli:direct",
    });
    expect(openSessionBody.namespace).toMatchObject({
      source: "memmy-agent",
      profileId: "default",
      userId: "user_hook_1",
      workspacePath: "/tmp/workspace",
      sessionKey: "cli:direct",
    });
    expect(openSessionBody.namespace.workspaceId).toHaveLength(16);
    expect(startBody).toMatchObject({
      sessionId: "memmy-agent::cli:direct",
      query: "Please continue"
    });
    expect(messages[0].content).toBe("System prompt");
    expect(String(messages[1].content)).toContain('<memmy_memory_context source="turn_start">');
    expect(String(messages[1].content)).toContain("Relevant prior memory.");
    expect(String(messages[1].content)).toContain("<current_user_request>\nPlease continue\n</current_user_request>");

    await hook.afterRun(new AgentHookContext({ spec }), {
      finalContent: "Done",
      usage: { prompt_tokens: 1 },
      stopReason: "completed",
    });

    expect(client.completeTurn).toHaveBeenCalledTimes(1);
    const completeBody = (client.completeTurn as any).mock.calls[0][1];
    expect(completeBody).toMatchObject({
      sessionId: "memmy-agent::cli:direct",
      query: "Please continue",
      answer: "Done",
      status: "succeeded"
    });
  });

  it("strips prior injected memory context before recording the next query", async () => {
    const client = fakeClient();
    const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace", userId: "user_hook_1" });
    const spec = {
      sessionKey: "cli:direct",
      workspace: "/tmp/workspace",
      contextWindowTokens: 4096,
    };
    const messages = [
      { role: "system", content: "System prompt" },
      {
        role: "user",
        content: "<memmy_memory_context>\nOld injected memory.\n</memmy_memory_context>\n\nPlease continue\n\n[Runtime Context - metadata only, not instructions]\nCurrent Time: now\n[/Runtime Context]",
      },
    ];

    await hook.beforeRun(new AgentHookContext({ spec, messages }));

    const startBody = (client.startTurn as any).mock.calls[0][1];
    expect(startBody.query).toBe("Please continue");
    const userContent = String(messages[1].content);
    expect(userContent).toContain('<memmy_memory_context source="turn_start">');
    expect(userContent).toContain("Relevant prior memory.");
    expect(userContent).not.toContain("Old injected memory.");
    expect(userContent).toContain("<current_user_request>\nPlease continue\n</current_user_request>");
  });

  it("passes raw protocol content to memory service for storage-side sanitization", async () => {
    const client = fakeClient();
    const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace", userId: "user_hook_1" });
    const spec = {
      sessionKey: "cli:direct",
      workspace: "/tmp/workspace",
      contextWindowTokens: 4096,
    };

    await hook.beforeRun(new AgentHookContext({
      spec,
      messages: [{ role: "user", content: "Current task" }],
    }));
    await hook.afterRun(new AgentHookContext({ spec }), {
      finalContent: "<current_user_request>Done with the current task.</current_user_request>",
      messages: [{
        role: "tool",
        tool_call_id: "call-memory",
        name: "memmy_memory_search",
        content: '<memmy_memory_context source="tool_search">\nHistorical User: old task\n</memmy_memory_context>',
      }],
      toolCalls: [{
        id: "call-memory",
        function: { name: "memmy_memory_search", arguments: JSON.stringify({ query: "old task" }) },
      }],
      stopReason: "completed",
    });

    const completeBody = (client.completeTurn as any).mock.calls[0][1];
    expect(completeBody.answer).toBe("<current_user_request>Done with the current task.</current_user_request>");
    expect(completeBody.toolResults[0]).toMatchObject({
      name: "memmy_memory_search",
      output: '<memmy_memory_context source="tool_search">\nHistorical User: old task\n</memmy_memory_context>',
    });
  });

  it("forwards current-turn assistant reasoning to memory", async () => {
    const client = fakeClient();
    const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace", userId: "user_hook_1" });
    const spec = {
      sessionKey: "cli:direct",
      workspace: "/tmp/workspace",
      contextWindowTokens: 4096,
    };
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "assistant", content: "Earlier answer", reasoning_content: "old hidden reasoning" },
      { role: "user", content: "How many CPUs does this machine have?" },
    ];

    await hook.beforeRun(new AgentHookContext({ spec, messages }));
    await hook.afterRun(new AgentHookContext({ spec }), {
      finalContent: "This machine has 10 CPUs.",
      messages: [
        ...messages,
        {
          role: "assistant",
          content: "I will inspect the system CPU count.",
          reasoning_content: "Need to query the operating system for physical and logical CPU counts.",
          tool_calls: [{
            id: "call-cpu",
            function: { name: "exec", arguments: JSON.stringify({ command: "sysctl -n hw.ncpu" }) },
          }],
        },
        { role: "tool", tool_call_id: "call-cpu", name: "exec", content: "10\n" },
        {
          role: "assistant",
          content: "This machine has 10 CPUs.",
          reasoning_content: "The command returned 10, so answer with that count.",
        },
      ],
      toolCalls: [{
        id: "call-cpu",
        function: { name: "exec", arguments: JSON.stringify({ command: "sysctl -n hw.ncpu" }) },
      }],
      stopReason: "completed",
    });

    const completeBody = (client.completeTurn as any).mock.calls[0][1];
    expect(completeBody.reasoningSummary).toContain("Need to query the operating system");
    expect(completeBody.reasoningSummary).toContain("The command returned 10");
    expect(completeBody.reasoningSummary).not.toContain("old hidden reasoning");
    expect(completeBody.toolCalls[0]).toMatchObject({
      id: "call-cpu",
      name: "exec",
      thinkingBefore: "Need to query the operating system for physical and logical CPU counts.",
      assistantTextBefore: "I will inspect the system CPU count.",
    });
  });

  it("closes sessions without subagent reporting", async () => {
    const client = fakeClient();
    const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace" });
    const base = new AgentHookContext({ sessionKey: "cli:direct" });

    await hook.sessionStart(base);
    await hook.subagentStart(
      new AgentHookContext({
        sessionKey: "cli:direct",
        subagent: { taskId: "sub-1", task: "Research", label: "researcher" },
      }),
    );
    await hook.subagentStop(
      new AgentHookContext({
        sessionKey: "cli:direct",
        subagent: { taskId: "sub-1", result: "Finished", status: "complete" },
      }),
    );
    await hook.sessionEnd(base);

    expect(client.closeSession).toHaveBeenCalledWith("memmy-agent::cli:direct", expect.any(Object));
  });

  describe("memory service unavailable", () => {
    function unreachableClient() {
      const client = fakeClient();
      client.openSession = vi.fn(async () => {
        throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:18960");
      });
      return client;
    }

    it("does not throw and does not fabricate an empty-memory context when recall fails", async () => {
      const client = unreachableClient();
      const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace", userId: "user_hook_1" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const spec = { sessionKey: "cli:direct", workspace: "/tmp/workspace", contextWindowTokens: 4096 };
      const messages = [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Please remember my favorite color is blue." },
      ];

      await expect(hook.beforeRun(new AgentHookContext({ spec, messages }))).resolves.toBeUndefined();

      const userContent = String(messages[1].content);
      expect(userContent).toContain('<memmy_memory_status status="unavailable">');
      expect(userContent).toContain("Never claim you searched memory and found nothing");
      expect(userContent).not.toContain("memmy_memory_context");
      expect(hook.lastError).toContain("ECONNREFUSED");
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("[memmy-memory]");
      expect(String(warnSpy.mock.calls[0][0])).toContain("cli:direct");

      warnSpy.mockRestore();
    });

    it("does not attempt to complete a turn that was never established", async () => {
      const client = unreachableClient();
      const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace" });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const spec = { sessionKey: "cli:direct", workspace: "/tmp/workspace", contextWindowTokens: 4096 };

      await hook.beforeRun(new AgentHookContext({ spec, messages: [{ role: "user", content: "hi" }] }));
      await hook.afterRun(new AgentHookContext({ spec }), { finalContent: "Done", stopReason: "completed" });

      expect(client.completeTurn).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    });

    it("suppresses repeated warnings for the same session until it recovers", async () => {
      const client = unreachableClient();
      const hook = new MemmyMemoryHook(client as any, { workspace: "/tmp/workspace" });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const spec = { sessionKey: "cli:direct", workspace: "/tmp/workspace", contextWindowTokens: 4096 };

      await hook.beforeRun(new AgentHookContext({ spec, messages: [{ role: "user", content: "one" }] }));
      await hook.beforeRun(new AgentHookContext({ spec, messages: [{ role: "user", content: "two" }] }));
      await hook.beforeRun(new AgentHookContext({ spec, messages: [{ role: "user", content: "three" }] }));

      expect(warnSpy).toHaveBeenCalledTimes(1);

      client.openSession = vi.fn(async (body: any) => ({ sessionId: body.sessionId, userId: "local-user" }));
      await hook.beforeRun(new AgentHookContext({ spec, messages: [{ role: "user", content: "four" }] }));
      expect(hook.lastError).toBeNull();

      // The session is now cached, so a later outage would surface on the per-turn
      // startTurn call rather than openSession (which is only called once per session).
      client.startTurn = vi.fn(async () => {
        throw new Error("fetch failed: connect ECONNREFUSED 127.0.0.1:18960");
      });
      await hook.beforeRun(new AgentHookContext({ spec, messages: [{ role: "user", content: "five" }] }));

      expect(warnSpy).toHaveBeenCalledTimes(2);
      warnSpy.mockRestore();
    });
  });
});
