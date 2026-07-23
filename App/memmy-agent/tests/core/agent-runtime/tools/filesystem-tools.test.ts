import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EditFileTool,
  FsTool,
  ListDirTool,
  MatchSpan,
  ReadFileTool,
  WriteFileTool,
  fileNotFoundMessage,
  findMatch,
  isBlockedDevicePath,
  leadingWhitespace,
  notFoundMessage,
  stripTrailingWhitespace,
} from "../../../../src/core/agent-runtime/tools/index.js";

const roots: string[] = [];

function workspace(): string {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "memmy-fs-"));
  roots.push(root);
  return root;
}

async function sampleFile(root: string): Promise<string> {
  const file = path.join(root, "sample.txt");
  await fs.writeFile(file, [...Array(20).keys()].map((i) => `line ${i + 1}`).join("\n"));
  return file;
}

afterEach(() => {
  ReadFileTool.MAX_CHARS = 128_000;
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

describe("ReadFileTool", () => {
  it("reads files with line numbers", async () => {
    const root = workspace();
    const file = await sampleFile(root);

    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });

    expect(result).toContain("1| line 1");
    expect(result).toContain("20| line 20");
  });

  it("exposes filesystem helper parity methods", () => {
    const root = workspace();
    const base = new FsTool({ workspace: root, allowedDir: root });
    const span = new MatchSpan(1, 4, "abc", 2);

    expect(base.resolve(".")).toBe(root);
    expect(span).toMatchObject({ start: 1, end: 4, text: "abc", line: 2 });
    expect(isBlockedDevicePath("/dev/zero")).toBe(true);
    expect(isBlockedDevicePath(path.join(root, "regular.txt"))).toBe(false);
    expect(leadingWhitespace(" \tvalue")).toBe(" \t");
    expect(stripTrailingWhitespace("a  \nb\t")).toBe("a\nb");
    expect(fileNotFoundMessage("missing.txt", path.join(root, "missing.txt"))).toContain("File not found");
    expect(notFoundMessage("needle", "haystack", "sample.txt")).toContain("old_text not found");
  });

  it("supports offset and limit", async () => {
    const root = workspace();
    const file = await sampleFile(root);

    const result = await new ReadFileTool({ workspace: root }).execute({ path: file, offset: 5, limit: 3 });

    expect(result).toContain("5| line 5");
    expect(result).toContain("7| line 7");
    expect(result).not.toContain("8| line 8");
    expect(result).toContain("Use offset=8 to continue");
  });

  it("reports offsets beyond end", async () => {
    const root = workspace();
    const file = await sampleFile(root);

    const result = await new ReadFileTool({ workspace: root }).execute({ path: file, offset: 999 });

    expect(result).toContain("Error");
    expect(result).toContain("beyond end");
  });

  it("marks end of file", async () => {
    const root = workspace();
    const file = await sampleFile(root);

    const result = await new ReadFileTool({ workspace: root }).execute({ path: file, offset: 1, limit: 9999 });

    expect(result).toContain("End of file");
  });

  it("reports empty files", async () => {
    const root = workspace();
    const file = path.join(root, "empty.txt");
    await fs.writeFile(file, "");

    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });

    expect(result).toContain("Empty file");
  });

  it("returns multimodal blocks for images", async () => {
    const root = workspace();
    const file = path.join(root, "pixel.png");
    await fs.writeFile(file, Buffer.from("\x89PNG\r\n\x1a\nfake-png-data"));

    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });

    expect(Array.isArray(result)).toBe(true);
    expect(result[0].type).toBe("image_url");
    expect(result[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(result[0].meta.path).toBe(file);
    expect(result[1]).toEqual({ type: "text", text: `(Image file: ${file})` });
  });

  it("reports missing files", async () => {
    const root = workspace();

    const result = await new ReadFileTool({ workspace: root }).execute({ path: path.join(root, "nope.txt") });

    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("reports a missing path clearly", async () => {
    const result = await new ReadFileTool({ workspace: workspace() }).execute();

    expect(result).toBe("Error reading file: Unknown path");
  });

  it("trims output to the character budget", async () => {
    const root = workspace();
    const file = path.join(root, "big.txt");
    await fs.writeFile(file, Array.from({ length: 2000 }, () => "x".repeat(110)).join("\n"));

    const result = await new ReadFileTool({ workspace: root }).execute({ path: file });

    expect(result.length).toBeLessThanOrEqual(ReadFileTool.MAX_CHARS + 500);
    expect(result).toContain("Use offset=");
  });
});

describe("findMatch", () => {
  it("finds exact matches", () => {
    expect(findMatch("hello world", "world")).toEqual(["world", 1]);
  });

  it("reports no exact match", () => {
    expect(findMatch("hello world", "xyz")).toEqual([null, 0]);
  });

  it("matches normalized line endings", () => {
    const [match, count] = findMatch("line1\nline2\nline3", "line1\nline2\nline3");

    expect(match).not.toBeNull();
    expect(count).toBe(1);
  });

  it("falls back to line-trim matching", () => {
    const [match, count] = findMatch("    function foo() {\n      return 0;\n    }\n", "function foo() {\n  return 0;\n}");

    expect(match).toContain("    function foo() {");
    expect(count).toBe(1);
  });

  it("counts multiple line-trim candidates", () => {
    const [, count] = findMatch("  a\n  b\n  a\n  b\n", "a\nb");

    expect(count).toBe(2);
  });

  it("treats empty old_text as a match", () => {
    const [match] = findMatch("hello", "");

    expect(match).toBe("");
  });
});

describe("EditFileTool", () => {
  it("edits exact matches", async () => {
    const root = workspace();
    const file = path.join(root, "a.ts");
    await fs.writeFile(file, "hello world");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "world", new_text: "earth" });

    expect(result).toContain("Successfully");
    expect(await fs.readFile(file, "utf8")).toBe("hello earth");
  });

  it("preserves CRLF line endings", async () => {
    const root = workspace();
    const file = path.join(root, "crlf.ts");
    await fs.writeFile(file, "line1\r\nline2\r\nline3");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "line1\nline2",
      new_text: "LINE1\nLINE2",
    });

    expect(result).toContain("Successfully");
    expect(await fs.readFile(file, "utf8")).toContain("\r\n");
  });

  it("edits using trim fallback", async () => {
    const root = workspace();
    const file = path.join(root, "indent.ts");
    await fs.writeFile(file, "    function foo() {\n      return 0;\n    }\n");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "function foo() {\n  return 0;\n}",
      new_text: "function bar() {\n  return 1;\n}",
    });

    expect(result).toContain("Successfully");
    expect(await fs.readFile(file, "utf8")).toContain("bar");
  });

  it("reports ambiguous matches", async () => {
    const root = workspace();
    const file = path.join(root, "dup.ts");
    await fs.writeFile(file, "aaa\nbbb\naaa\nbbb\n");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "aaa\nbbb", new_text: "xxx" });

    expect(result.toLowerCase()).toMatch(/appears|warning/);
  });

  it("replaces all matches", async () => {
    const root = workspace();
    const file = path.join(root, "multi.ts");
    await fs.writeFile(file, "foo bar foo bar foo");

    const result = await new EditFileTool({ workspace: root }).execute({
      path: file,
      old_text: "foo",
      new_text: "baz",
      replace_all: true,
    });

    expect(result).toContain("Successfully");
    expect(await fs.readFile(file, "utf8")).toBe("baz bar baz bar baz");
  });

  it("reports missing old_text", async () => {
    const root = workspace();
    const file = path.join(root, "nf.ts");
    await fs.writeFile(file, "hello");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "xyz", new_text: "abc" });

    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("reports a missing new_text clearly", async () => {
    const root = workspace();
    const file = path.join(root, "a.ts");
    await fs.writeFile(file, "hello");

    const result = await new EditFileTool({ workspace: root }).execute({ path: file, old_text: "hello" });

    expect(result).toBe("Error editing file: Unknown new_text");
  });
});

describe("filesystem post-write validation", () => {
  it("appends passed, failed, and skipped lint results without changing the success prefix", async () => {
    const root = workspace();
    const validPath = path.join(root, "valid.json");
    const invalidPath = path.join(root, "invalid.json");
    const markdownPath = path.join(root, "README.md");
    const tool = new WriteFileTool({ workspace: root });

    const valid = await tool.execute({ path: validPath, content: "{}" });
    const invalid = await tool.execute({ path: invalidPath, content: "{" });
    const skipped = await tool.execute({ path: markdownPath, content: "# Notes" });

    expect(valid).toBe(`Successfully wrote ${validPath}\n\nLint results:\n- ${validPath}: passed`);
    expect(invalid).toMatch(new RegExp(`^Successfully wrote ${invalidPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\nLint results:`));
    expect(invalid).toContain(`${invalidPath}: failed`);
    expect(await fs.readFile(invalidPath, "utf8")).toBe("{");
    expect(skipped).toContain(`${markdownPath}: skipped`);
    expect(skipped).toContain("No validator for .md");
  });

  it("keeps the original write result when post-write validation is disabled", async () => {
    const root = workspace();
    const target = path.join(root, "memory.md");

    const result = await new WriteFileTool({ workspace: root, postWriteValidation: false }).execute({
      path: target,
      content: "memory",
    });

    expect(result).toBe(`Successfully wrote ${target}`);
  });

  it("rejects write_file when the exact readback does not match", async () => {
    const root = workspace();
    const target = path.join(root, "mismatch.json");
    const originalReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const result = await originalReadFile(...args);
      return String(args[0]) === target && typeof result === "string" ? `${result}changed` : result;
    });

    await expect(new WriteFileTool({ workspace: root }).execute({ path: target, content: "{}" }))
      .rejects.toThrow("content mismatch");
  });

  it("uses lint delta for exact edits and reports edit readback mismatches as errors", async () => {
    const root = workspace();
    const target = path.join(root, "delta.ts");
    await fs.writeFile(target, "const value: = 1;\nconst label = 'old';\n", "utf8");
    const tool = new EditFileTool({ workspace: root });

    const unchangedFailure = await tool.execute({ path: target, old_text: "'old'", new_text: "'new'" });

    expect(unchangedFailure).toContain(`${target}: passed`);
    expect(unchangedFailure).toContain("pre-existing lint output unchanged");

    const originalReadFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      const result = await originalReadFile(...args);
      return String(args[0]) === target && typeof result === "string" ? `${result}changed` : result;
    });
    const mismatch = await tool.execute({ path: target, old_text: "'new'", new_text: "'again'" });

    expect(mismatch).toContain("Error editing file: Write verification failed");
  });
});

describe("filesystem tool cancellation", () => {
  function abortedContext(): { abortSignal: AbortSignal } {
    const controller = new AbortController();
    controller.abort();
    return { abortSignal: controller.signal };
  }

  function abortError(): Error {
    const error = new Error("task cancelled");
    error.name = "AbortError";
    return error;
  }

  it("does not create a file when write_file starts with an aborted signal", async () => {
    const root = workspace();
    const target = path.join(root, "cancelled.txt");

    await expect(new WriteFileTool({ workspace: root }).execute({
      path: target,
      content: "should not be written",
    }, abortedContext())).rejects.toMatchObject({ name: "AbortError" });

    expect(fsSync.existsSync(target)).toBe(false);
  });

  it("does not create or update files when edit_file starts with an aborted signal", async () => {
    const root = workspace();
    const createTarget = path.join(root, "created.txt");
    const updateTarget = path.join(root, "updated.txt");
    await fs.writeFile(updateTarget, "before", "utf8");

    const tool = new EditFileTool({ workspace: root });
    await expect(tool.execute({
      path: createTarget,
      old_text: "",
      new_text: "new file",
    }, abortedContext())).rejects.toMatchObject({ name: "AbortError" });
    await expect(tool.execute({
      path: updateTarget,
      old_text: "before",
      new_text: "after",
    }, abortedContext())).rejects.toMatchObject({ name: "AbortError" });

    expect(fsSync.existsSync(createTarget)).toBe(false);
    expect(await fs.readFile(updateTarget, "utf8")).toBe("before");
  });

  it("records file state conservatively when write_file aborts after the write starts", async () => {
    const root = workspace();
    const target = path.join(root, "partial.txt");
    const tool = new WriteFileTool({ workspace: root });
    const originalWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await originalWriteFile(...args);
      throw abortError();
    });

    await expect(tool.execute({ path: target, content: "partial" }, { abortSignal: new AbortController().signal }))
      .rejects.toMatchObject({ name: "AbortError" });

    expect(await fs.readFile(target, "utf8")).toBe("partial");
    expect(tool.fileStates().get(target)).not.toBeNull();
  });

  it("records file state conservatively when edit_file aborts after the write starts", async () => {
    const root = workspace();
    const target = path.join(root, "edit-partial.txt");
    await fs.writeFile(target, "before", "utf8");
    const tool = new EditFileTool({ workspace: root });
    const originalWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await originalWriteFile(...args);
      throw abortError();
    });

    await expect(tool.execute({
      path: target,
      old_text: "before",
      new_text: "after",
    }, { abortSignal: new AbortController().signal })).rejects.toMatchObject({ name: "AbortError" });

    expect(await fs.readFile(target, "utf8")).toBe("after");
    expect(tool.fileStates().get(target)).not.toBeNull();
  });
});

describe("ListDirTool", () => {
  async function populatedDir(): Promise<string> {
    const root = workspace();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "main.ts"), "export {};");
    await fs.writeFile(path.join(root, "src", "utils.ts"), "export {};");
    await fs.writeFile(path.join(root, "README.md"), "hi");
    await fs.mkdir(path.join(root, ".git"));
    await fs.writeFile(path.join(root, ".git", "config"), "x");
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    return root;
  }

  it("lists directory entries", async () => {
    const root = await populatedDir();

    const result = await new ListDirTool({ workspace: root }).execute({ path: root });

    expect(result).toContain("README.md");
    expect(result).toContain("src/");
    expect(result).not.toContain(".git");
    expect(result).not.toContain("node_modules");
  });

  it("lists recursively", async () => {
    const root = await populatedDir();

    const result = await new ListDirTool({ workspace: root }).execute({ path: root, recursive: true });

    expect(result).toContain("src/main.ts");
    expect(result).toContain("src/utils.ts");
    expect(result).toContain("README.md");
    expect(result).not.toContain(".git");
    expect(result).not.toContain("node_modules");
  });

  it("truncates max entries", async () => {
    const root = workspace();
    for (let i = 0; i < 10; i += 1) {
      await fs.writeFile(path.join(root, `file_${i}.txt`), "x");
    }

    const result = await new ListDirTool({ workspace: root }).execute({ path: root, max_entries: 3 });

    expect(result).toContain("truncated");
    expect(result).toContain("3 of 10");
  });

  it("reports empty directories", async () => {
    const root = workspace();
    const dir = path.join(root, "empty");
    await fs.mkdir(dir);

    const result = await new ListDirTool({ workspace: root }).execute({ path: dir });

    expect(result.toLowerCase()).toContain("empty");
  });

  it("reports missing directories", async () => {
    const root = workspace();

    const result = await new ListDirTool({ workspace: root }).execute({ path: path.join(root, "nope") });

    expect(result).toContain("Error");
    expect(result).toContain("not found");
  });

  it("reports a missing path clearly", async () => {
    const result = await new ListDirTool({ workspace: workspace() }).execute();

    expect(result).toBe("Error listing directory: Unknown path");
  });
});

describe("workspace restrictions", () => {
  it("allows unrestricted tools to operate on absolute paths outside the workspace", async () => {
    const root = workspace();
    const outsideDir = path.join(path.dirname(root), `outside-default-${Date.now()}`);
    roots.push(outsideDir);
    await fs.mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "outside.txt");
    await fs.writeFile(outsideFile, "Original content.");

    const readResult = await new ReadFileTool({ workspace: root }).execute({ path: outsideFile });
    expect(readResult).toContain("Original content.");
    expect(readResult).not.toContain("outside workspace");

    const writeFile = path.join(outsideDir, "created.txt");
    const writeResult = await new WriteFileTool({ workspace: root }).execute({ path: writeFile, content: "created outside" });
    expect(writeResult).toContain("Successfully");
    expect(await fs.readFile(writeFile, "utf8")).toBe("created outside");

    const editResult = await new EditFileTool({ workspace: root }).execute({
      path: outsideFile,
      old_text: "Original content.",
      new_text: "Edited content.",
    });
    expect(editResult).toContain("Successfully");
    expect(await fs.readFile(outsideFile, "utf8")).toBe("Edited content.");

    const listResult = await new ListDirTool({ workspace: root }).execute({ path: outsideDir });
    expect(listResult).toContain("outside.txt");
    expect(listResult).toContain("created.txt");
  });

  it("blocks reads outside the workspace", async () => {
    const root = workspace();
    const outside = path.join(path.dirname(root), `outside-read-${Date.now()}.txt`);
    await fs.writeFile(outside, "top secret");
    roots.push(outside);

    const result = await new ReadFileTool({ workspace: root, allowedDir: root }).execute({ path: outside });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toContain("outside");
  });

  it("allows reads from extra allowed directories", async () => {
    const root = workspace();
    const extra = path.join(path.dirname(root), `skills-${Date.now()}`);
    roots.push(extra);
    const skillFile = path.join(extra, "weather", "SKILL.md");
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, "# Test Skill\nDo something.", "utf8");

    const result = await new ReadFileTool({ workspace: root, allowedDir: root, extraAllowedDirs: [extra] }).execute({
      path: skillFile,
    });

    expect(result).toContain("Test Skill");
    expect(result).not.toContain("Error");
  });

  it("allows restricted writes, edits, and listings in extra allowed directories", async () => {
    const root = workspace();
    const extra = path.join(path.dirname(root), `extra-write-${Date.now()}`);
    roots.push(extra);
    await fs.mkdir(extra, { recursive: true });
    const file = path.join(extra, "note.txt");

    const writeResult = await new WriteFileTool({ workspace: root, allowedDir: root, extraAllowedDirs: [extra] }).execute({
      path: file,
      content: "Original content.",
    });
    expect(writeResult).toContain("Successfully");
    expect(await fs.readFile(file, "utf8")).toBe("Original content.");

    const editResult = await new EditFileTool({ workspace: root, allowedDir: root, extraAllowedDirs: [extra] }).execute({
      path: file,
      old_text: "Original content.",
      new_text: "Edited content.",
    });
    expect(editResult).toContain("Successfully");
    expect(await fs.readFile(file, "utf8")).toBe("Edited content.");

    const listResult = await new ListDirTool({ workspace: root, allowedDir: root, extraAllowedDirs: [extra] }).execute({
      path: extra,
    });
    expect(listResult).toContain("note.txt");
    expect(listResult).not.toContain("outside workspace");
  });

  it("allows reads from the media directory", async () => {
    const root = workspace();
    const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;
    const dataDir = path.join(path.dirname(root), `data-${Date.now()}`);
    roots.push(dataDir);
    process.env.MEMMY_AGENT_DATA_DIR = dataDir;
    const mediaFile = path.join(dataDir, "media", "photo.txt");
    await fs.mkdir(path.dirname(mediaFile), { recursive: true });
    await fs.writeFile(mediaFile, "shared media", "utf8");

    try {
      const result = await new ReadFileTool({ workspace: root, allowedDir: root }).execute({ path: mediaFile });

      expect(result).toContain("shared media");
      expect(result).not.toContain("Error");
    } finally {
      if (oldDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
      else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
    }
  });

  it("still blocks unrelated directories when extra allowed directories are configured", async () => {
    const root = workspace();
    const extra = path.join(path.dirname(root), `skills-${Date.now()}`);
    const unrelated = path.join(path.dirname(root), `unrelated-${Date.now()}`);
    roots.push(extra, unrelated);
    await fs.mkdir(extra, { recursive: true });
    await fs.mkdir(unrelated, { recursive: true });
    const secret = path.join(unrelated, "secret.txt");
    await fs.writeFile(secret, "nope", "utf8");

    const result = await new ReadFileTool({ workspace: root, allowedDir: root, extraAllowedDirs: [extra] }).execute({
      path: secret,
    });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toContain("outside");
  });

  it("blocks writes outside the workspace", async () => {
    const root = workspace();
    const outside = path.join(path.dirname(root), `outside-write-${Date.now()}.txt`);

    const result = await new WriteFileTool({ workspace: root, allowedDir: root }).execute({
      path: outside,
      content: "pwned",
    });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toContain("outside");
    expect(fsSync.existsSync(outside)).toBe(false);
  });

  it("blocks directory listings outside the workspace", async () => {
    const root = workspace();
    const outside = path.join(path.dirname(root), `outside-list-${Date.now()}`);
    roots.push(outside);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");

    const result = await new ListDirTool({ workspace: root, allowedDir: root }).execute({ path: outside });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toContain("outside");
  });

  it("blocks writes, edits, and listings in unrelated directories when extra allowed directories are configured", async () => {
    const root = workspace();
    const extra = path.join(path.dirname(root), `extra-block-${Date.now()}`);
    const unrelated = path.join(path.dirname(root), `unrelated-block-${Date.now()}`);
    roots.push(extra, unrelated);
    await fs.mkdir(extra, { recursive: true });
    await fs.mkdir(unrelated, { recursive: true });
    const file = path.join(unrelated, "secret.txt");
    await fs.writeFile(file, "Original content.");

    const writeResult = await new WriteFileTool({ workspace: root, allowedDir: root, extraAllowedDirs: [extra] }).execute({
      path: path.join(unrelated, "created.txt"),
      content: "nope",
    });
    expect(writeResult).toContain("Error");
    expect(writeResult.toLowerCase()).toContain("outside");
    expect(fsSync.existsSync(path.join(unrelated, "created.txt"))).toBe(false);

    const editResult = await new EditFileTool({ workspace: root, allowedDir: root, extraAllowedDirs: [extra] }).execute({
      path: file,
      old_text: "Original content.",
      new_text: "Edited content.",
    });
    expect(editResult).toContain("Error");
    expect(editResult.toLowerCase()).toContain("outside");
    expect(await fs.readFile(file, "utf8")).toBe("Original content.");

    const listResult = await new ListDirTool({ workspace: root, allowedDir: root, extraAllowedDirs: [extra] }).execute({
      path: unrelated,
    });
    expect(listResult).toContain("Error");
    expect(listResult.toLowerCase()).toContain("outside");
  });

  it("keeps workspace files readable", async () => {
    const root = workspace();
    const file = path.join(root, "README.md");
    await fs.writeFile(file, "hello from workspace");

    const result = await new ReadFileTool({ workspace: root, allowedDir: root }).execute({ path: file });

    expect(result).toContain("hello from workspace");
    expect(result).not.toContain("Error");
  });

  it("blocks edits outside the workspace", async () => {
    const root = workspace();
    const outside = path.join(path.dirname(root), `outside-edit-${Date.now()}.txt`);
    await fs.writeFile(outside, "Original content.");
    roots.push(outside);

    const result = await new EditFileTool({ workspace: root, allowedDir: root }).execute({
      path: outside,
      old_text: "Original content.",
      new_text: "Hacked content.",
    });

    expect(result).toContain("Error");
    expect(result.toLowerCase()).toContain("outside");
    expect(await fs.readFile(outside, "utf8")).toBe("Original content.");
  });
});
