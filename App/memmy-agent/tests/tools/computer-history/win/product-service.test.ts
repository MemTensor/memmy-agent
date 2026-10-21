import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as settings from "../../../../src/tools/computer-history/win/settings.js";
import { WindowsComputerHistoryService } from "../../../../src/tools/computer-history/win/computer-history-api.js";
import { context, executable } from "./fixtures.js";

const roots: string[] = [];
const services: WindowsComputerHistoryService[] = [];
function setup(script?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-service-test-")); roots.push(root);
  const binary = path.join(root, "native.exe"); fs.writeFileSync(binary, "placeholder");
  const recorderScript = path.join(root, "recorder.mjs");
  fs.writeFileSync(recorderScript, script ?? [
    'import fs from "node:fs";',
    'const file=process.argv[process.argv.indexOf("--out")+1];',
    'const old=fs.existsSync(file)?fs.readFileSync(file,"utf8").trim().split("\\n"):[];',
    'let seq=old.length?JSON.parse(old.at(-1)).sequence:0;',
    'if(!old.length)fs.writeFileSync(file,JSON.stringify({recordType:"human_history_metadata",schemaVersion:1,platform:"windows"})+"\\n");',
    'const write=eventType=>fs.appendFileSync(file,JSON.stringify({recordType:"human_event",sequence:++seq,eventType,timestamp:new Date().toISOString()})+"\\n");',
    'const state=state=>console.log(JSON.stringify({kind:"recorder.state",state}));',
    'write("recording_started");state("running");',
    'const stop=()=>{write("recording_stopped");state("stopped");process.exit(0);};',
    'process.stdin.on("data",stop);process.stdin.on("end",stop);',
  ].join("\n"));
  const service = new WindowsComputerHistoryService({ binary, recorderScript, windowsSettingsFile: path.join(root, "windows-settings.json"),
    historyDirectory: path.join(root, "histories"), recordingDirectory: path.join(root, "recordings"),
    workflowDirectory: path.join(root, "workflows"), observationSettingsFile: path.join(root, "mac-settings.json") });
  services.push(service);
  const store = new settings.WindowsSettingsStore(path.join(root, "windows-settings.json"));
  vi.spyOn(settings, "discoverApplications").mockResolvedValue([context]);
  return { root, service, store };
}
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown().catch(() => {});
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Windows managed service", () => {
  it("accepts persisted-event health alongside lifecycle status and updates capture coverage", async () => {
    const { root, service, store } = setup();
    const script = path.join(root, "recorder.mjs");
    fs.appendFileSync(script, '\nconsole.log("[recorder-health] "+JSON.stringify({code:"event_recorded",timestamp:new Date().toISOString()}));');
    store.write({ version: 1, applications: [{ executable }] });
    await service.startObservationWithPermissions();
    await vi.waitFor(() => expect(service.snapshot().observation.captureHealth?.lastEventAt).toEqual(expect.any(String)));
    expect(service.snapshot().observation.state).toBe("running");
    await service.stopObservation();
    expect(service.snapshot().observation.state).toBe("stopped");
  });
  it("rejects content-bearing payloads on the content-free health channel", async () => {
    const { root, service, store } = setup();
    fs.appendFileSync(path.join(root, "recorder.mjs"), '\nsetTimeout(()=>console.log("[recorder-health] "+JSON.stringify({code:"event_recorded",timestamp:new Date().toISOString(),text:"PRIVATE_CONTENT"})),20);');
    store.write({ version: 1, applications: [{ executable }] });
    await service.startObservationWithPermissions();
    await vi.waitFor(() => expect(service.snapshot().observation.state).toBe("failed"));
  });
  it("migrates an empty legacy scope without starting a recording or broadening it", async () => {
    const { root, service, store } = setup();
    store.write({ version: 1, applications: [] });
    const before = fs.readdirSync(root, { recursive: true });
    const result = await service.startObservationWithPermissions();
    expect(result.observation).toMatchObject({ state: "stopped", permissions: { platform: "windows", ready: false, reason: "authorization_required", accessibility: false, inputMonitoring: false } });
    expect(fs.readdirSync(root)).toEqual(expect.arrayContaining(before.map(String)));
    expect(service.getObservationSettings().observation).toMatchObject({ defaultApplicationBehavior: "do_not_observe", rules: [] });
    expect(fs.existsSync(path.join(root, "windows-settings.json.before-unification.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "recordings", "segments"))).toBe(false);
  });
  it("starts a new profile directly without application selection and remains stopped before Start", async () => {
    const { service, store } = setup();
    expect(store.read().defaultApplicationBehavior).toBe("observe");
    expect(service.snapshot().observation.state).toBe("stopped");
    expect((await service.getWindowsConfiguration()).permissions.ready).toBe(true);
    expect((await service.startObservationWithPermissions()).observation.state).toBe("running");
    await service.stopObservation();
  });
  it("reports missing components, closed applications and discovery failure before capture", async () => {
    const { root, service, store } = setup(); store.write({ version: 1, applications: [{ executable }] });
    vi.mocked(settings.discoverApplications).mockResolvedValue([]);
    expect((await service.startObservationWithPermissions()).observation.permissions?.reason).toBe("no_running_authorized_application");
    vi.mocked(settings.discoverApplications).mockRejectedValue(new Error("unavailable"));
    expect((await service.checkPermissions()).reason).toBe("discovery_failed");
    fs.unlinkSync(path.join(root, "native.exe"));
    expect((await service.checkPermissions()).reason).toBe("collector_unavailable");
    expect(service.snapshot().observation.state).toBe("stopped");
    expect(fs.existsSync(path.join(root, "recordings", "segments"))).toBe(false);
  });
  it("starts, pauses, resumes within a bucket and revokes only after the child closes", async () => {
    const { root, service, store } = setup(); store.write({ version: 1, applications: [{ executable }] });
    const start = await service.startObservationWithPermissions();
    expect(start.observation.state).toBe("running");
    const file = path.join(root, "recordings", "segments", start.observation.segmentId!, "events.jsonl");
    expect((await service.pauseObservation()).observation.state).toBe("paused");
    expect(fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1).eventType).toBe("recording_stopped");
    const resumed = await service.startObservationWithPermissions(true);
    expect(resumed.observation.segmentId).toBe(start.observation.segmentId);
    const denied = await service.updateWindowsSettings({ version: 1, applications: [] });
    expect(service.snapshot().observation.state).toBe("stopped");
    expect(denied.permissions.reason).toBe("authorization_required");
    expect(store.read().applications).toEqual([]);
    const events = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.slice(1).map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(service.getObservationSettings().observation.defaultApplicationBehavior).toBe("do_not_observe");
  });
  it("rejects invalid consent without stopping the active child", async () => {
    const { service, store } = setup(); store.write({ version: 1, applications: [{ executable }] });
    await service.startObservationWithPermissions();
    await expect(service.updateWindowsSettings({ version: 1, applications: [{ executable: "relative.exe" }] })).rejects.toMatchObject({ status: 422 });
    expect(service.snapshot().observation.state).toBe("running");
    expect(store.read().applications).toHaveLength(1);
    await service.stopObservation();
  });
  it("routes shared settings updates through shutdown and makes the Windows view agree", async () => {
    const { service } = setup();
    await service.startObservationWithPermissions();
    await expect(service.updateObservationSettings({ observation: { rules: [] } })).rejects.toThrow();
    expect(service.snapshot().observation.state).toBe("running");
    const next = service.getObservationSettings();
    next.observation.defaultApplicationBehavior = "do_not_observe";
    next.observation.rules = [{ scope: "url", urlDomain: "bank.example", behavior: "do_not_observe" }];
    await service.updateObservationSettings(next);
    expect(service.snapshot().observation.state).toBe("stopped");
    expect((await service.getWindowsConfiguration()).settings.defaultApplicationBehavior).toBe("do_not_observe");
    expect(service.getObservationSettings()).toEqual(next);
  });
  it("publishes content-free last-sample quality through the shared snapshot", async () => {
    const { root, service } = setup();
    const quality = { timestamp: "2026-10-15T12:00:00.000Z", status: "partial", reason: "labels_only" };
    fs.appendFileSync(path.join(root, "recorder.mjs"), `\nconsole.log("[recorder-quality] " + JSON.stringify(${JSON.stringify(quality)}));\n`);
    await service.startObservationWithPermissions();
    await vi.waitFor(() => expect(service.snapshot().observation.captureHealth?.content).toEqual(quality));
    await service.stopObservation();
  });
  it("reports failed startup and failed shutdown instead of success or a stuck stopping state", async () => {
    const startup = setup('console.log(JSON.stringify({kind:"recorder.state",state:"wrong"}));process.exit(0);');
    startup.store.write({ version: 1, applications: [{ executable }] });
    await expect(startup.service.startObservationWithPermissions()).rejects.toMatchObject({ status: 503 });
    expect(startup.service.snapshot().observation.state).toBe("failed");
    const shutdown = setup('console.log(JSON.stringify({kind:"recorder.state",state:"running"}));process.stdin.on("data",()=>process.exit(1));');
    shutdown.store.write({ version: 1, applications: [{ executable }] });
    await shutdown.service.startObservationWithPermissions();
    await expect(shutdown.service.stopObservation()).rejects.toThrow();
    expect(shutdown.service.snapshot().observation.state).toBe("failed");
  });
  it("validates fully drained status on independent exit, even with exit zero and an old stop marker", async () => {
    const { service, store } = setup([
      'import fs from "node:fs";',
      'const file=process.argv[process.argv.indexOf("--out")+1];',
      'fs.writeFileSync(file,JSON.stringify({recordType:"human_history_metadata",schemaVersion:1,platform:"windows"})+"\\n"+JSON.stringify({recordType:"human_event",eventType:"recording_stopped",sequence:1,timestamp:new Date().toISOString()})+"\\n");',
      'console.log(JSON.stringify({kind:"recorder.state",state:"running"}));',
      'setTimeout(()=>{console.log(JSON.stringify({kind:"recorder.state",state:"stopped"}));console.log("unexpected status");process.exit(0);},100);',
    ].join("\n"));
    store.write({ version: 1, applications: [{ executable }] });
    await service.startObservationWithPermissions();
    const deadline = Date.now() + 3000;
    while (service.snapshot().observation.state === "running" && Date.now() < deadline) await delay(25);
    expect(service.snapshot().observation.state).toBe("failed");
  });
});
