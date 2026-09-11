import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// The desktop client validates every snapshot against this schema. Importing
// it here checks the real contract rather than a hand-maintained list of field
// names, which drifted twice before anything caught it.
import { ComputerHistorySnapshotSchema } from "../App/frontend/desktop/src/api/computer-history-contract.js";
import { ComputerHistoryDemoService } from "../App/memmy-agent/src/entrypoints/frontend-bridge/computer-history-api.js";

const roots: string[] = [];

function service(): ComputerHistoryDemoService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-contract-"));
  roots.push(root);
  return new ComputerHistoryDemoService({
    historyDirectory: path.join(root, "histories"),
    recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"),
    observationSettingsFile: path.join(root, "observation-settings.json"),
  });
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

// This test lives at the repository root because the contract it checks spans
// two packages: the agent produces the snapshot, the desktop client validates
// it. Neither package can import the other, which is precisely why the two
// sides were free to drift.
describe("snapshot contract with the desktop client", () => {
  it("accepts an empty snapshot", () => {
    expect(() => ComputerHistorySnapshotSchema.parse(service().snapshot())).not.toThrow();
  });

  it("accepts a snapshot carrying a history, a workflow and a live segment", () => {
    const instance = service();
    const { markdownDirectory, eventStreamDirectory } = instance.snapshot().privacy;

    fs.mkdirSync(markdownDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(markdownDirectory, "2026-09-08T08-20-00Z-10min-summary.md"),
      '---\ntitle: "A window"\ndescription: "You did a thing."\napplications: ["com.apple.Notes"]\nsource_type: captured\nsummary_state: ready\n---\n\nbody\n',
      "utf8",
    );

    const segment = path.join(eventStreamDirectory, "2026-09-08T08-20-00Z");
    fs.mkdirSync(segment, { recursive: true });
    fs.writeFileSync(path.join(segment, "events.jsonl"), "{}\n", "utf8");
    fs.writeFileSync(
      path.join(segment, "metadata.json"),
      JSON.stringify({ id: "2026-09-08T08-20-00Z", startedAt: new Date().toISOString() }),
      "utf8",
    );

    const workflows = path.join(path.dirname(markdownDirectory), "workflows");
    fs.mkdirSync(workflows, { recursive: true });
    fs.writeFileSync(
      path.join(workflows, "w-1.md"),
      '---\ntitle: "A workflow"\nsource_history_id: "h"\n---\n\nbody\n',
      "utf8",
    );

    const snapshot = instance.snapshot();
    expect(snapshot.histories.length).toBeGreaterThan(0);
    expect(snapshot.workflows.length).toBeGreaterThan(0);

    // Parsing, not just shape-matching: the schema is strict, so this fails on
    // any field the backend grew and the client does not know about.
    expect(() => ComputerHistorySnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it("fails loudly when the backend grows a field the client does not know", () => {
    const snapshot = service().snapshot() as any;
    snapshot.histories = [{ ...snapshot.histories[0], somethingNew: 1 }];

    // This is the failure the page showed twice; it belongs in a test.
    expect(() => ComputerHistorySnapshotSchema.parse(snapshot)).toThrow();
  });
});
