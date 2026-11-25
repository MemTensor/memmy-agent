import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";
import { applyNarrative } from "../../../../src/tools/computer-history/mac/summary-writer.js";
import { instantId, sixHourWindowStart } from "../../../../src/tools/computer-history/mac/rollup.js";

const roots: string[] = [];
const instances: ComputerHistoryDemoService[] = [];
const segmentId = "2026-09-13T02-10-00Z";
const historyId = `${segmentId}-10min-summary`;
const answer = (title: string) => ({
  title, description: `You completed ${title}.`, body: `## Memory summary\n\nYou completed ${title}.`,
});
const response = (title: string) => ({ content: JSON.stringify(answer(title)) });

function serviceAt(root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-history-regression-"))) {
  if (!roots.includes(root)) roots.push(root);
  const service = new ComputerHistoryDemoService({
    historyDirectory: path.join(root, "histories"),
    recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"),
    observationSettingsFile: path.join(root, "settings.json"),
  });
  instances.push(service);
  fs.mkdirSync(path.join(root, "histories"), { recursive: true });
  return { root, service };
}

function seed(root: string, id = segmentId, ready = true) {
  const directory = path.join(root, "recordings", "segments", id);
  fs.mkdirSync(directory, { recursive: true });
  const metadataFile = path.join(directory, "metadata.json");
  const eventsFile = path.join(directory, "events.jsonl");
  const historyFile = path.join(root, "histories", `${id}-10min-summary.md`);
  fs.writeFileSync(metadataFile, JSON.stringify({ startedAt: new Date().toISOString() }));
  fs.writeFileSync(eventsFile, [
    { recordType: "human_history_metadata", schemaVersion: 1, recordingId: id, title: "Review", createdAt: "2026-09-13T02:10:00Z", platform: "macOS", display: { width: 100, height: 100 }, captureText: false, captureSearchText: true, allowedApplications: [], captureScopeApplications: [] },
    { recordType: "human_event", sequence: 1, timestamp: "2026-09-13T02:10:01Z", eventType: "application_changed", application: { name: "Notes", bundleId: "com.apple.Notes" }, details: {} },
    { recordType: "human_event", sequence: 2, timestamp: "2026-09-13T02:19:59Z", eventType: "recording_stopped", application: {}, details: {} },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const mechanical = "---\ntitle: Review\nsource_type: captured\nsummary_state: pending\nstatus: completed\nexperience_version: 1\n---\n\n## Memory summary\n\nRecorded work.\n";
  fs.writeFileSync(historyFile, ready ? applyNarrative(mechanical, answer("Standing summary")) : mechanical);
  return { id, directory, metadataFile, eventsFile, historyFile, startedAt: "2026-09-13T02:10:00Z", child: null, output: "" };
}

function runtime(chat: () => Promise<{ content: string }>) {
  return (() => ({ model: "stub", provider: { chatWithRetry: chat } })) as unknown as Parameters<ComputerHistoryDemoService["setLlmRuntime"]>[0];
}

// Exercise the private timer/finalization entrypoints without opening an event tap.
function internal(service: ComputerHistoryDemoService) {
  return service as unknown as {
    llmRuntime: ReturnType<typeof runtime>;
    segment: ReturnType<typeof seed> | null;
    finalizeSegment(segment: ReturnType<typeof seed>): Promise<void>;
    writeLiveSummary(segment: ReturnType<typeof seed>): void;
    writeRollupFor(start: Date): string | null;
    writeSixHourRollup(id: string): void;
    writeSummaryWith(file: string, window: "10min" | "6h", events: string | null): Promise<boolean>;
  };
}

function deferred() {
  let resolve!: (value: { content: string }) => void;
  const promise = new Promise<{ content: string }>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const instance of instances.splice(0)) {
    internal(instance).segment = null;
    await instance.shutdown();
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("summary retries and atomic replacement", () => {
  function pending(root: string, minute: number) {
    const id = `2026-09-13T02-${String(minute).padStart(2, "0")}-00Z-10min-summary`;
    const file = path.join(root, "histories", `${id}.md`);
    fs.writeFileSync(file, `---\ntitle: Pending\nsource_type: captured\nsummary_state: pending\nstatus: completed\n---\n\n## Memory summary\n\nEVIDENCE_${minute}\n`);
    return file;
  }

  it.each(["", "malformed JSON"])("defers only the failed record (%j) and retries it before newly arriving work", async (content) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T03:30:00Z"));
    const { root, service } = serviceAt();
    const a = pending(root, 0);
    pending(root, 10);
    const order: string[] = [];
    const chat = vi.fn(async (...args: any[]) => {
      const user = args[0].messages[1].content;
      order.push(user.split("BEGIN UNTRUSTED OBSERVED ACTIVITY\n")[1].split("\nEND UNTRUSTED")[0]);
      return order.length === 1 ? { content } : response("Recovered");
    });
    service.setLlmRuntime(runtime(chat));
    expect(await service.backfillUnwrittenSummaries()).toBe(1);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(order[0]).toContain("EVIDENCE_0");
    expect(order[1]).toContain("EVIDENCE_10");
    expect(fs.readFileSync(a, "utf8")).toContain("summary_state: pending");
    pending(root, 20);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(order[2]).toContain("EVIDENCE_0");
    expect(order[3]).toContain("EVIDENCE_20");
    expect(chat).toHaveBeenCalledTimes(4);
  });

  it("counts failures against the five-attempt batch limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T03:30:00Z"));
    const { root, service } = serviceAt();
    for (const minute of [0, 5, 10, 15, 20, 25, 30]) pending(root, minute);
    const chat = vi.fn(async () => ({ content: "invalid request", finishReason: "error", errorStatusCode: 400 }));
    service.setLlmRuntime(runtime(chat));
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(chat).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(chat).toHaveBeenCalledTimes(5);
  });

  it("does not send model requests when attempts cannot be persisted", async () => {
    vi.useFakeTimers();
    const { root, service } = serviceAt();
    pending(root, 0);
    const rename = fs.renameSync.bind(fs);
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith(".summary-retries.json")) throw new Error("synthetic disk failure");
      return rename(from, to);
    });
    try {
      const chat = vi.fn(async () => response("Must not run"));
      service.setLlmRuntime(runtime(chat));
      expect(await service.backfillUnwrittenSummaries()).toBe(0);
      expect(chat).not.toHaveBeenCalled();
      expect(service.snapshot().observation.narrationError).toContain("synthetic disk failure");
    } finally { spy.mockRestore(); }
  });

  it("uses a global cooldown after three different records fail the same uncertain way", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T03:30:00Z"));
    const { root, service } = serviceAt();
    for (const minute of [0, 10, 20, 30]) pending(root, minute);
    const chat = vi.fn(async () => ({ content: "" }));
    service.setLlmRuntime(runtime(chat));
    await service.backfillUnwrittenSummaries();
    expect(chat).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(chat).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(chat).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(chat).toHaveBeenCalledTimes(4);
  });

  it("preserves shared cooldown on restart and allows only one recovery probe across live and backfill", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T03:30:00Z"));
    const { root, service } = serviceAt();
    pending(root, 0);
    const b = pending(root, 10);
    service.setLlmRuntime(runtime(async () => ({ content: "rate limited", finishReason: "error", errorStatusCode: 429 })), "byok", null, "stable-model");
    await service.backfillUnwrittenSummaries();
    await service.shutdown();
    const restarted = serviceAt(root).service;
    const probe = deferred();
    const chat = vi.fn().mockImplementationOnce(() => probe.promise).mockResolvedValue(response("Recovered"));
    restarted.setLlmRuntime(runtime(chat), "byok", null, "stable-model");
    expect(await restarted.backfillUnwrittenSummaries()).toBe(0);
    expect(chat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(chat).toHaveBeenCalledOnce();
    expect(await internal(restarted).writeSummaryWith(b, "10min", null)).toBe(false);
    expect(chat).toHaveBeenCalledOnce();
    probe.resolve(response("Probe recovered"));
    expect(await restarted.backfillUnwrittenSummaries()).toBe(2);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("keeps a stopped record stopped after restart and still processes newly arriving records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T03:30:00Z"));
    const { root, service } = serviceAt();
    const a = pending(root, 0);
    const chat = vi.fn(async () => ({ content: "bad input", finishReason: "error", errorStatusCode: 400 }));
    service.setLlmRuntime(runtime(chat), "byok", null, "stable-model");
    await service.backfillUnwrittenSummaries();
    for (const wait of [60_000, 120_000, 240_000, 300_000]) await vi.advanceTimersByTimeAsync(wait);
    expect(chat).toHaveBeenCalledTimes(5);
    await service.shutdown();
    const restarted = serviceAt(root).service;
    pending(root, 10);
    const recovered = vi.fn(async () => response("New record"));
    restarted.setLlmRuntime(runtime(recovered), "byok", null, "stable-model");
    expect(await restarted.backfillUnwrittenSummaries()).toBe(1);
    expect(recovered).toHaveBeenCalledOnce();
    expect(restarted.snapshot().observation.narrationError).toContain("stopped after 5");
    fs.appendFileSync(a, "\nCorrected evidence.\n");
    expect(await restarted.backfillUnwrittenSummaries()).toBe(1);
    expect(recovered).toHaveBeenCalledTimes(2);
    expect(restarted.snapshot().observation.narrationError).toBeNull();
  });

  it("limits each background batch and resumes the remaining backlog on the next tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T03:30:00Z"));
    const { root, service } = serviceAt();
    for (let minute = 0; minute < 60; minute += 10) {
      seed(root, `2026-09-13T02-${String(minute).padStart(2, "0")}-00Z`, false);
    }
    const chat = vi.fn(async () => response("Recovered"));
    service.setLlmRuntime(runtime(chat));
    expect(await service.backfillUnwrittenSummaries()).toBe(5);
    expect(chat).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(chat).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(chat).toHaveBeenCalledTimes(6);
    expect(service.snapshot().histories.filter((entry) => entry.summaryStatus === "pending")).toHaveLength(0);
  });

  it.each([
    { content: "429 rate limit", finishReason: "error", errorStatusCode: 429 },
    { content: "history_summary_budget_unavailable", finishReason: "error", errorKind: "history_summary_budget" },
  ])("pauses the whole backlog and live summaries after %j", async (failure) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T03:30:00Z"));
    const { root, service } = serviceAt();
    seed(root, segmentId, false);
    const next = seed(root, "2026-09-13T02-20-00Z", false);
    const chat = vi.fn().mockResolvedValueOnce(failure).mockResolvedValue(response("Recovered"));
    service.setLlmRuntime(runtime(chat));
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(chat).toHaveBeenCalledOnce();
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(await internal(service).writeSummaryWith(next.historyFile, "10min", next.eventsFile)).toBe(false);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(chat).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(chat).toHaveBeenCalledTimes(3);
    expect(service.snapshot().observation.narrationError).toBeNull();
  });

  it("shares the batch limit between ten-minute summaries and six-hour rollups", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T03:30:00Z"));
    const { root, service } = serviceAt();
    for (const hour of ["02", "08"]) {
      for (const minute of ["10", "20"]) seed(root, `2026-09-13T${hour}-${minute}-00Z`, false);
    }
    const chat = vi.fn(async () => response("Recovered"));
    service.setLlmRuntime(runtime(chat));
    expect(await service.backfillUnwrittenSummaries()).toBe(5);
    expect(chat).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(chat).toHaveBeenCalledTimes(6);
    expect(service.snapshot().histories.filter((entry) => entry.summaryWindow === "6h")).toHaveLength(2);
  });

  it("resumes after a failed window so one malformed response cannot starve later work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T03:30:00Z"));
    const { root, service } = serviceAt();
    seed(root, segmentId, false);
    const nextId = "2026-09-13T02-20-00Z";
    seed(root, nextId, false);
    const chat = vi.fn().mockResolvedValueOnce({ content: "malformed JSON" })
      .mockResolvedValueOnce(response("Later window"))
      .mockResolvedValue({ content: "malformed JSON" });
    service.setLlmRuntime(runtime(chat));
    await service.backfillUnwrittenSummaries();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.snapshot().histories.find((entry) => entry.id === `${nextId}-10min-summary`)?.title).toBe("Later window");
    expect(service.snapshot().histories.find((entry) => entry.id === historyId)?.summaryStatus).toBe("pending");
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it("backs off one record, stops after five attempts, and resumes after an explicit model change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T03:30:00Z"));
    const { root, service } = serviceAt();
    seed(root, segmentId, false);
    const chat = vi.fn<() => Promise<{ content: string }>>(async () => { throw new Error("offline"); });
    service.setLlmRuntime(runtime(chat));
    await service.backfillUnwrittenSummaries();
    let calls = 1;
    for (const delay of [60_000, 120_000, 240_000, 300_000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(chat).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(chat).toHaveBeenCalledTimes(++calls);
    }
    await vi.advanceTimersByTimeAsync(600_000);
    expect(chat).toHaveBeenCalledTimes(5);
    expect(service.snapshot().observation.narrationError).toContain("stopped after 5");
    chat.mockImplementation(async () => response("Recovered"));
    service.setLlmRuntime(runtime(chat));
    await service.backfillUnwrittenSummaries();
    expect(service.snapshot().observation.narrationError).toBeNull();
    seed(root, "2026-09-13T02-20-00Z", false);
    chat.mockImplementation(async () => { throw new Error("offline again"); });
    await vi.advanceTimersByTimeAsync(60_000);
    const failedCalls = chat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(chat).toHaveBeenCalledTimes(failedCalls);
    await vi.advanceTimersByTimeAsync(1);
    expect(chat).toHaveBeenCalledTimes(failedCalls + 1);
  });

  it("cancels background retries when the summary runtime is removed", async () => {
    vi.useFakeTimers();
    const { root, service } = serviceAt();
    seed(root, segmentId, false);
    const chat = vi.fn(async () => { throw new Error("offline"); });
    service.setLlmRuntime(runtime(chat));
    await service.backfillUnwrittenSummaries();
    service.setLlmRuntime(null);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(chat).toHaveBeenCalledOnce();
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
  });

  it("keeps a clear unavailable-model error and rejects an old in-flight result", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root, segmentId, false);
    const pending = deferred();
    const chat = vi.fn(() => pending.promise);
    service.setLlmRuntime(runtime(chat), "account");
    await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const reason = "Computer History summary model is unavailable. Configure a Memory summary model in Memmy settings.";
    service.setLlmRuntime(null, null, reason);
    expect(await internal(service).writeSummaryWith(segment.historyFile, "10min", segment.eventsFile)).toBe(false);
    expect(service.snapshot().observation).toMatchObject({ modelSource: null, narrationError: reason });
    pending.resolve(response("Old account summary"));
    await pending.promise;
    await Promise.resolve();
    expect(service.snapshot().histories.some((entry) => entry.title === "Old account summary")).toBe(false);
    expect(chat).toHaveBeenCalledOnce();
  });

  it("immediately retries the active segment with BYOK while the old account request is pending", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root, segmentId, false);
    internal(service).segment = segment;
    (service as unknown as { observationState: string }).observationState = "running";
    fs.appendFileSync(segment.eventsFile, " ".repeat(4_100));
    const account = deferred();
    internal(service).llmRuntime = runtime(() => account.promise);
    internal(service).writeLiveSummary(segment);
    const byok = vi.fn(async () => response("Fresh BYOK activity"));
    service.setLlmRuntime(runtime(byok), "byok");
    await vi.waitFor(() => expect(service.snapshot().histories[0]?.title).toBe("Fresh BYOK activity"));
    expect(service.snapshot().observation.state).toBe("running");
    account.resolve({ content: "agent_chat tokens exhausted", errorCategory: "quota_exhausted" } as any);
    await account.promise;
    await Promise.resolve();
    expect(service.snapshot().observation.narrationErrorCategory).toBeNull();
  });

  it("switches a pending account summary to BYOK without waiting for the old model", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root);
    const oldModel = deferred();
    internal(service).llmRuntime = runtime(() => oldModel.promise);
    const oldRequest = internal(service).finalizeSegment(segment);
    const byok = vi.fn(async () => response("BYOK recovered"));
    service.setLlmRuntime(runtime(byok), "byok");
    await service.backfillUnwrittenSummaries();
    expect(byok).toHaveBeenCalled();
    expect(service.snapshot().observation).toMatchObject({ modelSource: "byok", narrationError: null });
    expect(service.snapshot().histories.some((entry) => entry.title === "BYOK recovered")).toBe(true);
    oldModel.resolve({ content: "Account quota exhausted", errorCategory: "quota_exhausted" } as any);
    await oldRequest;
    expect(service.snapshot().observation.narrationErrorCategory).toBeNull();
    expect(service.snapshot().histories.some((entry) => entry.title === "BYOK recovered")).toBe(true);
  });

  it("exposes BYOK quota exhaustion and clears it when the same provider recovers", async () => {
    vi.useFakeTimers();
    const { root, service } = serviceAt();
    const segment = seed(root);
    let exhausted = true;
    internal(service).llmRuntime = runtime(async () => exhausted
      ? { content: "Insufficient balance", finishReason: "error", errorCategory: "quota_exhausted" }
      : response("Recovered summary"));
    await internal(service).finalizeSegment(segment);
    expect(service.snapshot().observation).toMatchObject({ narrationErrorCategory: "quota_exhausted" });
    expect(service.snapshot().histories[0].title).toBe("Standing summary");
    exhausted = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await service.backfillUnwrittenSummaries();
    expect(service.snapshot().observation).toMatchObject({ narrationError: null, narrationErrorCategory: null });
    expect(service.snapshot().histories.some((entry) => entry.title === "Recovered summary")).toBe(true);
  });

  it("clears the previous provider's quota warning when model configuration changes", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root);
    internal(service).llmRuntime = runtime(async () => ({ content: "Insufficient balance", errorCategory: "quota_exhausted" }));
    await internal(service).finalizeSegment(segment);
    expect(service.snapshot().observation.narrationErrorCategory).toBe("quota_exhausted");
    service.setLlmRuntime(null);
    expect(service.snapshot().observation.narrationErrorCategory).toBeNull();
  });

  it("retries a failed pass with the recovered model in the same process", async () => {
    const { root, service } = serviceAt();
    seed(root, segmentId, false);
    service.setLlmRuntime(runtime(async () => { throw new Error("temporary outage"); }));
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(service.snapshot().histories).toMatchObject([{ id: historyId, summaryStatus: "pending" }]);
    const recovered = vi.fn(async () => response("Recovered"));
    service.setLlmRuntime(runtime(recovered));
    await service.backfillUnwrittenSummaries();
    expect(recovered).toHaveBeenCalled();
    expect(service.snapshot().histories.find((entry) => entry.id === historyId)?.title).toBe("Recovered");
  });

  it("periodically retries failed summaries even after recording has stopped", async () => {
    vi.useFakeTimers();
    const { root, service } = serviceAt();
    seed(root, segmentId, false);
    let available = false;
    service.setLlmRuntime(runtime(async () => {
      if (!available) throw new Error("offline");
      return response("Back online");
    }));
    await service.backfillUnwrittenSummaries();
    expect(service.snapshot().observation.state).toBe("stopped");
    available = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(service.snapshot().histories.find((entry) => entry.id === historyId)?.title).toBe("Back online");
  });

  it("keeps a failed replacement and recovers it after a service restart", async () => {
    vi.useFakeTimers();
    const { root, service } = serviceAt();
    const segment = seed(root);
    internal(service).llmRuntime = runtime(async () => { throw new Error("offline"); });
    await internal(service).finalizeSegment(segment);
    expect(service.snapshot().histories[0].title).toBe("Standing summary");
    expect(fs.existsSync(`${segment.historyFile}.staging`)).toBe(true);
    await service.shutdown();
    const restarted = serviceAt(root).service;
    restarted.setLlmRuntime(runtime(async () => response("Full final account")));
    expect(await restarted.backfillUnwrittenSummaries()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(restarted.snapshot().histories.find((entry) => entry.id === historyId)?.title).toBe("Full final account");
    expect(fs.existsSync(`${segment.historyFile}.staging`)).toBe(false);
  });

  it("does not let an earlier live response overwrite the finalized account", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root, segmentId, false);
    const live = deferred();
    const final = deferred();
    let calls = 0;
    internal(service).llmRuntime = runtime(() => ++calls === 1 ? live.promise : calls === 2 ? final.promise : Promise.resolve(response("Rollup")));
    const liveJob = internal(service).writeSummaryWith(segment.historyFile, "10min", segment.eventsFile);
    const finalJob = internal(service).finalizeSegment(segment);
    final.resolve(response("Final version"));
    await finalJob;
    live.resolve(response("Old live version"));
    expect(await liveJob).toBe(false);
    expect(service.snapshot().histories.find((entry) => entry.id === historyId)?.title).toBe("Final version");
  });

  it("retries live narration with unchanged events after a failure", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root, segmentId, false);
    internal(service).segment = segment;
    fs.appendFileSync(segment.eventsFile, " ".repeat(4_100));
    internal(service).llmRuntime = runtime(async () => { throw new Error("offline"); });
    internal(service).writeLiveSummary(segment);
    await vi.waitFor(() => expect(service.snapshot().observation.narrationError).toBe("offline"));
    service.setLlmRuntime(runtime(async () => response("Live recovery")));
    internal(service).writeLiveSummary(segment);
    await vi.waitFor(() => expect(service.snapshot().histories.find((entry) => entry.id === historyId)?.title).toBe("Live recovery"));
  });

  it("preserves the standing rollup on failure and commits the retry atomically", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root);
    const first = internal(service).writeRollupFor(sixHourWindowStart(new Date(segment.startedAt)))!;
    fs.writeFileSync(first, applyNarrative(fs.readFileSync(first, "utf8"), answer("Old rollup")));
    seed(root, "2026-09-13T02-20-00Z");
    internal(service).llmRuntime = runtime(async () => { throw new Error("offline"); });
    internal(service).writeSixHourRollup(segment.id);
    await vi.waitFor(() => expect(service.snapshot().observation.narrationError).toBe("offline"));
    expect(service.snapshot().histories.find((entry) => entry.summaryWindow === "6h")?.title).toBe("Old rollup");
    expect(fs.existsSync(`${first}.staging`)).toBe(true);
    service.setLlmRuntime(runtime(async () => response("Updated rollup")));
    await service.backfillUnwrittenSummaries();
    const updated = service.snapshot().histories.find((entry) => entry.summaryWindow === "6h");
    expect(updated?.title).toBe("Updated rollup");
    expect(updated?.coveredHistoryIds).toEqual([historyId, "2026-09-13T02-20-00Z-10min-summary"]);
    expect(fs.existsSync(`${first}.staging`)).toBe(false);
  });

  it("coalesces recovered segments into one model request per six-hour window", async () => {
    const { root, service } = serviceAt();
    for (const id of [segmentId, "2026-09-13T02-20-00Z", "2026-09-13T02-30-00Z"]) seed(root, id, false);
    const model = vi.fn(async () => response("Recovered account"));
    internal(service).llmRuntime = runtime(model);
    await service.backfillUnwrittenSummaries();
    expect(model).toHaveBeenCalledTimes(4); // Three segments, then one rollup.
    expect(service.snapshot().histories.find((entry) => entry.summaryWindow === "6h")?.coveredHistoryIds).toHaveLength(3);
  });

  it("invalidates an old-window staging request while realigning rollups", async () => {
    const { root, service } = serviceAt();
    const morning = new Date(2026, 8, 13, 9, 10);
    seed(root, instantId(morning));
    const oldId = `${instantId(new Date(2026, 8, 13, 2))}-6h-summary`;
    const file = path.join(root, "histories", `${oldId}.md`);
    const markdown = "---\ntitle: Old window\nsource_type: rollup\nsummary_state: pending\n---\n\n## Memory summary\n\nOld data.\n";
    // The old implementation could already have removed the canonical file
    // before a restart. An orphan staging file must be realigned as well.
    fs.writeFileSync(`${file}.staging`, markdown);
    const model = deferred();
    internal(service).llmRuntime = runtime(() => model.promise);
    const pending = internal(service).writeSummaryWith(`${file}.staging`, "6h", null);
    expect(service.realignRollups()).toBe(1);
    model.resolve(response("Obsolete window"));
    expect(await pending).toBe(false);
    await service.backfillUnwrittenSummaries();
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.staging`)).toBe(false);
    expect(service.snapshot().histories.some((entry) => entry.id === oldId)).toBe(false);
  });
});

describe("deletion and complete collection clearing", () => {
  it("cancels a pending finalization so deleted history and rollups cannot return", async () => {
    const { root, service } = serviceAt();
    const segment = seed(root);
    const model = deferred();
    internal(service).llmRuntime = runtime(() => model.promise);
    const pending = internal(service).finalizeSegment(segment);
    service.deleteHistory(historyId);
    model.resolve(response("Deleted work"));
    await pending;
    expect(service.snapshot().histories).toHaveLength(0);
    expect(fs.existsSync(segment.directory)).toBe(false);
    // Memory sync may retain deletion receipts in the history directory.
    expect(fs.readdirSync(path.join(root, "histories")).filter(name => /\.md(?:\.staging)?$/u.test(name))).toEqual([]);
  });

  it("deletes pending summaries and removes rollups containing deleted evidence", () => {
    const { root, service } = serviceAt();
    const segment = seed(root);
    const rollup = internal(service).writeRollupFor(sixHourWindowStart(new Date(segment.startedAt)))!;
    fs.writeFileSync(rollup, applyNarrative(fs.readFileSync(rollup, "utf8"), answer("Contains deleted evidence")));
    seed(root, segmentId, false);
    service.deleteHistory(historyId);
    expect(fs.existsSync(rollup)).toBe(false);
    expect(service.snapshot().histories).toHaveLength(0);
  });

  it("clear all includes invisible, staged, raw-only records and the active segment", async () => {
    const { root, service } = serviceAt();
    const staged = seed(root);
    const model = deferred();
    internal(service).llmRuntime = runtime(() => model.promise);
    const pending = internal(service).finalizeSegment(staged);
    const invisible = seed(root, "2026-09-13T02-20-00Z", false);
    const rawOnly = seed(root, "2026-09-13T02-30-00Z", false);
    fs.rmSync(rawOnly.historyFile);
    const active = seed(root, "2026-09-13T02-40-00Z", false);
    internal(service).segment = active;
    const result = await service.clearHistories("all");
    expect(result.histories).toHaveLength(0);
    expect(fs.existsSync(active.eventsFile)).toBe(false);
    expect(fs.existsSync(active.historyFile)).toBe(false);
    for (const segment of [staged, invisible, rawOnly]) {
      expect(fs.existsSync(segment.directory)).toBe(false);
      expect(fs.existsSync(segment.historyFile)).toBe(false);
    }
    model.resolve(response("Must not return"));
    await pending;
    expect(fs.readdirSync(path.join(root, "histories")).filter(name => /\.md(?:\.staging)?$/u.test(name))).toEqual([]);
  });

  it("clear today retains previous days while deleting pending records for today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 13, 15));
    const { root, service } = serviceAt();
    const today = seed(root, instantId(new Date(2026, 8, 13, 10)), false);
    const yesterday = seed(root, instantId(new Date(2026, 8, 12, 10)), false);
    await service.clearHistories("today");
    expect(fs.existsSync(today.eventsFile)).toBe(false);
    expect(fs.existsSync(yesterday.eventsFile)).toBe(true);
    expect(fs.existsSync(yesterday.historyFile)).toBe(true);
  });
});
