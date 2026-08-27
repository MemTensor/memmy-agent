import { Tool, type ToolExecutionContext } from "./base.js";

const HINT = "\n\n[Analyze the error above and try a different approach.]";

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private cachedDefinitions: Record<string, any>[] | null = null;

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.cachedDefinitions = null;
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.cachedDefinitions = null;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  private static schemaName(schema: Record<string, any>): string {
    return schema.function?.name ?? schema.name ?? "";
  }

  getDefinitions(): Record<string, any>[] {
    if (this.cachedDefinitions) return this.cachedDefinitions;
    const definitions = [...this.tools.values()].map((tool) => tool.toSchema());
    const builtins = definitions.filter((schema) => !ToolRegistry.schemaName(schema).startsWith("mcp_"));
    const mcp = definitions.filter((schema) => ToolRegistry.schemaName(schema).startsWith("mcp_"));
    builtins.sort((a, b) => ToolRegistry.schemaName(a).localeCompare(ToolRegistry.schemaName(b)));
    mcp.sort((a, b) => ToolRegistry.schemaName(a).localeCompare(ToolRegistry.schemaName(b)));
    this.cachedDefinitions = [...builtins, ...mcp];
    return this.cachedDefinitions;
  }

  prepareCall(name: string, params: Record<string, any>): [Tool | null, Record<string, any>, string | null] {
    if ((!params || typeof params !== "object" || Array.isArray(params)) && ["write_file", "read_file"].includes(name)) {
      return [
        null,
        params,
        `Error: Tool '${name}' parameters must be a JSON object, got ${Array.isArray(params) ? "array" : typeof params}. Use named parameters: tool_name(param1="value1", param2="value2")`,
      ];
    }
    const tool = this.tools.get(name);
    if (!tool) return [null, params, `Error: Tool '${name}' not found. Available: ${this.toolNames.join(", ")}`];
    const cast = tool.castParams(params ?? {});
    const errors = tool.validateParams(cast);
    if (errors.length) return [tool, cast, `Error: Invalid parameters for tool '${name}': ${errors.join("; ")}`];
    return [tool, cast, null];
  }

  async execute(name: string, params: Record<string, any>, context?: ToolExecutionContext): Promise<any> {
    const [tool, cast, error] = this.prepareCall(name, params);
    if (error) return error + HINT;
    try {
      const result = await tool!.execute(cast, context);
      if (typeof result === "string" && result.startsWith("Error")) return result + HINT;
      return result;
    } catch (fallbackError) {
      return `Error executing ${name}: ${(fallbackError as Error).message}` + HINT;
    }
  }

  get toolNames(): string[] {
    return [...this.tools.keys()];
  }

  get size(): number {
    return this.tools.size;
  }

  [Symbol.iterator](): IterableIterator<[string, Tool]> {
    return this.tools[Symbol.iterator]();
  }
}

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry();
}
