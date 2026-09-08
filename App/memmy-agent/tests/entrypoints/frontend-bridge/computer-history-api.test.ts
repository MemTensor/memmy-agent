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

  it("turns completed captured operation experience into a gated semantic workflow", () => {
    const { service, root } = createService();
    const historyDirectory = path.join(root, "histories");
    fs.mkdirSync(historyDirectory, { recursive: true });
    fs.writeFileSync(path.join(historyDirectory, "recorded-iphone.md"), [
      "---",
      'title: "人工示范配置 iPhone"',
      "source_type: captured",
      "experience_version: 1",
      "status: completed",
      "---",
      "",
      "## Reusable operation experience",
      "",
      "1. Activate Google Chrome (`com.google.Chrome`) and verify its main content window is visible.",
      "2. Text was entered in Google Chrome (`com.google.Chrome`) but was intentionally redacted; require a current task variable or stop instead of guessing it.",
      "3. In Google Chrome (`com.google.Chrome`), send `return`, then verify its effect.",
      "4. Confirm the front browser page in Google Chrome (`com.google.Chrome`) is now https://www.apple.com/ (“Apple - Google Chrome”) before continuing; the URL path encodes the state reached by the previous action.",
      "5. In Google Chrome (`com.google.Chrome`), move down only far enough to reveal the next recorded semantic target; observe again after at most one viewport.",
      "6. In Google Chrome (`com.google.Chrome`), locate AXButton \"银色\" from the current Accessibility state, activate it once, then verify the resulting UI state before continuing.",
      "",
    ].join("\n"), "utf8");

    const history = service.snapshot().histories[0];
    const generated = service.createWorkflow(history.id, "按我刚才示范的步骤配置，完成后停止。");
    const workflow = generated.workflows[0];

    expect(workflow.sourceHistoryId).toBe(history.id);
    expect(workflow.markdown).toContain("generated_from: recorded_operation_experience");
    expect(workflow.markdown).toContain("### Gate 1 of 2");
    expect(workflow.markdown).toContain("open https://www.apple.com/ in the current tab");
    expect(workflow.markdown).not.toContain("intentionally redacted");
    expect(workflow.markdown).toContain('AXButton "银色"');
    expect(workflow.markdown).toContain("never use a recorded coordinate");
    expect(workflow.markdown).not.toContain("Recorded semantic action: In Google Chrome (`com.google.Chrome`), move down");
    expect(workflow.markdown).toContain("mcp_open_computer_use_get_app_state");
    expect(workflow.markdown).toContain("action tools return refreshed post-action state");
    expect(workflow.markdown).toContain("Element indexes are state-scoped");
    expect(workflow.markdown).toContain("Recorded scrolls are navigation hints, not workflow gates");
    expect(workflow.markdown).toContain("COMPUTER_USE_RESULT: success");
    expect(workflow.markdown).toContain("do not start a CUA subprocess");
  });

  it("finds the most relevant replayable History for a natural-language chat request", () => {
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
      "## Reusable operation experience",
      "",
      "1. Open Notes and create a new note, then verify its title.",
      "",
    ].join("\n"), "utf8");
    service.installDemoFixture();

    const matches = service.searchHistories("接着帮我把那台 iPhone 配好", 2);

    expect(matches[0].history.title).toBe("微信里妈妈想要的 iPhone 配置");
    expect(matches[0].matchedTerms).toContain("iphone");
    expect(matches.map((match) => match.history.title)).toContain("在备忘录里记录会议纪要");
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
