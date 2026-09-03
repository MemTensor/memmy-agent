import { describe, expect, it } from "vitest";
import type { TraceDTO } from "../agent-contract/dto.js";
import { pickSummary } from "../viewer/src/views/memory-summary.js";

describe("Memmy Viewer memories", () => {
  it("shows the user query while the summary is pending and the summary once ready", () => {
    const trace = {
      summary: "摘要排队中",
      userText: "修复记忆列表的摘要占位文案",
      agentText: "已开始排查。",
    } as TraceDTO;

    expect(pickSummary(trace)).toBe("修复记忆列表的摘要占位文案");
    expect(pickSummary({
      ...trace,
      summary: "记忆列表在摘要生成前会展示用户请求",
    })).toBe("记忆列表在摘要生成前会展示用户请求");
  });
});
