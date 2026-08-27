import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tool } from "../../../src/core/agent-runtime/tools/base.js";
import { ToolLoader } from "../../../src/core/agent-runtime/tools/loader.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-tool-loader-entrypoint-"));
  roots.push(root);
  return root;
}

function writePluginPackage(root: string, name: string, toolName: string): void {
  const pkg = path.join(root, "node_modules", name);
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name, version: "1.0.0", memmyAgent: { tools: "./tool.cjs" } }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pkg, "tool.cjs"),
    `
class ExternalTool {
  static pluginDiscoverable = true;
  static scopes = new Set(["core"]);
  get name() { return ${JSON.stringify(toolName)}; }
  get description() { return "External tool for testing."; }
  get parameters() { return { type: "object", properties: {} }; }
  async execute() { return "external-ok"; }
}
module.exports = { toolClasses: [ExternalTool] };
`,
    "utf8",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ToolLoader entrypoints", () => {
  it("discovers plugin-like tool classes supplied by entrypoint tests", () => {
    class FakeTool extends Tool {
      static pluginDiscoverable = true;
      static scopes = new Set(["core"]);

      get name(): string {
        return "fake_tool";
      }

      get description(): string {
        return "A fake tool for testing.";
      }

      get parameters(): Record<string, any> {
        return { type: "object" };
      }

      async execute(): Promise<string> {
        return "ok";
      }
    }

    const discovered = new ToolLoader({ testClasses: [FakeTool] }).discover();

    expect(discovered).toEqual([FakeTool]);
  });

  it("skips abstract plugin-like tool classes", () => {
    abstract class AbstractTool extends Tool {
      static pluginDiscoverable = true;
      static scopes = new Set(["core"]);
    }

    const discovered = new ToolLoader({ testClasses: [AbstractTool as any] }).discover();

    expect(discovered).toEqual([]);
  });

  it("discovers built-in tool classes and loads a core registry", () => {
    const loader = new ToolLoader({ workspace: "/tmp/memmy-tool-loader-entrypoints" });
    const registry = loader.loadRegistry();

    expect(loader.discover().map((cls) => cls.name)).toContain("ReadFileTool");
    expect(registry.toolNames).toEqual(expect.arrayContaining(["read_file", "exec", "message"]));
  });

  it("discovers npm package tools from memmyAgent metadata", () => {
    const root = tempRoot();
    writePluginPackage(root, "memmy-external-tool", "external_tool");

    const loader = new ToolLoader({ workspace: root });
    const registry = loader.loadRegistry();

    expect(loader.discoverPlugins().map((cls) => cls.name)).toContain("ExternalTool");
    expect(registry.toolNames).toContain("external_tool");
  });

  it("does not let package tools override built-in tools", () => {
    const root = tempRoot();
    writePluginPackage(root, "memmy-conflicting-tool", "read_file");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const registry = new ToolLoader({ workspace: root }).loadRegistry();

    expect(registry.get("read_file")?.constructor.name).toBe("ReadFileTool");
    expect(warn.mock.calls.some((call) => String(call[0]).includes("conflicts with a built-in tool"))).toBe(true);
  });
});
