/** Home memory tests. */
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api/http.js";
import { createMemorySearchInput, summarizeMemoryRecall, summarizeMemoryRecallError } from "../home-memory.js";

describe("home memory recall helpers", () => {
  it("builds a real memory search request for the frontend adapter", () => {
    expect(createMemorySearchInput("总结我的偏好")).toEqual({
      query: "总结我的偏好"
    });
  });

  it("summarizes real recall hits without inventing memory data", () => {
    expect(
      summarizeMemoryRecall({
        injectedContext: "用户偏好中文结构化说明"
      })
    ).toBe("已连接真实记忆服务，召回 1 条记忆：用户偏好中文结构化说明");
  });

  it("summarizes full recall hits without inventing memory data", () => {
    expect(
      summarizeMemoryRecall({
        injectedContext: "用户偏好中文结构化说明",
        debug: {
          searchEventId: "search-1",
          hits: [
            {
              id: "memory-1",
              kind: "trace",
              memoryLayer: "L1",
              status: "activated",
              score: 0.9,
              snippet: "用户偏好中文结构化说明",
              tags: ["preference"],
              source: "search"
            }
          ],
          sourceMemoryIds: ["memory-1"],
          status: [],
          sections: [
            {
              id: "memory-1",
              title: "偏好",
              kind: "trace",
              memoryLayer: "L1",
              memoryIds: ["memory-1"],
              content: "用户偏好中文结构化说明"
            }
          ],
          serverTime: "2026-06-04T00:00:00.000Z"
        }
      })
    ).toBe("已连接真实记忆服务，召回 1 条记忆：用户偏好中文结构化说明");
  });

  it("reports unavailable memory service instead of fake recall data", () => {
    expect(summarizeMemoryRecall(null)).toBe("记忆服务未连接");
  });

  it("preserves structured backend recall errors for display", () => {
    const error = new ApiRequestError("invalid request", 400, "invalid_argument", "req-2");

    expect(summarizeMemoryRecallError(error)).toBe("记忆召回失败：invalid_argument invalid request（req-2）");
  });
});
