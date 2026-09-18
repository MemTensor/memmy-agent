import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ComputerHistoryDemoService } from "../../../../src/tools/computer-history/mac/computer-history-api.js";

interface RecorderInternals {
  segment: { child: ChildProcessWithoutNullStreams | null; eventsFile: string } | null;
  recorderChildren: Set<ChildProcessWithoutNullStreams>;
  clearRotationTimer(): void;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Synthetic recorder did not reach the expected state");
    await delay(10);
  }
}

describe("Computer History real child lifecycle", () => {
  it("rejects Start during Stop, drains the child, and can restart then shut down", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-history-child-process-"));
    const recorderScript = path.join(directory, "synthetic-recorder.cjs");
    // This stand-in observes nothing: it only appends synthetic heartbeats to
    // its test-owned --out file. The ready marker is written after installing
    // the delayed signal handler so Stop cannot race process initialization.
    fs.writeFileSync(recorderScript, `
const fs = require("node:fs");
const output = process.argv[process.argv.indexOf("--out") + 1];
const heartbeat = () => fs.appendFileSync(output, JSON.stringify({ syntheticHeartbeat: Date.now(), pid: process.pid }) + "\\n");
heartbeat();
setInterval(heartbeat, 20);
process.once("SIGTERM", () => setTimeout(() => process.exit(0), 150));
fs.writeFileSync(output + "." + process.pid + ".ready", "ready");
`, "utf8");
    const service = new ComputerHistoryDemoService({
      recorderScript,
      historyDirectory: path.join(directory, "histories"),
      recordingDirectory: path.join(directory, "recordings"),
      workflowDirectory: path.join(directory, "workflows"),
      observationSettingsFile: path.join(directory, "settings.json"),
    });
    const internals = service as unknown as RecorderInternals;
    const ownedChildren = new Set<ChildProcessWithoutNullStreams>();
    let stopping: ReturnType<ComputerHistoryDemoService["stopObservation"]> | null = null;
    const startChild = async () => {
      service.startObservation();
      // Rotation has separate clock-driven coverage. Prevent a wall-clock
      // ten-minute boundary from creating an unrelated child in this test.
      internals.clearRotationTimer();
      const { child, eventsFile } = internals.segment!;
      if (!child) throw new Error("Synthetic recorder child was not created");
      ownedChildren.add(child);
      expect(child.spawnargs[1]).toBe(recorderScript);
      expect(child.pid).toBeGreaterThan(0);
      await waitUntil(() => fs.existsSync(`${eventsFile}.${child.pid}.ready`));
      const before = fs.statSync(eventsFile).size;
      await waitUntil(() => fs.statSync(eventsFile).size > before);
      return { child, eventsFile };
    };

    try {
      const first = await startChild();
      stopping = service.stopObservation();
      expect(service.snapshot().observation.state).toBe("stopping");
      expect(() => service.startObservation()).toThrow("finishing a recorder transition");
      expect(first.child.exitCode).toBeNull();

      const stopped = await stopping;
      expect(stopped.observation.state).toBe("stopped");
      expect(stopped.observation.segmentId).toBeNull();
      expect(first.child.exitCode).toBe(0);
      expect(first.child.signalCode).toBeNull();
      const bytesAtStop = fs.statSync(first.eventsFile).size;
      await delay(100);
      expect(fs.statSync(first.eventsFile).size).toBe(bytesAtStop);

      const second = await startChild();
      expect(second.child.pid).not.toBe(first.child.pid);
      expect(service.snapshot().observation.state).toBe("running");
      await service.shutdown();
      expect(second.child.exitCode).toBe(0);
      expect(second.child.signalCode).toBeNull();
      expect(service.snapshot().observation.state).toBe("stopped");
      const bytesAtShutdown = fs.statSync(second.eventsFile).size;
      await delay(100);
      expect(fs.statSync(second.eventsFile).size).toBe(bytesAtShutdown);
    } finally {
      internals.clearRotationTimer();
      // Include a child even if startChild failed before returning, and only
      // ever signal handles created with this exact temporary script.
      for (const child of internals.recorderChildren) {
        if (child.spawnargs[1] === recorderScript) ownedChildren.add(child);
      }
      for (const child of ownedChildren) {
        if (child.spawnargs[1] !== recorderScript || !child.pid
          || child.exitCode !== null || child.signalCode !== null) continue;
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
      await stopping?.catch(() => undefined);
      await service.shutdown();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
