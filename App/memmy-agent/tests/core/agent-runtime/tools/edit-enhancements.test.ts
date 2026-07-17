import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EditFileTool, FileStates, ReadFileTool, clear } from "../../../../src/core/agent-runtime/tools/index.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-edit-enhanced-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  clear();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("edit_file read tracking and creation", () => {
  it("warns if a file has not been read first", async () => {
    const root = tmpRoot();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "hello world", "utf8");

    const result = await new EditFileTool({ workspace: root, fileStates: new FileStates() }).execute({
      path: file,
      old_text: "world",
      new_text: "earth",
    });

    expect(result).toContain("Successfully");
    expect(result.toLowerCase()).toMatch(/not been read|warning/);
  });

  it("edits cleanly after a read", async () => {
    const root = tmpRoot();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "hello world", "utf8");
    const states = new FileStates();
    await new ReadFileTool({ workspace: root, fileStates: states }).execute({ path: file });

    const result = await new EditFileTool({ workspace: root, fileStates: states }).execute({
      path: file,
      old_text: "world",
      new_text: "earth",
    });

    expect(result).toContain("Successfully");
    expect(result.toLowerCase()).not.toContain("not been read");
    expect(fs.readFileSync(file, "utf8")).toBe("hello earth");
  });

  it("warns if a file was modified since read", async () => {
    const root = tmpRoot();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "hello world", "utf8");
    const states = new FileStates();
    await new ReadFileTool({ workspace: root, fileStates: states }).execute({ path: file });
    fs.writeFileSync(file, "hello universe", "utf8");

    const result = await new EditFileTool({ workspace: root, fileStates: states }).execute({
      path: file,
      old_text: "universe",
      new_text: "earth",
    });

    expect(result).toContain("Successfully");
    expect(result.toLowerCase()).toMatch(/modified|warning/);
  });

  it("creates a new file when old_text is empty", async () => {
    const root = tmpRoot();
    const file = path.join(root, "subdir", "new.ts");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "", new_text: "print('hi')" });

    expect(result.toLowerCase()).toMatch(/created|successfully/);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("print('hi')");
  });

  it("does not create over an existing non-empty file", async () => {
    const root = tmpRoot();
    const file = path.join(root, "existing.ts");
    fs.writeFileSync(file, "existing content", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "", new_text: "new content" });

    expect(result.toLowerCase()).toMatch(/error|already exists/);
    expect(fs.readFileSync(file, "utf8")).toBe("existing content");
  });

  it("writes an existing empty file when old_text is empty", async () => {
    const root = tmpRoot();
    const file = path.join(root, "empty.ts");
    fs.writeFileSync(file, "", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "", new_text: "print('hi')" });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe("print('hi')");
  });

  it("edits ipynb files as JSON", async () => {
    const root = tmpRoot();
    const file = path.join(root, "analysis.ipynb");
    fs.writeFileSync(file, '{"cells": []}', "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: '"cells": []',
      new_text: '"cells": [{"cell_type": "markdown", "source": "hi"}]',
    });

    expect(result).toContain("Successfully edited");
    expect(fs.readFileSync(file, "utf8")).toContain('"source": "hi"');
  });

  it("suggests similar paths for missing targets", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "config.ts"), "x = 1", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: path.join(root, "conifg.ts"),
      old_text: "x = 1",
      new_text: "x = 2",
    });

    expect(result).toContain("Error");
    expect(result).toContain("config.ts");
  });

  it("shows cwd context for missing targets", async () => {
    const root = tmpRoot();

    const result = await new EditFileTool({ workspace: root }).execute({
      path: path.join(root, "nonexistent.ts"),
      old_text: "a",
      new_text: "b",
    });

    expect(result).toContain("Error");
  });
});
