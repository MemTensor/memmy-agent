import { describe, expect, it } from "vitest";
import { mergeLiveLines } from "../asr-live-transcription.js";

describe("mergeLiveLines", () => {
  it("keeps sentences ordered by their latest offset", () => {
    const merged = mergeLiveLines(
      [{ sentenceId: 2, startMs: 2_000, endMs: 2_500, text: "later" }],
      { sentenceId: 1, startMs: 0, endMs: 500, text: "first" }
    );

    expect(merged.map((line) => line.text)).toEqual(["first", "later"]);
  });

  it("replaces the same sentence even when the recognizer revises its offset", () => {
    const merged = mergeLiveLines(
      [{ sentenceId: 1, startMs: 0, endMs: 0, text: "帮我写一篇" }],
      { sentenceId: 1, startMs: 170, endMs: 920, text: "帮我写一篇关于 AI Memory 的综述" }
    );

    expect(merged).toEqual([
      { sentenceId: 1, startMs: 170, endMs: 920, text: "帮我写一篇关于 AI Memory 的综述" }
    ]);
  });
});
