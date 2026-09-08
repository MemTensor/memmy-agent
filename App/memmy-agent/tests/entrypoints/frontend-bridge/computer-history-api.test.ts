import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerHistoryDemoService } from "../../../src/entrypoints/frontend-bridge/computer-history-api.js";

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

  it("installs the transparent demo fixture and derives a separate CUA workflow", () => {
    const { service } = createService();
    const installed = service.installDemoFixture();
    const history = installed.histories[0];

    expect(history.sourceType).toBe("demo_fixture");
    expect(history.markdown).toContain("不是可直接逐击回放的宏");
    expect(history.markdown).toContain("iPhone 17 Pro / 银色 / 512GB");

    const generated = service.createWorkflow(
      history.id,
      "帮我把妈妈之前说的那台 iPhone 配好，加入购物袋就停，不要结账或支付。",
    );
    expect(generated.workflows).toHaveLength(1);
    expect(generated.workflows[0].sourceHistoryId).toBe(history.id);
    expect(generated.workflows[0].markdown).toContain("妈妈之前说的那台 iPhone");
    expect(generated.workflows[0].markdown).toContain("点击一次“添加到购物袋”");
    expect(generated.workflows[0].markdown).toContain("不得点击“结账”");
    expect(generated.workflows[0].markdown).toContain("creates_new_application_instance=false");
    expect(generated.workflows[0].markdown).toContain("desktop-scope foreground");
    expect(generated.workflows[0].markdown).toContain("CUA");
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

  it("finds relevant History whether or not its raw events still exist", () => {
    const { service, root } = createService();
    const historyDirectory = path.join(root, "histories");
    fs.mkdirSync(historyDirectory, { recursive: true });
    fs.writeFileSync(path.join(historyDirectory, "recorded-notes.md"), [
      "---",
      'title: "在备忘录里记录会议纪要"',
      "source_type: captured",
      "experience_version: 1",
      "status: completed",
      "---",
      "",
      "## Recording summary",
      "",
      "你在备忘录里记录了会议纪要。",
      "",
    ].join("\n"), "utf8");
    service.installDemoFixture();

    const matches = service.searchHistories("接着帮我把那台 iPhone 配好", 2);

    expect(matches[0].history.title).toBe("微信里妈妈想要的 iPhone 配置");
    expect(matches[0].matchedTerms).toContain("iphone");
    // This entry has no segment on disk, so it cannot be replayed — but asking
    // what happened must still find it.
    const notes = matches.find((match) => match.history.title === "在备忘录里记录会议纪要");
    expect(notes).toBeDefined();
    expect(notes!.history.replayPlan?.status).toBe("not_replayable");
  });
});

function createService(): { service: ComputerHistoryDemoService; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-computer-history-test-"));
  temporaryDirectories.push(root);
  return {
    root,
    service: new ComputerHistoryDemoService({
      repositoryRoot: path.resolve(import.meta.dirname, "../../../../.."),
      historyDirectory: path.join(root, "histories"),
      recordingDirectory: path.join(root, "recordings"),
      workflowDirectory: path.join(root, "workflows"),
    }),
  };
}
