import { describe, expect, it } from "vitest";
import { recordingVideoTime, recordingSourceTime, recordingEventVideoTime, RecordingIdleSpansSchema } from "@memmy/local-api-contracts";
describe("idle video presentation clock", () => {
  const spans = [{ startMs: 10000, endMs: 40000 }, { startMs: 60000, endMs: 90000 }];
  it("maps original event times to the compact video including boundaries and the idle tail", () => {
    expect([0, 9999, 10000, 25000, 40000, 50000, 60000, 90000, 100000].map(time => recordingVideoTime(time, spans)))
      .toEqual([0, 9999, 10000, 10000, 10000, 20000, 30000, 30000, 40000]);
    expect([0, 9999, 10000, 20000, 30000, 40000].map(time => recordingSourceTime(time, spans)))
      .toEqual([0, 9999, 40000, 50000, 90000, 100000]);
  });
  it("preserves existing recordings and refuses overlapping or reversed spans", () => {
    expect(recordingVideoTime(1234)).toBe(1234); expect(recordingSourceTime(1234)).toBe(1234);
    expect(RecordingIdleSpansSchema.safeParse([{startMs:10,endMs:5}]).success).toBe(false);
    expect(RecordingIdleSpansSchema.safeParse([{startMs:10,endMs:20},{startMs:15,endMs:30}]).success).toBe(false);
  });
  it("seeks events inside omitted waits to the retained image rather than the next changed image", () => {
    expect(recordingEventVideoTime(25000, spans)).toBe(9999);
    expect(recordingEventVideoTime(40000, spans)).toBe(10000);
    expect(recordingEventVideoTime(75000, spans)).toBe(29999);
    expect(recordingEventVideoTime(1234)).toBe(1234);
  });
});
