import { describe, expect, it } from "vitest";
import { createWindsurfSourceAdapter } from "../adapter.js";

describe("createWindsurfSourceAdapter", () => {
  it("returns a source adapter with the expected descriptor", () => {
    const adapter = createWindsurfSourceAdapter();
    expect(adapter.descriptor.sourceId).toBe("windsurf");
    expect(adapter.descriptor.displayName).toBe("Windsurf");
    expect(adapter.descriptor.builtin).toBe(true);
  });

  it("detect returns false when the data directory does not exist", async () => {
    const adapter = createWindsurfSourceAdapter({
      dataDirectory: "/nonexistent/path/to/windsurf",
    });
    const detected = await adapter.detect();
    expect(detected).toBe(false);
  });

  it("accepts custom descriptor and data directory", () => {
    const adapter = createWindsurfSourceAdapter({
      dataDirectory: "/custom/windsurf",
      descriptor: Object.freeze({
        sourceId: "windsurf-custom",
        displayName: "Windsurf (Custom)",
        builtin: false,
        dataPath: "/custom/windsurf",
      }),
    });
    expect(adapter.descriptor.sourceId).toBe("windsurf-custom");
    expect(adapter.descriptor.builtin).toBe(false);
  });
});
