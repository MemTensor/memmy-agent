import { describe, expect, it } from "vitest";
import { countL3Units } from "../../../src/service/l3-field/text-units.js";

describe("countL3Units", () => {
  it("counts CJK characters one by one", () => {
    expect(countL3Units("这个仓库用 SSH 拉代码会失败")).toBe(12);
  });

  it("counts other text by whitespace-separated words", () => {
    expect(countL3Units("pytest is the test runner here")).toBe(6);
  });

  it("counts mixed text by both rules and ignores punctuation-only tokens", () => {
    expect(countL3Units("用 npm ci 安装依赖 , 不用 npm install")).toBe(11);
  });

  it("returns zero for blank text", () => {
    expect(countL3Units("  \n ")).toBe(0);
  });
});
