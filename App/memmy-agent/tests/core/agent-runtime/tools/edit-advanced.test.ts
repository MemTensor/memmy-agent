import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EditFileTool, FileStates, ReadFileTool, clear, findMatch } from "../../../../src/core/agent-runtime/tools/index.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-edit-advanced-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  clear();
  EditFileTool.MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("advanced edit_file behavior", () => {
  it("deletes a line and consumes the trailing newline", async () => {
    const root = tmpRoot();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "line1\nline2\nline3\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "line2", new_text: "" });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe("line1\nline3\n");
  });

  it("deletes a line when old_text includes the newline", async () => {
    const root = tmpRoot();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "line1\nline2\nline3\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "line2\n", new_text: "" });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe("line1\nline3\n");
  });

  it("preserves surrounding content when deleting a word mid-line", async () => {
    const root = tmpRoot();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "hello world here\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "world ", new_text: "" });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe("hello here\n");
  });

  it("matches curly double quotes with straight old_text", () => {
    const [match, count] = findMatch("She said \u201chello\u201d to him", 'She said "hello" to him');

    expect(match).toContain("\u201c");
    expect(count).toBe(1);
  });

  it("matches curly apostrophes with straight old_text", () => {
    const [match, count] = findMatch("it\u2019s a test", "it's a test");

    expect(match).toContain("\u2019");
    expect(count).toBe(1);
  });

  it("matches straight content with curly old_text", () => {
    const [match, count] = findMatch('x = "hello"', "x = \u201chello\u201d");

    expect(match).not.toBeNull();
    expect(count).toBe(1);
  });

  it("prefers exact matches over quote normalization", () => {
    expect(findMatch('x = "hello"', 'x = "hello"')).toEqual(['x = "hello"', 1]);
  });

  it("preserves curly double quotes in replacements", async () => {
    const root = tmpRoot();
    const file = path.join(root, "quotes.txt");
    fs.writeFileSync(file, "message = \u201chello\u201d\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: 'message = "hello"',
      new_text: 'message = "goodbye"',
    });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe("message = \u201cgoodbye\u201d\n");
  });

  it("preserves curly apostrophes in replacements", async () => {
    const root = tmpRoot();
    const file = path.join(root, "apostrophe.txt");
    fs.writeFileSync(file, "it\u2019s fine\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "it's fine",
      new_text: "it's better",
    });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe("it\u2019s better\n");
  });

  it("preserves outer indentation for trimmed fallback replacements", async () => {
    const root = tmpRoot();
    const file = path.join(root, "indent.ts");
    fs.writeFileSync(file, "if (ok) {\n  function foo() {\n    return 0;\n  }\n}\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "function foo() {\n  return 0;\n}",
      new_text: "function bar() {\n  return 1;\n}",
    });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe("if (ok) {\n  function bar() {\n    return 1;\n  }\n}\n");
  });

  it("reports ambiguous candidate lines", async () => {
    const root = tmpRoot();
    const file = path.join(root, "dup.ts");
    fs.writeFileSync(file, "aaa\nbbb\naaa\nbbb\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "aaa\nbbb", new_text: "xxx" });

    expect(result.toLowerCase()).toContain("appears 2 times");
    expect(result.toLowerCase()).toContain("line 1");
    expect(result.toLowerCase()).toContain("line 3");
    expect(result).toContain("replace_all=true");
  });

  it("reports whitespace not-found hints", async () => {
    const root = tmpRoot();
    const file = path.join(root, "space.ts");
    fs.writeFileSync(file, "value =  1\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "value = 1", new_text: "value = 2" });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toContain("whitespace");
  });

  it("reports case not-found hints", async () => {
    const root = tmpRoot();
    const file = path.join(root, "case.ts");
    fs.writeFileSync(file, "HelloWorld\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "helloworld", new_text: "goodbye" });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toContain("letter case differs");
  });

  it("replace_all preserves each fallback match indentation", async () => {
    const root = tmpRoot();
    const file = path.join(root, "indent_multi.ts");
    fs.writeFileSync(
      file,
      "if (a) {\n  function foo() {\n    return 0;\n  }\n}\nif (b) {\n    function foo() {\n      return 0;\n    }\n}\n",
      "utf8",
    );

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "function foo() {\n  return 0;\n}",
      new_text: "function bar() {\n  return 1;\n}",
      replace_all: true,
    });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe(
      "if (a) {\n  function bar() {\n    return 1;\n  }\n}\nif (b) {\n    function bar() {\n      return 1;\n    }\n}\n",
    );
  });

  it("combines trim and quote fallback matching", async () => {
    const root = tmpRoot();
    const file = path.join(root, "quote_indent.ts");
    fs.writeFileSync(file, "    message = \u201chello\u201d\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: 'message = "hello"',
      new_text: 'message = "goodbye"',
    });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe("    message = \u201cgoodbye\u201d\n");
  });

  it("repeat-checks replace_all fallback indentation parity", async () => {
    const root = tmpRoot();
    const file = path.join(root, "indent_multi_repeat.ts");
    fs.writeFileSync(
      file,
      "if (a) {\n  function foo() {\n    return 0;\n  }\n}\nif (b) {\n    function foo() {\n      return 0;\n    }\n}\n",
      "utf8",
    );

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "function foo() {\n  return 0;\n}",
      new_text: "function bar() {\n  return 1;\n}",
      replace_all: true,
    });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe(
      "if (a) {\n  function bar() {\n    return 1;\n  }\n}\nif (b) {\n    function bar() {\n      return 1;\n    }\n}\n",
    );
  });

  it("repeat-checks combined trim and quote fallback parity", async () => {
    const root = tmpRoot();
    const file = path.join(root, "quote_indent_repeat.ts");
    fs.writeFileSync(file, "    message = \u201chello\u201d\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: 'message = "hello"',
      new_text: 'message = "goodbye"',
    });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe("    message = \u201cgoodbye\u201d\n");
  });

  it("strips trailing whitespace from non-markdown replacements", async () => {
    const root = tmpRoot();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "x = 1\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "x = 1",
      new_text: "x = 2   \ny = 3  ",
    });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toBe("x = 2\ny = 3\n");
  });

  it("preserves trailing whitespace in markdown replacements", async () => {
    const root = tmpRoot();
    const file = path.join(root, "doc.md");
    fs.writeFileSync(file, "# Title\n", "utf8");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "# Title",
      new_text: "# Title  \nSubtitle  ",
    });

    expect(result).toContain("Successfully");
    expect(fs.readFileSync(file, "utf8")).toContain("Title  ");
    expect(fs.readFileSync(file, "utf8")).toContain("Subtitle  ");
  });

  it("rejects files over the size limit", async () => {
    const root = tmpRoot();
    const file = path.join(root, "huge.txt");
    fs.writeFileSync(file, "xx", "utf8");
    EditFileTool.MAX_EDIT_FILE_SIZE = 1;

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "x", new_text: "y" });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toMatch(/too large|size/);
  });

  it("does not warn when mtime changed but content stayed the same", async () => {
    const root = tmpRoot();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "hello world", "utf8");
    const states = new FileStates();
    const reader = new ReadFileTool({ workspace: root, fileStates: states });
    const editor = new EditFileTool({ workspace: root, fileStates: states });

    await reader.execute({ path: file });
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original, "utf8");
    fs.utimesSync(file, Date.now() / 1000 + 1, Date.now() / 1000 + 1);
    const result = await editor.execute({ path: file, old_text: "world", new_text: "earth" });

    expect(result).toContain("Successfully");
    expect(result.toLowerCase()).not.toContain("modified");
  });
});
