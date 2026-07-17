import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EditFileTool, ReadFileTool } from "../../../../src/core/agent-runtime/tools/index.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-edit-coding-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("file editing coding enhancements", () => {
  it("force rereads unchanged files", async () => {
    const root = tmpRoot();
    const file = path.join(root, "data.txt");
    fs.writeFileSync(file, "alpha\n", "utf8");
    const tool = new ReadFileTool({ workspace: root });

    const first = await tool.execute({ path: file });
    const second = await tool.execute({ path: file });
    const forced = await tool.execute({ path: file, force: true });

    expect(first).toContain("alpha");
    expect(second.toLowerCase()).toContain("unchanged");
    expect(forced).toContain("alpha");
    expect(forced.toLowerCase()).not.toContain("unchanged");
  });

  it("selects an occurrence", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "one\nsame\ntwo\nsame\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
      occurrence: 2,
    });

    expect(result).toContain("Successfully edited");
    expect(fs.readFileSync(file, "utf8")).toBe("one\nsame\ntwo\nchanged\n");
  });

  it("guards replace_all with expected_replacements", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "same\nsame\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
      replace_all: true,
      expected_replacements: 1,
    });

    expect(result).toContain("expected 1 replacements but would make 2");
    expect(fs.readFileSync(file, "utf8")).toBe("same\nsame\n");
  });

  it("allows replace_all when expected_replacements matches", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "same\nsame\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
      replace_all: true,
      expected_replacements: 2,
    });

    expect(result).toContain("Successfully edited");
    expect(fs.readFileSync(file, "utf8")).toBe("changed\nchanged\n");
  });

  it("selects the nearest line_hint", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "one\nsame\ntwo\nsame\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
      line_hint: 4,
    });

    expect(result).toContain("Successfully edited");
    expect(fs.readFileSync(file, "utf8")).toBe("one\nsame\ntwo\nchanged\n");
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

  it("mentions occurrence in multiple-match hints", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "same\nsame\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
    });

    expect(result).toContain("old_text appears 2 times");
    expect(result).toContain("occurrence");
    expect(fs.readFileSync(file, "utf8")).toBe("same\nsame\n");
  });

  it("rejects ambiguous line hints", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "same\nmiddle\nsame\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
      line_hint: 2,
    });

    expect(result).toContain("line_hint 2 is ambiguous");
    expect(fs.readFileSync(file, "utf8")).toBe("same\nmiddle\nsame\n");
  });

  it("rejects occurrence with replace_all", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "same\nsame\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
      occurrence: 1,
      replace_all: true,
    });

    expect(result).toContain("occurrence cannot be used with replace_all");
    expect(fs.readFileSync(file, "utf8")).toBe("same\nsame\n");
  });

  it("rejects line_hint with replace_all", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "same\nsame\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
      line_hint: 1,
      replace_all: true,
    });

    expect(result).toContain("line_hint cannot be used with replace_all");
    expect(fs.readFileSync(file, "utf8")).toBe("same\nsame\n");
  });

  it("rejects line_hint with occurrence", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "same\nsame\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
      occurrence: 1,
      line_hint: 1,
    });

    expect(result).toContain("line_hint cannot be used with occurrence");
    expect(fs.readFileSync(file, "utf8")).toBe("same\nsame\n");
  });

  it("rejects zero occurrence", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "same\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
      occurrence: 0,
    });

    expect(result).toContain("occurrence must be >= 1");
    expect(fs.readFileSync(file, "utf8")).toBe("same\n");
  });

  it("rejects zero line_hint", async () => {
    const root = tmpRoot();
    const file = path.join(root, "duplicate.txt");
    fs.writeFileSync(file, "same\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "same",
      new_text: "changed",
      line_hint: 0,
    });

    expect(result).toContain("line_hint must be >= 1");
    expect(fs.readFileSync(file, "utf8")).toBe("same\n");
  });
});
