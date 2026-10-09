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
