import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { abbreviatePath } from "../../src/utils/path.js";

describe("abbreviatePath short paths", () => {
  it("keeps short paths, exact max length paths, basenames, and empty strings unchanged", () => {
    expect(abbreviatePath("/home/user/file.ts")).toBe("/home/user/file.ts");
    expect(abbreviatePath("/a/b/c", 7)).toBe("/a/b/c");
    expect(abbreviatePath("file.ts")).toBe("file.ts");
    expect(abbreviatePath("")).toBe("");
  });

  it("keeps exact max length paths unchanged", () => {
    expect(abbreviatePath("/a/b/c", 7)).toBe("/a/b/c");
  });

  it("keeps basename-only paths unchanged", () => {
    expect(abbreviatePath("file.ts")).toBe("file.ts");
  });

  it("keeps empty paths unchanged", () => {
    expect(abbreviatePath("")).toBe("");
  });
});

describe("abbreviatePath home paths", () => {
  it("replaces the current home with tilde", () => {
    const home = os.homedir();
    expect(abbreviatePath(path.join(home, "project", "file.ts"))).toMatch(/^~[/\\].*file\.ts$/);
    expect(abbreviatePath(path.join(home, "a.ts"))).toBe(`~${path.sep}a.ts`);
  });

  it("preserves short home paths after tilde replacement", () => {
    expect(abbreviatePath(path.join(os.homedir(), "a.ts"))).toBe(`~${path.sep}a.ts`);
  });
});

describe("abbreviatePath long paths", () => {
  it("keeps useful tail context including basename and parent directory", () => {
    let result = abbreviatePath("/a/b/c/d/e/f/g/h/very_long_filename.ts", 30);
    expect(result).toContain("…");
    expect(result).toMatch(/very_long_filename\.ts$/);

    result = abbreviatePath("/a/b/c/d/e/f/g/h/src/loop.ts", 30);
    expect(result).toContain("src");
    expect(result).toContain("loop.ts");
  });

  it("keeps the basename for long paths", () => {
    const result = abbreviatePath("/a/b/c/d/e/f/g/h/very_long_filename.ts", 30);
    expect(result).toContain("…");
    expect(result).toMatch(/very_long_filename\.ts$/);
  });

  it("keeps parent directory context for long paths", () => {
    const result = abbreviatePath("/a/b/c/d/e/f/g/h/src/loop.ts", 30);
    expect(result).toContain("src");
    expect(result).toContain("loop.ts");
  });

  it("falls back to a shortened basename when the path is extremely long", () => {
    const result = abbreviatePath("/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z/file.ts", 20);
    expect(result).toMatch(/file\.ts$/);
    expect(result.length).toBeLessThanOrEqual(20);
  });
});

describe("abbreviatePath Windows paths", () => {
  it("handles drive paths and home paths", () => {
    const result = abbreviatePath("D:\\Documents\\GitHub\\memmy\\src\\utils\\helpers.ts", 40);
    expect(result).toMatch(/helpers\.ts$/);
    expect(result).toContain("memmy");

    const home = os.homedir();
    const homeResult = abbreviatePath(path.join(home, ".memmy", "workspace", "log.txt"));
    expect(homeResult).toMatch(/^~[/\\]/);
    expect(homeResult).toContain("log.txt");
  });
});

describe("abbreviatePath URLs", () => {
  it("keeps domains and filenames for long URLs", () => {
    const result = abbreviatePath("https://example.com/api/v2/long/path/resource.json", 40);
    expect(result).toContain("example.com");
    expect(result).toContain("resource.json");
  });

  it("keeps short URLs and no-path URLs unchanged", () => {
    expect(abbreviatePath("https://example.com/api")).toBe("https://example.com/api");
    expect(abbreviatePath("https://example.com")).toBe("https://example.com");
  });

  it("keeps URLs without paths unchanged when short enough", () => {
    expect(abbreviatePath("https://example.com")).toBe("https://example.com");
  });

  it("abbreviates URLs with query strings and very long basenames", () => {
    let result = abbreviatePath("https://example.com/api/v2/endpoint?key=value&other=123", 40);
    expect(result).toContain("example.com");
    expect(result).toContain("…");

    result = abbreviatePath("https://example.com/path/very_long_resource_name_file.json", 35);
    expect(result).toContain("example.com");
    expect(result).toContain("…");
  });

  it("abbreviates URL paths that include query strings", () => {
    const result = abbreviatePath("https://example.com/api/v2/endpoint?key=value&other=123", 40);
    expect(result).toContain("example.com");
    expect(result).toContain("…");
  });

  it("abbreviates URLs with very long basenames", () => {
    const result = abbreviatePath("https://example.com/path/very_long_resource_name_file.json", 35);
    expect(result).toContain("example.com");
    expect(result).toContain("…");
  });

  it("uses domain/ellipsis/basename format under tight budgets", () => {
    const result = abbreviatePath("https://a.co/very/deep/path/with/lots/of/segments/and/a/long/basename.txt", 20);
    expect(result).toContain("a.co");
    expect(result).toContain("/…/");
  });
});
