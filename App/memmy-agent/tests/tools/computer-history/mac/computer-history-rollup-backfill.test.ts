import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";
import { instantId } from "../../../../src/tools/computer-history/mac/rollup.js";

let root: string;
const services: ComputerHistoryDemoService[] = [];
const start = new Date(2026, 8, 11, 6);
const rollupId = `${instantId(start)}-6h-summary`;
const historyFile = (id: string) => path.join(root, "histories", `${id}.md`);
const response = (title = "Collected reviews") => ({ content: JSON.stringify({
  title, description: "You completed the reviews.", body: "## Memory summary\n\nYou completed the reviews.",
}) });
const runtime = (chat: (...args: any[]) => Promise<{ content: string }>) =>
  (() => ({ model: "stub", provider: { chatWithRetry: chat } })) as unknown as Parameters<ComputerHistoryDemoService["setLlmRuntime"]>[0];

function serviceAt() {
  const service = new ComputerHistoryDemoService({
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
  });
  services.push(service);
  return service;
}

function seed(minute: number, extra = "", at = start): string {
  const id = `${instantId(new Date(at.getTime() + minute * 60_000))}-10min-summary`;
  const markdown = `---\ntitle: Review ${minute}\nsource_type: captured\nsummary_state: ready\nstatus: completed\n---\n\n## Memory summary\n\nReview ${minute}. ${extra}\n`;
  fs.writeFileSync(historyFile(id), markdown);
  return id;
}

function legacy(id: string, cited: string[]) {
  const markdown = `---\ntitle: Standing account\nsource_type: rollup\nsummary_state: ready\n---\n\n## Memory summary\n\nThe original written account must survive.\n\n## Citations\n\n${cited.map((source) => `- ${source}.md`).join("\n")}\n`;
  fs.writeFileSync(historyFile(id), markdown);
  return markdown;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "history-rollup-backfill-"));
  fs.mkdirSync(path.join(root, "histories"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("repairing historical six-hour aggregation", () => {
  it("waits for the six-hour window to close before preparing or narrating its final rollup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(start.getTime() + 6 * 60 * 60_000 - 1));
    const id = seed(10);
    const model = vi.fn(async () => response());
    const service = serviceAt();
    service.setLlmRuntime(runtime(model));

    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(model).not.toHaveBeenCalled();
    expect(fs.existsSync(historyFile(rollupId))).toBe(false);
    expect(service.snapshot().histories.map((entry) => entry.id)).toEqual([id]);

    vi.setSystemTime(new Date(start.getTime() + 6 * 60 * 60_000));
    expect(await service.backfillUnwrittenSummaries()).toBe(1);
    expect(model).toHaveBeenCalledTimes(1);
    expect(service.snapshot().histories.find((entry) => entry.id === rollupId)?.coveredHistoryIds).toEqual([id]);
  });

  it("hides a partial rollup left by an older version until its window closes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(start.getTime() + 60 * 60_000));
    const id = seed(10);
    legacy(rollupId, [id]);
    const service = serviceAt();

    expect(service.snapshot().histories.map((entry) => entry.id)).toEqual([id]);
    vi.setSystemTime(new Date(start.getTime() + 6 * 60 * 60_000));
    expect(service.snapshot().histories.map((entry) => entry.id)).toContain(rollupId);
  });

  it("waits for every ten-minute source before making the closed-window model call", async () => {
    const first = seed(10);
    const second = seed(20);
    fs.writeFileSync(historyFile(second), fs.readFileSync(historyFile(second), "utf8")
      .replace("summary_state: ready", "summary_state: pending"));
    let resolveSource!: (value: { content: string }) => void;
    const sourceNarration = new Promise<{ content: string }>((resolve) => { resolveSource = resolve; });
    const model = vi.fn(async () => model.mock.calls.length === 1 ? sourceNarration : response("Final window"));
    const service = serviceAt();
    service.setLlmRuntime(runtime(model));

    await vi.waitFor(() => expect(model).toHaveBeenCalledTimes(1));
    expect(fs.existsSync(historyFile(rollupId))).toBe(false);
    resolveSource(response("Recovered source"));
    expect(await service.backfillUnwrittenSummaries()).toBe(2);
    expect(model).toHaveBeenCalledTimes(2);
    expect(service.snapshot().histories.find((entry) => entry.id === rollupId)?.coveredHistoryIds)
      .toEqual([first, second]);
  });

  it("backfills missing rollups from already-ready captures without renarrating them or churning on restart", async () => {
    const ids = [seed(10), seed(20), seed(30)];
    const original = ids.map((id) => fs.readFileSync(historyFile(id), "utf8"));
    const model = vi.fn(async () => response());
    const service = serviceAt();
    service.setLlmRuntime(runtime(model));
    expect(await service.backfillUnwrittenSummaries()).toBe(1);
    expect(model).toHaveBeenCalledTimes(1);
    expect(service.snapshot().histories.find((entry) => entry.id === rollupId)?.coveredHistoryIds).toEqual(ids);
    expect(ids.map((id) => fs.readFileSync(historyFile(id), "utf8"))).toEqual(original);
    const completed = fs.readFileSync(historyFile(rollupId), "utf8");
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    await service.shutdown();
    const restarted = serviceAt();
    restarted.setLlmRuntime(runtime(model));
    expect(await restarted.backfillUnwrittenSummaries()).toBe(0);
    expect(model).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(historyFile(rollupId), "utf8")).toBe(completed);
  });

  it("repairs stale membership while retaining the ready legacy account until a retry succeeds", async () => {
    const first = seed(10);
    const original = legacy(rollupId, [first]);
    const second = seed(20, "A later review not cited by the old rollup.");
    const service = serviceAt();
    service.setLlmRuntime(runtime(async () => { throw new Error("offline"); }));
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(fs.readFileSync(historyFile(rollupId), "utf8")).toBe(original);
    expect(service.snapshot().histories.find((entry) => entry.id === rollupId)?.coveredHistoryIds).toEqual([first]);
    expect(fs.existsSync(`${historyFile(rollupId)}.staging`)).toBe(true);
    await service.shutdown();
    const model = vi.fn(async () => response("Full account"));
    const restarted = serviceAt();
    restarted.setLlmRuntime(runtime(model));
    expect(await restarted.backfillUnwrittenSummaries()).toBe(1);
    expect(restarted.snapshot().histories.find((entry) => entry.id === rollupId)).toMatchObject({
      title: "Full account", coveredHistoryIds: [first, second],
    });
    expect(fs.existsSync(`${historyFile(rollupId)}.staging`)).toBe(false);
    expect(await restarted.backfillUnwrittenSummaries()).toBe(0);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("detects changed source prose even when coverage ids stay the same", async () => {
    const id = seed(10, "Original decision.");
    const model = vi.fn(async () => response());
    const service = serviceAt();
    service.setLlmRuntime(runtime(model));
    await service.backfillUnwrittenSummaries();
    seed(10, "UPDATED_DECISION_RELEASE_218");
    expect(await service.backfillUnwrittenSummaries()).toBe(1);
    expect(model).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(model.mock.calls[1])).toContain("UPDATED_DECISION_RELEASE_218");
    expect(service.snapshot().histories.find((entry) => entry.id === rollupId)?.coveredHistoryIds).toEqual([id]);
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("repairs explicit empty coverage even when a standing input hash matches", async () => {
    const id = seed(10);
    const service = serviceAt();
    const model = vi.fn(async () => response());
    service.setLlmRuntime(runtime(model));
    await service.backfillUnwrittenSummaries();
    const file = historyFile(rollupId);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^covered_history_ids:.*$/mu, "covered_history_ids: []"));
    expect(service.snapshot().histories.find((entry) => entry.id === rollupId)?.coveredHistoryIds).toEqual([]);
    expect(await service.backfillUnwrittenSummaries()).toBe(1);
    expect(model).toHaveBeenCalledTimes(2);
    expect(service.snapshot().histories.find((entry) => entry.id === rollupId)?.coveredHistoryIds).toEqual([id]);
  });

  it("does not resurrect a user-deleted rollup during periodic repair or after restart", async () => {
    const id = seed(10);
    const service = serviceAt();
    const model = vi.fn(async () => response());
    service.setLlmRuntime(runtime(model));
    await service.backfillUnwrittenSummaries();
    service.deleteHistory(rollupId);
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    await service.shutdown();
    const restarted = serviceAt();
    restarted.setLlmRuntime(runtime(model));
    expect(await restarted.backfillUnwrittenSummaries()).toBe(0);
    expect(restarted.snapshot().histories.map((entry) => entry.id)).toEqual([id]);
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("discards an obsolete queued replacement when the standing rollup already matches all sources", async () => {
    const first = seed(10);
    seed(20);
    const service = serviceAt();
    const model = vi.fn(async () => response());
    service.setLlmRuntime(runtime(model));
    await service.backfillUnwrittenSummaries();
    const file = historyFile(rollupId);
    const standing = fs.readFileSync(file, "utf8");
    const old = standing.replace(/^summary_input_hash:.*$/mu, "summary_input_hash: stale")
      .replace(/^covered_history_ids:.*$/mu, `covered_history_ids: ${JSON.stringify([first])}`)
      .replace("summary_state: ready", "summary_state: pending");
    fs.writeFileSync(`${file}.staging`, old);
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(model).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(`${file}.staging`)).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(standing);

    // The same invalidation also prevents a replacement already at the model
    // from committing after a concurrent reconciliation finds current prose.
    fs.writeFileSync(`${file}.staging`, old);
    let resolve!: (value: { content: string }) => void;
    const pending = new Promise<{ content: string }>((done) => { resolve = done; });
    const internal = service as unknown as {
      llmRuntime: ReturnType<typeof runtime>;
      writeSummaryWith(file: string, window: "6h", events: null): Promise<boolean>;
    };
    internal.llmRuntime = runtime(() => pending);
    const writing = internal.writeSummaryWith(`${file}.staging`, "6h", null);
    service.realignRollups();
    resolve(response("Obsolete replacement"));
    expect(await writing).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(standing);
    expect(fs.existsSync(`${file}.staging`)).toBe(false);
  });

  it("rebuilds from surviving sources after deleting a ten-minute entry, without retaining deleted evidence", async () => {
    const first = seed(10, "DELETED_SOURCE_EVIDENCE");
    const second = seed(20, "SURVIVING_SOURCE_EVIDENCE");
    const service = serviceAt();
    const model = vi.fn(async () => response());
    service.setLlmRuntime(runtime(model));
    await service.backfillUnwrittenSummaries();
    service.deleteHistory(first);
    expect(fs.existsSync(historyFile(rollupId))).toBe(false);
    expect(await service.backfillUnwrittenSummaries()).toBe(1);
    const replacement = service.snapshot().histories.find((entry) => entry.id === rollupId)!;
    expect(replacement.coveredHistoryIds).toEqual([second]);
    expect(JSON.stringify(model.mock.calls[1])).not.toContain("DELETED_SOURCE_EVIDENCE");
    expect(JSON.stringify(model.mock.calls[1])).toContain("SURVIVING_SOURCE_EVIDENCE");
    service.clearHistories("all");
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(service.snapshot().histories).toHaveLength(0);
  });

  it("keeps old aligned accounts when their sources are unavailable and cannot be rebuilt", async () => {
    const original = legacy(rollupId, []);
    const service = serviceAt();
    const model = vi.fn(async () => response());
    service.setLlmRuntime(runtime(model));
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(fs.readFileSync(historyFile(rollupId), "utf8")).toBe(original);
    expect(model).not.toHaveBeenCalled();
  });

  it("preserves a legacy account with partially missing sources and rebuilds only when all sources return", async () => {
    const first = seed(10);
    const second = seed(20, "B_UNIQUE_INFORMATION");
    const original = legacy(rollupId, [first, second]);
    const secondMarkdown = fs.readFileSync(historyFile(second), "utf8");
    fs.rmSync(historyFile(second));
    const partial = original.replace(`- ${second}.md\n`, "").replace("summary_state: ready", "summary_state: pending");
    fs.writeFileSync(`${historyFile(rollupId)}.staging`, partial);
    const service = serviceAt();
    const model = vi.fn(async () => response("Restored complete account"));
    service.setLlmRuntime(runtime(model));
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(model).not.toHaveBeenCalled();
    expect(fs.readFileSync(historyFile(rollupId), "utf8")).toBe(original);
    expect(service.snapshot().histories.find((entry) => entry.id === rollupId)?.coveredHistoryIds).toEqual([first, second]);
    expect(fs.existsSync(`${historyFile(rollupId)}.staging`)).toBe(false);
    fs.writeFileSync(historyFile(second), secondMarkdown);
    expect(await service.backfillUnwrittenSummaries()).toBe(1);
    expect(model).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model.mock.calls)).toContain("B_UNIQUE_INFORMATION");
    expect(service.snapshot().histories.find((entry) => entry.id === rollupId)).toMatchObject({
      title: "Restored complete account", coveredHistoryIds: [first, second],
    });
  });

  it("rejects an incomplete queued staging account even when no source window can be rebuilt", async () => {
    const first = seed(10);
    const second = seed(20);
    const original = legacy(rollupId, [first, second]);
    fs.rmSync(historyFile(first));
    fs.rmSync(historyFile(second));
    fs.writeFileSync(`${historyFile(rollupId)}.staging`, original
      .replace(`- ${second}.md\n`, "").replace("summary_state: ready", "summary_state: pending"));
    const service = serviceAt();
    const model = vi.fn(async () => response("Incomplete account"));
    service.setLlmRuntime(runtime(model));
    expect(await service.backfillUnwrittenSummaries()).toBe(0);
    expect(model).not.toHaveBeenCalled();
    expect(fs.readFileSync(historyFile(rollupId), "utf8")).toBe(original);
    expect(fs.existsSync(`${historyFile(rollupId)}.staging`)).toBe(false);
    expect(service.snapshot().histories.find((entry) => entry.id === rollupId)?.coveredHistoryIds).toEqual([first, second]);
  });

  it("rechecks coverage immediately before a narrated staging account commits", async () => {
    const first = seed(10);
    const second = seed(20);
    const initial = legacy(rollupId, [first]);
    const file = historyFile(rollupId);
    fs.writeFileSync(`${file}.staging`, initial.replace("summary_state: ready", "summary_state: pending"));
    let resolve!: (value: { content: string }) => void;
    const result = new Promise<{ content: string }>((done) => { resolve = done; });
    const model = vi.fn(() => result);
    const service = serviceAt();
    const internal = service as unknown as {
      llmRuntime: ReturnType<typeof runtime>;
      writeSummaryWith(file: string, window: "6h", events: null): Promise<boolean>;
    };
    internal.llmRuntime = runtime(model);
    const writing = internal.writeSummaryWith(`${file}.staging`, "6h", null);
    expect(model).toHaveBeenCalledTimes(1);
    const fuller = legacy(rollupId, [first, second]);
    resolve(response("Older partial model response"));
    expect(await writing).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(fuller);
    expect(fs.existsSync(`${file}.staging`)).toBe(false);
  });

  it("removes a misaligned ready account only after its exact sources have ready replacements", async () => {
    const at = new Date(2026, 8, 11, 3);
    const id = seed(0, "Original source", at);
    const oldId = `${instantId(new Date(2026, 8, 11, 2))}-6h-summary`;
    const original = legacy(oldId, [id]);
    const unknownId = `${instantId(new Date(2026, 8, 11, 14))}-6h-summary`;
    const unknown = legacy(unknownId, []);
    const service = serviceAt();
    service.setLlmRuntime(runtime(async () => { throw new Error("offline"); }));
    await service.backfillUnwrittenSummaries();
    expect(fs.readFileSync(historyFile(oldId), "utf8")).toBe(original);
    service.setLlmRuntime(runtime(async () => response("Aligned replacement")));
    expect(await service.backfillUnwrittenSummaries()).toBe(1);
    expect(fs.existsSync(historyFile(oldId))).toBe(false);
    expect(fs.readFileSync(historyFile(unknownId), "utf8")).toBe(unknown);
    expect(service.snapshot().histories.find((entry) => entry.title === "Aligned replacement")?.coveredHistoryIds).toEqual([id]);
  });
});
