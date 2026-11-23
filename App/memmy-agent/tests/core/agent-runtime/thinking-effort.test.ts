import { describe, expect, it } from "vitest";
import { reasoningEffortFromTurnMetadata } from "../../../src/core/agent-runtime/loop.js";

describe("reasoningEffortFromTurnMetadata", () => {
  it("passes only explicit choices without inventing a level", () => {
    expect(reasoningEffortFromTurnMetadata({ thinking_enabled: false }, "gpt-5.4")).toBe("none");
    expect(reasoningEffortFromTurnMetadata({ thinking_enabled: true }, "gpt-5.4")).toBeUndefined();
    expect(reasoningEffortFromTurnMetadata({
      thinking_enabled: true,
      thinking_level: "high",
    }, "gpt-5.4")).toBe("high");
    expect(reasoningEffortFromTurnMetadata({}, "gpt-5.4")).toBeUndefined();
  });

  it("does not infer always-on behavior from model names", () => {
    expect(reasoningEffortFromTurnMetadata({
      thinking_enabled: false,
      thinking_level: "low",
    }, "claude-fable-5")).toBe("none");
  });

  it("lets a custom model turn thinking off even when the catalog model is always on", () => {
    expect(reasoningEffortFromTurnMetadata({
      model_provider: "custom",
      thinking_enabled: false,
      thinking_level: "low",
    }, "gpt-6-astra")).toBe("none");
  });
});
