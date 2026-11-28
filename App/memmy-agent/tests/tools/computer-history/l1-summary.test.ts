import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../src/tools/computer-history/mac/computer-history-api.js";
import { instantId } from "../../../src/tools/computer-history/mac/rollup.js";
import type { HistoryMemoryAdapter } from "../../../src/tools/computer-history/memory-adapter.js";
import * as writer from "../../../src/tools/computer-history/mac/summary-writer.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each(["darwin", "win32"] as const)("reads both summaries verbatim from L1 on %s without another model request", async (platform) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ch-l1-"));
  const dir = path.join(root, "histories");
  fs.mkdirSync(dir);
  const start = new Date(2026, 0, 12, 6);
  const segment = instantId(new Date(start.getTime() + 600_000)) + "-10min-summary";
  const rollup = instantId(start) + "-6h-summary";
  const file = path.join(dir, segment + ".md");
  fs.writeFileSync(file, "---\nsource_type: captured\ntitle: editor\nstatus: completed\nsummary_state: pending\n---\n\n## Memory summary\n\nObserved a change to the release date.\n");
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  vi.stubEnv("MEMMY_MEMORY_URL", "http://127.0.0.1:1");
  const narrate = vi.spyOn(writer, "writeSegmentNarrative");
  const revisions = new Map<string, string>();
  const ready = new Map<string, { revision: string; title: string; text: string }>();
  const skipped = new Map<string, string>();
  const posts: string[] = [];
  vi.stubGlobal("fetch", async (url: URL, request: RequestInit) => {
    const body = JSON.parse(String(request.body));
    if (url.pathname.endsWith("/sync")) {
      posts.push(body.sourceRecordId);
      revisions.set(body.sourceRecordId, body.revision);
      return Response.json({ id: "mem-" + body.sourceRecordId });
    }
    expect(url.pathname).toBe("/api/v1/evidence/status");
    expect(body.includeSummary).toBe(true);
    return Response.json({ evidence: body.sourceRecordIds.map((id: string) => ({
      id: "mem-" + id, sourceRecordId: id, status: "activated", l1Summary: ready.get(id), skippedSummaryRevision: skipped.get(id),
    })).reverse(), skills: [] });
  });
  const createService = () => new ComputerHistoryDemoService({ historyDirectory: dir, recordingDirectory: path.join(root, "raw"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings"),
    weChatConsentFile: path.join(root, "chat-consent") });
  let service = createService();
  let adapter = (service as unknown as { memoryAdapter: HistoryMemoryAdapter }).memoryAdapter;
  const entry = (id: string) => service.snapshot().histories.find((item) => item.id === id);
  try {
    await adapter.flushNow();
    expect(posts).toEqual([segment, rollup]);
    expect(entry(segment)).toMatchObject({ description: null, summaryStatus: "pending" });
    expect(entry(rollup)).toMatchObject({ description: null, summaryStatus: "pending", coveredHistoryIds: [segment] });
    ready.set(segment, { revision: revisions.get(segment)!, title: "分段", text: "交付日期改到周五。" });
    await adapter.flushNow();
    expect(entry(segment)).toMatchObject({ title: "分段", description: "交付日期改到周五。", summaryStatus: "ready" });
    expect(entry(rollup)?.summaryStatus).toBe("pending");
    ready.set(rollup, { revision: revisions.get(rollup)!, title: "Fenêtre de six heures", text: "La date de livraison a changé." });
    await adapter.flushNow();
    expect(entry(rollup)).toMatchObject({ description: "La date de livraison a changé.", summaryStatus: "ready" });
    expect(service.searchHistories("livraison")[0]?.history.id).toBe(rollup);
    await adapter.flushNow();
    expect(posts).toEqual([segment, rollup]);
    expect(fs.readFileSync(file, "utf8")).not.toContain("交付日期改到周五");
    ready.clear();
    skipped.set(segment, revisions.get(segment)!);
    await adapter.flushNow();
    expect(entry(segment)).toMatchObject({ description: null, summaryStatus: "skipped" });
    expect(entry(rollup)?.summaryStatus).toBe("pending");
    skipped.set(rollup, revisions.get(rollup)!);
    await adapter.flushNow();
    expect(entry(rollup)).toMatchObject({ description: null, summaryStatus: "skipped" });
    expect(posts).toEqual([segment, rollup]);
    await service.shutdown();
    service = createService();
    adapter = (service as unknown as { memoryAdapter: HistoryMemoryAdapter }).memoryAdapter;
    expect([entry(segment)?.summaryStatus, entry(rollup)?.summaryStatus]).toEqual(["skipped", "skipped"]);
    fs.appendFileSync(file, "New observation\n");
    fs.utimesSync(file, new Date(), new Date(Date.parse(revisions.get(segment)!) + 2_000));
    await adapter.flushNow();
    expect(entry(segment)).toMatchObject({ description: null, summaryStatus: "pending" });
    expect(entry(rollup)?.summaryStatus).toBe("pending");
    await adapter.flushNow(); // A late reply for the previous revision cannot restore "skipped".
    expect([entry(segment)?.summaryStatus, entry(rollup)?.summaryStatus]).toEqual(["pending", "pending"]);
    expect(narrate).not.toHaveBeenCalled();
  } finally {
    await service.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
