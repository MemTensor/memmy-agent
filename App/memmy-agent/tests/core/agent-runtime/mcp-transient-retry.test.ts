import { describe, expect, it, vi } from "vitest";
import { MCPPromptWrapper, MCPResourceWrapper, MCPToolWrapper, isTransient } from "../../../src/core/agent-runtime/tools/mcp.js";

class NamedError extends Error {
  constructor(name: string, message = name) {
    super(message);
    this.name = name;
  }
}

const closed = (message = "gone") => new NamedError("ClosedResourceError", message);
const endOfStream = (message = "eof") => new NamedError("EndOfStream", message);
const brokenPipe = () => new NamedError("BrokenPipeError", "pipe");
const connectionReset = () => new NamedError("ConnectionResetError", "reset");
const connectionRefused = () => new NamedError("ConnectionRefusedError", "refused");
const valueError = () => new NamedError("ValueError", "nope");
const runtimeError = () => new NamedError("RuntimeError", "bad");
const timeoutError = () => new NamedError("TimeoutError", "timeout");
const cancelledError = () => new NamedError("CancelledError", "cancelled");

function scripted<T>(effects: Array<T | Error>) {
  const queue = [...effects];
  return vi.fn(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
}

function toolDef(name = "test_tool") {
  return { name, description: "A test tool", inputSchema: { type: "object", properties: {} } };
}

function toolResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function resourceDef(name = "test_resource") {
  return { name, uri: "file:///test", description: "A test resource" };
}

function resourceResult(text: string) {
  return { contents: [{ uri: "file:///test", text }] };
}

function promptDef(name = "test_prompt") {
  return { name, description: "A test prompt", arguments: [] };
}

function promptResult(text: string) {
  return { messages: [{ content: { type: "text", text } }] };
}

describe("MCP transient retry helpers", () => {
  it("recognizes closed resource errors as transient", () => {
    expect(isTransient(closed())).toBe(true);
  });

  it("recognizes broken pipe errors as transient", () => {
    expect(isTransient(brokenPipe())).toBe(true);
  });

  it("recognizes connection reset errors as transient", () => {
    expect(isTransient(connectionReset())).toBe(true);
  });

  it("recognizes connection refused errors as transient", () => {
    expect(isTransient(connectionRefused())).toBe(true);
  });

  it("recognizes end-of-stream errors as transient", () => {
    expect(isTransient(endOfStream())).toBe(true);
  });

  it("rejects value errors as non-transient", () => {
    expect(isTransient(valueError())).toBe(false);
  });

  it("rejects runtime errors as non-transient", () => {
    expect(isTransient(runtimeError())).toBe(false);
  });

  it("rejects timeout errors as non-transient", () => {
    expect(isTransient(timeoutError())).toBe(false);
  });

  it("retries MCP tool calls on transient errors", async () => {
    const callTool = scripted([closed("connection lost"), toolResult("ok")]);
    const wrapper = new MCPToolWrapper({ callTool }, "test_server", toolDef(), 5);
    expect(await wrapper.execute({ foo: "bar" })).toBe("ok");
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("reports MCP tool failure after retry exhaustion", async () => {
    const callTool = scripted([closed("still dead"), closed("still dead again")]);
    const wrapper = new MCPToolWrapper({ callTool }, "test_server", toolDef(), 5);
    const output = await wrapper.execute();
    expect(output).toContain("failed after retry");
    expect(output).toContain("ClosedResourceError");
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("does not retry MCP tool calls on non-transient errors", async () => {
    const callTool = scripted([valueError()]);
    const wrapper = new MCPToolWrapper({ callTool }, "test_server", toolDef(), 5);
    const output = await wrapper.execute();
    expect(output).toContain("ValueError");
    expect(output).not.toContain("retry");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("does not retry MCP tool timeouts", async () => {
    const callTool = scripted([new Error("timeout")]);
    const wrapper = new MCPToolWrapper({ callTool }, "test_server", toolDef(), 5);
    const output = await wrapper.execute();
    expect(output).toContain("timed out");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("does not retry MCP tool calls that succeed first try", async () => {
    const callTool = scripted([toolResult("hello")]);
    const wrapper = new MCPToolWrapper({ callTool }, "test_server", toolDef(), 5);
    expect(await wrapper.execute()).toBe("hello");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("does not retry MCP tool calls cancelled by the caller", async () => {
    const callTool = scripted([cancelledError()]);
    const wrapper = new MCPToolWrapper({ callTool }, "test_server", toolDef(), 5);
    const output = await wrapper.execute();
    expect(output).toContain("cancelled");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("retries MCP tool calls on connection reset", async () => {
    const callTool = scripted([connectionReset(), toolResult("recovered")]);
    const wrapper = new MCPToolWrapper({ callTool }, "test_server", toolDef(), 5);
    expect(await wrapper.execute()).toBe("recovered");
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("retries MCP tool calls on end-of-stream", async () => {
    const callTool = scripted([endOfStream(), toolResult("back")]);
    const wrapper = new MCPToolWrapper({ callTool }, "test_server", toolDef(), 5);
    expect(await wrapper.execute()).toBe("back");
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("retries MCP resource reads on transient errors", async () => {
    const readResource = scripted([closed(), resourceResult("data")]);
    const wrapper = new MCPResourceWrapper({ readResource }, "test_server", resourceDef());
    expect(await wrapper.execute()).toBe("data");
    expect(readResource).toHaveBeenCalledTimes(2);
  });

  it("reports MCP resource failure after retry exhaustion", async () => {
    const error = closed("dead");
    const readResource = scripted([error, error]);
    const wrapper = new MCPResourceWrapper({ readResource }, "test_server", resourceDef());
    const output = await wrapper.execute();
    expect(output).toContain("failed after retry");
    expect(readResource).toHaveBeenCalledTimes(2);
  });

  it("does not retry MCP resource reads on non-transient errors", async () => {
    const readResource = scripted([runtimeError()]);
    const wrapper = new MCPResourceWrapper({ readResource }, "test_server", resourceDef());
    const output = await wrapper.execute();
    expect(output).toContain("RuntimeError");
    expect(readResource).toHaveBeenCalledTimes(1);
  });

  it("retries MCP prompt calls on transient errors", async () => {
    const getPrompt = scripted([closed(), promptResult("prompt text")]);
    const wrapper = new MCPPromptWrapper({ getPrompt }, "test_server", promptDef());
    expect(await wrapper.execute()).toBe("prompt text");
    expect(getPrompt).toHaveBeenCalledTimes(2);
  });

  it("reports MCP prompt failure after retry exhaustion", async () => {
    const error = closed("dead");
    const getPrompt = scripted([error, error]);
    const wrapper = new MCPPromptWrapper({ getPrompt }, "test_server", promptDef());
    const output = await wrapper.execute();
    expect(output).toContain("failed after retry");
    expect(getPrompt).toHaveBeenCalledTimes(2);
  });

  it("does not retry MCP application-level prompt errors", async () => {
    const appError: any = new Error("not found");
    appError.error = { code: -1, message: "not found" };
    const getPrompt = scripted([appError]);
    const wrapper = new MCPPromptWrapper({ getPrompt }, "test_server", promptDef());
    const output = await wrapper.execute();
    expect(output).toContain("not found");
    expect(getPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not retry MCP prompt calls on non-transient errors", async () => {
    const getPrompt = scripted([runtimeError()]);
    const wrapper = new MCPPromptWrapper({ getPrompt }, "test_server", promptDef());
    const output = await wrapper.execute();
    expect(output).toContain("RuntimeError");
    expect(getPrompt).toHaveBeenCalledTimes(1);
  });
});
