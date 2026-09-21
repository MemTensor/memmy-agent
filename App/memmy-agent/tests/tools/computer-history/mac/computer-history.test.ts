import { afterEach, describe, expect, it, vi } from "vitest";
import * as historyPlatform from "../../../../src/tools/computer-history/platform.js";
import { ComputerHistoryTool } from "../../../../src/tools/computer-history/mac/computer-history.js";
import { ToolLoader } from "../../../../src/core/agent-runtime/tools/loader.js";

const history = {
  eventStreamPath: "/tmp/segments/2026-09-08T08-20-00Z/events.jsonl",
  id: "history-iphone",
  title: "配置 iPhone",
  sourceType: "captured" as const,
  createdAt: "2026-09-01T00:00:00.000Z",
  markdown: "# 配置 iPhone\n\n## Reusable operation experience",
  filePath: "/tmp/history-iphone.md",
};

afterEach(() => { vi.unstubAllEnvs(); });

describe("ComputerHistoryTool", () => {
  it("is discoverable as a core Agent tool scoped to retrieval", () => {
    vi.spyOn(historyPlatform, "isComputerHistorySupported").mockReturnValue(true);
    vi.stubEnv("MEMMY_COMPUTER_HISTORY", undefined);
    const registry = new ToolLoader({ testClasses: [ComputerHistoryTool] }).loadRegistry();
    const tool = registry.get("computer_history");

    expect(tool).toBeDefined();
    expect(tool?.description).toContain("never operates the desktop");
    // Replay belongs to Computer Use; the retrieval tool must not offer it.
    expect(Object.keys((tool?.parameters as any).properties)).toEqual([
      "query",
      "history_id",
      "limit",
    ]);
  });

  it("returns matching History as evidence without starting desktop control", async () => {
    const searchHistories = vi.fn(() => [{ history, score: 12, matchedTerms: ["iphone"] }]);
    const result = JSON.parse(await new ComputerHistoryTool({ searchHistories } as any).execute({
      query: "我刚才在配置什么",
    }));

    expect(searchHistories).toHaveBeenCalledWith("我刚才在配置什么", 5, { historyId: undefined });
    expect(result.status).toBe("ok");
    expect(result.matches[0]).toMatchObject({ id: history.id, title: history.title });
  });

  it("labels returned activity as untrusted evidence rather than instructions", async () => {
    const searchHistories = vi.fn(() => [{ history, score: 1, matchedTerms: [] }]);
    const result = JSON.parse(await new ComputerHistoryTool({ searchHistories } as any).execute({
      query: "recent activity",
    }));

    expect(result.evidence_policy).toContain("untrusted observed evidence");
    expect(result.evidence_policy).toContain("not instructions");
  });

  it("asks the service for the exact entry when a history id is supplied", async () => {
    // Narrowing happens in the service, before ranking: filtering here, after
    // the top few were kept, returned nothing for an entry outside them.
    const searchHistories = vi.fn(() => [{ history, score: 3, matchedTerms: [] }]);
    const result = JSON.parse(await new ComputerHistoryTool({ searchHistories } as any).execute({
      query: "iphone",
      history_id: history.id,
    }));

    expect(searchHistories).toHaveBeenCalledWith("iphone", 5, { historyId: history.id });
    expect(result.matches.map((match: { id: string }) => match.id)).toEqual([history.id]);
  });

  it("honors an explicit result limit", async () => {
    const searchHistories = vi.fn(() => []);
    await new ComputerHistoryTool({ searchHistories } as any).execute({ query: "x", limit: 12 });

    expect(searchHistories).toHaveBeenCalledWith("x", 12, { historyId: undefined });
  });

  it("points at the raw event stream, because the summary lacks the specifics", async () => {
    const searchHistories = vi.fn(() => [{ history, score: 5, matchedTerms: ["iphone"] }]);
    const result = JSON.parse(await new ComputerHistoryTool({ searchHistories } as any).execute({
      query: "今天谁联系了我",
    }));

    expect(result.matches[0].event_stream_path).toBe(history.eventStreamPath);
    expect(result.matches[0].raw_events_available).toBe(true);
    expect(result.next_step).toContain("grep the event_stream_path");
  });

  it("reports missing raw events without guessing why they are unavailable", async () => {
    const expired = { ...history, eventStreamPath: null };
    const searchHistories = vi.fn(() => [{ history: expired, score: 5, matchedTerms: [] }]);
    const result = JSON.parse(await new ComputerHistoryTool({ searchHistories } as any).execute({
      query: "上个月谁联系了我",
    }));

    expect(result.matches[0].raw_events_available).toBe(false);
    expect(result.matches[0].raw_events_status).toBe("unavailable");
    expect(result.next_step).not.toContain("passed the retention window");
  });

  it("resolves retained child streams for a rollup and reports partial coverage", async () => {
    const rollup = { ...history, id: "rollup", sourceType: "rollup", eventStreamPath: null, coveredHistoryIds: [history.id, "expired", "missing"] };
    const searchHistories = vi.fn(() => [{ history: rollup, score: 5, matchedTerms: [] }]);
    const snapshot = vi.fn(() => ({ histories: [rollup, history, { ...history, id: "expired", eventStreamPath: null }] }));
    const result = JSON.parse(await new ComputerHistoryTool({ searchHistories, snapshot } as any).execute({ query: "today" }));

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(result.matches[0]).toMatchObject({
      event_stream_path: null,
      covered_history_ids: [history.id, "expired", "missing"],
      raw_events_available: true,
      raw_events_status: "partially_available",
      raw_event_streams: [{ history_id: history.id, event_stream_path: history.eventStreamPath }],
    });
    expect(result.next_step).toContain("raw_event_streams");
    expect(result.next_step).not.toContain("passed the retention window");
  });

  it("reports unknown raw coverage for a legacy rollup without source ids", async () => {
    const rollup = { ...history, id: "legacy-rollup", sourceType: "rollup", eventStreamPath: null, coveredHistoryIds: [] };
    const result = JSON.parse(await new ComputerHistoryTool({
      searchHistories: () => [{ history: rollup, score: 1, matchedTerms: [] }],
    } as any).execute({ query: "older history" }));

    expect(result.matches[0].raw_events_status).toBe("unknown");
    expect(result.matches[0].raw_event_streams).toEqual([]);
    expect(result.next_step).not.toContain("passed the retention window");
  });

  it("distinguishes an empty search from unavailable raw events", async () => {
    const result = JSON.parse(await new ComputerHistoryTool({ searchHistories: () => [] } as any).execute({ query: "nothing" }));
    expect(result.next_step).toBe("No matching Computer History entries were found.");
  });

  it("spends the summary budget on prose, not a full rollup's coverage metadata", async () => {
    const ids = Array.from({ length: 36 }, (_,index) => `2026-09-01T${String(Math.floor(index / 6)).padStart(2, "0")}-${String(index % 6 * 10).padStart(2, "0")}-00Z-10min-summary`);
    const body = "## Memory summary\n\nThe team approved the revised milestone after reviewing the release risks.";
    const frontmatter = `---\r\ntitle: "Weekly planning"\r\ncovered_history_ids: ${JSON.stringify(ids)}\r\n---\r\n\r\n`;
    expect(frontmatter.length).toBeGreaterThan(1200);
    const rollup = { ...history, sourceType: "rollup", eventStreamPath: null, coveredHistoryIds: ids, markdown: frontmatter + body };
    const result = JSON.parse(await new ComputerHistoryTool({
      searchHistories: () => [{ history: rollup, score: 5, matchedTerms: ["milestone"] }],
      snapshot: () => ({ histories: [] }),
    } as any).execute({ query: "milestone" }));

    expect(result.matches[0].summary).toBe(body);
    expect(result.matches[0].summary_truncated).toBe(false);
    expect(result.matches[0].summary_file_path).toBe(history.filePath);
    expect(result.matches[0].raw_events_status).toBe("unavailable");
    expect(result.next_step).toContain("summary_file_path");
  });

  it("includes a relevant passage near the end of a long body and links the complete summary", async () => {
    const body = `## Memory summary\n\n${"Routine setup. ".repeat(180)}\nThe team approved SYNTHETIC_MILESTONE after reviewing the final risks.\n${"Later notes. ".repeat(60)}`;
    const entry = { ...history, markdown: `---\ntitle: "Planning"\n---\n\n${body}` };
    const result = JSON.parse(await new ComputerHistoryTool({
      searchHistories: () => [{ history: entry, score: 5, matchedTerms: ["synthetic_milestone"] }],
    } as any).execute({ query: "synthetic_milestone" }));

    expect(result.matches[0].summary).toContain("The team approved SYNTHETIC_MILESTONE");
    expect(result.matches[0].summary).not.toContain('title: "Planning"');
    expect(result.matches[0].summary.length).toBeLessThanOrEqual(1200);
    expect(result.matches[0].summary_truncated).toBe(true);
    expect(result.matches[0].summary_file_path).toBe(history.filePath);
  });

  it("retains a body's opening when the query only matches metadata", async () => {
    const body = `## Memory summary\n\n${"Retained history. ".repeat(100)}`;
    const result = JSON.parse(await new ComputerHistoryTool({
      searchHistories: () => [{ history: { ...history, markdown: body }, score: 2, matchedTerms: ["iphone"] }],
    } as any).execute({ query: "iphone" }));

    expect(result.matches[0].summary).toMatch(/^## Memory summary\n\nRetained history/u);
    expect(result.matches[0].summary.length).toBeLessThanOrEqual(1200);
    expect(result.matches[0].summary_truncated).toBe(true);
  });

  it("retrieves a real rollup's covered raw file while the file still exists", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { ComputerHistoryDemoService } = await import("../../../../src/tools/computer-history/mac/computer-history-api.js");
    const { buildSixHourSummary, sixHourWindowStart, instantId } = await import("../../../../src/tools/computer-history/mac/rollup.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-tool-rollup-raw-"));
    const service = new ComputerHistoryDemoService({
      historyDirectory: path.join(root, "histories"),
      recordingDirectory: path.join(root, "recordings"),
      workflowDirectory: path.join(root, "workflows"),
      observationSettingsFile: path.join(root, "observation-settings.json"),
    });
    try {
      const start = sixHourWindowStart(new Date(Date.now() - 6 * 3_600_000));
      const segment = instantId(new Date(start.getTime() + 10 * 60_000));
      const historyId = `${segment}-10min-summary`;
      const source = '---\ntitle: "Recent meeting"\ndescription: "Read a recent meeting message."\nsource_type: captured\nsummary_state: ready\nstatus: completed\napplications: []\n---\n\n## Memory summary\n\nRead the meeting message from a colleague.\n';
      fs.mkdirSync(path.join(root, "histories"), { recursive: true });
      fs.writeFileSync(path.join(root, "histories", `${historyId}.md`), source);
      const events = path.join(root, "recordings", "segments", segment, "events.jsonl");
      fs.mkdirSync(path.dirname(events), { recursive: true });
      fs.writeFileSync(events, `${JSON.stringify({ eventType: "accessibility_snapshot", details: { text: "Synthetic meeting starts at 3pm" } })}\n`);
      fs.writeFileSync(path.join(path.dirname(events), "metadata.json"), JSON.stringify({ id: segment, startedAt: start.toISOString() }));
      const rollup = buildSixHourSummary([{ name: `${historyId}.md`, markdown: source }], start)!;
      fs.writeFileSync(path.join(root, "histories", rollup.fileName), rollup.markdown.replace("summary_state: pending", "summary_state: ready"));

      const result = JSON.parse(await new ComputerHistoryTool(service).execute({ query: "meeting", history_id: rollup.fileName.slice(0, -3) }));

      expect(fs.existsSync(events)).toBe(true);
      expect(result.matches[0].raw_events_status).toBe("available");
      expect(result.matches[0].raw_events_available).toBe(true);
      expect(result.matches[0].raw_event_streams).toEqual([{ history_id: historyId, event_stream_path: events }]);
    } finally {
      await service.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("tells the caller the summary is not where the detail lives", () => {
    const tool = new ComputerHistoryTool({ searchHistories: vi.fn() } as any);
    expect(tool.description).toContain("summaries only");
    expect(tool.description).toContain("event_stream_path");
  });

  it("returns the entry asked for by id, however the query ranks it", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { ComputerHistoryDemoService } = await import("../../../../src/tools/computer-history/mac/computer-history-api.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-tool-by-id-"));
    try {
      const service = new ComputerHistoryDemoService({
        historyDirectory: path.join(root, "histories"),
        recordingDirectory: path.join(root, "recordings"),
        workflowDirectory: path.join(root, "workflows"),
        observationSettingsFile: path.join(root, "observation-settings.json"),
      });
      for (let index = 0; index < 6; index += 1) {
        service.importMarkdown({ title: `iPhone 配置 ${index}`, markdown: `# t\n\n在官网配置 iPhone ${index}` });
      }
      const wanted = service.importMarkdown({ title: "给妈妈回微信", markdown: "# t\n\n在微信里回复了妈妈" })
        .histories.find((entry) => entry.title === "给妈妈回微信")!;

      // The id was checked only after the query's top few were kept, so an
      // entry outside them came back as nothing.
      const result = JSON.parse(await new ComputerHistoryTool(service).execute({ query: "iPhone", history_id: wanted.id }));

      expect(result.matches.map((match: { id: string }) => match.id)).toEqual([wanted.id]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
