import { describe, expect, it } from "vitest";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { Tool, type ToolExecutionContext } from "../../../src/core/agent-runtime/tools/base.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { ToolCallRequest } from "../../../src/providers/base.js";
import { withProgressCapabilities } from "../../../src/utils/progress-events.js";

class DelayTool extends Tool {
  constructor(
    private readonly toolName: string,
    private readonly delayMs: number,
    private readonly readOnlyFlag: boolean,
    private readonly sharedEvents: string[],
    private readonly exclusiveFlag = false,
  ) {
    super();
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return this.toolName;
  }

  get parameters(): Record<string, any> {
    return { type: "object", properties: {}, required: [] };
  }

  get readOnly(): boolean {
    return this.readOnlyFlag;
  }

  get exclusive(): boolean {
    return this.exclusiveFlag;
  }

  async execute(): Promise<string> {
    this.sharedEvents.push(`start:${this.toolName}`);
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.sharedEvents.push(`end:${this.toolName}`);
    return this.toolName;
  }
}

describe("AgentRunner tool execution", () => {
  it("executes registered tools and records event status", async () => {
    const runner = new AgentRunner();
    const call = new ToolCallRequest({ id: "c1", name: "echo", arguments: { text: "hi" } });
    const spec = new AgentRunSpec({
      tools: { execute: async (name: string, args: any) => args.text, get: () => ({ readOnly: true }) } as any,
    });

    const [result] = await runner.executeTools(spec, [call]);

    expect(result.result).toBe("hi");
    expect(result.event).toMatchObject({ name: "echo", status: "ok" });
  });

  it("keeps file lint failures as successful tool content", async () => {
    const runner = new AgentRunner();
    const content = "Successfully wrote /workspace/broken.json\n\nLint results:\n- /workspace/broken.json: failed\n  syntax error";
    const call = new ToolCallRequest({ id: "c1", name: "write_file", arguments: {} });
    const spec = new AgentRunSpec({
      failOnToolError: true,
      tools: { execute: async () => content, get: () => ({ readOnly: false }) } as any,
    });

    const [result] = await runner.executeTools(spec, [call]);

    expect(result.result).toBe(content);
    expect(result.error).toBeNull();
    expect(result.event).toMatchObject({ name: "write_file", status: "ok" });
  });

  it("keeps no-change tool results successful when failOnToolError is enabled", async () => {
    const runner = new AgentRunner();
    const content = "No changes made to /workspace/same.txt: existing content is identical.";
    const call = new ToolCallRequest({ id: "c-noop", name: "write_file", arguments: {} });
    const spec = new AgentRunSpec({
      failOnToolError: true,
      tools: { execute: async () => content, get: () => ({ readOnly: false }) } as any,
    });

    const [result] = await runner.executeTools(spec, [call]);

    expect(result.result).toBe(content);
    expect(result.error).toBeNull();
    expect(result.event).toMatchObject({ name: "write_file", status: "ok" });
  });

  it("publishes unchanged file outcomes only for the reporting tool call", async () => {
    class MutationOutcomeTool extends Tool {
      get name(): string {
        return "write_file";
      }

      get description(): string {
        return "test file mutation outcomes";
      }

      get parameters(): Record<string, any> {
        return {
          type: "object",
          properties: { path: { type: "string" }, unchanged: { type: "boolean" } },
          required: ["path"],
        };
      }

      async execute(params: Record<string, any>, context?: ToolExecutionContext): Promise<string> {
        if (params.unchanged) {
          context?.reportFileMutation?.({ path: `/workspace/${params.path}`, changed: false });
          return `No changes made to /workspace/${params.path}: existing content is identical.`;
        }
        return `Successfully wrote /workspace/${params.path}`;
      }
    }

    const tools = new ToolRegistry();
    tools.register(new MutationOutcomeTool());
    const fileEditEvents: Record<string, any>[] = [];
    const progressCallback = withProgressCapabilities(
      (_content, options) => {
        fileEditEvents.push(...(options?.fileEditEvents ?? []));
      },
      { fileEditEvents: true },
    );

    const results = await new AgentRunner().executeTools(
      new AgentRunSpec({ tools, workspace: "/workspace", progressCallback }),
      [
        new ToolCallRequest({ id: "noop-call", name: "write_file", arguments: { path: "same.txt", unchanged: true } }),
        new ToolCallRequest({ id: "write-call", name: "write_file", arguments: { path: "changed.txt", unchanged: false } }),
      ],
    );

    expect(results.map((result) => result.event.status)).toEqual(["ok", "ok"]);
    const noopEvents = fileEditEvents.filter((event) => event.call_id === "noop-call");
    const writeEvents = fileEditEvents.filter((event) => event.call_id === "write-call");
    expect(noopEvents).toHaveLength(2);
    expect(noopEvents[1]).toMatchObject({ phase: "end", status: "done", unchanged: true, added: 0, deleted: 0 });
    expect(noopEvents[0]?.ui_tool_call_id).toBe(noopEvents[1]?.ui_tool_call_id);
    expect(writeEvents).toHaveLength(2);
    expect(writeEvents[1]).toMatchObject({ phase: "end", status: "done" });
    expect(writeEvents[1]).not.toHaveProperty("unchanged");
  });

  it("returns SSRF and workspace boundary errors as recoverable tool results", async () => {
    const runner = new AgentRunner();
    const ssrf = new ToolCallRequest({ id: "c1", name: "web_fetch", arguments: { url: "http://127.0.0.1/admin" } });
    const workspace = new ToolCallRequest({ id: "c2", name: "read_file", arguments: { path: "/etc/passwd" } });
    const spec = new AgentRunSpec({
      failOnToolError: true,
      tools: {
        get: () => null,
        execute: async (name: string) =>
          name === "web_fetch"
            ? "Error: internal/private URL detected"
            : "Error: path is outside allowed directory",
      } as any,
    });

    const [ssrfResult, workspaceResult] = await runner.executeTools(spec, [ssrf, workspace]);

    expect(ssrfResult.error).toBeNull();
    expect(ssrfResult.result).toContain("non-bypassable security boundary");
    expect(workspaceResult.error).toBeNull();
    expect(workspaceResult.event.detail).toContain("workspace_violation");
  });

  it("batches read-only tools before exclusive work", async () => {
    const tools = new ToolRegistry();
    const sharedEvents: string[] = [];
    tools.register(new DelayTool("read_a", 20, true, sharedEvents));
    tools.register(new DelayTool("read_b", 20, true, sharedEvents));
    tools.register(new DelayTool("write_a", 1, false, sharedEvents));

    await new AgentRunner().executeTools(
      new AgentRunSpec({ tools, concurrentTools: true }),
      [
        new ToolCallRequest({ id: "ro1", name: "read_a", arguments: {} }),
        new ToolCallRequest({ id: "ro2", name: "read_b", arguments: {} }),
        new ToolCallRequest({ id: "rw1", name: "write_a", arguments: {} }),
      ],
    );

    expect(sharedEvents.slice(0, 2)).toEqual(["start:read_a", "start:read_b"]);
    expect(sharedEvents.indexOf("end:read_a")).toBeLessThan(sharedEvents.indexOf("start:write_a"));
    expect(sharedEvents.indexOf("end:read_b")).toBeLessThan(sharedEvents.indexOf("start:write_a"));
    expect(sharedEvents.slice(-2)).toEqual(["start:write_a", "end:write_a"]);
  });

  it("passes the run abort signal into tools and returns a cancelled tool result", async () => {
    let entered!: () => void;
    const receivedContexts: ToolExecutionContext[] = [];
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    class AbortAwareTool extends Tool {
      get name(): string {
        return "abort_aware";
      }

      get description(): string {
        return "abort aware";
      }

      get parameters(): Record<string, any> {
        return { type: "object", properties: {}, required: [] };
      }

      async execute(_params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
        if (context) receivedContexts.push(context);
        entered();
        return await new Promise((resolve, reject) => {
          const onAbort = () => {
            const error = new Error("task cancelled");
            error.name = "AbortError";
            reject(error);
          };
          context?.abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
      }
    }

    const tools = new ToolRegistry();
    tools.register(new AbortAwareTool());
    const controller = new AbortController();
    const running = new AgentRunner().executeTools(
      new AgentRunSpec({ tools, abortSignal: controller.signal }),
      [new ToolCallRequest({ id: "abort-call", name: "abort_aware", arguments: {} })],
    );
    await enteredPromise;
    controller.abort();

    const [result] = await running;

    expect(receivedContexts[0]?.abortSignal).toBe(controller.signal);
    expect(receivedContexts[0]).toMatchObject({ toolName: "abort_aware", callId: "abort-call" });
    expect(result.result).toBe("Error: task cancelled");
    expect(result.event).toMatchObject({ name: "abort_aware", status: "error" });
  });
});
