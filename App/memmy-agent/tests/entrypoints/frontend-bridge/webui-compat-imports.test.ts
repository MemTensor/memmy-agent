import { describe, expect, it } from "vitest";
import * as sessionWebuiTurns from "../../../src/core/session/webui-turns.js";
import * as utilsCompat from "../../../src/utils/index.js";
import * as threadDisk from "../../../src/entrypoints/frontend-bridge/thread-disk.js";
import * as transcript from "../../../src/entrypoints/frontend-bridge/transcript.js";

describe("legacy webui utils compatibility exports", () => {
  it("resolves webui helper exports to the new modules", () => {
    expect(utilsCompat.deleteWebuiThread).toBe(threadDisk.deleteWebuiThread);
    expect(utilsCompat.appendTranscriptObject).toBe(transcript.appendTranscriptObject);
    expect(utilsCompat.markWebuiSession).toBe(sessionWebuiTurns.markWebuiSession);
  });
});
