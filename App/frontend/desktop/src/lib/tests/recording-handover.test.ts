// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { AsrClient } from "../../api/asr-client.js";
import { formatMessage, zhCNMessages } from "../../i18n/messages.js";
import { handOverRecording } from "../recording-handover.js";
import { createTranscriptionJob } from "../plugin-transcription-jobs.js";

type HandoverInput = Parameters<typeof handOverRecording>[0];
function input(): HandoverInput {
  return {
    stopped: { sessionId: "pinned-model", recording: new Blob(["full recording"], { type: "audio/webm" }), recordingMimeType: "audio/webm", durationMs: 1000, liveText: "complete live transcript" },
    asrClient: {
      transcribe: vi.fn(async () => ({ text: "HTTP transcript", segments: [{ text: "HTTP transcript", speakerId: 0 }], transcribedAt: "2026-01-01" })),
      release: vi.fn(async () => {})
    } as unknown as AsrClient,
    uploadFiles: vi.fn(async files => files.map(file => ({ path: `/recordings/${file.name}`, url: "local://recording", name: file.name, kind: file.kind, mime: file.mime, bytes: file.blob.size }))),
    startTranscription: (_path, attempt) => createTranscriptionJob(attempt, () => {}),
    t: ((key, values) => formatMessage(zhCNMessages[key], values)) as HandoverInput["t"]
  };
}

describe("recording handover", () => {
  it("stores audio and an already completed realtime transcript without another ASR call", async () => {
    const args = input();
    const { job } = await handOverRecording(args);
    expect(await job.wait()).toMatchObject({ text: "complete live transcript", transcriptFile: { kind: "file" } });
    expect(args.uploadFiles).toHaveBeenCalledTimes(2);
    expect(args.asrClient.transcribe).not.toHaveBeenCalled();
    expect(args.asrClient.release).toHaveBeenCalledWith("pinned-model");
  });

  it("releases the pinned session when storing the audio fails before a job can take ownership", async () => {
    const args = input();
    vi.mocked(args.uploadFiles).mockRejectedValueOnce(new Error("disk full"));
    await expect(handOverRecording(args)).rejects.toThrow("disk full");
    expect(args.asrClient.release).toHaveBeenCalledWith("pinned-model");
    expect(args.asrClient.transcribe).not.toHaveBeenCalled();
  });

  it("uses the pinned model for an explicitly requested diarization pass", async () => {
    const args = input(); args.diarization = true;
    const { job } = await handOverRecording(args);
    expect(await job.wait()).toMatchObject({ text: "HTTP transcript", segments: [{ speakerId: 0 }] });
    expect(args.asrClient.transcribe).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "pinned-model", diarization: true }), undefined);
    expect(args.asrClient.release).toHaveBeenCalledOnce();
  });

  it("keeps the model snapshot through retries and releases it when a failed job is skipped", async () => {
    const args = input(); delete args.stopped.liveText;
    args.stopped.liveError = new Error("realtime unavailable");
    vi.mocked(args.asrClient.transcribe).mockRejectedValue(new Error("HTTP quota exhausted"));
    const { job } = await handOverRecording(args);
    await vi.waitFor(() => expect(job.state.status).toBe("failed"));
    expect(job.state).toMatchObject({ message: expect.stringMatching(/realtime unavailable.*\n.*HTTP quota exhausted/) });
    expect(args.asrClient.transcribe).toHaveBeenCalledTimes(3);
    for (const [request] of vi.mocked(args.asrClient.transcribe).mock.calls) expect(request.sessionId).toBe("pinned-model");
    expect(args.asrClient.release).not.toHaveBeenCalled();
    job.skip(); expect(await job.wait()).toBeNull();
    expect(args.asrClient.release).toHaveBeenCalledWith("pinned-model");
  });
});
