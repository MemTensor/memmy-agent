import { describe, expect, it } from "vitest";
import { formatClock, groupSpeakerTurns } from "../interview-recording-panel.js";

describe("groupSpeakerTurns", () => {
  it("merges consecutive sentences from the same speaker into one turn", () => {
    const turns = groupSpeakerTurns([
      { text: "喝水吗？", speakerId: 0, startMs: 55_000 },
      { text: "我给你们拿点水。", speakerId: 0, startMs: 55_800 },
      { text: "谢谢。", speakerId: 1, startMs: 57_000 },
      { text: "我先不用。", speakerId: 0, startMs: 57_500 }
    ]);

    expect(turns).toEqual([
      { speakerId: 0, startMs: 55_000, text: "喝水吗？我给你们拿点水。" },
      { speakerId: 1, startMs: 57_000, text: "谢谢。" },
      { speakerId: 0, startMs: 57_500, text: "我先不用。" }
    ]);
  });

  it("returns nothing to group when the model separated no speakers", () => {
    // The caller falls back to flat text, which is the only honest rendering
    // when every sentence would carry the same invented label.
    expect(groupSpeakerTurns([{ text: "一段没有发言人的转写" }])).toEqual([]);
  });

  it("skips blank segments", () => {
    const turns = groupSpeakerTurns([
      { text: "  ", speakerId: 0 },
      { text: "有内容", speakerId: 0 }
    ]);
    expect(turns).toEqual([{ speakerId: 0, startMs: undefined, text: "有内容" }]);
  });
});

describe("formatClock", () => {
  it("shows mm:ss inside the first hour", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(5_400)).toBe("00:05");
    expect(formatClock(68_000)).toBe("01:08");
  });

  it("grows to h:mm:ss for a long interview", () => {
    expect(formatClock(3_600_000)).toBe("1:00:00");
    expect(formatClock(7_265_000)).toBe("2:01:05");
  });

  it("floors a negative offset at zero", () => {
    expect(formatClock(-1_000)).toBe("00:00");
  });
});
