import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SafeFileHistory, sanitizeSurrogates } from "../../../src/entrypoints/cli/commands.js";

const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-cli-history-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("sanitizeSurrogates", () => {
  it("preserves paired surrogate emoji", () => {
    expect(sanitizeSurrogates("你为什么会用 🐈")).toBe("你为什么会用 🐈");
  });

  it("removes lone surrogates", () => {
    const result = sanitizeSurrogates("hello \udce9 world");

    expect(result).not.toContain("\udce9");
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });

  it("leaves normal mixed unicode unchanged", () => {
    expect(sanitizeSurrogates("你好 hello こんにちは 🎉")).toBe("你好 hello こんにちは 🎉");
  });

  it("leaves normal ascii text unchanged", () => {
    expect(sanitizeSurrogates("normal ascii text")).toBe("normal ascii text");
  });

  it("leaves already-correct emoji unchanged", () => {
    expect(sanitizeSurrogates("hello 🐈 memmy")).toBe("hello 🐈 memmy");
  });

  it("removes multiple lone surrogates", () => {
    const result = sanitizeSurrogates("\udce9\udcf1\udcff");

    expect(result).not.toContain("\udce9");
    expect(result).not.toContain("\udcf1");
    expect(result).not.toContain("\udcff");
  });
});

describe("SafeFileHistory", () => {
  it("stores sanitized history strings", () => {
    const history = new SafeFileHistory(path.join(tmpRoot(), "history"));

    history.storeString("hello \udce9 world");
    const entries = history.loadHistoryStrings();

    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain("\udce9");
    expect(entries[0]).toContain("hello");
    expect(entries[0]).toContain("world");
  });

  it("preserves normal text and emoji", () => {
    const history = new SafeFileHistory(path.join(tmpRoot(), "history"));

    history.storeString("hello 🐈 memmy");

    expect(history.loadHistoryStrings()).toEqual(["hello 🐈 memmy"]);
  });

  it("preserves normal ascii text", () => {
    const history = new SafeFileHistory(path.join(tmpRoot(), "history"));

    history.storeString("normal ascii text");

    expect(history.loadHistoryStrings()).toEqual(["normal ascii text"]);
  });

  it("preserves mixed unicode text", () => {
    const history = new SafeFileHistory(path.join(tmpRoot(), "history"));

    history.storeString("你好 hello こんにちは 🎉");

    expect(history.loadHistoryStrings()).toEqual(["你好 hello こんにちは 🎉"]);
  });

  it("stores sanitized strings with multiple lone surrogates", () => {
    const history = new SafeFileHistory(path.join(tmpRoot(), "history"));

    history.storeString("\udce9\udcf1\udcff");
    const entries = history.loadHistoryStrings();

    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain("\udce9");
  });
});
