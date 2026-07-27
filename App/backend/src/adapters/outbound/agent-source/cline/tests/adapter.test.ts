import { describe, expect, it } from "vitest";
import { createClineSourceAdapter } from "../adapter.js";

describe("createClineSourceAdapter", () => {
  it("returns a source adapter with the expected descriptor", () => {
    const adapter = createClineSourceAdapter();
    expect(adapter.descriptor.sourceId).toBe("cline");
    expect(adapter.descriptor.displayName).toBe("Cline");
    expect(adapter.descriptor.builtin).toBe(true);
  });

  it("detect returns false when the data directory does not exist", async () => {
    const adapter = createClineSourceAdapter({
      dataDirectory: "/nonexistent/path/to/cline",
    });
    const detected = await adapter.detect();
    expect(detected).toBe(false);
  });

  it("accepts custom descriptor and data directory", () => {
    const adapter = createClineSourceAdapter({
      dataDirectory: "/custom/cline",
      descriptor: Object.freeze({
        sourceId: "cline-custom",
        displayName: "Cline (Custom)",
        builtin: false,
        dataPath: "/custom/cline",
      }),
    });
    expect(adapter.descriptor.sourceId).toBe("cline-custom");
    expect(adapter.descriptor.builtin).toBe(false);
  });
});
