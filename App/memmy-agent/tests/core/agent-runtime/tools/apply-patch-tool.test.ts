import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplyPatchTool } from "../../../../src/core/agent-runtime/tools/apply-patch.js";

const roots: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-patch-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("ApplyPatchTool structured edits", () => {
  it("exposes only structured edit parameters", () => {
    const root = workspace();
    const tool = new ApplyPatchTool({ workspace: root });

    expect(tool.parameters.required).toEqual(["edits"]);
    expect(tool.parameters.properties).not.toHaveProperty("patch");
    expect(tool.parameters.properties.edits.minItems).toBe(1);
    expect(tool.parameters.properties.edits.items.required).toEqual(["path", "action"]);
  });

  it("rejects raw patch-string calls", async () => {
    const root = workspace();
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({ patch: "*** Begin Patch\n*** End Patch\n" } as any);

    expect(result).toBe("Error: edits must be a list");
  });

  it("replaces text in an existing file", async () => {
    const root = workspace();
    const target = path.join(root, "calc.ts");
    fs.writeFileSync(target, "function add(a: number, b: number) {\n  return a + b;\n}\n");
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [
        {
          path: "calc.ts",
          action: "replace",
          oldText: "  return a + b;",
          newText: "  return a - b;",
        },
      ],
    });

    expect(result).toContain("update calc.ts");
    expect(fs.readFileSync(target, "utf8")).toBe("function add(a: number, b: number) {\n  return a - b;\n}\n");
  });

  it("adds a new file", async () => {
    const root = workspace();
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [{ path: "config.ts", action: "add", newText: "export const DEBUG = true;" }],
    });

    expect(result).toContain("add config.ts");
    expect(fs.readFileSync(path.join(root, "config.ts"), "utf8")).toBe("export const DEBUG = true;\n");
  });

  it("preserves trailing blank lines when adding a new file", async () => {
    const root = workspace();
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [{ path: "notes.txt", action: "add", newText: "one\n\n" }],
    });

    expect(result).toContain("add notes.txt");
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("one\n\n");
  });

  it("appends text to an existing file", async () => {
    const root = workspace();
    const target = path.join(root, "log.ts");
    fs.writeFileSync(target, "const logger = console;\n");
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [
        {
          path: "log.ts",
          action: "add",
          newText: "function debug(msg: string) {\n  logger.debug(msg);\n}",
        },
      ],
    });

    expect(result).toContain("update log.ts");
    expect(fs.readFileSync(target, "utf8")).toBe(
      "const logger = console;\nfunction debug(msg: string) {\n  logger.debug(msg);\n}\n",
    );
  });

  it("deletes text from an existing file", async () => {
    const root = workspace();
    const target = path.join(root, "utils.ts");
    fs.writeFileSync(target, "function unused() {\n  return 0;\n}\nfunction used() {\n  return 1;\n}\n");
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [{ path: "utils.ts", action: "delete", oldText: "function unused() {\n  return 0;\n}\n" }],
    });

    expect(result).toContain("update utils.ts");
    expect(fs.readFileSync(target, "utf8")).toBe("function used() {\n  return 1;\n}\n");
  });

  it("deletes a file when the whole content is removed", async () => {
    const root = workspace();
    const target = path.join(root, "obsolete.txt");
    fs.writeFileSync(target, "remove me\n");
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [{ path: "obsolete.txt", action: "delete", oldText: "remove me\n" }],
    });

    expect(result).toContain("delete obsolete.txt");
    expect(fs.existsSync(target)).toBe(false);
  });

  it("deletes a substring while preserving surrounding whitespace", async () => {
    const root = workspace();
    const target = path.join(root, "keep_whitespace.txt");
    fs.writeFileSync(target, "  token  \n");
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [{ path: "keep_whitespace.txt", action: "delete", oldText: "token" }],
    });

    expect(result).toContain("update keep_whitespace.txt");
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("    \n");
  });

  it("applies a batch across multiple files", async () => {
    const root = workspace();
    const a = path.join(root, "a.ts");
    const b = path.join(root, "b.ts");
    fs.writeFileSync(a, "export const x = 1;\n");
    fs.writeFileSync(b, "import { x } from './a';\nconsole.log(x);\n");
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [
        { path: "a.ts", action: "replace", oldText: "export const x = 1;", newText: "export const y = 1;" },
        { path: "b.ts", action: "replace", oldText: "import { x }", newText: "import { y }" },
      ],
    });

    expect(result).toContain("update a.ts");
    expect(result).toContain("update b.ts");
    expect(fs.readFileSync(a, "utf8")).toBe("export const y = 1;\n");
    expect(fs.readFileSync(b, "utf8")).toBe("import { y } from './a';\nconsole.log(x);\n");
  });

  it("rejects ambiguous oldText", async () => {
    const root = workspace();
    const target = path.join(root, "repeated.txt");
    fs.writeFileSync(target, "target\nmiddle\ntarget\n");
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [{ path: "repeated.txt", action: "replace", oldText: "target", newText: "changed" }],
    });

    expect(result).toContain("oldText appears multiple times");
    expect(fs.readFileSync(target, "utf8")).toBe("target\nmiddle\ntarget\n");
  });

  it("validates dry runs without writing", async () => {
    const root = workspace();
    const target = path.join(root, "dry.txt");
    fs.writeFileSync(target, "before\n");
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [
        { path: "dry.txt", action: "replace", oldText: "before", newText: "after" },
        { path: "added.txt", action: "add", newText: "new" },
      ],
      dryRun: true,
    });

    expect(result).toContain("Patch dry-run succeeded");
    expect(fs.readFileSync(target, "utf8")).toBe("before\n");
    expect(fs.existsSync(path.join(root, "added.txt"))).toBe(false);
  });

  it("rejects absolute and parent paths", async () => {
    const root = workspace();
    const tool = new ApplyPatchTool({ workspace: root });

    const absolute = await tool.execute({
      edits: [{ path: "/tmp/owned.txt", action: "add", newText: "nope" }],
    });
    const parent = await tool.execute({
      edits: [{ path: "../owned.txt", action: "add", newText: "nope" }],
    });
    const windowsAbsolute = await tool.execute({
      edits: [{ path: String.raw`C:\owned.txt`, action: "add", newText: "nope" }],
    });
    const windowsParent = await tool.execute({
      edits: [{ path: String.raw`..\owned.txt`, action: "add", newText: "nope" }],
    });

    expect(absolute).toContain("must be relative");
    expect(parent).toContain("must not contain '..'");
    expect(windowsAbsolute).toContain("must be relative");
    expect(windowsParent).toContain("must not contain '..'");
    expect(fs.existsSync(path.join(path.dirname(root), "owned.txt"))).toBe(false);
  });

  it("reports invalid edit shapes", async () => {
    const root = workspace();
    const tool = new ApplyPatchTool({ workspace: root });

    const missingPath = await tool.execute({ edits: [{ action: "add", newText: "x" }] });
    const missingAction = await tool.execute({ edits: [{ path: "x.txt", newText: "x" }] as any });
    const nonObject = await tool.execute({ edits: ["not an object"] as any });

    expect(missingPath).toContain("path required for edit");
    expect(missingAction).toContain("action required for edit: x.txt");
    expect(nonObject).toContain("each edit must be an object");
  });

  it("does not write earlier batch changes when a later operation fails", async () => {
    const root = workspace();
    const first = path.join(root, "first.txt");
    fs.writeFileSync(first, "before\n");
    const tool = new ApplyPatchTool({ workspace: root });

    const result = await tool.execute({
      edits: [
        { path: "first.txt", action: "replace", oldText: "before", newText: "after" },
        { path: "missing.txt", action: "delete", oldText: "remove me" },
      ],
    });

    expect(result).toContain("file to update does not exist: missing.txt");
    expect(fs.readFileSync(first, "utf8")).toBe("before\n");
  });

  it("rejects dry runs with an aborted signal without writing files", async () => {
    const root = workspace();
    const target = path.join(root, "dry.txt");
    fs.writeFileSync(target, "before\n");
    const controller = new AbortController();
    controller.abort();

    await expect(new ApplyPatchTool({ workspace: root }).execute({
      edits: [{ path: "dry.txt", action: "replace", oldText: "before", newText: "after" }],
      dryRun: true,
    }, { abortSignal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });

    expect(fs.readFileSync(target, "utf8")).toBe("before\n");
  });

  it("rolls back an applied file when aborting before the next batch change", async () => {
    const root = workspace();
    const first = path.join(root, "first.txt");
    const second = path.join(root, "second.txt");
    fs.writeFileSync(first, "before-one\n");
    fs.writeFileSync(second, "before-two\n");
    const controller = new AbortController();
    const originalWriteFile = fsp.writeFile.bind(fsp);
    vi.spyOn(fsp, "writeFile").mockImplementation(async (...args) => {
      const filePath = String(args[0]);
      const content = String(args[1]);
      await originalWriteFile(...args);
      if (filePath === first && content.includes("after-one")) {
        controller.abort();
      }
    });

    await expect(new ApplyPatchTool({ workspace: root }).execute({
      edits: [
        { path: "first.txt", action: "replace", oldText: "before-one", newText: "after-one" },
        { path: "second.txt", action: "replace", oldText: "before-two", newText: "after-two" },
      ],
    }, { abortSignal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });

    expect(fs.readFileSync(first, "utf8")).toBe("before-one\n");
    expect(fs.readFileSync(second, "utf8")).toBe("before-two\n");
  });
});
