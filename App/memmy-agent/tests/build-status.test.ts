import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStatusContent,
  type RuntimeStatusSnapshot,
} from "../src/utils/helpers.js";

const NOW_MS = 2_000_000_000_000;

function statusSnapshot(
  overrides: Partial<RuntimeStatusSnapshot> = {},
): RuntimeStatusSnapshot {
  return {
    version: "1.0.5",
    model: {
      state: "ok",
      value: { provider: "openai", displayModel: "gpt-5.5" },
    },
    usage: {
      state: "reported",
      promptTokens: 19_124,
      completionTokens: 820,
      cachedTokens: 11_857,
    },
    context: {
      state: "ok",
      value: { estimatedTokens: 19_124, windowTokens: 200_000 },
    },
    conversationUserTurns: 7,
    agentStartTime: NOW_MS / 1000 - 663,
    searchUsageText: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("build status content", () => {
  it("renders the stable status fields in their fixed order", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    const content = buildStatusContent(statusSnapshot({
      searchUsageText: "🔍 Web Search: duckduckgo\n   Usage tracking: not available for this provider",
    }));

    expect(content).toBe([
      "memmy v1.0.5",
      "Model: openai / gpt-5.5",
      "Last run tokens: 19124 in / 820 out (62% cached)",
      "Context: ~19k / 200k",
      "Conversation: 7 user turns",
      "Agent uptime: 11m 3s",
      "🔍 Web Search: duckduckgo",
      "   Usage tracking: not available for this provider",
    ].join("\n"));
    expect(content).not.toMatch(/Tasks:|input budget|tiktoken|Preset:|Goal:|Queue:|Subagent/i);
  });

  it("renders unavailable when the last run has no reported usage", () => {
    const content = buildStatusContent(statusSnapshot({ usage: { state: "missing" } }));

    expect(content).toContain("Last run tokens: unavailable");
    expect(content).not.toContain("0 in / 0 out");
  });

  it("preserves explicitly reported zero usage", () => {
    const content = buildStatusContent(statusSnapshot({
      usage: {
        state: "reported",
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
      },
    }));

    expect(content).toContain("Last run tokens: 0 in / 0 out");
    expect(content.toLowerCase()).not.toContain("cached");
  });

  it("omits cache information when no cached tokens were reported", () => {
    const content = buildStatusContent(statusSnapshot({
      usage: {
        state: "reported",
        promptTokens: 2000,
        completionTokens: 300,
        cachedTokens: 0,
      },
    }));

    expect(content).toContain("Last run tokens: 2000 in / 300 out");
    expect(content.toLowerCase()).not.toContain("cached");
  });

  it("does not clamp a context estimate that exceeds the model window", () => {
    const content = buildStatusContent(statusSnapshot({
      context: {
        state: "ok",
        value: { estimatedTokens: 205_999, windowTokens: 200_000 },
      },
    }));

    expect(content).toContain("Context: ~205k / 200k");
  });

  it.each([
    ["token_estimation_failed", "Context: error (token estimation failed)"],
    ["invalid_model_context_window", "Context: error (invalid model context window)"],
  ] as const)("renders the %s context error explicitly", (reason, expected) => {
    const content = buildStatusContent(statusSnapshot({
      context: { state: "error", reason },
    }));

    expect(content).toContain(expected);
  });

  it("keeps model and context errors aligned when the session model cannot be resolved", () => {
    const content = buildStatusContent(statusSnapshot({
      model: { state: "error", reason: "session_model_selection_unavailable" },
      context: { state: "error", reason: "session_model_selection_unavailable" },
    }));

    expect(content).toContain("Model: error (session model selection cannot be resolved)");
    expect(content).toContain("Context: error (session model selection cannot be resolved)");
  });

  it("uses singular conversation wording and the existing long uptime format", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW_MS);
    const content = buildStatusContent(statusSnapshot({
      conversationUserTurns: 1,
      agentStartTime: NOW_MS / 1000 - 7384,
    }));

    expect(content).toContain("Conversation: 1 user turn");
    expect(content).toContain("Agent uptime: 2h 3m");
  });

  it("keeps the string-array compatibility input", () => {
    expect(buildStatusContent(["one", "", "two"])).toBe("one\ntwo");
  });
});
