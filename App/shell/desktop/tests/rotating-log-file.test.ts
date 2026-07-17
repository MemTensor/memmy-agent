import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRotatingWriter, rollLogFiles } from "../src/main/rotating-log-file.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memmy-rotate-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("rollLogFiles", () => {
  it("把 x.log 滚动为 x.1.log,并把旧的 x.1.log 推到 x.2.log", () => {
    const base = join(dir, "memory.log");
    writeFileSync(base, "current");
    writeFileSync(join(dir, "memory.1.log"), "older");

    rollLogFiles(base, 5);

    expect(existsSync(base)).toBe(false);
    expect(readFileSync(join(dir, "memory.1.log"), "utf8")).toBe("current");
    expect(readFileSync(join(dir, "memory.2.log"), "utf8")).toBe("older");
  });

  it("超过 maxFiles 时丢弃最老的一份", () => {
    const base = join(dir, "memory.log");
    writeFileSync(base, "n0");
    writeFileSync(join(dir, "memory.1.log"), "n1");
    writeFileSync(join(dir, "memory.2.log"), "n2");

    rollLogFiles(base, 3); // Handles expect.

    expect(existsSync(join(dir, "memory.3.log"))).toBe(false);
    expect(readFileSync(join(dir, "memory.1.log"), "utf8")).toBe("n0");
    expect(readFileSync(join(dir, "memory.2.log"), "utf8")).toBe("n1");
  });
});

describe("createRotatingWriter", () => {
  it("累计写入超过 maxSize 时触发轮转", () => {
    const base = join(dir, "agent-gateway.log");
    const writer = createRotatingWriter({ filePath: base, maxSize: 10, maxFiles: 3 });

    writer.write("abcdefgh"); // 8 bytes
    writer.write("ijklmn"); // Handles expect.

    expect(existsSync(join(dir, "agent-gateway.1.log"))).toBe(true);
    expect(readFileSync(join(dir, "agent-gateway.1.log"), "utf8")).toBe("abcdefghijklmn");
    expect(existsSync(base)).toBe(false); // Rotating log file tests.
  });

  it("写入到不存在的目录不抛异常(降级吞掉)", () => {
    const writer = createRotatingWriter({
      filePath: join(dir, "missing-sub", "x.log"),
      maxSize: 10,
      maxFiles: 3
    });
    expect(() => writer.write("hello")).not.toThrow();
  });
});
