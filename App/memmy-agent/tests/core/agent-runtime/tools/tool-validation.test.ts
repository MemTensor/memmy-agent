import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ArraySchema,
  IntegerSchema,
  ObjectSchema,
  Schema,
  StringSchema,
  Tool,
  ToolRegistry,
  toolParameters,
  toolParametersSchema,
} from "../../../../src/core/agent-runtime/tools/index.js";
import { ExecTool, ExecToolConfig } from "../../../../src/core/agent-runtime/tools/shell.js";
import { configureSsrfWhitelist } from "../../../../src/security/network.js";

class SampleTool extends Tool {
  get name() {
    return "sample";
  }

  get description() {
    return "sample tool";
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        query: { type: "string", minLength: 2 },
        count: { type: "integer", minimum: 1, maximum: 10 },
        mode: { type: "string", enum: ["fast", "full"] },
        meta: {
          type: "object",
          properties: {
            tag: { type: "string" },
            flags: { type: "array", items: { type: "string" } },
          },
          required: ["tag"],
        },
      },
      required: ["query", "count"],
    };
  }

  async execute() {
    return "ok";
  }
}

class DecoratedBase extends Tool {
  get name() {
    return "decorated_sample";
  }

  get description() {
    return "decorated sample tool";
  }

  get parameters(): any {
    return {};
  }

  async execute(params: any = {}) {
    return `ok:${params.count}`;
  }
}

const DecoratedSampleTool = toolParameters(
  toolParametersSchema({
    query: new StringSchema("", { minLength: 2 }),
    count: new IntegerSchema(2, { minimum: 1, maximum: 10 }),
    required: ["query", "count"],
  }),
)(DecoratedBase);

class CastTestTool extends Tool {
  constructor(private readonly schema: Record<string, any>) {
    super();
  }

  get name() {
    return "cast_test";
  }

  get description() {
    return "test tool for casting";
  }

  get parameters() {
    return this.schema;
  }

  async execute() {
    return "ok";
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "memmy-tool-validation-"));
}

function shellQuote(value: string): string {
  if (process.platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

describe("tool schema validation", () => {
  it("matches Schema.validateJsonSchemaValue, ObjectSchema.validateValue, and Tool.validateParams", () => {
    const root = toolParametersSchema({
      query: new StringSchema("", { minLength: 2 }),
      count: new IntegerSchema(2, { minimum: 1, maximum: 10 }),
      required: ["query", "count"],
    });
    const obj = new ObjectSchema(
      {
        query: new StringSchema("", { minLength: 2 }),
        count: new IntegerSchema(2, { minimum: 1, maximum: 10 }),
      },
      { required: ["query", "count"] },
    );
    const params = { query: "h", count: 2 };

    class MiniTool extends Tool {
      get name() {
        return "m";
      }

      get description() {
        return "";
      }

      get parameters() {
        return root;
      }

      async execute() {
        return "";
      }
    }

    const expected = new MiniTool().validateParams(params);
    expect(Schema.validateJsonSchemaValue(params, root, "")).toEqual(expected);
    expect(obj.validateValue(params, "")).toEqual(expected);
    expect(new IntegerSchema(0, { minimum: 1 }).validateValue(0, "n")).toEqual(["n must be >= 1"]);
  });

  it("builds JSON schemas equivalent to hand-written tool parameters", () => {
    const built = toolParametersSchema({
      query: new StringSchema("", { minLength: 2 }),
      count: new IntegerSchema(2, { minimum: 1, maximum: 10 }),
      mode: new StringSchema("", { enum: ["fast", "full"] }),
      meta: new ObjectSchema(
        {
          tag: new StringSchema(""),
          flags: new ArraySchema(new StringSchema("")),
        },
        { required: ["tag"] },
      ),
      required: ["query", "count"],
    });
    expect(built).toEqual(new SampleTool().parameters);
  });

  it("returns a fresh parameters copy for decorated tools", () => {
    const tool = new (DecoratedSampleTool as any)();

    const first = tool.parameters;
    const second = tool.parameters;

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.properties).not.toBe(second.properties);

    first.properties.query.minLength = 99;
    expect(tool.parameters.properties.query.minLength).toBe(2);
  });

  it("executes decorated tools through the registry", async () => {
    const reg = new ToolRegistry();
    reg.register(new (DecoratedSampleTool as any)());

    await expect(reg.execute("decorated_sample", { query: "hello", count: "3" })).resolves.toBe("ok:3");
  });

  it("reports registry validation errors", async () => {
    const reg = new ToolRegistry();
    reg.register(new SampleTool());

    await expect(reg.execute("sample", { query: "hi" })).resolves.toContain("Invalid parameters");
    await expect(reg.execute("decorated_sample", { query: "h", count: 3 })).resolves.toContain("not found");
  });

  it("validates missing required parameters", () => {
    const errors = new SampleTool().validateParams({ query: "hi" });

    expect(errors.join("; ")).toContain("missing required count");
  });

  it("validates parameter type and range", () => {
    const tool = new SampleTool();

    expect(tool.validateParams({ query: "hi", count: 0 }).some((e) => e.includes("count must be >= 1"))).toBe(true);
    expect(tool.validateParams({ query: "hi", count: "2" }).some((e) => e.includes("count should be integer"))).toBe(
      true,
    );
  });

  it("validates enum and minimum string length", () => {
    const errors = new SampleTool().validateParams({ query: "h", count: 2, mode: "slow" });

    expect(errors.some((e) => e.includes("query must be at least 2 chars"))).toBe(true);
    expect(errors.some((e) => e.includes("mode must be one of"))).toBe(true);
  });

  it("validates nested objects and arrays", () => {
    const errors = new SampleTool().validateParams({
      query: "hi",
      count: 2,
      meta: { flags: [1, "ok"] },
    });

    expect(errors.some((e) => e.includes("missing required meta.tag"))).toBe(true);
    expect(errors.some((e) => e.includes("meta.flags[0] should be string"))).toBe(true);
  });

  it("ignores unknown fields", () => {
    expect(new SampleTool().validateParams({ query: "hi", count: 2, extra: "x" })).toEqual([]);
  });

  it("keeps full Windows paths when extracting absolute paths", () => {
    expect(ExecTool.extractAbsolutePaths(String.raw`type C:\user\workspace\txt`)).toEqual([
      String.raw`C:\user\workspace\txt`,
    ]);
  });

  it("captures Windows drive root paths", () => {
    expect(ExecTool.extractAbsolutePaths("dir E:\\")).toEqual(["E:\\"]);
  });

  it("ignores relative POSIX path segments", () => {
    expect(ExecTool.extractAbsolutePaths("node_modules/.bin/tsx script.ts")).not.toContain("/.bin/tsx");
  });

  it("ignores URLs while extracting paths", () => {
    const paths = ExecTool.extractAbsolutePaths('curl -s -o /dev/null -w "%{http_code}" https://www.google.com');
    expect(paths).toEqual(["/dev/null"]);
  });

  it.each([
    'curl -s -o /dev/null -w "%{http_code}" https://93.184.216.34',
    "wget -q -O - http://93.184.216.34 2>&1 | head -c 100",
    "node -e \"fetch('http://93.184.216.34').then(r => r.text()).then(t => console.log(t.slice(0, 100)))\"",
  ])("allows public URLs in guarded exec commands: %s", async (command) => {
    const dir = makeTempDir();
    try {
      const error = await new ExecTool({ restrictToWorkspace: true }).guardCommand(command, dir);
      expect(error).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows whitelisted internal URLs in guarded exec commands", async () => {
    const dir = makeTempDir();
    configureSsrfWhitelist(["10.10.10.0/24"]);
    try {
      const error = await new ExecTool({ restrictToWorkspace: true }).guardCommand(
        'curl -s -H "Authorization: Bearer ..." http://10.10.10.3:8123/api/',
        dir,
      );
      expect(error).toBeNull();
    } finally {
      configureSsrfWhitelist([]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("captures POSIX absolute paths", () => {
    const paths = ExecTool.extractAbsolutePaths("cat /tmp/data.txt > /tmp/out.txt");
    expect(paths).toContain("/tmp/data.txt");
    expect(paths).toContain("/tmp/out.txt");
  });

  it("captures home paths", () => {
    const paths = ExecTool.extractAbsolutePaths("cat ~/.memmy/config.yaml > ~/out.txt");
    expect(paths).toContain("~/.memmy/config.yaml");
    expect(paths).toContain("~/out.txt");
  });

  it("captures quoted absolute and home paths", () => {
    const paths = ExecTool.extractAbsolutePaths('cat "/tmp/data.txt" "~/.memmy/config.yaml"');
    expect(paths).toContain("/tmp/data.txt");
    expect(paths).toContain("~/.memmy/config.yaml");
  });

  it("blocks home paths outside the guarded workspace", async () => {
    const dir = makeTempDir();
    try {
      const error = await new ExecTool({ restrictToWorkspace: true }).guardCommand("cat ~/.memmy/config.yaml", dir);
      expect(error).toMatch(/^Error: Command blocked by safety guard \(path outside working dir\)/);
      expect(error).toContain("hard policy boundary");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks quoted home paths outside the guarded workspace", async () => {
    const dir = makeTempDir();
    try {
      const error = await new ExecTool({ restrictToWorkspace: true }).guardCommand('cat "~/.memmy/config.yaml"', dir);
      expect(error).toMatch(/^Error: Command blocked by safety guard \(path outside working dir\)/);
      expect(error).toContain("hard policy boundary");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows media paths outside the guarded workspace", async () => {
    const root = makeTempDir();
    const previous = process.env.MEMMY_AGENT_DATA_DIR;
    process.env.MEMMY_AGENT_DATA_DIR = root;
    try {
      const mediaDir = path.join(root, "media");
      fs.mkdirSync(mediaDir, { recursive: true });
      const mediaFile = path.join(mediaDir, "photo.jpg");
      fs.writeFileSync(mediaFile, "ok", "utf8");

      const error = await new ExecTool({ restrictToWorkspace: true }).guardCommand(
        `cat ${shellQuote(mediaFile)}`,
        path.join(root, "workspace"),
      );
      expect(error).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.MEMMY_AGENT_DATA_DIR;
      else process.env.MEMMY_AGENT_DATA_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks Windows drive roots outside the guarded workspace", async () => {
    const error = await new ExecTool({ restrictToWorkspace: true }).guardCommand("dir E:\\", "E:\\workspace");
    expect(error).toMatch(/^Error: Command blocked by safety guard \(path outside working dir\)/);
    expect(error).toContain("hard policy boundary");
  });

  it("allows /dev/null redirects outside the guarded workspace", async () => {
    const root = makeTempDir();
    try {
      const workspace = path.join(root, "workspace");
      fs.mkdirSync(workspace);
      const file = path.join(workspace, "file.txt");
      fs.writeFileSync(file, "ok", "utf8");
      const error = await new ExecTool({ restrictToWorkspace: true }).guardCommand(`rm ${shellQuote(file)} 2>/dev/null`, workspace);
      expect(error).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows /dev/urandom reads outside the guarded workspace", async () => {
    const dir = makeTempDir();
    try {
      const error = await new ExecTool({ restrictToWorkspace: true }).guardCommand(
        "cat /dev/urandom | head -c 16 > random.bin",
        dir,
      );
      expect(error).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks non-benign /dev paths outside the guarded workspace", async () => {
    const dir = makeTempDir();
    try {
      const error = await new ExecTool({ restrictToWorkspace: true }).guardCommand("cat /dev/sda", dir);
      expect(error).toContain("path outside working dir");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores pipe-prefixed tilde expressions when extracting paths", () => {
    const paths = ExecTool.extractAbsolutePaths("node query.js --query '{job=\"app\"} |~ \"error\"'");
    expect(paths.some((p) => p.startsWith("~"))).toBe(false);
  });

  it("casts string integers", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { count: { type: "integer" } },
    });

    const result = tool.castParams({ count: "42" });
    expect(result.count).toBe(42);
    expect(typeof result.count).toBe("number");
  });

  it("casts string numbers", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { rate: { type: "number" } },
    });

    const result = tool.castParams({ rate: "3.14" });
    expect(result.rate).toBe(3.14);
    expect(typeof result.rate).toBe("number");
  });

  it("casts boolean strings", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { enabled: { type: "boolean" } },
    });

    expect(tool.castParams({ enabled: "true" }).enabled).toBe(true);
    expect(tool.castParams({ enabled: "false" }).enabled).toBe(false);
    expect(tool.castParams({ enabled: "1" }).enabled).toBe(true);
  });

  it("casts array items", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: {
        nums: { type: "array", items: { type: "integer" } },
      },
    });

    expect(tool.castParams({ nums: ["1", "2", "3"] }).nums).toEqual([1, 2, 3]);
  });

  it("casts nested object values", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            port: { type: "integer" },
            debug: { type: "boolean" },
          },
        },
      },
    });

    const result = tool.castParams({ config: { port: "8080", debug: "true" } });
    expect(result.config.port).toBe(8080);
    expect(result.config.debug).toBe(true);
  });

  it("does not silently cast booleans to integers", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { count: { type: "integer" } },
    });

    const result = tool.castParams({ count: true });
    expect(result.count).toBe(true);
    expect(tool.validateParams(result).some((e) => e.includes("count should be integer"))).toBe(true);
  });

  it("preserves empty strings for string fields", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { name: { type: "string" } },
    });

    expect(tool.castParams({ name: "" }).name).toBe("");
  });

  it("casts false-like boolean strings", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { flag: { type: "boolean" } },
    });

    expect(tool.castParams({ flag: "false" }).flag).toBe(false);
    expect(tool.castParams({ flag: "FALSE" }).flag).toBe(false);
    expect(tool.castParams({ flag: "0" }).flag).toBe(false);
    expect(tool.castParams({ flag: "no" }).flag).toBe(false);
    expect(tool.castParams({ flag: "NO" }).flag).toBe(false);
  });

  it("preserves invalid boolean strings for validation", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { flag: { type: "boolean" } },
    });

    expect(tool.castParams({ flag: "random" }).flag).toBe("random");
    expect(tool.castParams({ flag: "maybe" }).flag).toBe("maybe");
  });

  it("preserves invalid integer strings for validation", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { count: { type: "integer" } },
    });

    expect(tool.castParams({ count: "abc" }).count).toBe("abc");
    expect(tool.castParams({ count: "12.5.7" }).count).toBe("12.5.7");
  });

  it("preserves invalid number strings for validation", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { rate: { type: "number" } },
    });

    expect(tool.castParams({ rate: "not_a_number" }).rate).toBe("not_a_number");
  });

  it("does not accept booleans as numbers", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { rate: { type: "number" } },
    });

    expect(tool.validateParams({ rate: false }).some((e) => e.includes("rate should be number"))).toBe(true);
  });

  it("preserves null values while casting", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        items: { type: "array" },
        config: { type: "object" },
      },
    });

    const result = tool.castParams({ name: null, count: null, items: null, config: null });
    expect(result.name).toBeNull();
    expect(result.count).toBeNull();
    expect(result.items).toBeNull();
    expect(result.config).toBeNull();
  });

  it("does not wrap single values as arrays", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { items: { type: "array" } },
    });

    expect(tool.castParams({ items: 5 }).items).toBe(5);
    expect(tool.castParams({ items: "text" }).items).toBe("text");
  });

  it("always returns an exit code from exec", async () => {
    const result = await new ExecTool().execute({ command: "echo hello" });
    expect(result).toContain("Exit code: 0");
    expect(result).toContain("hello");
  });

  it("uses head-tail truncation for long exec output", async () => {
    const dir = makeTempDir();
    try {
      const script = path.join(dir, "gen-output.js");
      fs.writeFileSync(script, 'console.log("A".repeat(6000) + "\\n" + "B".repeat(6000));\n', "utf8");

      const result = await new ExecTool().execute({ command: `${shellQuote(process.execPath)} ${shellQuote(script)}` });
      expect(result).toContain("chars truncated");
      expect(result.startsWith("A")).toBe(true);
      expect(result).toContain("Exit code:");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the per-call timeout parameter", async () => {
    const command = `${shellQuote(process.execPath)} -e ${shellQuote("setTimeout(() => {}, 10000)")}`;
    const result = await new ExecTool({ timeout: 60 }).execute({ command, timeout: 1 });
    expect(result).toContain("timed out");
    expect(result).toContain("1 seconds");
  });

  it("caps per-call exec timeout at the maximum", async () => {
    const result = await new ExecTool().execute({ command: "echo ok", timeout: 9999 });
    expect(result).toContain("Exit code: 0");
  });

  it("keeps config timeout uncapped and accepts zero as unlimited", () => {
    expect(new ExecToolConfig({ timeout: 0 }).timeout).toBe(0);
    expect(new ExecToolConfig({ timeout: 3600 }).timeout).toBe(3600);
    expect(() => new ExecToolConfig({ timeout: -1 })).toThrow(/timeout/);
  });

  it("resolves config timeout as uncapped and zero as unlimited", () => {
    expect(new ExecTool({ timeout: 3600 }).resolveTimeout(null)).toBe(3600);
    expect(new ExecTool({ timeout: 0 }).resolveTimeout(null)).toBeNull();
  });

  it("caps per-call timeout even when config timeout is unlimited", () => {
    expect(new ExecTool({ timeout: 0 }).resolveTimeout(9999)).toBe(ExecTool.MAX_TIMEOUT);
    expect(new ExecTool({ timeout: 60 }).resolveTimeout(120)).toBe(120);
  });

  it("resolves simple string JSON schema types", () => {
    expect(Schema.resolveJsonSchemaType("string")).toBe("string");
  });

  it("resolves JSON schema union types with null", () => {
    expect(Schema.resolveJsonSchemaType(["string", "null"])).toBe("string");
  });

  it("resolves JSON schema union types containing only null to null", () => {
    expect(Schema.resolveJsonSchemaType(["null"])).toBeNull();
  });

  it("resolves null JSON schema type input to null", () => {
    expect(Schema.resolveJsonSchemaType(null)).toBeNull();
  });

  it("accepts strings for nullable parameters", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { name: { type: ["string", "null"] } },
    });

    expect(tool.validateParams({ name: "hello" })).toEqual([]);
  });

  it("accepts null for nullable parameters", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { name: { type: ["string", "null"] } },
    });

    expect(tool.validateParams({ name: null })).toEqual([]);
  });

  it("accepts null for normalized nullable flags", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { name: { type: "string", nullable: true } },
    });

    expect(tool.validateParams({ name: null })).toEqual([]);
  });

  it("casts nullable parameters without crashing", () => {
    const tool = new CastTestTool({
      type: "object",
      properties: { name: { type: ["string", "null"] } },
    });

    expect(tool.castParams({ name: "hello" }).name).toBe("hello");
    expect(tool.castParams({ name: null }).name).toBeNull();
  });
});
