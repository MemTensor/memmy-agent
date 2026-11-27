import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTeachingBrowserEnhancement } from "../../../src/tools/plugin-host/teaching-browser-enhancement.js";

describe("optional Teach browser enrichment", () => {
  it("keeps the desktop session usable without a connected extension", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-teach-no-extension-"));
    let released = false;
    const bridge = {
      hasBrowserHistoryConnection: () => false,
      teachingBrowserCaptureIntent: () => ({ enabled: false, generation: null, settings: null, captureText: false }),
      subscribeTeachingBrowserHistory: () => () => { released = true; },
    };
    try {
      const source = await createTeachingBrowserEnhancement(bridge).acquire("session", directory);
      const checkpoint = await source.checkpoint();
      expect(checkpoint).toMatchObject({ running: true, complete: true,
        limitations: [expect.stringContaining("not connected")] });
      expect(checkpoint.streams[0]?.size).toBe(0);
      await source.release();
      expect(released).toBe(true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
