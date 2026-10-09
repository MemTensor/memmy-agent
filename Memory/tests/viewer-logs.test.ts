import { describe, expect, it } from "vitest";
import type { ApiLogDTO } from "../agent-contract/dto.js";
import { locale } from "../viewer/src/stores/i18n.js";
import { buildMemoryLogSummary } from "../viewer/src/views/log-utils.js";

function log(toolName: string): ApiLogDTO {
  return {
    id: 1,
    toolName,
    inputJson: "{}",
    outputJson: "{}",
    durationMs: 0,
    success: true,
    calledAt: 0 as ApiLogDTO["calledAt"],
  };
}

describe("Viewer log summaries", () => {
  it("uses the user query instead of an internal RawTurn id", () => {
    expect(buildMemoryLogSummary(
      log("memory_add"),
      { query: "我之前做过什么职业" },
      {
        details: [{
          role: "trace",
          summary: "RawTurn: raw_d9022d9fc7e3513b402a",
          query: "我之前做过什么职业",
        }],
      },
    )).toEqual({ text: "我之前做过什么职业" });
  });

  it("localizes the memory search count", () => {
    locale.value = "zh";
    expect(buildMemoryLogSummary(
      log("memory_search"),
      { query: "我之前做过什么职业" },
      {
        candidates: [{ refId: "1" }, { refId: "2" }],
        filtered: [{ refId: "2" }],
      },
    )).toEqual({ text: "我之前做过什么职业", tail: "· 保留 1/2" });
  });
});
