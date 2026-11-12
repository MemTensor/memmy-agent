import { describe, expect, it, vi } from "vitest";
import {
  bytesToBase64,
  createChunkedLiveTranscriber,
  encodeWav,
  findQuietestCut,
  mergeLiveLines,
  type AsrLiveLine
} from "../asr-live-transcription.js";

const SAMPLE_RATE = 16_000;

/** Builds a constant-amplitude block, standing in for captured audio. */
function block(samples: number, amplitude = 8_000): Int16Array {
  return new Int16Array(samples).fill(amplitude);
}

function stubClient(text: (callIndex: number) => string = () => "转写结果") {
  let calls = 0;
  const transcribe = vi.fn(async () => {
    const index = calls;
    calls += 1;
    return {
      text: text(index),
      modelId: "qwen3-asr-flash",
      provider: "aliyun" as const,
      source: "account" as const,
      transcribedAt: new Date().toISOString()
    };
  });
  return { transcribe };
}

describe("createChunkedLiveTranscriber", () => {
  it("reports a line once a segment has been filled", async () => {
    const client = stubClient(() => "公司目前有多少名员工");
    const lines: AsrLiveLine[] = [];
    const transcriber = createChunkedLiveTranscriber(client as never, {
      sampleRate: SAMPLE_RATE,
      segmentMs: 1_000,
      onLine: (line) => lines.push(line)
    });

    // Half a segment is not enough to transcribe anything yet.
    transcriber.push(block(SAMPLE_RATE / 2));
    await transcriber.finish();
    expect(client.transcribe).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.text).toBe("公司目前有多少名员工");
    expect(lines[0]?.startMs).toBe(0);
  });

  it("numbers segment offsets from the start of the recording", async () => {
    const client = stubClient((index) => `第 ${index + 1} 段`);
    const lines: AsrLiveLine[] = [];
    const transcriber = createChunkedLiveTranscriber(client as never, {
      sampleRate: SAMPLE_RATE,
      segmentMs: 1_000,
      onLine: (line) => lines.push(line)
    });

    // Three seconds of constant audio: the cut search finds no quiet point, so
    // segments land on the target boundary.
    transcriber.push(block(SAMPLE_RATE * 3));
    await transcriber.finish();

    expect(lines.map((line) => line.text)).toEqual(["第 1 段", "第 2 段", "第 3 段"]);
    expect(lines.map((line) => line.startMs)).toEqual([0, 1_000, 2_000]);
  });

  it("keeps the recording going when a segment fails to transcribe", async () => {
    const transcribe = vi.fn()
      .mockRejectedValueOnce(new Error("upstream unavailable"))
      .mockResolvedValue({
        text: "第二段",
        modelId: "qwen3-asr-flash",
        provider: "aliyun",
        source: "account",
        transcribedAt: new Date().toISOString()
      });
    const lines: AsrLiveLine[] = [];
    const errors: Error[] = [];
    const transcriber = createChunkedLiveTranscriber({ transcribe } as never, {
      sampleRate: SAMPLE_RATE,
      segmentMs: 1_000,
      onLine: (line) => lines.push(line),
      onError: (error) => errors.push(error)
    });

    transcriber.push(block(SAMPLE_RATE * 2));
    await transcriber.finish();

    expect(errors).toHaveLength(1);
    // The failed segment is reported but skipped; the next one still lands.
    expect(lines.map((line) => line.text)).toEqual(["第二段"]);
  });

  it("drops empty transcriptions rather than showing blank lines", async () => {
    const client = stubClient((index) => (index === 0 ? "   " : "有内容"));
    const lines: AsrLiveLine[] = [];
    const transcriber = createChunkedLiveTranscriber(client as never, {
      sampleRate: SAMPLE_RATE,
      segmentMs: 1_000,
      onLine: (line) => lines.push(line)
    });

    transcriber.push(block(SAMPLE_RATE * 2));
    await transcriber.finish();

    expect(lines.map((line) => line.text)).toEqual(["有内容"]);
  });

  it("stops transcribing and reports nothing more once cancelled", async () => {
    const client = stubClient();
    const lines: AsrLiveLine[] = [];
    const transcriber = createChunkedLiveTranscriber(client as never, {
      sampleRate: SAMPLE_RATE,
      segmentMs: 1_000,
      onLine: (line) => lines.push(line)
    });

    transcriber.cancel();
    transcriber.push(block(SAMPLE_RATE * 2));
    await transcriber.finish();

    expect(client.transcribe).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("sends each segment as a self-contained WAV so a later chunk is decodable", async () => {
    const client = stubClient();
    const transcriber = createChunkedLiveTranscriber(client as never, {
      sampleRate: SAMPLE_RATE,
      segmentMs: 1_000,
      onLine: () => undefined
    });

    transcriber.push(block(SAMPLE_RATE * 2));
    await transcriber.finish();

    for (const call of client.transcribe.mock.calls) {
      const input = call[0] as { audioBase64: string; mimeType: string };
      expect(input.mimeType).toBe("audio/wav");
      expect(atob(input.audioBase64).startsWith("RIFF")).toBe(true);
    }
  });
});

describe("findQuietestCut", () => {
  it("moves the cut onto a pause instead of splitting a word", () => {
    const samples = block(SAMPLE_RATE * 2);
    // A 150 ms silence shortly before the one-second target.
    const silenceStart = SAMPLE_RATE - Math.round(SAMPLE_RATE * 0.25);
    samples.fill(0, silenceStart, silenceStart + Math.round(SAMPLE_RATE * 0.15));

    const cut = findQuietestCut(samples, SAMPLE_RATE, SAMPLE_RATE);

    expect(cut).toBeLessThan(SAMPLE_RATE);
    expect(cut).toBeGreaterThan(silenceStart - SAMPLE_RATE * 0.1);
  });

  it("falls back to the target when the audio is uniformly loud", () => {
    expect(findQuietestCut(block(SAMPLE_RATE * 2), SAMPLE_RATE, SAMPLE_RATE)).toBe(SAMPLE_RATE);
  });

  it("never cuts past the audio it was given", () => {
    const samples = block(1_000);
    expect(findQuietestCut(samples, SAMPLE_RATE, SAMPLE_RATE)).toBeLessThanOrEqual(samples.length);
  });
});

describe("encodeWav", () => {
  it("writes a mono 16-bit header that matches the sample data", () => {
    const wav = encodeWav(new Int16Array([0, 1_000, -1_000]), SAMPLE_RATE);
    const view = new DataView(wav.buffer);

    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(44 + 2, true)).toBe(1_000);
    expect(view.getInt16(44 + 4, true)).toBe(-1_000);
  });
});

describe("bytesToBase64", () => {
  it("encodes payloads larger than one chunk", () => {
    const bytes = new Uint8Array(0x8000 + 17).fill(7);
    expect(atob(bytesToBase64(bytes))).toHaveLength(bytes.length);
  });
});

describe("mergeLiveLines", () => {
  it("keeps lines ordered by offset", () => {
    const merged = mergeLiveLines(
      [{ startMs: 6_000, endMs: 12_000, text: "第二句" }],
      { startMs: 0, endMs: 6_000, text: "第一句" }
    );
    expect(merged.map((line) => line.text)).toEqual(["第一句", "第二句"]);
  });

  it("replaces a line rather than duplicating its offset", () => {
    const merged = mergeLiveLines(
      [{ startMs: 0, endMs: 6_000, text: "旧文本" }],
      { startMs: 0, endMs: 6_000, text: "新文本" }
    );
    expect(merged).toEqual([{ startMs: 0, endMs: 6_000, text: "新文本" }]);
  });
});
