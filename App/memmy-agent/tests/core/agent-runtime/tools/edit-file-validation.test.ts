import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditFileTool } from "../../../../src/core/agent-runtime/tools/filesystem.js";
import { ToolRegistry } from "../../../../src/core/agent-runtime/tools/registry.js";

const roots: string[] = [];
type Params = Parameters<EditFileTool["execute"]>[0];

function setup() {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "memmy-edit-validation-"));
  roots.push(root);
  const tool = new EditFileTool({ workspace: root, postWriteValidation: false });
  const registry = new ToolRegistry();
  registry.register(tool);
  return { root, tool, registry, file: path.join(root, "nested", "sample.txt") };
}

function watchFileAccess(tool: EditFileTool) {
  return [
    vi.spyOn(fs, "readFile"), vi.spyOn(fs, "writeFile"), vi.spyOn(fs, "mkdir"),
    vi.spyOn(fsSync, "statSync"), vi.spyOn(fsSync, "existsSync"),
    vi.spyOn(tool.fileStates(), "checkRead"), vi.spyOn(tool.fileStates(), "recordWrite"),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fsSync.rmSync(root, { recursive: true, force: true });
});

describe("edit_file parameter validation", () => {
  const conflicts: Params[] = [
    { occurrence: 1, line_hint: 1 },
    { replace_all: true, occurrence: 1 },
    { replace_all: true, line_hint: 1 },
    { occurrence: 1, lineHint: 1 },
    { replaceAll: true, occurrence: 1 },
    { replaceAll: true, lineHint: 1 },
    { replace_all: true, lineHint: 1 },
    { replace_all: true, occurrence: 1, line_hint: 1 },
  ];
  const scenarios = [
    { name: "matching", before: "same\nsame\n", oldText: "same", newText: "changed" },
    { name: "no match", before: "same\n", oldText: "absent", newText: "changed" },
    { name: "missing file", before: null, oldText: "same", newText: "changed" },
    { name: "create missing file", before: null, oldText: "", newText: "changed" },
    { name: "fill empty file", before: "", oldText: "", newText: "changed" },
    { name: "fill whitespace file", before: " \n", oldText: "", newText: "changed" },
    { name: "empty no-op", before: "", oldText: "", newText: "" },
    { name: "replacement no-op", before: "same\n", oldText: "same", newText: "same" },
    { name: "create over nonempty file", before: "same\n", oldText: "", newText: "changed" },
  ];

  for (const conflict of conflicts) {
    for (const scenario of scenarios) {
      it(`rejects ${JSON.stringify(conflict)} before file access: ${scenario.name}`, async () => {
        const { file, tool, registry } = setup();
        if (scenario.before !== null) {
          await fs.mkdir(path.dirname(file));
          await fs.writeFile(file, scenario.before);
        }
        const params = { path: file, old_text: scenario.oldText, new_text: scenario.newText, ...conflict };
        const spies = watchFileAccess(tool);
        const reportFileMutation = vi.fn();
        expect(registry.prepareCall("edit_file", params)[2]).toContain("cannot be used");
        expect(await registry.execute("edit_file", params, { reportFileMutation })).toContain("cannot be used");
        expect(await tool.execute(params, { reportFileMutation })).toContain("cannot be used");
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(reportFileMutation).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        if (scenario.before === null) {
          expect(fsSync.existsSync(path.dirname(file))).toBe(false);
        } else {
          expect(await fs.readFile(file, "utf8")).toBe(scenario.before);
        }
      });
    }
  }

  it.each(["occurrence", "line_hint", "lineHint", "expected_replacements", "expectedReplacements"])(
    "rejects invalid %s before accessing files through either entry point", async (name) => {
      const { file, tool, registry } = setup();
      const spies = watchFileAccess(tool);
      for (const value of [0, -1, 1.5, NaN, Infinity]) {
        const params = { path: file, old_text: "same", new_text: "changed", [name]: value };
        expect(registry.prepareCall("edit_file", params)[2]).not.toBeNull();
        expect(await tool.execute(params)).toMatch(/^Error:/);
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    },
  );

  it.each([
    { occurrence: 1 }, { line_hint: 1 }, { lineHint: 1 }, { replace_all: true }, { replaceAll: true },
    { expected_replacements: 2 }, { expectedReplacements: 99 },
  ])("rejects replacement-only options in create mode: %j", async (options) => {
    const { file, tool, registry } = setup();
    const spies = watchFileAccess(tool);
    const params = { path: file, oldText: "", newText: "created", ...options };
    expect(registry.prepareCall("edit_file", params)[2]).toContain("create mode");
    expect(await tool.execute(params)).toContain("create mode");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("preserves normal schema validation for malformed parameter objects", () => {
    const { registry } = setup();
    for (const params of [null, [], 42, { path: "sample.txt", occurrence: "invalid" }]) {
      expect(registry.prepareCall("edit_file", params as any)[2]).toContain("Invalid parameters");
    }
  });
});

describe("edit_file valid modes and independent replacement counts", () => {
  const modes = [
    { name: "unique", options: {}, before: "same\n", after: "changed\n", count: 1 },
    { name: "occurrence", options: { occurrence: 2 }, before: "same\nx\nsame\n", after: "same\nx\nchanged\n", count: 1 },
    { name: "line_hint", options: { line_hint: 4 }, before: "same\nx\nsame\n", after: "same\nx\nchanged\n", count: 1 },
    { name: "replace_all", options: { replace_all: true }, before: "same\nx\nsame\n", after: "changed\nx\nchanged\n", count: 2 },
  ];
  for (const mode of modes) {
    for (const aliases of [false, true]) {
      it(`${mode.name}, aliases=${aliases}: asserts count without selecting matches`, async () => {
        const { file, registry } = setup();
        await fs.mkdir(path.dirname(file));
        await fs.writeFile(file, mode.before);
        const params: Record<string, unknown> = { path: file, old_text: "same", new_text: "changed", ...mode.options };
        const countKey = aliases ? "expectedReplacements" : "expected_replacements";
        if (aliases) {
          for (const [snake, camel] of [["old_text", "oldText"], ["new_text", "newText"], ["line_hint", "lineHint"], ["replace_all", "replaceAll"]]) {
            if (snake in params) { params[camel] = params[snake]; delete params[snake]; }
          }
        }
        const rejected = await registry.execute("edit_file", { ...params, [countKey]: mode.count + 1 });
        expect(rejected).toContain(`expected ${mode.count + 1} replacements but would make ${mode.count}`);
        expect(await fs.readFile(file, "utf8")).toBe(mode.before);
        expect(await registry.execute("edit_file", { ...params, [countKey]: mode.count })).toContain("Successfully edited");
        expect(await fs.readFile(file, "utf8")).toBe(mode.after);
      });
    }
  }

  it.each([undefined, null, 1])("accepts create mode with expected_replacements=%s", async (count) => {
    for (const before of [null, "", " \n"]) {
      const { file, registry } = setup();
      if (before !== null) { await fs.mkdir(path.dirname(file)); await fs.writeFile(file, before); }
      const result = await registry.execute("edit_file", {
        path: file, old_text: "", new_text: "created", replace_all: false,
        occurrence: null, line_hint: null, ...(count === undefined ? {} : { expected_replacements: count }),
      });
      expect(result).toContain("Successfully");
      expect(await fs.readFile(file, "utf8")).toBe("created");
    }
  });

  it("checks the count before a create-mode no-op", async () => {
    const { file, tool } = setup();
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, "");
    const write = vi.spyOn(fs, "writeFile");
    const params = { path: file, old_text: "", new_text: "" };
    expect(await tool.execute({ ...params, expected_replacements: 2 })).toContain("expected 2 replacements");
    expect(await tool.execute({ ...params, expected_replacements: 1 })).toContain("No changes made");
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { occurrence: 1, line_hint: null, lineHint: null, replace_all: false },
    { occurrence: null, line_hint: 1, replace_all: false },
    { occurrence: null, line_hint: null, replace_all: true },
    { occurrence: 1, replace_all: false, replaceAll: true, line_hint: null, lineHint: null },
  ])("accepts unused selectors and preserves alias precedence: %j", async (options) => {
    const { file, registry } = setup();
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, "same\n");
    expect(await registry.execute("edit_file", {
      path: file, old_text: "same", new_text: "changed", expected_replacements: 1, ...options,
    })).toContain("Successfully edited");
    expect(await fs.readFile(file, "utf8")).toBe("changed\n");
  });

  it("checks effective aliases after registry type casting", async () => {
    const { file, registry } = setup();
    const spies = watchFileAccess(registry.get("edit_file") as EditFileTool);
    const result = await registry.execute("edit_file", {
      path: file, oldText: "same", newText: "changed", replaceAll: "true", line_hint: null, lineHint: "1",
    });
    expect(result).toContain("line_hint cannot be used with replace_all=true");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("does not use a count assertion to resolve ambiguous matches", async () => {
    const { file, registry } = setup();
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, "same\nsame\n");
    const result = await registry.execute("edit_file", {
      path: file, old_text: "same", new_text: "changed", expected_replacements: 1,
    });
    expect(result).toContain("old_text appears 2 times");
    expect(await fs.readFile(file, "utf8")).toBe("same\nsame\n");
  });
});
