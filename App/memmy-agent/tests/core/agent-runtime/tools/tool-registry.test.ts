import { describe, expect, it } from "vitest";
import { Tool, ToolRegistry } from "../../../../src/core/agent-runtime/tools/index.js";

class FakeTool extends Tool {
  constructor(private readonly toolName: string) {
    super();
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return `${this.toolName} tool`;
  }

  get parameters(): Record<string, any> {
    return { type: "object", properties: {} };
  }

  async execute(params: Record<string, any> = {}): Promise<Record<string, any>> {
    return params;
  }
}

function toolNames(definitions: Array<Record<string, any>>): string[] {
  return definitions.map((definition) => definition.function?.name ?? "");
}

describe("ToolRegistry", () => {
  it("orders builtins before MCP tools", () => {
    const registry = new ToolRegistry();
    registry.register(new FakeTool("mcp_git_status"));
    registry.register(new FakeTool("write_file"));
    registry.register(new FakeTool("mcp_fs_list"));
    registry.register(new FakeTool("read_file"));

    expect(toolNames(registry.getDefinitions())).toEqual([
      "read_file",
      "write_file",
      "mcp_fs_list",
      "mcp_git_status",
    ]);
  });

  it("rejects non-object read_file params with an actionable hint", () => {
    const registry = new ToolRegistry();
    registry.register(new FakeTool("read_file"));

    const [tool, params, error] = registry.prepareCall("read_file", ["foo.txt"] as any);

    expect(tool).toBeNull();
    expect(params).toEqual(["foo.txt"]);
    expect(error).toContain("must be a JSON object");
    expect(error).toContain("Use named parameters");
  });

  it("keeps generic object validation for other tools", () => {
    const registry = new ToolRegistry();
    registry.register(new FakeTool("grep"));

    const [tool, params, error] = registry.prepareCall("grep", ["TODO"] as any);

    expect(tool).toBeInstanceOf(FakeTool);
    expect(params).toEqual(["TODO"]);
    expect(error).toBe("Error: Invalid parameters for tool 'grep': parameters must be an object, got array");
  });

  it("returns cached definitions", () => {
    const registry = new ToolRegistry();
    registry.register(new FakeTool("read_file"));

    const first = registry.getDefinitions();
    expect((registry as any).cachedDefinitions).not.toBeNull();
    const second = registry.getDefinitions();

    expect(second).toBe(first);
  });

  it("invalidates the cache on register", () => {
    const registry = new ToolRegistry();
    registry.register(new FakeTool("read_file"));
    const first = registry.getDefinitions();

    registry.register(new FakeTool("write_file"));
    const second = registry.getDefinitions();

    expect(second).not.toBe(first);
    expect(second).toHaveLength(2);
  });

  it("invalidates the cache on unregister", () => {
    const registry = new ToolRegistry();
    registry.register(new FakeTool("read_file"));
    registry.register(new FakeTool("write_file"));
    const first = registry.getDefinitions();

    registry.unregister("write_file");
    const second = registry.getDefinitions();

    expect(second).not.toBe(first);
    expect(second).toHaveLength(1);
  });
});
