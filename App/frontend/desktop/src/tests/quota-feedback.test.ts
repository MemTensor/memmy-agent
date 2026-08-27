/** Quota feedback tests. */
import { describe, expect, it } from "vitest";
import { FEEDBACK_MIN_LENGTH, canSubmitFeedback, feedbackLength } from "../feedback/quota-feedback.js";

describe("canSubmitFeedback", () => {
  it("最小有效长度为 20", () => {
    expect(FEEDBACK_MIN_LENGTH).toBe(20);
  });

  it("19 字时不可提交,20 字时可提交", () => {
    expect(canSubmitFeedback("a".repeat(19))).toBe(false);
    expect(canSubmitFeedback("a".repeat(20))).toBe(true);
    expect(canSubmitFeedback("a".repeat(21))).toBe(true);
  });

  it("按去除首尾空白后的长度判定", () => {
    expect(canSubmitFeedback(`   ${"a".repeat(19)}   `)).toBe(false);
    expect(canSubmitFeedback(`   ${"a".repeat(20)}   `)).toBe(true);
  });

  it("中文按 1 字计算", () => {
    expect(canSubmitFeedback("一".repeat(19))).toBe(false);
    expect(canSubmitFeedback("一".repeat(20))).toBe(true);
  });

  it("空串与纯空白不可提交", () => {
    expect(canSubmitFeedback("")).toBe(false);
    expect(canSubmitFeedback("          ")).toBe(false);
  });
});

describe("feedbackLength", () => {
  it("返回去除首尾空白后的字符数", () => {
    expect(feedbackLength("  hello  ")).toBe(5);
    expect(feedbackLength("")).toBe(0);
  });
});
