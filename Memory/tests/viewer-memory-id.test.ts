import { describe, expect, it } from "vitest";
import { displayMemoryId } from "../viewer/src/utils/memory-id.js";

describe("Viewer memory ids", () => {
  it("matches Memmy's memory id display", () => {
    expect(displayMemoryId("memmy-memory::trace_abc123")).toBe("trace_abc123");
    expect(displayMemoryId("trace_abc123")).toBe("trace_abc123");
  });
});
