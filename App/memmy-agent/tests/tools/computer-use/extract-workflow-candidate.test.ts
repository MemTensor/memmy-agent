import assert from "node:assert/strict";
import { test } from "vitest";
import { renderWorkflowCandidate } from "../../../src/tools/computer-use/extract-workflow-candidate.js";

test("renders a separate semantic Workflow Candidate from human events", async () => {
  const markdown = renderWorkflowCandidate({
    file: "/tmp/events.jsonl",
    sourceHistoryId: "history-1",
    title: "Amazon MacBook Pro 加购",
    records: [
      { recordType: "human_event", eventType: "application_changed", application: { name: "Google Chrome", bundleId: "com.google.Chrome" } },
      { recordType: "human_event", eventType: "mouse_click", application: { name: "Google Chrome", bundleId: "com.google.Chrome" }, details: { accessibility: { role: "AXButton", title: "Add to cart" } } },
    ],
  });

  assert.ok(markdown, "a recording with a labelled click yields a candidate");
  assert.match(markdown, /kind: computer_use_workflow_candidate/);
  assert.match(markdown, /source_history_id: "history-1"/);
  assert.match(markdown, /## Semantic steps/);
  assert.match(markdown, /Add to cart/);
  assert.doesNotMatch(markdown, /812, 406/);
});

test("Windows hook evidence does not invent a click target or resulting input characters", () => {
  const application = { id: "windows:fixture", platform: "windows", name: "Fixture.exe" };
  const markdown = renderWorkflowCandidate({ file: "D:/fixture/events.jsonl", records: [
    { recordType: "human_event", eventType: "mouse_click", application, details: { source: "low_level_hook", injected: true, x: 812, y: 406 } },
    { recordType: "human_event", eventType: "text_input", application, details: { source: "low_level_hook", unit: "key_press", pressCount: 1, redacted: true } },
  ] });
  assert.ok(markdown);
  assert.match(markdown, /semantic target and effect were not verified/);
  assert.match(markdown, /resulting characters are unknown/);
  assert.match(markdown, /may have originated from software/);
  assert.doesNotMatch(markdown, /812|406|activate it once/);
});
