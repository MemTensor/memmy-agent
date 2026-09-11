import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("ComputerHistoryDemoService", () => {
  it("keeps imported context distinguishable from captured history", () => {
    const { service } = createService();
    const snapshot = service.importMarkdown({
      title: "My context",
      markdown: "# Timeline\n\nI compared two configurations.",
    });

    expect(snapshot.histories).toHaveLength(1);
    expect(snapshot.histories[0].sourceType).toBe("imported");
    expect(snapshot.histories[0].markdown).toContain("source_type: imported");
    expect(snapshot.privacy.screenshots).toBe(false);
    expect(snapshot.privacy.rawRetentionHours).toBe(48);
  });

  it("deletes a History together with its derived workflows and raw recording", () => {
    const { service, root } = createService();
    const created = service.importMarkdown({
      title: "Disposable history",
      markdown: "# Timeline\n\nA temporary recording.",
    });
    const history = created.histories[0];
    const workflowDirectory = path.join(root, "workflows");
    const recordingDirectory = path.join(root, "recordings", history.id);
    fs.mkdirSync(workflowDirectory, { recursive: true });
    fs.mkdirSync(recordingDirectory, { recursive: true });
    fs.writeFileSync(path.join(workflowDirectory, "derived.md"), [
      "---",
      'title: "Derived workflow"',
      `source_history_id: ${history.id}`,
      "---",
      "",
      "# Workflow",
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(recordingDirectory, "events.jsonl"), "{}\n", "utf8");

    const afterDelete = service.deleteHistory(history.id);

    expect(afterDelete.histories).toHaveLength(0);
    expect(afterDelete.workflows).toHaveLength(0);
    expect(fs.existsSync(history.filePath)).toBe(false);
    expect(fs.existsSync(recordingDirectory)).toBe(false);
  });

  // Steps are derived from a segment's own event stream now, so a replayable
  // entry needs the events on disk — a summary alone is no longer enough.
  function captureSegment(root: string, segmentId: string): void {
    const directory = path.join(root, "recordings", "segments", segmentId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "metadata.json"),
      JSON.stringify({ id: segmentId, startedAt: new Date().toISOString() }),
      "utf8",
    );
    fs.writeFileSync(path.join(directory, "events.jsonl"), [
      JSON.stringify({
        recordType: "human_event", sequence: 1, timestamp: "2026-09-08T03:30:01.000Z",
        eventType: "application_changed",
        application: { name: "Google Chrome", bundleId: "com.google.Chrome" }, details: {},
      }),
      JSON.stringify({
        recordType: "human_event", sequence: 2, timestamp: "2026-09-08T03:30:02.000Z",
        eventType: "mouse_click",
        application: { name: "Google Chrome", bundleId: "com.google.Chrome" },
        details: { button: "left", clickCount: 1, accessibility: { role: "AXButton", title: "银色" } },
      }),
      "",
    ].join("\n"), "utf8");

    const histories = path.join(root, "histories");
    fs.mkdirSync(histories, { recursive: true });
    fs.writeFileSync(path.join(histories, `${segmentId}-10min-summary.md`), [
      "---",
      'title: "人工示范配置 iPhone"',
      "source_type: captured",
      "summary_state: ready",
      "experience_version: 1",
      "status: completed",
      "---",
      "",
      "## Recording summary",
      "",
      "你在 Chrome 里配置了一台 iPhone。",
      "",
    ].join("\n"), "utf8");
  }

  it("derives a gated semantic workflow from the segment's event stream", () => {
    const { service, root } = createService();
    captureSegment(root, "2026-09-08T03-30-00Z");

    const history = service.snapshot().histories[0];
    expect(history.replayPlan?.status).toBe("ready");

    const generated = service.createWorkflow(history.id, "按我刚才示范的步骤配置，完成后停止。");
    const workflow = generated.workflows[0];

    expect(workflow.sourceHistoryId).toBe(history.id);
    expect(workflow.markdown).toContain("generated_from: recorded_operation_experience");
    expect(workflow.markdown).toContain("银色");
  });

  it("says the evidence expired rather than that nothing was repeatable", () => {
    const { service, root } = createService();
    captureSegment(root, "2026-09-08T03-30-00Z");
    const history = service.snapshot().histories[0];
    fs.rmSync(path.join(root, "recordings", "segments", "2026-09-08T03-30-00Z"), {
      recursive: true, force: true,
    });

    expect(() => service.createWorkflow(history.id, "再来一次"))
      .toThrow(/passed the retention window/);
  });

  it("keeps a written summary through the live pass instead of overwriting it", () => {
    const { service, root } = createService();
    const segmentId = "2026-09-09T06-10-00Z";
    const directory = path.join(root, "recordings", "segments", segmentId);
    const historyDirectory = path.join(root, "histories");
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(historyDirectory, { recursive: true });
    const eventsFile = path.join(directory, "events.jsonl");
    const historyFile = path.join(historyDirectory, `${segmentId}-10min-summary.md`);
    fs.writeFileSync(eventsFile, [
      JSON.stringify({
        recordType: "human_history_metadata", schemaVersion: 1, recordingId: segmentId,
        title: "配置 iPhone", createdAt: "2026-09-09T06:10:00.000Z", platform: "macOS",
        display: { width: 1920, height: 1080 },
        captureText: false, captureSearchText: true,
        allowedApplications: [], captureScopeApplications: [],
      }),
      JSON.stringify({
        recordType: "human_event", sequence: 1, timestamp: "2026-09-09T06:10:01.000Z",
        eventType: "application_changed",
        application: { name: "Google Chrome", bundleId: "com.google.Chrome" }, details: {},
      }),
      "",
    ].join("\n"), "utf8");
    const written = [
      "---",
      'title: "配置 iPhone"',
      "source_type: captured",
      "summary_state: ready",
      "experience_version: 1",
      "status: completed",
      "---",
      "",
      "## Memory summary",
      "",
      "你在 Chrome 里配置了一台 iPhone。",
      "",
    ].join("\n");
    fs.writeFileSync(historyFile, written, "utf8");

    // The segment is still open and its events keep growing, which is exactly
    // when the live pass used to rewrite the account back into a placeholder.
    fs.appendFileSync(eventsFile, `${JSON.stringify({
      recordType: "human_event", sequence: 2, timestamp: "2026-09-09T06:10:02.000Z",
      eventType: "mouse_click",
      application: { name: "Google Chrome", bundleId: "com.google.Chrome" },
      details: { button: "left", clickCount: 1 },
    })}\n`, "utf8");
    liveSummaryPass(service, {
      id: segmentId,
      directory,
      eventsFile,
      historyFile,
      metadataFile: path.join(directory, "metadata.json"),
      startedAt: "2026-09-09T06:10:00.000Z",
      child: null,
      output: "",
    });

    expect(fs.readFileSync(historyFile, "utf8")).toBe(written);
    expect(service.snapshot().histories.map((entry) => entry.id)).toContain(`${segmentId}-10min-summary`);
  });

  it("keeps a mechanical rollup off the timeline until it is written", () => {
    const { service, root } = createService();
    const historyDirectory = path.join(root, "histories");
    fs.mkdirSync(historyDirectory, { recursive: true });
    // A rollup reads as "imported" unless source_type knows the word, and an
    // imported entry is exempt from the written gate — which is how a templated
    // body reached the timeline.
    fs.writeFileSync(path.join(historyDirectory, "2026-09-08T06-00-00Z-6h-summary.md"), [
      "---",
      'title: "ClawForce Architecture and Requirements Review"',
      "source_type: rollup",
      "summary_window: 6h",
      "---",
      "",
      "## Memory summary",
      "",
      "本窗口由 9 份 10 分钟摘要汇总而来，覆盖 5 个应用。",
      "",
    ].join("\n"), "utf8");

    expect(service.snapshot().histories).toHaveLength(0);
  });

  it("writes the summaries the model never reached, so their history returns", async () => {
    const { service, root } = createService();
    const historyDirectory = path.join(root, "histories");
    fs.mkdirSync(historyDirectory, { recursive: true });
    fs.writeFileSync(path.join(historyDirectory, "2026-09-08T11-30-00Z-10min-summary.md"), [
      "---",
      'title: "Computer History Review"',
      "source_type: captured",
      "---",
      "",
      "## Memory summary",
      "",
      "用户完成了一组电脑操作。",
      "",
    ].join("\n"), "utf8");
    expect(service.snapshot().histories).toHaveLength(0);

    service.setLlmRuntime(narratingRuntime());
    const written = await service.backfillUnwrittenSummaries();

    expect(written).toBe(1);
    const histories = service.snapshot().histories;
    expect(histories).toHaveLength(1);
    expect(histories[0].markdown).toContain("summary_state: ready");
    expect(histories[0].markdown).not.toContain("用户完成了一组电脑操作。");
  });

  it("never replaces a written summary with a placeholder while finalizing", async () => {
    const { service, root } = createService();
    const segmentId = "2026-09-10T02-10-00Z";
    const directory = path.join(root, "recordings", "segments", segmentId);
    const historyDirectory = path.join(root, "histories");
    fs.mkdirSync(directory, { recursive: true });
    fs.mkdirSync(historyDirectory, { recursive: true });
    const eventsFile = path.join(directory, "events.jsonl");
    const historyFile = path.join(historyDirectory, `${segmentId}-10min-summary.md`);
    fs.writeFileSync(eventsFile, [
      JSON.stringify({
        recordType: "human_history_metadata", schemaVersion: 1, recordingId: segmentId,
        title: "A window", createdAt: "2026-09-10T02:10:00.000Z", platform: "macOS",
        display: { width: 1920, height: 1080 },
        captureText: false, captureSearchText: true,
        allowedApplications: [], captureScopeApplications: [],
      }),
      JSON.stringify({
        recordType: "human_event", sequence: 1, timestamp: "2026-09-10T02:10:01.000Z",
        eventType: "application_changed",
        application: { name: "Google Chrome", bundleId: "com.google.Chrome" }, details: {},
      }),
      "",
    ].join("\n"), "utf8");
    const standing = [
      "---",
      'title: "What the model wrote"',
      "source_type: captured",
      "summary_state: ready",
      "---",
      "",
      "你在 Chrome 里做了一件事。",
      "",
    ].join("\n");
    fs.writeFileSync(historyFile, standing, "utf8");

    // The model is unreachable, which is the case that used to lose the entry
    // for good rather than for a few seconds.
    await finalize(service, {
      id: segmentId,
      directory,
      eventsFile,
      historyFile,
      metadataFile: path.join(directory, "metadata.json"),
      startedAt: "2026-09-10T02:10:00.000Z",
      child: null,
      output: "",
    });

    expect(fs.readFileSync(historyFile, "utf8")).toBe(standing);
    expect(service.snapshot().histories.map((entry) => entry.title)).toContain("What the model wrote");
    // The staged rewrite is cleaned up rather than left beside the summary.
    expect(fs.existsSync(`${historyFile}.staging`)).toBe(false);
  });

  it("dates a summary by the window it covers, not by when it was last written", () => {
    const { service, root } = createService();
    const historyDirectory = path.join(root, "histories");
    fs.mkdirSync(historyDirectory, { recursive: true });
    const write = (name: string, title: string) => {
      fs.writeFileSync(path.join(historyDirectory, name), [
        "---",
        `title: ${JSON.stringify(title)}`,
        "source_type: captured",
        "summary_state: ready",
        "---",
        "",
        "body",
        "",
      ].join("\n"), "utf8");
    };
    // Written newest-first on disk, so mtime order is the reverse of the truth.
    write("2026-09-10T02-20-00Z-10min-summary.md", "The later window");
    write("2026-09-10T02-10-00Z-10min-summary.md", "The earlier window");

    const histories = service.snapshot().histories;

    // A summary is rewritten every time the model catches up with it, so its
    // file says when that happened, never when the activity did.
    expect(histories.map((entry) => entry.createdAt)).toEqual([
      "2026-09-10T02:20:00.000Z",
      "2026-09-10T02:10:00.000Z",
    ]);
    expect(histories.map((entry) => entry.title)).toEqual(["The later window", "The earlier window"]);
  });

  it("finds relevant History whether or not its raw events still exist", () => {
    const { service, root } = createService();
    const historyDirectory = path.join(root, "histories");
    fs.mkdirSync(historyDirectory, { recursive: true });
    fs.writeFileSync(path.join(historyDirectory, "recorded-notes.md"), [
      "---",
      'title: "在备忘录里记录会议纪要"',
      "source_type: captured",
      "summary_state: ready",
      "experience_version: 1",
      "status: completed",
      "---",
      "",
      "## Recording summary",
      "",
      "你在备忘录里记录了会议纪要。",
      "",
    ].join("\n"), "utf8");
    service.importMarkdown({
      title: "配置一台 iPhone",
      markdown: "# Timeline\n\n在 Apple 官网选好了 iPhone 的颜色和容量。",
    });

    const matches = service.searchHistories("接着帮我把那台 iPhone 配好", 2);

    expect(matches[0].history.title).toBe("配置一台 iPhone");
    expect(matches[0].matchedTerms).toContain("iphone");
    // This entry has no segment on disk, so it cannot be replayed — but asking
    // what happened must still find it.
    const notes = matches.find((match) => match.history.title === "在备忘录里记录会议纪要");
    expect(notes).toBeDefined();
    expect(notes!.history.replayPlan?.status).toBe("not_replayable");
  });
});

/** A model that always writes, so the backfill can be checked without one. */
function narratingRuntime() {
  return (() => ({
    model: "test-model",
    provider: {
      chatWithRetry: async () => ({
        content: JSON.stringify({
          title: "Computer History review",
          description: "You looked over earlier Computer History entries.",
          body: "## Memory summary\n\nYou looked over earlier Computer History entries.",
        }),
      }),
    },
  })) as unknown as Parameters<ComputerHistoryDemoService["setLlmRuntime"]>[0];
}

/** Closes a segment the way rotation and stopping both do. */
function finalize(service: ComputerHistoryDemoService, segment: unknown): Promise<void> {
  return (service as unknown as { finalizeSegment(state: unknown): Promise<void> }).finalizeSegment(segment);
}

/**
 * Runs one tick of the live summary pass. It is private because nothing outside
 * the timer drives it, but the invariant it now upholds — that a written
 * summary survives the tick — is worth holding onto.
 */
function liveSummaryPass(service: ComputerHistoryDemoService, segment: unknown): void {
  (service as unknown as { writeLiveSummary(state: unknown): void }).writeLiveSummary(segment);
}

function createService(): { service: ComputerHistoryDemoService; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-computer-history-test-"));
  temporaryDirectories.push(root);
  return {
    root,
    service: new ComputerHistoryDemoService({
      historyDirectory: path.join(root, "histories"),
      recordingDirectory: path.join(root, "recordings"),
      workflowDirectory: path.join(root, "workflows"),
    }),
  };
}
