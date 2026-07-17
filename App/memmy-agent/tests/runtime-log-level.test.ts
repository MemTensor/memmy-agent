import { describe, expect, it, vi } from "vitest";
import { parseLogLevel, selectConsoleMethods } from "../src/runtime-log-level.js";

function fakeConsole() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    debug: vi.fn(),
  };
}

describe("parseLogLevel", () => {
  it("非法回退 info", () => {
    expect(parseLogLevel("verbose")).toBe("info");
    expect(parseLogLevel(undefined)).toBe("info");
  });
});

describe("selectConsoleMethods", () => {
  it("error 级别:仅保留 error,其余静默", () => {
    const base = fakeConsole();
    const out = selectConsoleMethods("error", base);
    expect(out.error).toBe(base.error);
    expect(out.warn).not.toBe(base.warn);
    expect(out.info).not.toBe(base.info);
    expect(out.log).not.toBe(base.log);
    expect(out.debug).not.toBe(base.debug);
  });

  it("info 级别:静默 debug,保留 log/info/warn/error", () => {
    const base = fakeConsole();
    const out = selectConsoleMethods("info", base);
    expect(out.debug).not.toBe(base.debug);
    expect(out.info).toBe(base.info);
    expect(out.log).toBe(base.log);
    expect(out.warn).toBe(base.warn);
    expect(out.error).toBe(base.error);
  });

  it("debug 级别:全部保留", () => {
    const base = fakeConsole();
    const out = selectConsoleMethods("debug", base);
    expect(out.debug).toBe(base.debug);
    expect(out.log).toBe(base.log);
  });
});
