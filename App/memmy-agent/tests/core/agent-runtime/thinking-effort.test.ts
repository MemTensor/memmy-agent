import { describe, expect, it } from "vitest";
import { reasoningEffortFromTurnMetadata } from "../../../src/core/agent-runtime/loop.js";

describe("reasoningEffortFromTurnMetadata", () => {
  it("maps disabled thinking to none and missing level to medium", () => {
    expect(reasoningEffortFromTurnMetadata({ thinking_enabled: false }, "gpt-5.4")).toBe("none");
    expect(reasoningEffortFromTurnMetadata({ thinking_enabled: true }, "gpt-5.4")).toBe("medium");
    expect(reasoningEffortFromTurnMetadata({
      thinking_enabled: true,
      thinking_level: "high",
    }, "gpt-5.4")).toBe("high");
    expect(reasoningEffortFromTurnMetadata({}, "gpt-5.4")).toBeUndefined();
  });

  it("keeps always-on table models enabled even if the frame asked to disable", () => {
    expect(reasoningEffortFromTurnMetadata({
      thinking_enabled: false,
      thinking_level: "low",
    }, "claude-fable-5")).toBe("low");
  });

  it("lets a custom model turn thinking off even when the catalog model is always on", () => {
    expect(reasoningEffortFromTurnMetadata({
      model_provider: "custom",
      thinking_enabled: false,
      thinking_level: "low",
    }, "gpt-6-astra")).toBe("none");
  });
});
