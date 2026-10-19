import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditFileTool } from "../../../../src/core/agent-runtime/tools/filesystem.js";
import { ToolRegistry } from "../../../../src/core/agent-runtime/tools/registry.js";

const roots: string[] = [];
const aliases = ["oldText", "newText", "replaceAll", "lineHint", "expectedReplacements"];

function setup() {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "memmy-edit-aliases-"));
  roots.push(root);
  const tool = new EditFileTool({ workspace: root, postWriteValidation: false });
  const registry = new ToolRegistry();
  registry.register(tool);
  return { root, file: path.join(root, "nested", "sample.txt"), tool, registry };
}

function watchFileAccess(tool: EditFileTool) {
  return [
    vi.spyOn(fs, "readFile"), vi.spyOn(fs, "writeFile"), vi.spyOn(fs, "mkdir"),
    vi.spyOn(fsSync, "existsSync"), vi.spyOn(fsSync, "statSync"),
    vi.spyOn(tool.fileStates(), "checkRead"), vi.spyOn(tool.fileStates(), "recordWrite"),
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fsSync.rmSync(root, { recursive: true, force: true });
});

describe("edit_file alias compatibility", () => {
  it("exposes only canonical fields to the model and requires both text arguments", () => {
    const { registry } = setup();
    const schema = registry.getDefinitions()[0].function.parameters;
    expect(Object.keys(schema.properties).sort()).toEqual([
      "expected_replacements", "line_hint", "new_text", "occurrence", "old_text", "path", "replace_all",
    ]);
    expect(schema.required).toEqual(["path", "old_text", "new_text"]);
    expect(registry.prepareCall("edit_file", { path: "file.txt" })[2]).toContain("missing required old_text");
    expect(registry.prepareCall("edit_file", { path: "file.txt", oldText: "old" })[2]).toContain("missing required new_text");
  });

  it("casts old aliases, removes them, and leaves the caller's object intact", () => {
    const { file, registry } = setup();
    const input = { path: file, oldText: "alpha", newText: "", replaceAll: "false", lineHint: "3", expectedReplacements: "1" };
    const before = structuredClone(input);
    const [, normalized, error] = registry.prepareCall("edit_file", input);
    expect(error).toBeNull();
    expect(normalized).toEqual({ path: file, old_text: "alpha", new_text: "", replace_all: false, line_hint: 3, expected_replacements: 1 });
    expect(input).toEqual(before);
  });

  it("merges equal duplicates after type conversion", () => {
    const { file, registry } = setup();
    const [, normalized, error] = registry.prepareCall("edit_file", {
      path: file, old_text: "alpha", oldText: "alpha", new_text: "", newText: "",
      replace_all: false, replaceAll: "false", line_hint: 3, lineHint: "3",
      expected_replacements: 1, expectedReplacements: "1",
    });
    expect(error).toBeNull();
    expect(normalized).toEqual({ path: file, old_text: "alpha", new_text: "", replace_all: false, line_hint: 3, expected_replacements: 1 });
  });

  const conflicts = [
    { pair: ["old_text", "oldText"], values: { old_text: "alpha", oldText: "other" } },
    { pair: ["new_text", "newText"], values: { new_text: "X", newText: "Y" } },
    { pair: ["replace_all", "replaceAll"], values: { replace_all: false, replaceAll: true } },
    { pair: ["replace_all", "replaceAll"], values: { replace_all: true, replaceAll: false } },
    { pair: ["line_hint", "lineHint"], values: { line_hint: 1, lineHint: 3 } },
    { pair: ["expected_replacements", "expectedReplacements"], values: { expected_replacements: 1, expectedReplacements: 2 } },
    { pair: ["old_text", "oldText"], values: { old_text: "", oldText: "alpha" } },
    { pair: ["old_text", "oldText"], values: { old_text: "alpha", oldText: "" } },
    { pair: ["new_text", "newText"], values: { new_text: "", newText: "replacement" } },
    { pair: ["new_text", "newText"], values: { new_text: "replacement", newText: "" } },
  ];
  for (const conflict of conflicts) {
    for (const state of ["matching", "no-match", "missing", "create", "empty", "noop"] as const) {
      it(`rejects ${JSON.stringify(conflict.values)} before file access (${state})`, async () => {
        const { file, tool, registry } = setup();
        const before = state === "empty" || state === "noop" ? "" : "alpha\nother\nalpha\n";
        const exists = state !== "missing" && state !== "create";
        if (exists) { await fs.mkdir(path.dirname(file)); await fs.writeFile(file, before); }
        const input = {
          path: file,
          old_text: ["create", "empty", "noop"].includes(state) ? "" : state === "no-match" ? "absent" : "alpha",
          new_text: state === "noop" ? "" : "X",
          ...conflict.values,
        };
        const spies = watchFileAccess(tool);
        const reportFileMutation = vi.fn();
        const results = [
          registry.prepareCall("edit_file", input)[2],
          await registry.execute("edit_file", input, { reportFileMutation }),
          await tool.execute(input, { reportFileMutation }),
        ];
        for (const result of results) {
          expect(result).toContain("Conflicting parameters:");
          expect(result).toContain(`${conflict.pair[0]} and ${conflict.pair[1]}`);
        }
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
        expect(reportFileMutation).not.toHaveBeenCalled();
        vi.restoreAllMocks();
        if (exists) expect(await fs.readFile(file, "utf8")).toBe(before);
        else expect(fsSync.existsSync(path.dirname(file))).toBe(false);
      });
    }
  }

  it.each([
    { old_text: "alpha", new_text: "" },
    { oldText: "alpha", newText: "" },
    { old_text: "alpha", oldText: "alpha", new_text: "", newText: "" },
  ])("preserves explicit empty replacement as deletion: %j", async (options) => {
    for (const direct of [false, true]) {
      const { file, tool, registry } = setup();
      await fs.mkdir(path.dirname(file));
      await fs.writeFile(file, "alpha\nkeep\n");
      const params = { path: file, ...options };
      const result = direct ? await tool.execute(params) : await registry.execute("edit_file", params);
      expect(result).toContain("Successfully edited");
      expect(await fs.readFile(file, "utf8")).toBe("keep\n");
    }
  });

  it.each([
    { occurrence: 2, expectedReplacements: "1" },
    { lineHint: "3", expectedReplacements: "1" },
    { replaceAll: "true", expectedReplacements: "2" },
  ])("executes legacy selection/count parameters after normalization: %j", async (options) => {
    const { file, registry } = setup();
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, "alpha\nmiddle\nalpha\n");
    const input = { path: file, oldText: "alpha", newText: "X", ...options };
    const [, normalized, error] = registry.prepareCall("edit_file", input);
    expect(error).toBeNull();
    for (const alias of aliases) expect(normalized).not.toHaveProperty(alias);
    expect(await registry.execute("edit_file", input)).toContain("Successfully edited");
    expect(await fs.readFile(file, "utf8")).toBe("replaceAll" in options ? "X\nmiddle\nX\n" : "alpha\nmiddle\nX\n");
  });

  it("keeps nullish fallback, but does not turn false or empty strings into defaults", () => {
    const { file, registry } = setup();
    const [, normalized, error] = registry.prepareCall("edit_file", {
      path: file, oldText: "alpha", newText: "", replaceAll: false,
      line_hint: null, lineHint: 3, expected_replacements: undefined, expectedReplacements: 1,
    });
    expect(error).toBeNull();
    expect(normalized).toEqual({ path: file, old_text: "alpha", new_text: "", replace_all: false, line_hint: 3, expected_replacements: 1 });
  });

  it.each([
    { replaceAll: "invalid" }, { lineHint: "invalid" }, { expectedReplacements: "invalid" },
  ])("does not bypass type validation through a hidden alias: %j", async (options) => {
    const { file, tool, registry } = setup();
    const spies = watchFileAccess(tool);
    const input = { path: file, oldText: "alpha", newText: "X", ...options };
    expect(registry.prepareCall("edit_file", input)[2]).toContain("should be");
    expect(await tool.execute(input as any)).toContain("should be");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("normalization is idempotent and does not hide conflicts on a second cast", () => {
    const { tool } = setup();
    for (const params of [
      { oldText: "alpha", newText: "", lineHint: "3" },
      { old_text: "alpha", oldText: "other", new_text: "X" },
    ]) {
      const once = tool.castParams(params);
      expect(tool.castParams(once)).toEqual(once);
    }
  });
});
