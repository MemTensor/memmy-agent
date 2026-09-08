import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComputerHistoryApiError,
  ComputerHistoryDemoService,
  isCodexSkysightCopy,
} from "../../../src/entrypoints/frontend-bridge/computer-history-api.js";
import { ObservationSettingsStore } from "../../../src/core/agent-runtime/computer-history/settings-store.js";

const roots: string[] = [];
const settingsFiles: string[] = [];

function allowNotes(settingsFile: string): void {
  new ObservationSettingsStore(settingsFile).write({
    observation: {
      defaultApplicationBehavior: "do_not_observe",
      defaultURLBehavior: "observe",
      rules: [{ scope: "app", bundleID: "com.apple.Notes", behavior: "observe" }],
    },
  });
}

function service(): ComputerHistoryDemoService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-observation-"));
  roots.push(root);
  const settingsFile = path.join(root, "observation-settings.json");
  allowNotes(settingsFile);
  settingsFiles.push(settingsFile);
  return new ComputerHistoryDemoService({
    observationSettingsFile: settingsFile,
    historyDirectory: path.join(root, "histories"),
    recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"),
  });
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("Computer History observation lifecycle", () => {
  it("starts stopped, so a fresh install records nothing", () => {
    expect(service().snapshot().observation).toMatchObject({
      state: "stopped",
      startedAt: null,
      segmentId: null,
    });
  });

  it("opens a ten-minute-aligned segment when observation starts", async () => {
    const instance = service();
    const snapshot = instance.startObservation();

    expect(snapshot.observation.state).toBe("running");
    // Segment ids align to the ten-minute grid so they sort and group cleanly.
    expect(snapshot.observation.segmentId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-[0-5]0-00Z$/);
    await instance.stopObservation();
  });

  it("writes segment metadata next to the event stream", async () => {
    const instance = service();
    const snapshot = instance.startObservation();
    const segmentId = snapshot.observation.segmentId!;
    const directory = path.join(
      instance.snapshot().privacy.markdownDirectory.replace(/histories$/, "recordings"),
      "segments",
      segmentId,
    );
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "metadata.json"), "utf8"));

    expect(metadata).toMatchObject({ id: segmentId });
    expect(metadata.eventsPath).toContain("events.jsonl");
    await instance.stopObservation();
  });

  it("keeps the current segment across a pause and resume", async () => {
    const instance = service();
    const started = instance.startObservation();
    const paused = await instance.pauseObservation();

    expect(paused.observation.state).toBe("paused");
    // Pause is not a weaker stop: the segment survives so the arc is unbroken.
    expect(paused.observation.segmentId).toBe(started.observation.segmentId);

    const resumed = instance.resumeObservation();
    expect(resumed.observation.state).toBe("running");
    expect(resumed.observation.segmentId).toBe(started.observation.segmentId);
    await instance.stopObservation();
  });

  it("clears the segment on stop while completed history remains", async () => {
    const instance = service();
    instance.startObservation();
    const stopped = await instance.stopObservation();

    expect(stopped.observation).toMatchObject({ state: "stopped", segmentId: null, startedAt: null });
  });

  it("refuses to start when the policy would record nothing", () => {
    const instance = service();
    new ObservationSettingsStore(settingsFiles.at(-1)!).write({
      observation: { defaultApplicationBehavior: "do_not_observe", defaultURLBehavior: "observe", rules: [] },
    });

    expect(() => instance.startObservation()).toThrow(/observes nothing yet/);
  });

  it("rejects transitions that do not apply to the current state", async () => {
    const instance = service();
    await expect(instance.stopObservation()).rejects.toBeInstanceOf(ComputerHistoryApiError);
    expect(() => instance.resumeObservation()).toThrow(ComputerHistoryApiError);

    instance.startObservation();
    expect(() => instance.startObservation()).toThrow(ComputerHistoryApiError);
    await instance.stopObservation();
  });

  it("stops recording when the app shuts down", async () => {
    const instance = service();
    instance.startObservation();
    await instance.shutdown();

    expect(instance.snapshot().observation.state).toBe("stopped");
    // Shutting down twice must stay quiet rather than throwing on app exit.
    await expect(instance.shutdown()).resolves.toBeUndefined();
  });
});

describe("Codex-derived history", () => {
  it("recognizes copies of Codex Skysight summaries by their file name", () => {
    // Codex: <utc>-<4 random chars>-<window>-memory-summary
    expect(isCodexSkysightCopy("2026-08-26T15-00-00-jsSd-10min-memory-summary")).toBe(true);
    expect(isCodexSkysightCopy("2026-08-26T12-00-00-gnKw-6h-memory-summary")).toBe(true);
  });

  it("never mistakes Memmy's own summaries for Codex copies", () => {
    // Memmy: <segment id>-<window>-summary, no random component, no "memory-".
    expect(isCodexSkysightCopy("2026-09-08T03-30-00Z-10min-summary")).toBe(false);
    expect(isCodexSkysightCopy("2026-09-08T00-00-00Z-6h-summary")).toBe(false);
    expect(isCodexSkysightCopy("2026-09-08T02-52-00Z-computer-history-demonstration")).toBe(false);
    expect(isCodexSkysightCopy("my-imported-note")).toBe(false);
  });

  it("keeps Codex copies out of the timeline while leaving them on disk", () => {
    const instance = service();
    const directory = instance.snapshot().privacy.markdownDirectory;
    fs.mkdirSync(directory, { recursive: true });
    const codexCopy = path.join(directory, "2026-08-26T15-00-00-jsSd-10min-memory-summary.md");
    const own = path.join(directory, "2026-09-08T03-30-00Z-10min-summary.md");
    fs.writeFileSync(codexCopy, '---\ntitle: "codex"\nsource_type: imported\n---\n', "utf8");
    fs.writeFileSync(own, '---\ntitle: "memmy"\n---\n', "utf8");

    const ids = instance.snapshot().histories.map((entry) => entry.id);
    expect(ids).toContain("2026-09-08T03-30-00Z-10min-summary");
    expect(ids).not.toContain("2026-08-26T15-00-00-jsSd-10min-memory-summary");
    // Hidden, not deleted.
    expect(fs.existsSync(codexCopy)).toBe(true);
  });

  it("leaves Codex's live Skysight directory out unless explicitly enabled", () => {
    expect(service().snapshot().privacy.codexSyncDirectory).toBeNull();
  });
});
