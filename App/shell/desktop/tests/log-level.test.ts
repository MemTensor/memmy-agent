import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLogLevel, readPersistedLogLevel, writePersistedLogLevel } from "../src/main/log-level.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memmy-loglevel-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseLogLevel", () => {
  it("接受合法级别", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("error")).toBe("error");
  });

  it("非法或缺失回退 info", () => {
    expect(parseLogLevel("verbose")).toBe("info");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel(123)).toBe("info");
  });
});

describe("persist", () => {
  it("写入后能读回同一级别", () => {
    const file = join(dir, "developer-settings.json");
    writePersistedLogLevel(file, "warn");
    expect(readPersistedLogLevel(file)).toBe("warn");
  });

  it("文件不存在时读到默认 info", () => {
    expect(readPersistedLogLevel(join(dir, "nope.json"))).toBe("info");
  });

  it("文件损坏时读到默认 info", () => {
    const file = join(dir, "broken.json");
    writeFileSync(file, "{not json");
    expect(readPersistedLogLevel(file)).toBe("info");
  });
});
