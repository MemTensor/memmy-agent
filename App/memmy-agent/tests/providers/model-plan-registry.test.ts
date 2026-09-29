import { describe, expect, it } from "vitest";
import { findByName } from "../../src/providers/registry.js";

describe("model plan routing", () => {
  it("uses a separate Anthropic backend for MiniMax Token Plan", () => {
    expect(findByName("minimax")?.backend).toBe("openai_compat");
    expect(findByName("minimax_token_plan")).toMatchObject({
      backend: "anthropic",
      defaultApiBase: "https://api.minimax.cn/anthropic"
    });
  });

  it("keeps subscription API bases separate from metered API bases", () => {
    expect(findByName("dashscope_coding_plan")?.defaultApiBase).toBe(
      "https://coding.dashscope.aliyuncs.com/v1"
    );
    expect(findByName("dashscope")?.defaultApiBase).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1"
    );
    expect(findByName("volcengine_coding_plan")?.defaultApiBase).toBe(
      "https://ark.cn-beijing.volces.com/api/coding/v3"
    );
  });
});
