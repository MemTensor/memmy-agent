import { describe, expect, it } from "vitest";
import {
  resolveToolResultMaxChars,
  SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME,
} from "../../../src/core/agent-runtime/tool-result-budget.js";

describe("tool result budgets", () => {
  it.each([
    ["exec", 50_000],
    ["read_file", 128_000],
    ["write_stdin", 16_000],
    ["Exec", 16_000],
    [undefined, 16_000],
  ])("resolves %s to %i chars", (toolName, expected) => {
    expect(resolveToolResultMaxChars(toolName, 16_000, SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME)).toBe(expected);
  });

  it("uses the fallback when no per-tool overrides are provided", () => {
    expect(resolveToolResultMaxChars("read_file", 16_000)).toBe(16_000);
  });

  it.each([0, -1, 1.5, Number.NaN])("ignores invalid override %s", (override) => {
    expect(resolveToolResultMaxChars("exec", 16_000, { exec: override })).toBe(16_000);
  });
});
