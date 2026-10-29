import { describe, expect, it } from "vitest";
import { ASR_MAX_AUDIO_BYTES } from "@memmy/local-api-contracts";
import { ASR_AUDIO_BITS_PER_SECOND, ASR_MAX_RECORDING_MS, asrRecordingTimeRemainingMs } from "../asr-recorder.js";

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;

describe("asr recording limits", () => {
  it("keeps a two-hour interview inside a single transcription", () => {
    // Splitting a recording restarts speaker numbering, so the whole interview
    // has to fit one request for diarization to stay meaningful.
    const bytes = (TWO_HOURS_MS / 1_000) * (ASR_AUDIO_BITS_PER_SECOND / 8);

    expect(bytes).toBeLessThanOrEqual(ASR_MAX_AUDIO_BYTES);
    expect(ASR_MAX_RECORDING_MS).toBeGreaterThanOrEqual(TWO_HOURS_MS);
  });

  it("counts down to the hard stop and never reports negative time", () => {
    expect(asrRecordingTimeRemainingMs(0)).toBe(ASR_MAX_RECORDING_MS);
    expect(asrRecordingTimeRemainingMs(ASR_MAX_RECORDING_MS)).toBe(0);
    expect(asrRecordingTimeRemainingMs(ASR_MAX_RECORDING_MS + 60_000)).toBe(0);
  });
});
