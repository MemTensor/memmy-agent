import { describe, expect, it, vi } from "vitest";
import type { UploadAgentMediaInput, UploadedAgentMedia } from "../../api/memmy-agent-client.js";
import type { AsrRecordingTranscription } from "../../pages/asr-recorder.js";
import { zhCNMessages, formatMessage } from "../../i18n/messages.js";
import { formatTranscript, persistRecording, recordingFormat } from "../recording-deliverables.js";

/** Stands in for the card's translator, resolving against the real catalogue. */
const t = ((key: keyof typeof zhCNMessages, values?: Record<string, string | number>) =>
  formatMessage(zhCNMessages[key], values)) as Parameters<typeof persistRecording>[1];

function transcription(overrides: Partial<AsrRecordingTranscription> = {}): AsrRecordingTranscription {
  return {
    text: "我们社保按最低基数缴。",
    modelId: "qwen-audio-3.0-asr-flash-filetrans",
    provider: "dashscope",
    transcribedAt: "2026-03-04T05:06:07.008Z",
    source: "account",
    recording: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mp4" }),
    recordingMimeType: "audio/mp4;codecs=mp4a.40.2",
    durationMs: 9_000,
    ...overrides
  } as AsrRecordingTranscription;
}

function sink() {
  const calls: UploadAgentMediaInput[][] = [];
  const uploadFiles = vi.fn(async (files: UploadAgentMediaInput[]): Promise<UploadedAgentMedia[]> => {
    calls.push(files);
    return files.map((file, index) => ({
      path: `/uploads/${index}-${file.name}`,
      url: `memmy://uploads/${index}`,
      name: file.name,
      kind: file.kind,
      mime: file.mime,
      bytes: 3
    })) as UploadedAgentMedia[];
  });
  return { uploadFiles, calls };
}

describe("recording deliverables", () => {
  it("stores the recording and the transcript as two files", async () => {
    const { uploadFiles, calls } = sink();

    const stored = await persistRecording(transcription(), t, uploadFiles);

    expect(calls[0]).toHaveLength(2);
    expect(stored.audio?.kind).toBe("audio");
    expect(stored.transcript?.mime).toBe("text/plain");
    // The stamp comes from the transcription, so both files share it and sort together.
    expect(stored.audio?.name).toBe("访谈录音-2026-03-04T05-06-07-008Z.m4a");
    expect(stored.transcript?.name).toBe("访谈转写-2026-03-04T05-06-07-008Z.txt");
  });

  it("declares a media type the upload contract accepts", async () => {
    const { uploadFiles, calls } = sink();

    // MediaRecorder reports codec parameters that uploads reject, and the
    // extension has to agree with whatever type is declared.
    await persistRecording(transcription({ recordingMimeType: "audio/webm;codecs=opus" }), t, uploadFiles);

    expect(calls[0]?.[0]?.mime).toBe("audio/webm");
    expect(calls[0]?.[0]?.name.endsWith(".webm")).toBe(true);
  });

  it("answers with nothing when the Host has no upload sink", async () => {
    // A card without an upload sink still has to return its transcript rather
    // than failing the interaction.
    expect(await persistRecording(transcription(), t)).toEqual({});
  });

  it("writes the transcript one speaker turn per line", () => {
    const text = formatTranscript({
      text: "忽略这段扁平文本。",
      segments: [
        { text: "我们社保按最低基数缴。", speakerId: 0, startMs: 0, endMs: 4_000 },
        { text: "食堂是非全日制用工。", speakerId: 1, startMs: 65_000, endMs: 70_000 }
      ]
    }, t);

    // Speaker numbers restart per transcription, so they read as labels rather
    // than identities, and they are shown one-based to match the UI.
    expect(text).toBe("[00:00] 【说话人 1】我们社保按最低基数缴。\n[01:05] 【说话人 2】食堂是非全日制用工。");
  });

  it("falls back to flat text when the model separated no speakers", () => {
    expect(formatTranscript({ text: "一段没有分离说话人的转写。", segments: [] }, t)).toBe("一段没有分离说话人的转写。");
    expect(formatTranscript({ text: "同上。" }, t)).toBe("同上。");
  });

  it("omits labels the transcription did not provide", () => {
    const text = formatTranscript({ text: "x", segments: [{ text: "只有文本。" }] }, t);

    expect(text).toBe("只有文本。");
  });

  it("maps every media type a recorder may report to an extension", () => {
    expect(recordingFormat("audio/mp4")).toEqual({ extension: ".m4a", mime: "audio/mp4" });
    expect(recordingFormat("AUDIO/OGG ")).toEqual({ extension: ".ogg", mime: "audio/ogg" });
    // An unrecognised type still has to produce a storable pair.
    expect(recordingFormat("audio/exotic")).toEqual({ extension: ".webm", mime: "audio/webm" });
  });
});

describe("the transcript's speaker label", () => {
  it("is resolved rather than shipped as a template", () => {
    // The catalogue writes the label with `{index}`, and the panel passed `id`,
    // so every turn rendered the literal 「【说话人 {index}】」. The message
    // renders with whatever a caller supplies, which is why this is asserted
    // through the catalogue instead of against a literal.
    expect(zhCNMessages["plugin.ui.audio.speakerLabel"]).toBeDefined();
    expect(formatMessage(zhCNMessages["plugin.ui.audio.speakerLabel"], { index: 2 })).toBe("发言人 2");
    expect(formatMessage(zhCNMessages["plugin.ui.audio.speakerLabel"], { index: 2 })).not.toContain("{index}");
  });
});
