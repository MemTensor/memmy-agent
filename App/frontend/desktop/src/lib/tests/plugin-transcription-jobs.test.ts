import { describe, expect, it, vi } from "vitest";
import { createTranscriptionJob, PLUGIN_TRANSCRIPTION_ATTEMPTS, type PluginTranscriptionState } from "../plugin-transcription-jobs.js";

const transcript = { text: "访谈内容", segments: [], transcribedAt: "2026-10-14T00:00:00Z" };

/** Lets the job's queued attempts run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createTranscriptionJob", () => {
  it("resolves with the transcript once an attempt succeeds", async () => {
    const job = createTranscriptionJob(async () => transcript, () => undefined);
    await expect(job.wait()).resolves.toEqual(transcript);
    expect(job.state.status).toBe("ready");
  });

  it("retries quietly and only stops to ask after the automatic attempts are spent", async () => {
    const states: PluginTranscriptionState[] = [];
    const attempt = vi.fn(async () => { throw new Error("ASR timeout"); });
    const job = createTranscriptionJob(attempt, (state) => states.push(state));
    await flush();
    expect(attempt).toHaveBeenCalledTimes(PLUGIN_TRANSCRIPTION_ATTEMPTS);
    expect(states.filter((state) => state.status === "transcribing").map((state) => state.status === "transcribing" && state.attempt))
      .toEqual([1, 2, 3]);
    expect(job.state).toEqual({ status: "failed", message: "ASR timeout" });
  });

  it("succeeds on a later automatic attempt without the user seeing a failure", async () => {
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce(transcript);
    const states: string[] = [];
    const job = createTranscriptionJob(attempt, (state) => states.push(state.status));
    await expect(job.wait()).resolves.toEqual(transcript);
    expect(states).not.toContain("failed");
  });

  it("starts another round when the user retries, and resolves the original waiter", async () => {
    let fail = true;
    const attempt = vi.fn(async () => { if (fail) throw new Error("down"); return transcript; });
    const job = createTranscriptionJob(attempt, () => undefined);
    const waiting = job.wait();
    await flush();
    expect(job.state.status).toBe("failed");
    fail = false;
    job.retry();
    await expect(waiting).resolves.toEqual(transcript);
  });

  it("lets the user go on without the transcript, which resolves waiters with null", async () => {
    const job = createTranscriptionJob(async () => { throw new Error("down"); }, () => undefined);
    const waiting = job.wait();
    await flush();
    job.skip();
    await expect(waiting).resolves.toBeNull();
    expect(job.state.status).toBe("skipped");
  });

  it("ignores skip while an attempt is still running", async () => {
    let finish!: (value: typeof transcript) => void;
    const job = createTranscriptionJob(() => new Promise((resolve) => { finish = resolve; }), () => undefined);
    job.skip();
    expect(job.state.status).toBe("transcribing");
    finish(transcript);
    await expect(job.wait()).resolves.toEqual(transcript);
  });
});
