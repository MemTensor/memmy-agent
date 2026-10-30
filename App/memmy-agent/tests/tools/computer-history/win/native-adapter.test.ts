import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { WindowsHistoryRecorder } from "../../../../src/tools/computer-history/win/recorder.js";
import { parseNativePolicy, replaceNativePolicy } from "../../../../src/tools/computer-history/win/policy.js";
import { loadRecords, renderHumanSummary } from "../../../../src/tools/computer-history/core/summarize-history.js";
import { compactEventEvidence } from "../../../../src/tools/computer-history/core/summary-writer.js";
import { WindowsComputerHistoryService } from "../../../../src/tools/computer-history/win/computer-history-api.js";
import { WindowsSettingsStore } from "../../../../src/tools/computer-history/win/settings.js";

const binaryDirectory = process.env.MEMMY_WINDOWS_HISTORY_TEST_BIN_DIR;
const enabled = process.platform === "win32" && !!binaryDirectory;
const binary = path.join(binaryDirectory ?? "", "memmy-history-recorder.exe");
function files() {
  const parent = process.env.MEMMY_WINDOWS_HISTORY_TEST_ARTIFACTS ?? os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, "ts-native-adapter-"));
  return { directory, policyFile: path.join(directory, "policy.json"), eventsFile: path.join(directory, "events.jsonl") };
}
describe.skipIf(!enabled)("production C++ to TypeScript adapter", () => {
  it("runs the product service through the real Node entry and EXE with explicit app consent", async () => {
    const test = files();
    const fixture = spawn(path.join(binaryDirectory!, "memmy-history-fixture.exe"), ["--nonce", "product-service"], { stdio: ["pipe", "pipe", "pipe"] });
    fixture.stderr.resume();
    const lines = readline.createInterface({ input: fixture.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const closed = new Promise<void>((resolve) => fixture.once("close", () => resolve()));
    const instance = new WindowsComputerHistoryService({ binary, recorderScript: path.resolve("dist/tools/computer-history/win/record-human-history.js"),
      windowsSettingsFile: path.join(test.directory, "windows-settings.json"), historyDirectory: path.join(test.directory, "histories"),
      recordingDirectory: path.join(test.directory, "recordings"), workflowDirectory: path.join(test.directory, "workflows"),
      observationSettingsFile: path.join(test.directory, "mac-settings.json") });
    try {
      fixture.stdin.write("info\n");
      const info = JSON.parse((await iterator.next()).value!);
      const store = new WindowsSettingsStore(path.join(test.directory, "windows-settings.json"));
      store.write({ version: 1, applications: [{ executable: info.exe, sensitiveAutomationIds: ["1007"] }] });
      expect((await instance.getWindowsConfiguration()).permissions.ready).toBe(true);
      const started = await instance.startObservationWithPermissions();
      expect(started.observation.state).toBe("running");
      expect((await instance.pauseObservation()).observation.state).toBe("paused");
      expect((await instance.startObservationWithPermissions(true)).observation.segmentId).toBe(started.observation.segmentId);
      await instance.updateWindowsSettings({ version: 1, applications: [] });
      expect(instance.snapshot().observation.state).toBe("stopped");
      const file = path.join(test.directory, "recordings", "segments", started.observation.segmentId!, "events.jsonl");
      const records = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records.filter((item) => item.recordType === "human_history_metadata")).toHaveLength(1);
      expect(records.filter((item) => item.eventType === "recording_started")).toHaveLength(2);
      expect(records.filter((item) => item.eventType === "recording_stopped")).toHaveLength(2);
      expect(records.at(-1).eventType).toBe("recording_stopped");
      expect(fs.existsSync(path.join(test.directory, "mac-settings.json"))).toBe(false);
      fs.writeFileSync(path.join(test.directory, "product-service-result.json"), JSON.stringify({ state: instance.snapshot().observation.state,
        sequences: records.slice(1).map((item) => item.sequence), explicitConsentRevoked: store.read().applications.length === 0 }));
    } finally {
      await instance.shutdown();
      fixture.stdin.end(); const timer = setTimeout(() => fixture.kill(), 2000); await closed; clearTimeout(timer); lines.close();
    }
  }, 30000);
  it("starts, pauses, resumes and handles EOF without authorizing desktop applications", async () => {
    const test = files();
    replaceNativePolicy(test.policyFile, parseNativePolicy({ version: 1, applications: [{ pid: process.pid,
      executable: process.execPath, processStart: "1" }] }));
    const recorder = await WindowsHistoryRecorder.start({ ...test, binary, title: "Controlled lifecycle", seconds: 10 });
    try {
      await recorder.pause(); expect(recorder.state).toBe("paused");
      await recorder.resume(); await recorder.endInput();
      expect(recorder.state).toBe("stopped");
      const records = loadRecords(test.eventsFile);
      expect(records.records.some((record) => record.accessibility)).toBe(false);
      expect(renderHumanSummary({ file: test.eventsFile, ...records })).toContain("status: completed");
    } finally { await recorder.stop().catch(() => {}); }
  }, 15000);
  it("ends on the bounded duration without requiring a stop command", async () => {
    const test = files();
    replaceNativePolicy(test.policyFile, parseNativePolicy({ version: 1, applications: [{ pid: process.pid, executable: process.execPath, processStart: "1" }] }));
    const recorder = await WindowsHistoryRecorder.start({ ...test, binary, title: "Duration", seconds: 1 });
    await recorder.finished; expect(recorder.state).toBe("stopped");
  }, 10000);
  it("captures the controlled fixture, redacts secrets and keeps password/edit subtrees out of summaries", async (testContext) => {
    const test = files();
    const fixture = spawn(path.join(binaryDirectory!, "memmy-history-fixture.exe"), ["--nonce", "ts-adapter"], { stdio: ["pipe", "pipe", "pipe"] });
    fixture.stderr.resume();
    const lines = readline.createInterface({ input: fixture.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const command = async (value: string): Promise<any> => {
      fixture.stdin.write(value + "\n");
      const next = await iterator.next();
      if (next.done) throw new Error("fixture_exited");
      return JSON.parse(next.value);
    };
    const fixtureClosed = new Promise<void>((resolve) => fixture.once("close", () => resolve()));
    let recorder: WindowsHistoryRecorder | null = null;
    try {
      const info = await command("info");
      const activated = await command("activate a");
      fs.writeFileSync(path.join(test.directory, "fixture-precondition.json"), JSON.stringify({ info, activated }));
      if (!activated.ok || activated.foreground !== info.hwndA) { testContext.skip(); return; }
      await command("focus search");
      replaceNativePolicy(test.policyFile, parseNativePolicy({ version: 1, applications: [{ pid: info.pid, executable: info.exe,
        processStart: info.processStart, hwnd: info.hwndA, searchFields: [{ controlType: "Edit", automationId: "1003" }],
        documentRegions: [{ controlType: "Document", automationId: "1006" }, { controlType: "Edit", automationId: "1006" }],
        sensitiveAutomationIds: ["1007"] }] }));
      const captured: string[] = [];
      recorder = await WindowsHistoryRecorder.start({ ...test, binary, title: "Fixture acceptance", seconds: 20,
        sampleMs: 200, inputHooks: true, onEvent: (event) => { captured.push(JSON.stringify(event)); } });
      const until = async (predicate: () => boolean) => {
        const deadline = Date.now() + 6000;
        while (!predicate()) {
          if (recorder?.state === "failed") await recorder.finished;
          if (Date.now() > deadline) throw new Error("fixture_capture_timeout");
          await delay(25);
        }
      };
      await until(() => captured.some((line) => line.includes("FIXTURE-MESSAGE-1-ts-adapter")));
      const navigation = await command("input navigation"); expect(navigation.ok).toBe(true);
      await until(() => captured.some((line) => line.includes('"eventType":"key_press"') && line.includes("F6")));
      await command("focus edit"); await delay(300);
      const input = await command("input text-key"); expect(input.ok).toBe(true);
      await until(() => captured.some((line) => line.includes('"unit":"key_press"')));
      await command("focus password"); await delay(300);
      const passwordStart = captured.length;
      await command("input navigation"); await command("input text-key"); await delay(500);
      expect(captured.slice(passwordStart).some((line) => line.includes('"eventType":"key_press"') || line.includes('"eventType":"text_input"'))).toBe(false);
      await command("focus search"); await delay(300);
      await recorder.pause();
      const count = captured.length;
      await command("set-message paused content"); await delay(300); expect(captured).toHaveLength(count);
      await command("set-message Release 218 api_key=secretfixturevalue");
      await recorder.resume();
      await until(() => captured.some((line) => line.includes("Release 218")));
      await recorder.stop();
      const contents = fs.readFileSync(test.eventsFile, "utf8");
      for (const secret of ["FIXTURE-PASSWORD-", "FIXTURE-PWCHILD-", "FIXTURE-EDIT-", "FIXTURE-EDITCHILD-", "FIXTURE-SENSITIVE-", "secretfixturevalue", "paused content"])
        expect(contents).not.toContain(secret);
      expect(contents).toContain("[REDACTED]");
      expect(captured.findLast((line) => line.includes("Release 218"))).toContain('"sourceMode":"full"');
      expect(compactEventEvidence(contents.split("\n"))).toContain("Release 218");
      expect(renderHumanSummary({ file: test.eventsFile, ...loadRecords(test.eventsFile) })).toContain("status: completed");
    } finally {
      await recorder?.stop().catch(() => {});
      fixture.stdin.end();
      const timer = setTimeout(() => fixture.kill(), 2000);
      await fixtureClosed; clearTimeout(timer); lines.close();
    }
  }, 25000);
});
