import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplyPatchTool } from "../../../../src/core/agent-runtime/tools/apply-patch.js";
import * as fileLint from "../../../../src/core/agent-runtime/tools/file-lint.js";
import { ToolRegistry } from "../../../../src/core/agent-runtime/tools/registry.js";

const roots: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-patch-"));
  roots.push(root);
  return root;
}

function input(...lines: string[]): { input: string } {
  return { input: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n") };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ApplyPatchTool contract", () => {
  it("exposes only one required string input with the complete patch guide", () => {
    const tool = new ApplyPatchTool({ workspace: workspace() });

    expect(tool.description).toBe(
      "Apply a patch to add, update, delete, or move one or more workspace-relative files.",
    );
    expect(tool.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["input"],
      properties: { input: { type: "string", minLength: 1 } },
    });
    expect(Object.keys(tool.parameters.properties)).toEqual(["input"]);
    expect(tool.parameters.properties.input.description).toContain("*** Begin Patch");
    expect(tool.parameters.properties.input.description).toContain("*** Add File:");
    expect(tool.parameters.properties.input.description).toContain("*** Update File:");
    expect(tool.parameters.properties.input.description).toContain("*** Delete File:");
    expect(tool.parameters.properties.input.description).toContain("*** Move to:");
    expect(tool.parameters.properties.input.description).toContain("@@");
    expect(tool.parameters.properties.input.description).toContain("*** End of File");
    expect(tool.parameters.properties.input.description).toContain("workspace-relative");
    expect(tool.parameters.properties.input.description).toContain("at most 20");
  });

  it("does not cast non-string input", () => {
    const tool = new ApplyPatchTool({ workspace: workspace() });
    expect(tool.castParams({ input: 42 } as any)).toEqual({ input: 42 });
    expect(tool.castParams({ input: false } as any)).toEqual({ input: false });
  });

  it.each([
    undefined,
    null,
    {},
    { input: 42 },
    { input: "" },
    { input: "   " },
    { edits: [{ path: "a" }] },
  ])("rejects missing or invalid input %#", async (params) => {
    const result = await new ApplyPatchTool({ workspace: workspace() }).execute(params as any);
    expect(result).toBe("Error applying patch: input must be a non-empty string");
  });

  it.each([
    { dryRun: true },
    { dry_run: true },
    { edits: [] },
    { extra: "value" },
  ])("rejects extra parameters %#", async (extra) => {
    const tool = new ApplyPatchTool({ workspace: workspace() });
    const result = await tool.execute({ ...input("*** Add File: a", "+x"), ...extra });
    expect(result).toBe("Error applying patch: apply_patch accepts only the input parameter");
  });

  it("lets the normal registry validation reject the removed edits-only shape", () => {
    const registry = new ToolRegistry();
    registry.register(new ApplyPatchTool({ workspace: workspace() }));

    const [, cast, error] = registry.prepareCall("apply_patch", { edits: [{ path: "a" }] });

    expect(cast).toEqual({ edits: [{ path: "a" }] });
    expect(error).toBe("Error: Invalid parameters for tool 'apply_patch': missing required input");
  });
});

describe("ApplyPatchTool operations", () => {
  it("adds, updates, deletes, and moves files in one patch", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "update.txt"), "old\n");
    fs.writeFileSync(path.join(root, "delete.txt"), "gone\n");
    fs.writeFileSync(path.join(root, "move.txt"), "before\n");
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute(input(
      "*** Add File: nested/new.txt",
      "+new",
      "*** Update File: update.txt",
      "@@",
      "-old",
      "+updated",
      "*** Delete File: delete.txt",
      "*** Update File: move.txt",
      "*** Move to: moved.txt",
      "@@",
      "-before",
      "+after",
    ));

    expect(result).toContain("Patch applied:");
    expect(result).toContain("- add nested/new.txt (+1/-0)");
    expect(result).toContain("- update update.txt (+1/-1)");
    expect(result).toContain("- delete delete.txt (+0/-1)");
    expect(result).toContain("- move move.txt -> moved.txt (+1/-1)");
    expect(fs.readFileSync(path.join(root, "nested/new.txt"), "utf8")).toBe("new\n");
    expect(fs.readFileSync(path.join(root, "update.txt"), "utf8")).toBe("updated\n");
    expect(fs.existsSync(path.join(root, "delete.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "move.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "moved.txt"), "utf8")).toBe("after\n");
  });

  it("creates an empty file and preserves extra blank lines", async () => {
    const root = workspace();
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Add File: empty.txt",
      "*** Add File: blank.txt",
      "+one",
      "+",
    ));

    expect(result).toContain("- add empty.txt");
    expect(fs.readFileSync(path.join(root, "empty.txt"))).toEqual(Buffer.alloc(0));
    expect(fs.readFileSync(path.join(root, "blank.txt"), "utf8")).toBe("one\n\n");
  });

  it("performs a pure text move without rewriting bytes", async () => {
    const root = workspace();
    const bytes = Buffer.from("\ufefffirst\r\nsecond\r\n", "utf8");
    fs.writeFileSync(path.join(root, "old.txt"), bytes);

    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: old.txt",
      "*** Move to: new.txt",
    ));

    expect(result).toContain("- move old.txt -> new.txt");
    expect(result).not.toContain("(+0/-0)");
    expect(fs.readFileSync(path.join(root, "new.txt"))).toEqual(bytes);
  });

  it.each([
    ["add existing", ["*** Add File: file.txt", "+new"], "file already exists"],
    ["update missing", ["*** Update File: missing.txt", "@@", "-old", "+new"], "file does not exist"],
    ["delete missing", ["*** Delete File: missing.txt"], "file does not exist"],
  ])("rejects invalid file state: %s", async (_name, lines, message) => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "file.txt"), "old\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(...lines));
    expect(result).toContain(message);
    expect(fs.readFileSync(path.join(root, "file.txt"), "utf8")).toBe("old\n");
  });

  it("does not overwrite a move target", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "source.txt"), "source\n");
    fs.writeFileSync(path.join(root, "target.txt"), "target\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: source.txt",
      "*** Move to: target.txt",
    ));
    expect(result).toContain("move target already exists");
    expect(fs.readFileSync(path.join(root, "source.txt"), "utf8")).toBe("source\n");
    expect(fs.readFileSync(path.join(root, "target.txt"), "utf8")).toBe("target\n");
  });

  it("rejects symlink paths and non-directory parents before reading content", async () => {
    const root = workspace();
    const outside = workspace();
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n");
    fs.symlinkSync(path.join(outside, "outside.txt"), path.join(root, "link.txt"));
    fs.writeFileSync(path.join(root, "parent"), "file\n");
    const tool = new ApplyPatchTool({ workspace: root });

    expect(await tool.execute(input("*** Delete File: link.txt"))).toContain("symbolic links");
    expect(await tool.execute(input("*** Add File: parent/child.txt", "+x"))).toContain(
      "parent is not a directory",
    );
    expect(fs.readFileSync(path.join(outside, "outside.txt"), "utf8")).toBe("outside\n");
  });

  it("plans every operation before the first write", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "bad.txt"), "old\n");
    const writeSpy = vi.spyOn(fsp, "writeFile");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Add File: valid.txt",
      "+valid",
      "*** Update File: bad.txt",
      "@@",
      "-missing",
      "+new",
    ));
    expect(result).toContain("was not found");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, "valid.txt"))).toBe(false);
  });
});

describe("ApplyPatchTool hunk matching", () => {
  it("uses exact, trimEnd, trim, and Unicode normalization tiers", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "exact.txt"), "old\n");
    fs.writeFileSync(path.join(root, "trim-end.txt"), "old\n");
    fs.writeFileSync(path.join(root, "trim.txt"), "  old\n");
    fs.writeFileSync(path.join(root, "unicode.txt"), "value – ‘quoted’\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: exact.txt",
      "@@",
      "-old",
      "+exact",
      "*** Update File: trim-end.txt",
      "@@",
      "-old   ",
      "+trim-end",
      "*** Update File: trim.txt",
      "@@",
      "-old",
      "+trim",
      "*** Update File: unicode.txt",
      "@@",
      "-value - 'quoted'",
      "+unicode",
    ));

    expect(result).toContain("Patch applied:");
    expect(fs.readFileSync(path.join(root, "exact.txt"), "utf8")).toBe("exact\n");
    expect(fs.readFileSync(path.join(root, "trim-end.txt"), "utf8")).toBe("trim-end\n");
    expect(fs.readFileSync(path.join(root, "trim.txt"), "utf8")).toBe("trim\n");
    expect(fs.readFileSync(path.join(root, "unicode.txt"), "utf8")).toBe("unicode\n");
  });

  it("prefers a later exact match over an earlier loose match", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "matches.txt"), " target \nmiddle\ntarget\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: matches.txt",
      "@@",
      "-target",
      "+changed",
    ));
    expect(result).toContain("Patch applied:");
    expect(fs.readFileSync(path.join(root, "matches.txt"), "utf8")).toBe(" target \nmiddle\nchanged\n");
  });

  it("uses the first match within a tier and preserves actual context whitespace", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "context.txt"), "  keep\nold\n  keep\nold\n");
    await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: context.txt",
      "@@",
      " keep",
      "-old",
      "+new",
    ));
    expect(fs.readFileSync(path.join(root, "context.txt"), "utf8")).toBe(
      "  keep\nnew\n  keep\nold\n",
    );
  });

  it("enforces forward-only original coordinates and prevents overlap", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "ordered.txt"), "first\nsecond\nthird\n");
    const tool = new ApplyPatchTool({ workspace: root });
    const result = await tool.execute(input(
      "*** Update File: ordered.txt",
      "@@",
      "-second",
      "+changed",
      "@@",
      "-first",
      "+too-late",
    ));
    expect(result).toContain("was not found");
    expect(fs.readFileSync(path.join(root, "ordered.txt"), "utf8")).toBe("first\nsecond\nthird\n");

    const overlap = await tool.execute(input(
      "*** Update File: ordered.txt",
      "@@",
      " first",
      "-second",
      "+changed",
      "@@",
      "-second",
      "+again",
    ));
    expect(overlap).toContain("was not found");
  });

  it("cannot reference text added by an earlier hunk", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "original.txt"), "anchor\nend\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: original.txt",
      "@@ anchor",
      "+inserted",
      "@@ inserted",
      "+later",
    ));
    expect(result).toContain("was not found");
    expect(fs.readFileSync(path.join(root, "original.txt"), "utf8")).toBe("anchor\nend\n");
  });

  it("inserts after an anchor, appends at EOF, and preserves same-coordinate order", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "insert.txt"), "anchor\nend\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: insert.txt",
      "@@ anchor",
      "+after-anchor",
      "@@",
      "+first-eof",
      "*** End of File",
      "@@",
      "+second-eof",
      "*** End of File",
    ));
    expect(result).toContain("Patch applied:");
    expect(fs.readFileSync(path.join(root, "insert.txt"), "utf8")).toBe(
      "anchor\nafter-anchor\nend\nfirst-eof\nsecond-eof\n",
    );
  });

  it("requires EOF hunks to match the file end", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "eof.txt"), "old\nafter\n");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: eof.txt",
      "@@",
      "-old",
      "+new",
      "*** End of File",
    ));
    expect(result).toContain("was not found");
    expect(fs.readFileSync(path.join(root, "eof.txt"), "utf8")).toBe("old\nafter\n");
  });

  it("does not use case, substring, regex, or edit-distance matching", async () => {
    const candidates = [
      ["Case", "case"],
      ["prefix-target-suffix", "target"],
      ["a.c", "a.c"],
      ["colour", "color"],
    ];
    for (const [source, needle] of candidates) {
      const root = workspace();
      const file = path.join(root, "strict.txt");
      fs.writeFileSync(file, source + "\n");
      const patchNeedle = source === "a.c" ? "a.c*" : needle;
      const result = await new ApplyPatchTool({ workspace: root }).execute(input(
        "*** Update File: strict.txt",
        "@@",
        "-" + patchNeedle,
        "+changed",
      ));
      expect(result).toContain("was not found");
      expect(fs.readFileSync(file, "utf8")).toBe(source + "\n");
    }
  });
});

describe("ApplyPatchTool text handling and no-op behavior", () => {
  it("preserves UTF-8 BOM, CRLF, and a trailing newline for hunk updates", async () => {
    const root = workspace();
    const target = path.join(root, "bom.txt");
    fs.writeFileSync(target, Buffer.from("\ufeffold\r\nnext\r\n", "utf8"));
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: bom.txt",
      "@@",
      "-old",
      "+new",
    ));
    expect(result).toContain("Patch applied:");
    expect(fs.readFileSync(target)).toEqual(Buffer.from("\ufeffnew\r\nnext\r\n", "utf8"));
  });

  it("adds a trailing newline to a changed file that had none", async () => {
    const root = workspace();
    const target = path.join(root, "none.txt");
    fs.writeFileSync(target, "old");
    await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: none.txt",
      "@@",
      "-old",
      "+new",
    ));
    expect(fs.readFileSync(target, "utf8")).toBe("new\n");
  });

  it.each([
    ["mixed", "one\r\ntwo\n"],
    ["lone CR", "one\rtwo\r"],
  ])("rejects %s line endings for hunk updates", async (_name, content) => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "lines.txt"), content);
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: lines.txt",
      "@@",
      "-one",
      "+changed",
    ));
    expect(result).toContain("unsupported");
    expect(fs.readFileSync(path.join(root, "lines.txt"), "utf8")).toBe(content);
  });

  it.each(["update", "delete", "move"])("rejects invalid UTF-8 source files for %s", async (kind) => {
    const root = workspace();
    const target = path.join(root, "binary.bin");
    const bytes = Buffer.from([0xff, 0xfe]);
    fs.writeFileSync(target, bytes);
    const lines = kind === "delete"
      ? ["*** Delete File: binary.bin"]
      : kind === "move"
        ? ["*** Update File: binary.bin", "*** Move to: moved.bin"]
        : ["*** Update File: binary.bin", "@@", "-x", "+y"];
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(...lines));
    expect(result).toBe("Error applying patch: binary files are not supported: binary.bin");
    expect(fs.readFileSync(target)).toEqual(bytes);
  });

  it.each(["update", "delete", "move"])("rejects NUL source files for %s", async (kind) => {
    const root = workspace();
    const target = path.join(root, "binary.bin");
    const bytes = Buffer.from([0x61, 0x00, 0x62]);
    fs.writeFileSync(target, bytes);
    const lines = kind === "delete"
      ? ["*** Delete File: binary.bin"]
      : kind === "move"
        ? ["*** Update File: binary.bin", "*** Move to: moved.bin"]
        : ["*** Update File: binary.bin", "@@", "-a", "+b"];
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(...lines));
    expect(result).toBe("Error applying patch: binary files are not supported: binary.bin");
    expect(fs.readFileSync(target)).toEqual(bytes);
  });

  it("rejects NUL in Add and Update patch content before writing", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "existing.txt"), "old\n");
    const tool = new ApplyPatchTool({ workspace: root });
    expect(await tool.execute(input("*** Add File: nul.txt", "+a\0b"))).toContain(
      "binary files are not supported: nul.txt",
    );
    expect(await tool.execute(input(
      "*** Update File: existing.txt",
      "@@",
      "-old",
      "+a\0b",
    ))).toContain("binary files are not supported: existing.txt");
    expect(fs.existsSync(path.join(root, "nul.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "existing.txt"), "utf8")).toBe("old\n");
  });

  it("reports a same-content patch as unchanged without writing or linting", async () => {
    const root = workspace();
    const target = path.join(root, "same.ts");
    fs.writeFileSync(target, "export const value = 1;\n");
    const writeSpy = vi.spyOn(fsp, "writeFile");
    const reportFileMutation = vi.fn();
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: same.ts",
      "@@",
      "-export const value = 1;",
      "+export const value = 1;",
    ), { reportFileMutation });
    expect(result).toBe("No changes made by patch:\n- unchanged same.ts");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(result).not.toContain("Lint results:");
    expect(reportFileMutation).toHaveBeenCalledWith({ path: target, changed: false });
  });

  it("writes and lints only changed files in a mixed patch", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "same.txt"), "same\n");
    fs.writeFileSync(path.join(root, "changed.json"), "{\"value\":1}\n");
    const writeSpy = vi.spyOn(fsp, "writeFile");
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: same.txt",
      "@@",
      "-same",
      "+same",
      "*** Update File: changed.json",
      "@@",
      "-{\"value\":1}",
      "+{\"value\":2}",
    ));
    expect(result).toContain("- unchanged same.txt");
    expect(result).toContain("- update changed.json (+1/-1)");
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy.mock.calls[0]?.[0]).toBe(path.join(root, "changed.json"));
  });

  it("keeps failed and skipped lint diagnostics in patch order", async () => {
    const root = workspace();
    const result = await new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Add File: broken.json",
      "+{",
      "*** Add File: README.md",
      "+notes",
    ));

    expect(result.startsWith("Patch applied:\n")).toBe(true);
    expect(result).toContain(`${path.join(root, "broken.json")}: failed`);
    expect(result).toContain(`${path.join(root, "README.md")}: skipped`);
    expect(result.indexOf("broken.json")).toBeLessThan(result.lastIndexOf("README.md"));
    expect(fs.readFileSync(path.join(root, "broken.json"), "utf8")).toBe("{\n");
    expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("notes\n");
  });
});

describe("ApplyPatchTool rollback", () => {
  it("rolls back an attempted Add when creating its parent directory fails", async () => {
    const root = workspace();
    const target = path.join(root, "nested", "new.txt");
    const originalMkdir = fsp.mkdir.bind(fsp);
    let failed = false;
    vi.spyOn(fsp, "mkdir").mockImplementation(async (directory, options) => {
      if (String(directory) === path.dirname(target) && !failed) {
        failed = true;
        throw new Error("mkdir failed");
      }
      return originalMkdir(directory, options);
    });

    await expect(new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Add File: nested/new.txt",
      "+new",
    ))).rejects.toThrow("mkdir failed");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("rolls back attempted files when a later write fails", async () => {
    const root = workspace();
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    fs.writeFileSync(first, "one\n");
    fs.writeFileSync(second, "two\n");
    const originalWrite = fsp.writeFile.bind(fsp);
    let failed = false;
    vi.spyOn(fsp, "writeFile").mockImplementation(async (target, data, options) => {
      if (String(target) === second && !failed) {
        failed = true;
        throw new Error("write failed");
      }
      return originalWrite(target, data, options as any);
    });

    await expect(new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: first.txt",
      "@@",
      "-one",
      "+changed-one",
      "*** Update File: second.txt",
      "@@",
      "-two",
      "+changed-two",
    ))).rejects.toThrow("write failed");
    expect(fs.readFileSync(first, "utf8")).toBe("one\n");
    expect(fs.readFileSync(second, "utf8")).toBe("two\n");
  });

  it("does not attempt a later change after an earlier write fails", async () => {
    const root = workspace();
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    const third = path.join(root, "third.txt");
    fs.writeFileSync(first, "one\n");
    fs.writeFileSync(second, "two\n");
    fs.writeFileSync(third, "three\n");
    const originalWrite = fsp.writeFile.bind(fsp);
    const attemptedWrites: string[] = [];
    vi.spyOn(fsp, "writeFile").mockImplementation(async (target, data, options) => {
      const resolved = String(target);
      attemptedWrites.push(resolved);
      if (resolved === second && String(data).includes("changed-two")) {
        throw new Error("write failed");
      }
      return originalWrite(target, data, options as any);
    });

    await expect(new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: first.txt",
      "@@",
      "-one",
      "+changed-one",
      "*** Update File: second.txt",
      "@@",
      "-two",
      "+changed-two",
      "*** Update File: third.txt",
      "@@",
      "-three",
      "+changed-three",
    ))).rejects.toThrow("write failed");
    expect(attemptedWrites).not.toContain(third);
    expect(fs.readFileSync(first, "utf8")).toBe("one\n");
    expect(fs.readFileSync(second, "utf8")).toBe("two\n");
    expect(fs.readFileSync(third, "utf8")).toBe("three\n");
  });

  it("rolls back a move target when deleting the source fails", async () => {
    const root = workspace();
    const source = path.join(root, "source.txt");
    const target = path.join(root, "target.txt");
    fs.writeFileSync(source, "source\n");
    const originalRm = fsp.rm.bind(fsp);
    let failed = false;
    vi.spyOn(fsp, "rm").mockImplementation(async (file, options) => {
      if (String(file) === source && !failed) {
        failed = true;
        throw new Error("delete failed");
      }
      return originalRm(file, options as any);
    });

    await expect(new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: source.txt",
      "*** Move to: target.txt",
    ))).rejects.toThrow("delete failed");
    expect(fs.readFileSync(source, "utf8")).toBe("source\n");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("verifies Delete removed the file and rolls back when it did not", async () => {
    const root = workspace();
    const target = path.join(root, "delete.txt");
    fs.writeFileSync(target, "before\n");
    const originalRm = fsp.rm.bind(fsp);
    let skippedDelete = false;
    vi.spyOn(fsp, "rm").mockImplementation(async (file, options) => {
      if (String(file) === target && !skippedDelete) {
        skippedDelete = true;
        return;
      }
      return originalRm(file, options as any);
    });

    await expect(new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Delete File: delete.txt",
    ))).rejects.toThrow("Delete verification failed");
    expect(fs.readFileSync(target, "utf8")).toBe("before\n");
  });

  it("rolls back after stat verification throws", async () => {
    const root = workspace();
    const target = path.join(root, "stat.txt");
    fs.writeFileSync(target, "before\n");
    const originalStat = fsp.stat.bind(fsp);
    let failed = false;
    vi.spyOn(fsp, "stat").mockImplementation(async (file, options) => {
      if (String(file) === target && !failed) {
        failed = true;
        throw new Error("stat failed");
      }
      return originalStat(file, options);
    });

    await expect(new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: stat.txt",
      "@@",
      "-before",
      "+after",
    ))).rejects.toThrow("stat failed");
    expect(fs.readFileSync(target, "utf8")).toBe("before\n");
  });

  it("rolls back after exact text readback throws", async () => {
    const root = workspace();
    const target = path.join(root, "readback.txt");
    fs.writeFileSync(target, "before\n");
    const originalReadFile = fsp.readFile.bind(fsp);
    let failed = false;
    vi.spyOn(fsp, "readFile").mockImplementation(async (file, options) => {
      if (
        String(file) === target &&
        typeof options === "object" &&
        options !== null &&
        "encoding" in options &&
        options.encoding === "utf8" &&
        !failed
      ) {
        failed = true;
        throw new Error("readback failed");
      }
      return originalReadFile(file, options as any);
    });

    await expect(new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: readback.txt",
      "@@",
      "-before",
      "+after",
    ))).rejects.toThrow("readback failed");
    expect(fs.readFileSync(target, "utf8")).toBe("before\n");
  });

  it("rolls back after lint throws", async () => {
    const root = workspace();
    const target = path.join(root, "lint.ts");
    fs.writeFileSync(target, "export const value = 1;\n");
    vi.spyOn(fileLint, "lintFiles").mockRejectedValueOnce(new Error("lint failed unexpectedly"));

    await expect(new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: lint.ts",
      "@@",
      "-export const value = 1;",
      "+export const value = 2;",
    ))).rejects.toThrow("lint failed unexpectedly");
    expect(fs.readFileSync(target, "utf8")).toBe("export const value = 1;\n");
  });

  it("reports the original error and every rollback failure path", async () => {
    const root = workspace();
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    fs.writeFileSync(first, "one\n");
    fs.writeFileSync(second, "two\n");
    const originalWrite = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, "writeFile").mockImplementation(async (target, data, options) => {
      const resolved = String(target);
      const content = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (resolved === second && content === "changed-two\n") throw new Error("write failed");
      if (resolved === first && content === "one\n") throw new Error("restore failed");
      return originalWrite(target, data, options as any);
    });

    await expect(new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: first.txt",
      "@@",
      "-one",
      "+changed-one",
      "*** Update File: second.txt",
      "@@",
      "-two",
      "+changed-two",
    ))).rejects.toThrow(`write failed; rollback failed for ${first}: restore failed`);
    expect(fs.readFileSync(first, "utf8")).toBe("changed-one\n");
    expect(fs.readFileSync(second, "utf8")).toBe("two\n");
  });

  it("finishes rollback before rejecting an observed abort", async () => {
    const root = workspace();
    const target = path.join(root, "abort.txt");
    fs.writeFileSync(target, "before\n");
    const controller = new AbortController();
    const originalWrite = fsp.writeFile.bind(fsp);
    let aborted = false;
    vi.spyOn(fsp, "writeFile").mockImplementation(async (file, data, options) => {
      const result = await originalWrite(file, data, options as any);
      if (!aborted) {
        aborted = true;
        controller.abort();
      }
      return result;
    });

    await expect(new ApplyPatchTool({ workspace: root }).execute(input(
      "*** Update File: abort.txt",
      "@@",
      "-before",
      "+after",
    ), { abortSignal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.readFileSync(target, "utf8")).toBe("before\n");
  });
});
