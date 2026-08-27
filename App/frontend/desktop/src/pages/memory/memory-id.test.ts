import { describe, expect, it } from "vitest";
import { displayMemoryId } from "./memory-id.js";

describe("displayMemoryId", () => {
  it("展示数据源编码后的原始记忆 id", () => {
    expect(displayMemoryId("memmy-memory::trace_abc123")).toBe("trace_abc123");
    expect(displayMemoryId("trace_abc123")).toBe("trace_abc123");
  });
});
