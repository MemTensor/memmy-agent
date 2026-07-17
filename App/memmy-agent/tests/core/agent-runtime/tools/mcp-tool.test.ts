import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MCPPromptWrapper,
  MCPResourceWrapper,
  MCPToolWrapper,
  closeServer,
  normalizeWindowsStdioCommand,
  sanitizeName,
  serverSignature,
  toolPrefix,
  unregisterServerTools,
  connectMcpServers,
  connectMissingServers,
  handleRuntimeControl,
  reloadServers,
  requestMcpReload,
  runtimeLines,
  setMcpRuntimeForTest,
  sessionExtra,
} from "../../../../src/core/agent-runtime/tools/mcp.js";
import { InboundMessage, INBOUND_META_RUNTIME_CONTROL, RUNTIME_CONTROL_ACK, RUNTIME_CONTROL_MCP_RELOAD } from "../../../../src/core/runtime-messages/events.js";
import { saveConfig, setConfigPath } from "../../../../src/config/loader.js";
import { Config } from "../../../../src/config/schema.js";
import { ToolRegistry } from "../../../../src/core/agent-runtime/tools/registry.js";

class FakeTextContent {
  constructor(public text: string) {}
}

class FakeTextResourceContents {
  constructor(public text: string) {}
}

class FakeBlobResourceContents {
  constructor(public blob: Uint8Array) {}
}

class FakeMcpError extends Error {
  error: { code: number; message: string };
  constructor(code: number, message: string) {
    super(message);
    this.name = "McpError";
    this.error = { code, message };
  }
}

function toolDef(name: string, schema: Record<string, any> = { type: "object", properties: {} }) {
  return { name, description: `${name} tool`, inputSchema: schema };
}

function fakeSession(toolNames: string[], resources: string[] = [], prompts: string[] = []) {
  return {
    async initialize() {},
    async listTools() {
      return { tools: toolNames.map((name) => toolDef(name)) };
    },
    async listResources() {
      return { resources: resources.map((name) => ({ name, uri: `file:///${name}`, description: `${name} resource` })) };
    },
    async listPrompts() {
      return { prompts: prompts.map((name) => ({ name, description: `${name} prompt`, arguments: null })) };
    },
  };
}

function runtimeFor(sessions: Record<string, any>, capture?: (params: any) => void) {
  return {
    ClientSession: class {
      constructor(read: string) {
        return sessions[read];
      }
    },
    StdioServerParameters: class {
      constructor(init: any) {
        Object.assign(this, init);
      }
    },
    stdioClient: async (params: any) => {
      capture?.(params);
      if (params.command === "bad") throw new Error("boom");
      if (params.command === "polluted") throw new Error("Parse error: Unexpected token INFO before JSON-RPC headers");
      return [params.command, {}];
    },
    sseClient: async () => [{}, {}],
    streamableHttpClient: async () => [{}, {}, {}],
  };
}

const roots: string[] = [];

function useConfig(config: Config): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-mcp-tool-"));
  roots.push(root);
  setConfigPath(path.join(root, "config.yaml"));
  saveConfig(config);
  return root;
}

afterEach(() => {
  setMcpRuntimeForTest(null);
  vi.restoreAllMocks();
  setConfigPath(path.join(os.tmpdir(), "memmy-agent-empty-config.yaml"));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MCPToolWrapper schema normalization", () => {
  it("preserves non-nullable unions", () => {
    const wrapper = new MCPToolWrapper({ callTool: null }, "test", toolDef("demo", {
      type: "object",
      properties: { value: { anyOf: [{ type: "string" }, { type: "integer" }] } },
    }));

    expect(wrapper.parameters.properties.value.anyOf).toEqual([{ type: "string" }, { type: "integer" }]);
  });

  it("normalizes nullable type unions", () => {
    const wrapper = new MCPToolWrapper({ callTool: null }, "test", toolDef("demo", {
      type: "object",
      properties: { name: { type: ["string", "null"] } },
    }));

    expect(wrapper.parameters.properties.name).toEqual({ type: "string", nullable: true });
  });

  it("normalizes nullable anyOf branches", () => {
    const wrapper = new MCPToolWrapper({ callTool: null }, "test", toolDef("demo", {
      type: "object",
      properties: { name: { anyOf: [{ type: "string" }, { type: "null" }], description: "optional name" } },
    }));

    expect(wrapper.parameters.properties.name).toEqual({ type: "string", description: "optional name", nullable: true });
  });
});

describe("Windows stdio command normalization", () => {
  it("is a no-op off Windows", () => {
    expect(normalizeWindowsStdioCommand("npx", ["-y", "chrome-devtools-mcp@latest"], { FOO: "bar" }, "posix")).toEqual([
      "npx",
      ["-y", "chrome-devtools-mcp@latest"],
      { FOO: "bar" },
    ]);
  });

  it("wraps npx on Windows", () => {
    expect(normalizeWindowsStdioCommand("npx", ["-y", "chrome-devtools-mcp@latest"], { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, "nt")).toEqual([
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/c", "npx", "-y", "chrome-devtools-mcp@latest"],
      { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
    ]);
  });

  it("wraps resolved cmd launchers", () => {
    expect(normalizeWindowsStdioCommand("custom-launcher", ["serve"], { PATH: "C:\\Tools", COMSPEC: "cmd.exe" }, "nt")).toEqual([
      "cmd.exe",
      ["/d", "/c", "custom-launcher", "serve"],
      { PATH: "C:\\Tools", COMSPEC: "cmd.exe" },
    ]);
  });

  it("keeps real executables and existing shells unchanged", () => {
    expect(normalizeWindowsStdioCommand("node.exe", ["server.js"], { FOO: "bar" }, "nt")).toEqual([
      "node.exe",
      ["server.js"],
      { FOO: "bar" },
    ]);
    expect(normalizeWindowsStdioCommand("cmd.exe", ["/c", "echo", "hello"], null, "nt")).toEqual([
      "cmd.exe",
      ["/c", "echo", "hello"],
      null,
    ]);
  });
});

describe("MCPToolWrapper execution", () => {
  it("returns text blocks", async () => {
    const session = {
      async callTool(name: string, args: any) {
        expect(name).toBe("demo");
        expect(args).toEqual({ value: 1 });
        return { content: [new FakeTextContent("hello"), 42] };
      },
    };

    await expect(new MCPToolWrapper(session, "test", toolDef("demo"), 0.1).execute({ value: 1 })).resolves.toBe("hello\n42");
  });

  it("returns a timeout message", async () => {
    const session = { callTool: () => new Promise(() => undefined) };

    await expect(new MCPToolWrapper(session, "test", toolDef("demo"), 0.01).execute()).resolves.toBe("(MCP tool call timed out after 0.01s)");
  });

  it("handles server cancellation and generic exceptions", async () => {
    const cancelled = new Error("cancelled");
    cancelled.name = "CancelledError";
    await expect(new MCPToolWrapper({ async callTool() { throw cancelled; } }, "test", toolDef("demo"), 0.1).execute()).resolves.toBe(
      "(MCP tool call was cancelled)",
    );
    const boom = new Error("boom");
    boom.name = "RuntimeError";
    await expect(new MCPToolWrapper({ async callTool() { throw boom; } }, "test", toolDef("demo"), 0.1).execute()).resolves.toBe(
      "(MCP tool call failed: RuntimeError)",
    );
  });

  it("retries transient errors once", async () => {
    let calls = 0;
    const first = new Error("closed");
    first.name = "ClosedResourceError";
    const session = {
      async callTool() {
        calls += 1;
        if (calls === 1) throw first;
        return { content: [new FakeTextContent("ok")] };
      },
    };

    await expect(new MCPToolWrapper(session, "test", toolDef("demo"), 0.1).execute()).resolves.toBe("ok");
    expect(calls).toBe(2);
  });
});

describe("connectMcpServers enabled tools", () => {
  it("supports raw names, wrapped names, defaults, and empty lists", async () => {
    setMcpRuntimeForTest(runtimeFor({ test: fakeSession(["demo", "other"]) }) as any);
    let registry = new ToolRegistry();
    let stacks = await connectMcpServers({ test: { command: "test", enabled_tools: ["demo"] } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));
    expect(registry.toolNames).toEqual(["mcp_test_demo"]);

    registry = new ToolRegistry();
    stacks = await connectMcpServers({ test: { command: "test" } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));
    expect(registry.toolNames).toEqual(["mcp_test_demo", "mcp_test_other"]);

    registry = new ToolRegistry();
    stacks = await connectMcpServers({ test: { command: "test", enabled_tools: ["mcp_test_demo"] } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));
    expect(registry.toolNames).toEqual(["mcp_test_demo"]);

    registry = new ToolRegistry();
    stacks = await connectMcpServers({ test: { command: "test", enabled_tools: [] } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));
    expect(registry.toolNames).toEqual([]);
  });

  it("warns on unknown enabled_tools entries", async () => {
    setMcpRuntimeForTest(runtimeFor({ test: fakeSession(["demo"]) }) as any);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await connectMcpServers({ test: { command: "test", enabled_tools: ["unknown"] } }, new ToolRegistry());

    expect(warn.mock.calls[0][0]).toContain("enabledTools entries not found: unknown");
    expect(warn.mock.calls[0][0]).toContain("Available raw names: demo");
    expect(warn.mock.calls[0][0]).toContain("Available wrapped names: mcp_test_demo");
  });

  it("logs stdio pollution hints and one failure does not block another server", async () => {
    setMcpRuntimeForTest(runtimeFor({ good: fakeSession(["demo"]) }) as any);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const registry = new ToolRegistry();
    const stacks = await connectMcpServers({ good: { command: "good" }, bad: { command: "bad" }, polluted: { command: "polluted" } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));

    expect(registry.toolNames).toEqual(["mcp_good_demo"]);
    expect(Object.keys(stacks)).toEqual(["good"]);
    expect(error.mock.calls[0][0]).toContain("stdio protocol pollution");
  });

  it("passes Windows-wrapped stdio launchers and cwd", async () => {
    const captured: any[] = [];
    setMcpRuntimeForTest(runtimeFor({ "cmd.exe": fakeSession(["demo"]) }, (params) => captured.push(params)) as any);

    const stacks = await connectMcpServers({
      test: {
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest"],
        env: { COMSPEC: "cmd.exe" },
        cwd: "/tmp/memmy-agent-mcp-test",
        platform: "nt",
      },
    }, new ToolRegistry());
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));

    expect(captured[0].command).toBe("cmd.exe");
    expect(captured[0].args).toEqual(["/d", "/c", "npx", "-y", "chrome-devtools-mcp@latest"]);
    expect(captured[0].cwd).toBe("/tmp/memmy-agent-mcp-test");
  });
});

describe("MCPResourceWrapper", () => {
  const resource = { name: "myres", uri: "file:///tmp/data.txt", description: "A test resource" };

  it("exposes properties", () => {
    const wrapper = new MCPResourceWrapper(null, "myserver", resource);

    expect(wrapper.name).toBe("mcp_myserver_resource_myres");
    expect(wrapper.description).toContain("[MCP Resource]");
    expect(wrapper.parameters).toEqual({ type: "object", properties: {}, required: [] });
    expect(wrapper.readOnly).toBe(true);
  });

  it("returns text, blob, timeout, and error results", async () => {
    await expect(new MCPResourceWrapper({ async readResource() { return { contents: [new FakeTextResourceContents("line1"), new FakeTextResourceContents("line2")] }; } }, "srv", resource, 0.1).execute()).resolves.toBe("line1\nline2");
    await expect(new MCPResourceWrapper({ async readResource() { return { contents: [new FakeBlobResourceContents(new Uint8Array([0, 1, 2]))] }; } }, "srv", resource, 0.1).execute()).resolves.toContain("[Binary resource: 3 bytes]");
    await expect(new MCPResourceWrapper({ readResource: () => new Promise(() => undefined) }, "srv", resource, 0.01).execute()).resolves.toBe("(MCP resource read timed out after 0.01s)");
    const boom = new Error("boom");
    boom.name = "RuntimeError";
    await expect(new MCPResourceWrapper({ async readResource() { throw boom; } }, "srv", resource, 0.1).execute()).resolves.toBe("(MCP resource read failed: RuntimeError)");
  });
});

describe("MCPPromptWrapper", () => {
  it("exposes argument schema and descriptions", () => {
    const wrapper = new MCPPromptWrapper(null, "myserver", {
      name: "myprompt",
      description: "A test prompt",
      arguments: [
        { name: "topic", required: true, description: "The subject to discuss" },
        { name: "style", required: false },
      ],
    });

    expect(wrapper.name).toBe("mcp_myserver_prompt_myprompt");
    expect(wrapper.description).toContain("workflow guide");
    expect(wrapper.parameters.properties.topic).toEqual({ type: "string", description: "The subject to discuss" });
    expect(wrapper.parameters.properties.style).toEqual({ type: "string" });
    expect(wrapper.parameters.required).toEqual(["topic"]);
    expect(wrapper.readOnly).toBe(true);
  });

  it("returns text, timeout, mcp error, and generic error results", async () => {
    const prompt = { name: "myprompt", description: "A test prompt", arguments: null };
    await expect(new MCPPromptWrapper({ async getPrompt() { return { messages: [{ content: [new FakeTextContent("hello")] }] }; } }, "srv", prompt, 0.1).execute({ topic: "AI" })).resolves.toBe("hello");
    await expect(new MCPPromptWrapper({ getPrompt: () => new Promise(() => undefined) }, "srv", prompt, 0.01).execute()).resolves.toBe("(MCP prompt call timed out after 0.01s)");
    await expect(new MCPPromptWrapper({ async getPrompt() { throw new FakeMcpError(42, "invalid argument"); } }, "srv", prompt, 0.1).execute()).resolves.toContain("code 42");
    const boom = new Error("boom");
    boom.name = "RuntimeError";
    await expect(new MCPPromptWrapper({ async getPrompt() { throw boom; } }, "srv", prompt, 0.1).execute()).resolves.toBe("(MCP prompt call failed: RuntimeError)");
  });
});

describe("MCP names and capability registration", () => {
  it("sanitizes names consistently", () => {
    expect(sanitizeName("PostgreSQL System Information")).toBe("PostgreSQL_System_Information");
    expect(sanitizeName("foo.bar@baz!")).toBe("foo_bar_baz_");
    expect(sanitizeName("a   b")).toBe("a_b");
    expect(sanitizeName("my-tool_v2")).toBe("my-tool_v2");
  });

  it("sanitizes wrapper names and preserves original MCP names", () => {
    const wrapper = new MCPToolWrapper({ callTool: null }, "srv", toolDef("My Tool"));

    expect(wrapper.name).toBe("mcp_srv_My_Tool");
    expect(wrapper.originalName).toBe("My Tool");
    expect(new MCPResourceWrapper(null, "srv", { name: "PostgreSQL System Information", uri: "file:///pg/info", description: "PG info" }).name)
      .toBe("mcp_srv_resource_PostgreSQL_System_Information");
    expect(new MCPPromptWrapper(null, "my server", { name: "design-schema", description: "Design schema", arguments: null }).name)
      .toBe("mcp_my_server_prompt_design-schema");
  });

  it("registers resources and prompts and matches sanitized enabled tool names", async () => {
    setMcpRuntimeForTest(runtimeFor({
      test: fakeSession(["tool_a", "My Tool", "other"], ["PostgreSQL System Information"], ["prompt_c"]),
    }) as any);
    let registry = new ToolRegistry();
    let stacks = await connectMcpServers({ test: { command: "test" } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));

    expect(registry.toolNames).toContain("mcp_test_tool_a");
    expect(registry.toolNames).toContain("mcp_test_resource_PostgreSQL_System_Information");
    expect(registry.toolNames).toContain("mcp_test_prompt_prompt_c");

    registry = new ToolRegistry();
    stacks = await connectMcpServers({ test: { command: "test", enabled_tools: ["mcp_test_My_Tool"] } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));
    expect(registry.toolNames).toEqual(["mcp_test_My_Tool", "mcp_test_resource_PostgreSQL_System_Information", "mcp_test_prompt_prompt_c"]);
  });
});

describe("MCP parity split cases", () => {
  it("keeps existing Windows shells unchanged", () => {
    expect(normalizeWindowsStdioCommand("cmd.exe", ["/c", "echo", "hello"], null, "nt")).toEqual([
      "cmd.exe",
      ["/c", "echo", "hello"],
      null,
    ]);
  });

  it("handles generic MCP tool exceptions", async () => {
    const boom = new Error("boom");
    boom.name = "RuntimeError";

    await expect(new MCPToolWrapper({ async callTool() { throw boom; } }, "test", toolDef("demo"), 0.1).execute()).resolves.toBe(
      "(MCP tool call failed: RuntimeError)",
    );
  });

  it("connects enabled raw tool names", async () => {
    setMcpRuntimeForTest(runtimeFor({ test: fakeSession(["demo", "other"]) }) as any);
    const registry = new ToolRegistry();

    const stacks = await connectMcpServers({ test: { command: "test", enabled_tools: ["demo"] } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));

    expect(registry.toolNames).toEqual(["mcp_test_demo"]);
  });

  it("connects all tools by default", async () => {
    setMcpRuntimeForTest(runtimeFor({ test: fakeSession(["demo", "other"]) }) as any);
    const registry = new ToolRegistry();

    const stacks = await connectMcpServers({ test: { command: "test" } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));

    expect(registry.toolNames).toEqual(["mcp_test_demo", "mcp_test_other"]);
  });

  it("connects enabled wrapped tool names", async () => {
    setMcpRuntimeForTest(runtimeFor({ test: fakeSession(["demo", "other"]) }) as any);
    const registry = new ToolRegistry();

    const stacks = await connectMcpServers({ test: { command: "test", enabled_tools: ["mcp_test_demo"] } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));

    expect(registry.toolNames).toEqual(["mcp_test_demo"]);
  });

  it("registers no tools for an empty enabled_tools list", async () => {
    setMcpRuntimeForTest(runtimeFor({ test: fakeSession(["demo", "other"]) }) as any);
    const registry = new ToolRegistry();

    const stacks = await connectMcpServers({ test: { command: "test", enabled_tools: [] } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));

    expect(registry.toolNames).toEqual([]);
  });

  it("keeps connecting other MCP servers after one failure", async () => {
    setMcpRuntimeForTest(runtimeFor({ good: fakeSession(["demo"]) }) as any);
    const registry = new ToolRegistry();

    const stacks = await connectMcpServers({ good: { command: "good" }, bad: { command: "bad" } }, registry);
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));

    expect(registry.toolNames).toEqual(["mcp_good_demo"]);
    expect(Object.keys(stacks)).toEqual(["good"]);
  });

  it("passes stdio cwd to MCP server parameters", async () => {
    const captured: any[] = [];
    setMcpRuntimeForTest(runtimeFor({ test: fakeSession(["demo"]) }, (params) => captured.push(params)) as any);

    const stacks = await connectMcpServers({ test: { command: "test", cwd: "/tmp/memmy-agent-mcp-test" } }, new ToolRegistry());
    await Promise.all(Object.values(stacks).map((stack) => stack.aclose()));

    expect(captured[0].cwd).toBe("/tmp/memmy-agent-mcp-test");
  });

  it("resource wrapper execute returns text", async () => {
    const resource = { name: "myres", uri: "file:///tmp/data.txt", description: "A test resource" };
    const session = {
      async readResource(uri: string) {
        expect(uri).toBe("file:///tmp/data.txt");
        return { contents: [new FakeTextResourceContents("line1"), new FakeTextResourceContents("line2")] };
      },
    };

    await expect(new MCPResourceWrapper(session, "srv", resource, 0.1).execute()).resolves.toBe("line1\nline2");
  });

  it("resource wrapper execute handles blobs", async () => {
    const resource = { name: "myres", uri: "file:///tmp/data.txt", description: "A test resource" };

    await expect(
      new MCPResourceWrapper({ async readResource() { return { contents: [new FakeBlobResourceContents(new Uint8Array([0, 1, 2]))] }; } }, "srv", resource, 0.1).execute(),
    ).resolves.toContain("[Binary resource: 3 bytes]");
  });

  it("resource wrapper execute handles timeout", async () => {
    const resource = { name: "myres", uri: "file:///tmp/data.txt", description: "A test resource" };

    await expect(new MCPResourceWrapper({ readResource: () => new Promise(() => undefined) }, "srv", resource, 0.01).execute()).resolves.toBe(
      "(MCP resource read timed out after 0.01s)",
    );
  });

  it("resource wrapper execute handles errors", async () => {
    const resource = { name: "myres", uri: "file:///tmp/data.txt", description: "A test resource" };
    const boom = new Error("boom");
    boom.name = "RuntimeError";

    await expect(new MCPResourceWrapper({ async readResource() { throw boom; } }, "srv", resource, 0.1).execute()).resolves.toBe(
      "(MCP resource read failed: RuntimeError)",
    );
  });

  it("prompt wrapper has an empty schema with no arguments", () => {
    const wrapper = new MCPPromptWrapper(null, "myserver", { name: "myprompt", description: "A test prompt", arguments: null });

    expect(wrapper.parameters).toEqual({ type: "object", properties: {}, required: [] });
  });

  it("prompt wrapper preserves argument descriptions", () => {
    const wrapper = new MCPPromptWrapper(null, "srv", {
      name: "myprompt",
      description: "A test prompt",
      arguments: [{ name: "topic", required: true, description: "The subject to discuss" }],
    });

    expect(wrapper.parameters.properties.topic).toEqual({ type: "string", description: "The subject to discuss" });
  });

  it("prompt wrapper execute returns text", async () => {
    const prompt = { name: "myprompt", description: "A test prompt", arguments: null };
    const session = {
      async getPrompt(name: string, args: any) {
        expect(name).toBe("myprompt");
        expect(args).toEqual({ topic: "AI" });
        return {
          messages: [
            { content: [new FakeTextContent("You are an expert on {{topic}}.")] },
            { content: [new FakeTextContent("Understood. Ask me anything.")] },
          ],
        };
      },
    };

    const result = await new MCPPromptWrapper(session, "srv", prompt, 0.1).execute({ topic: "AI" });

    expect(result).toContain("You are an expert on {{topic}}.");
    expect(result).toContain("Understood. Ask me anything.");
  });

  it("prompt wrapper execute handles timeout", async () => {
    const prompt = { name: "myprompt", description: "A test prompt", arguments: null };

    await expect(new MCPPromptWrapper({ getPrompt: () => new Promise(() => undefined) }, "srv", prompt, 0.01).execute()).resolves.toBe(
      "(MCP prompt call timed out after 0.01s)",
    );
  });

  it("prompt wrapper execute handles MCP errors", async () => {
    const prompt = { name: "myprompt", description: "A test prompt", arguments: null };

    await expect(new MCPPromptWrapper({ async getPrompt() { throw new FakeMcpError(42, "invalid argument"); } }, "srv", prompt, 0.1).execute()).resolves.toContain(
      "invalid argument [code 42]",
    );
  });

  it("prompt wrapper execute handles generic errors", async () => {
    const prompt = { name: "myprompt", description: "A test prompt", arguments: null };
    const boom = new Error("boom");
    boom.name = "RuntimeError";

    await expect(new MCPPromptWrapper({ async getPrompt() { throw boom; } }, "srv", prompt, 0.1).execute()).resolves.toBe(
      "(MCP prompt call failed: RuntimeError)",
    );
  });

  it("sanitize name is a no-op for already clean names", () => {
    expect(sanitizeName("mcp_server_tool")).toBe("mcp_server_tool");
  });
});

describe("MCP runtime annotations and hot reload", () => {
  it("returns persisted session extras and model-visible runtime lines", () => {
    const presets = [{ name: "docs", display_name: "Docs", transport: "sse" }];

    expect(sessionExtra({ mcp_presets: presets })).toEqual({ mcp_presets: presets });
    expect(sessionExtra({ mcp_presets: [] })).toEqual({});

    expect(runtimeLines({ metadata: { mcp_presets: presets } }, { availableServerNames: new Set(["docs"]) })[0])
      .toContain("tool_prefix=mcp_docs_");
    expect(runtimeLines({ metadata: { mcp_presets: presets } }, { configuredServerNames: new Set(), connectedServerNames: new Set() })[0])
      .toContain("has not loaded the latest MCP settings");
    expect(runtimeLines({ metadata: { mcp_presets: presets } }, { configuredServerNames: new Set(["docs"]), connectedServerNames: new Set() })[0])
      .toContain("is not currently live");
    expect(runtimeLines({ metadata: { mcp_presets: presets } }, { skip: true })).toEqual([]);
  });

  it("connects only missing servers on a live state", async () => {
    setMcpRuntimeForTest(runtimeFor({
      missing: fakeSession(["demo"]),
    }) as any);
    const state = {
      mcpServers: {
        live: { command: "live" },
        missing: { command: "missing" },
      },
      mcpStacks: {
        live: { aclose: vi.fn(async () => undefined) },
      },
      mcpConnected: true,
      mcpConnecting: false,
    };
    const registry = new ToolRegistry();

    await connectMissingServers(state, registry);

    expect(Object.keys(state.mcpStacks).sort()).toEqual(["live", "missing"]);
    expect(registry.toolNames).toEqual(["mcp_missing_demo"]);
    expect(state.mcpConnected).toBe(true);
    expect(state.mcpConnecting).toBe(false);
  });

  it("reconciles added, changed, removed, and retry-missing servers", async () => {
    useConfig(new Config({
      tools: {
        mcpServers: {
          old: { command: "old" },
          changed: { command: "changed-new" },
          added: { command: "added" },
          retry: { command: "retry" },
        },
      },
    }));
    setMcpRuntimeForTest(runtimeFor({
      "changed-new": fakeSession(["fresh"]),
      added: fakeSession(["new_tool"]),
      retry: fakeSession(["again"]),
    }) as any);
    const closed: string[] = [];
    const stack = (name: string) => ({ aclose: vi.fn(async () => { closed.push(name); }) });
    const state = {
      mcpServers: {
        old: { command: "old" },
        changed: { command: "changed-old" },
        removed: { command: "removed" },
        retry: { command: "retry" },
      },
      mcpStacks: {
        old: stack("old"),
        changed: stack("changed"),
        removed: stack("removed"),
      },
      mcpConnected: true,
    };
    const registry = new ToolRegistry();
    registry.register(new MCPToolWrapper({ callTool: async () => ({ content: [] }) }, "old", toolDef("keep")));
    registry.register(new MCPToolWrapper({ callTool: async () => ({ content: [] }) }, "changed", toolDef("stale")));
    registry.register(new MCPToolWrapper({ callTool: async () => ({ content: [] }) }, "removed", toolDef("gone")));

    const result = await reloadServers(state, registry);

    expect(result).toMatchObject({
      ok: true,
      added: ["added"],
      changed: ["changed"],
      removed: ["removed"],
      retried: ["retry"],
      failed: [],
      tools_removed: 2,
      requires_restart: false,
    });
    expect(closed.sort()).toEqual(["changed", "removed"]);
    expect(result.connected).toEqual(["added", "changed", "old", "retry"]);
    expect(registry.toolNames.sort()).toEqual([
      "mcp_added_new_tool",
      "mcp_changed_fresh",
      "mcp_old_keep",
      "mcp_retry_again",
    ]);
  });

  it("handles runtime control reload acknowledgements and timeout fallback", async () => {
    useConfig(new Config({ tools: { mcpServers: {} } }));
    const state = { mcpServers: {}, mcpStacks: {}, mcpConnected: false };
    const registry = new ToolRegistry();
    let published: InboundMessage | null = null;
    const bus = {
      async publishInbound(msg: InboundMessage) {
        published = msg;
      },
    };

    const pending = requestMcpReload(bus, { timeout: 0.5 });
    await Promise.resolve();
    expect(published).not.toBeNull();
    const publishedMessage = published as unknown as InboundMessage;
    expect(publishedMessage.metadata[INBOUND_META_RUNTIME_CONTROL]).toBe(RUNTIME_CONTROL_MCP_RELOAD);
    expect(await handleRuntimeControl(state, publishedMessage, registry)).toBe(true);
    await expect(pending).resolves.toMatchObject({ ok: true, message: "MCP config is already live." });

    await expect(requestMcpReload({ async publishInbound() {} }, { timeout: 0.001 })).resolves.toMatchObject({
      ok: false,
      requires_restart: true,
    });
    const ignored = new InboundMessage({
      channel: "system",
      chatId: "runtime",
      senderId: "webui-settings",
      content: "noop",
      metadata: { [INBOUND_META_RUNTIME_CONTROL]: "other", [RUNTIME_CONTROL_ACK]: vi.fn() },
    });
    await expect(handleRuntimeControl(state, ignored, registry)).resolves.toBe(false);
  });

  it("unregisters and closes helpers using sanitized server prefixes", async () => {
    const registry = new ToolRegistry();
    registry.register(new MCPToolWrapper({ callTool: async () => ({ content: [] }) }, "my server", toolDef("search")));
    registry.register(new MCPToolWrapper({ callTool: async () => ({ content: [] }) }, "other", toolDef("search")));
    const state = { mcpStacks: { "my server": { aclose: vi.fn(async () => undefined) } } };

    expect(toolPrefix("my server")).toBe("mcp_my_server_");
    expect(serverSignature({ b: 1, a: ["x"] })).toBe('{"a":["x"],"b":1}');
    expect(unregisterServerTools(state, registry, "my server")).toBe(1);
    expect(registry.toolNames).toEqual(["mcp_other_search"]);
    await closeServer(state, "my server");
    expect(state.mcpStacks).toEqual({});
  });
});
