import { afterEach, describe, expect, it, vi } from "vitest";
import { executeManagedTool, createManagedExecutionScope, withManagedExecution } from "../../../src/core/agent-runtime/managed-execution.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { ToolCallRequest } from "../../../src/providers/base.js";
import { createApp } from "../../../src/entrypoints/openai-like-api/server.js";

const credential = { protocol: 2, tools: [{ name: "web_fetch", description: "managed fetch", inputSchema: { type: "object" } }], url: "http://127.0.0.1:12345/authorize", token: "a".repeat(64) };
const scope = () => createManagedExecutionScope(credential, new AbortController().signal);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("mandatory managed execution", () => {
  it("advertises the generic managed execution contract", async () => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    vi.stubEnv("AGENT_MACOS_SANDBOX", "1");
    const response = await createApp().fetch(new Request("http://127.0.0.1/health"));
    expect(await response.json()).toEqual({ status: "ok", permissionProtocol: 1,
      managedExecutionProtocol: 2, managedExecutionRequired: true, macosSandbox: true });
  });

  it("keeps standalone health independent of managed execution", async () => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "0");
    const response = await createApp().fetch(new Request("http://127.0.0.1/health"));
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("uses the Host web result without executing any native network tool", async () => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", result: "approved page" })));
    const execute = vi.fn();
    const results = await withManagedExecution(scope(), () => new AgentRunner().executeTools(new AgentRunSpec({
      tools: { execute, get: () => ({ readOnly: true }) } as any
    }), [new ToolCallRequest({ id: "web", name: "web_fetch", arguments: { url: "https://example.com" } })]));
    expect(execute).not.toHaveBeenCalled(); expect(results[0].result).toContain("approved page");
  });
  it.each([false, true])("waits across redirect approvals but keeps a bounded lifetime: timeout=%s", async expires => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(new Error("timeout")), ms); return controller.signal;
    });
    let reply!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((resolve, reject) => {
      reply = resolve;
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    })));
    try {
      const pending = withManagedExecution(scope(), () => executeManagedTool("web_fetch", { url: "https://example.com" }));
      if (expires) {
        const rejected = expect(pending).rejects.toThrow("timeout");
        await vi.advanceTimersByTimeAsync(900_000); await rejected;
      } else {
        await vi.advanceTimersByTimeAsync(150_000);
        reply(Response.json({ decision: "allow", result: "after several approvals" }));
        expect((await pending).result).toBe("after several approvals");
      }
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });

  it("does not fall back to direct networking when the Host omits its web result", async () => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow" })));
    await expect(withManagedExecution(scope(), () => executeManagedTool("web_fetch", { url: "https://example.com" }))).rejects.toThrow("result is missing");
  });
  it("blocks managed tools without an authenticated request context", async () => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    await expect(executeManagedTool("write_file", {})).rejects.toThrow("context is missing");
  });
  it("rejects non-local approval endpoints", () => {
    for (const url of ["https://evil.example/authorize", "http://localhost:123/authorize", "http://127.0.0.1:123/authorize?redirect=x"]) {
      expect(() => createManagedExecutionScope({ ...credential, url }, new AbortController().signal)).toThrow();
    }
  });
  it.each([true, false])("waits for the Host and never calls the %s native-execute branch", async direct => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    let reply!: (value: Response) => void;
    const received: any[] = [];
    vi.stubGlobal("fetch", vi.fn((_url, init) => { received.push(JSON.parse(init.body)); return new Promise(resolve => { reply = resolve; }); }));
    const execute = vi.fn(async (args: any) => args.path);
    const original = { path: "before.txt" };
    const tools = { get: () => ({ readOnly: false }), prepareCall: () => [direct ? { execute } : null, original, null], execute: (_name: string, args: any) => execute(args) };
    const pending = withManagedExecution(scope(), () => new AgentRunner().executeTools(new AgentRunSpec({ tools: tools as any }), [new ToolCallRequest({ id: "one", name: "write_file", arguments: {} })]));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(execute).not.toHaveBeenCalled(); original.path = "after.txt";
    reply(Response.json({ decision: "allow", result: "Host result" }));
    await pending;
    expect(execute).not.toHaveBeenCalled();
    expect(received[0].args).toEqual({});
  });
  it.each(["deny", "allow_always", "unavailable"])("never executes on %s", async decision => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    vi.stubGlobal("fetch", vi.fn(async () => decision === "unavailable" ? Promise.reject(new Error("offline")) : Response.json({ decision })));
    const execute = vi.fn();
    const results = await withManagedExecution(scope(), () => new AgentRunner().executeTools(new AgentRunSpec({
      tools: { execute, get: () => ({ readOnly: true }) } as any
    }), [new ToolCallRequest({ id: "one", name: "read_file", arguments: { path: "a" } })]));
    expect(execute).not.toHaveBeenCalled(); expect(results[0].event.status).toBe("error");
  });
  it("checks runtime authentication before parsing attachments or invoking the agent", async () => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1"); vi.stubEnv("AGENT_RUNTIME_TOKEN", "b".repeat(64));
    const loop = vi.fn(); const app = createApp(loop);
    const response = await app.fetch(new Request("http://127.0.0.1/v1/chat/completions", { method: "POST", body: "invalid json" }));
    expect(response.status).toBe(401); expect(loop).not.toHaveBeenCalled();
  });
  it("carries the verified request scope to tool execution and ends it with the response", async () => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1"); vi.stubEnv("AGENT_RUNTIME_TOKEN", "b".repeat(64));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", result: "Host result" })));
    let detached!: () => Promise<unknown>;
    const app = createApp(async () => {
      // AsyncResource preserves the request scope for deferred work, which must expire.
      const { AsyncResource } = await import("node:async_hooks");
      detached = AsyncResource.bind(() => executeManagedTool("read_file", { path: "a" }));
      await executeManagedTool("read_file", { path: "a" }); return "ok";
    });
    const result = await app.fetch(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-agent-runtime-token": "b".repeat(64) },
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }], managed_execution: credential })
    }));
    expect(result.status).toBe(200); await expect(detached()).rejects.toThrow("run has ended");
  });
  it.each(["allow", "deny"])("streams tool outcomes with the approval call id for %s", async decision => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1"); vi.stubEnv("AGENT_RUNTIME_TOKEN", "b".repeat(64));
    const requests: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { requests.push(JSON.parse(init.body)); return Response.json({ decision, ...(decision === "allow" ? { result: "written" } : {}) }); }));
    const execute = vi.fn(async () => "written");
    const app = createApp(async (args: any) => {
      await args.onProgress("", { toolEvents: [{ phase: "start", call_id: "correlated", name: "write_file", arguments: { path: "a" } }] });
      await new AgentRunner().executeTools(new AgentRunSpec({ tools: { execute, get: () => ({ readOnly: false }) } as any }),
        [new ToolCallRequest({ id: "correlated", name: "write_file", arguments: { path: "a" } })]);
      await args.onProgress("", { toolEvents: [{ phase: decision === "allow" ? "end" : "error", call_id: "correlated", name: "write_file", result: "written", error: "denied" }] });
      return "finished";
    });
    const response = await app.fetch(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-agent-runtime-token": "b".repeat(64) },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "test" }], managed_execution: credential })
    }));
    const events = (await response.text()).split("\n\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)).memmy_event).filter(Boolean);
    expect(requests[0].callId).toBe("correlated");
    expect(events.map(event => [event.type, event.callId])).toEqual([["tool_call", "correlated"], ["tool_result", "correlated"]]);
    expect(events[1].ok).toBe(decision === "allow");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([true, false])("keeps approval pending beyond the legacy deadline and authenticates explicit stop (stream=%s)", async stream => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    vi.stubEnv("AGENT_RUNTIME_TOKEN", "b".repeat(64));
    let approvalSignal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_url, init) => new Promise((_resolve, reject) => {
      approvalSignal = init.signal;
      approvalSignal.addEventListener("abort", () => reject(approvalSignal.reason), { once: true });
    })));
    const execute = vi.fn();
    const app = createApp(async () => {
      await executeManagedTool("write_file", { path: "a" });
      await execute();
      return "written";
    }, "memmy", 0.001);
    const responsePromise = app.fetch(new Request("http://127.0.0.1/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "x-agent-runtime-token": "b".repeat(64) },
      body: JSON.stringify({ stream, session_id: "s", request_id: "r", messages: [{ role: "user", content: "test" }], managed_execution: credential })
    }));
    await vi.waitFor(() => expect(approvalSignal).toBeDefined());
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(app.context.activeRequests.size).toBe(1);
    expect(approvalSignal.aborted).toBe(false);
    const cancel = (token?: string) => app.fetch(new Request("http://127.0.0.1/v1/chat/cancel", {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-agent-runtime-token": token } : {}) },
      body: JSON.stringify({ session_id: "s", request_id: "r" })
    }));
    expect((await cancel()).status).toBe(401);
    expect(approvalSignal.aborted).toBe(false);
    expect((await cancel("b".repeat(64))).status).toBe(200);
    const response = await responsePromise;
    if (stream) {
      const text = await response.text();
      expect(text).toContain('"code":"cancelled"');
      expect(text).not.toContain("[DONE]");
    } else {
      expect(response.status).toBe(409);
    }
    expect(approvalSignal.aborted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(app.context.activeRequests.size).toBe(0);
  });

});


describe("managed execution outcomes", () => {
  it.each(["read_file", "write_file", "list_dir", "run_command", "web_fetch", "web_search"])("delegates %s entirely to the Host", async name => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "allow", result: "Error is valid file content" })));
    const native = vi.fn(() => { throw new Error("native execution must not run"); });
    const runner = new AgentRunner();
    const results = await withManagedExecution(scope(), () => runner.executeTools(new AgentRunSpec({
      tools: { prepareCall: native, execute: native, get: () => ({ readOnly: true }) } as any
    }), [new ToolCallRequest({ id: name, name, arguments: { path: "file" } })]));
    expect(native).not.toHaveBeenCalled();
    expect(results[0].event.status).toBe("ok");
    expect(results[0].result).toBe("Error is valid file content");
  });
  it("retains execution errors instead of relabelling them as denied approvals", async () => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    const error = { kind: "execution", code: "ENOTFOUND" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ decision: "deny", reason: "ENOTFOUND", error })));
    const results = await withManagedExecution(scope(), () => new AgentRunner().executeTools(new AgentRunSpec({
      tools: { get: () => ({ readOnly: true }) } as any
    }), [new ToolCallRequest({ id: "dns", name: "web_fetch", arguments: {} })]));
    expect(results[0].event).toMatchObject({ status: "error", executionError: error });
    expect(results[0].result).toContain("execution failed: ENOTFOUND");
    expect(results[0].result).not.toContain("denied");
  });
  it("requires protocol 2 and a Host tool catalog", () => {
    expect(() => createManagedExecutionScope({ ...credential, protocol: 1 }, new AbortController().signal)).toThrow("protocol 2");
    expect(() => createManagedExecutionScope({ ...credential, tools: [] }, new AbortController().signal)).toThrow("tool definitions");
  });
  it("only exposes the request-scoped Host tools", async () => {
    vi.stubEnv("AGENT_MANAGED_EXECUTION_REQUIRED", "1");
    const { ToolRegistry } = await import("../../../src/core/agent-runtime/tools/registry.js");
    const registry = new ToolRegistry();
    expect(registry.getDefinitions()).toEqual([]);
    withManagedExecution(scope(), () => expect(registry.getDefinitions().map(tool => tool.function.name)).toEqual(["web_fetch"]));
    expect(registry.getDefinitions()).toEqual([]);
  });
});
