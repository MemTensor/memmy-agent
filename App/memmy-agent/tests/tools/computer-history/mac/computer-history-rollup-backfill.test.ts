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
function evidence(service: ComputerHistoryDemoService) {
  return (service as unknown as { memoryEvidence(): Array<{ id: string; content: string; parentSourceRecordIds: string[] }> }).memoryEvidence();
}
function serviceAt() {
  const service = new ComputerHistoryDemoService({
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
    weChatConsentFile: path.join(root, "wechat", "consent.json"),
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

describe("preparing evidence for six-hour L1 aggregation", () => {
  it("submits a closed local window with exact parent IDs and leaves its inputs stable on restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(start.getTime() + 6 * 60 * 60_000 - 1));
    const first = seed(10), second = seed(20);
    fs.writeFileSync(historyFile(second), fs.readFileSync(historyFile(second), "utf8").replace("summary_state: ready", "summary_state: pending"));
    const service = serviceAt();
    expect(evidence(service).map((entry) => entry.id)).toEqual([first, second]);
    expect(fs.existsSync(historyFile(rollupId))).toBe(false);
    vi.setSystemTime(new Date(start.getTime() + 6 * 60 * 60_000));
    expect(evidence(service).at(-1)).toMatchObject({ id: rollupId, parentSourceRecordIds: [first, second] });
    const modified = fs.statSync(historyFile(rollupId)).mtimeMs;
    await service.shutdown();
    const next = serviceAt();
    expect(evidence(next)).toHaveLength(3);
    expect(fs.statSync(historyFile(rollupId)).mtimeMs).toBe(modified);
    next.deleteHistory(rollupId);
    expect(evidence(next).map((entry) => entry.id)).toEqual([first, second]);
  });

  it("preserves the only rollup covering missing sources and repairs its membership when they return", () => {
    const a = seed(10), b = seed(20);
    const original = legacy(rollupId, [a, b]);
    const partial = legacy(rollupId, [a]);
    fs.writeFileSync(historyFile(rollupId), original);
    fs.writeFileSync(historyFile(rollupId) + ".staging", partial);
    fs.rmSync(historyFile(b));
    const service = serviceAt();
    evidence(service);
    expect(fs.readFileSync(historyFile(rollupId), "utf8")).toBe(original);
    expect(fs.existsSync(historyFile(rollupId) + ".staging")).toBe(false);
    seed(20, "Restored source");
    const c = seed(30);
    expect(evidence(service).at(-1)?.parentSourceRecordIds).toEqual([a, b, c]);
    expect(fs.readFileSync(historyFile(rollupId), "utf8")).toContain("Restored source");
    seed(20, "Updated source");
    evidence(service);
    expect(fs.readFileSync(historyFile(rollupId), "utf8")).toContain("Updated source");
    service.deleteHistory(b);
    expect(evidence(service).at(-1)?.parentSourceRecordIds).toEqual([a, c]);
    expect(fs.readFileSync(historyFile(rollupId), "utf8")).not.toContain("Updated source");
  });

  it("keeps a misaligned legacy account until L1 can display its aligned replacement", () => {
    const early = new Date(2026, 8, 11, 3);
    const id = seed(0, "Original source", early);
    const old = instantId(new Date(2026, 8, 11, 2)) + "-6h-summary";
    const aligned = instantId(new Date(2026, 8, 11, 0)) + "-6h-summary";
    const original = legacy(old, [id]);
    const service = serviceAt();
    evidence(service);
    expect(fs.readFileSync(historyFile(old), "utf8")).toBe(original);
    const adapter = (service as unknown as { memoryAdapter: import("../../../../src/tools/computer-history/memory-adapter.js").HistoryMemoryAdapter }).memoryAdapter;
    const revision = fs.statSync(historyFile(aligned)).mtime.toISOString();
    vi.spyOn(adapter, "summaryFor").mockImplementation((key, rev) => key === aligned && rev === revision
      ? { status: "ready", title: "Replacement", text: "Source accounted for", revision } : undefined);
    service.realignRollups();
    expect(fs.existsSync(historyFile(old))).toBe(false);
    expect(service.snapshot().histories.find((entry) => entry.id === aligned)?.coveredHistoryIds).toEqual([id]);
  });

  it("does not submit WeChat evidence or its aggregate without consent", () => {
    const id = seed(10);
    fs.writeFileSync(historyFile(id), fs.readFileSync(historyFile(id), "utf8").replace("status: completed",
      'status: completed\napplications: ["com.tencent.xinWeChat"]'));
    expect(evidence(serviceAt())).toEqual([]);
  });
});
