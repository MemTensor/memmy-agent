import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

describe("native stop completion through the service", () => {
  it.each([false, true])("finalizes a successful hotkey exit without an API Stop (earlier summary: %s)", async (hasEarlierSummary) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-hotkey-regression-"));
    const recorderScript = path.join(root, "synthetic-recorder.mjs");
    // Emulates the wrapper's successful finish protocol only. No event tap,
    // keyboard listener, screen capture or global hotkey is installed.
    fs.writeFileSync(recorderScript, `import fs from 'node:fs';
const file=process.argv[process.argv.indexOf('--out')+1];
const timestamp=new Date().toISOString();
const records=[
 {recordType:'human_history_metadata',schemaVersion:1,recordingId:'synthetic',title:'Synthetic hotkey',platform:'macOS'},
 {recordType:'human_event',eventType:'accessibility_snapshot',timestamp,application:{name:'Notes',bundleId:'com.apple.Notes'},ax:{mode:'fullTree',text:'AXStaticText||LATE_FINISHED_ACTION|||'},details:{}},
 {recordType:'human_event',eventType:'recording_stopped',timestamp,details:{reason:'stop_hotkey'}}
];
fs.appendFileSync(file,records.map(JSON.stringify).join('\\n')+'\\n');
console.log('recording written: '+file);
`);
    const service = new ComputerHistoryDemoService({ recorderScript,
      historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
      workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "settings.json"),
    });
    let resolveNarration!: (value: { content: string }) => void;
    const pendingNarration = new Promise<{ content: string }>((resolve) => { resolveNarration = resolve; });
    const response = { content: JSON.stringify({ title: "Finished work", description: "LATE_FINISHED_ACTION", body: "## Memory summary\n\nLATE_FINISHED_ACTION" }) };
    const chat = vi.fn(async () => chat.mock.calls.length === 1 ? pendingNarration : response);
    service.setLlmRuntime((() => ({ model: "stub", provider: { chatWithRetry: chat } })) as unknown as Parameters<typeof service.setLlmRuntime>[0]);
    try {
      const snapshot = service.startObservation();
      const id = `${snapshot.observation.segmentId}-10min-summary`;
      const file = path.join(root, "histories", `${id}.md`);
      const internals = service as unknown as { segment: { child: import("node:child_process").ChildProcessWithoutNullStreams }; clearRotationTimer(): void };
      internals.clearRotationTimer();
      const child = internals.segment.child;
      if (hasEarlierSummary) fs.writeFileSync(file, "---\ntitle: Early work\nsource_type: captured\nsummary_state: ready\nstatus: incomplete\n---\n\n## Memory summary\n\nOpened Notes.\n");
      await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); });
      await vi.waitFor(() => expect(service.snapshot().observation).toMatchObject({ state: "stopped", segmentId: null, error: null }));
      expect(child.exitCode).toBe(0);
      expect(chat).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(chat.mock.calls)).toContain("LATE_FINISHED_ACTION");
      if (hasEarlierSummary) expect(service.snapshot().histories.find((entry) => entry.id === id)?.title).toBe("Early work");
      resolveNarration(response);
      await vi.waitFor(() => expect(service.snapshot().histories.find((entry) => entry.id === id)?.title).toBe("Finished work"));
      expect(service.snapshot().histories.some((entry) => entry.summaryWindow === "6h")).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toContain("capture_complete: true");
      expect(fs.existsSync(`${file}.staging`)).toBe(false);
      await service.backfillUnwrittenSummaries();
      expect(chat).toHaveBeenCalledTimes(1); // The open six-hour window is not narrated incrementally.
    } finally {
      resolveNarration(response);
      await service.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
