import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as settings from "../../../../src/tools/computer-history/win/settings.js";
import { WindowsComputerHistoryService } from "../../../../src/tools/computer-history/win/computer-history-api.js";
import { WindowsPlatformDriver } from "../../../../src/tools/computer-history/win/platform-driver.js";
import { ApplicationIconReader } from "../../../../src/tools/computer-history/mac/application-icon.js";
import { WindowsApplicationIconReader } from "../../../../src/tools/computer-history/win/application-icon.js";
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
  it("uses the Windows icon reader for Windows History application IDs", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.spyOn(os, "release").mockReturnValue("10.0.26100");
    const windowsIcon = vi.spyOn(WindowsApplicationIconReader.prototype, "iconFor")
      .mockResolvedValue("data:image/png;base64,AAA");
    const macIcon = vi.spyOn(ApplicationIconReader.prototype, "iconFor")
      .mockResolvedValue(null);
    const { service } = setup();

    await expect(service.applicationIcon("win32.explorer"))
      .resolves.toBe("data:image/png;base64,AAA");
    expect(windowsIcon).toHaveBeenCalledWith("win32.explorer");
    expect(macIcon).not.toHaveBeenCalled();
  });

  it("hands Unicode output paths to the same managed process and validates the rotation acknowledgement", async () => {
    const {root, store} = setup([
      'import fs from "node:fs";import readline from "node:readline";',
      'console.log(JSON.stringify({kind:"recorder.state",state:"running"}));',
      'readline.createInterface({input:process.stdin}).on("line",line=>{',
      'if(line==="stop"){console.log(JSON.stringify({kind:"recorder.state",state:"stopped"}));process.exit(0);}',
      'const request=JSON.parse(line);fs.writeFileSync(process.argv[process.argv.indexOf("--out")+1]+".request",JSON.stringify(request));',
      'console.log("[recorder-rotation] "+JSON.stringify({id:request.id,complete:true}));});',
    ].join("\n"));
    store.write({version: 1, applications: [{executable}]});
    const driver = new WindowsPlatformDriver(store, path.join(root,"native.exe"), path.join(root,"recorder.mjs"));
    const first = {title: "First", eventsFile: path.join(root,"events.jsonl"), observationSettingsFile: path.join(root,"mac-settings.json")};
    const child = driver.launch(first); await driver.ready(child);
    const next = {...first, title: "下一段 📝", eventsFile: path.join(root,"中文 📝","events.jsonl")};
    await driver.rotate(child,next);
    expect(JSON.parse(fs.readFileSync(first.eventsFile+".request","utf8"))).toMatchObject({kind:"rotate",eventsFile:next.eventsFile,title:next.title});
    expect(child.exitCode).toBeNull(); await driver.stop(child);
  });
  it("uses the durable marker offset even when later events reach disk before the acknowledgement", async () => {
    const { service, store } = setup([
      'import fs from "node:fs"; import readline from "node:readline";',
      'const file=process.argv[process.argv.indexOf("--out")+1];let sequence=0;',
      'const append=(eventType,text)=>fs.appendFileSync(file,JSON.stringify({recordType:"human_event",eventType,sequence:++sequence,timestamp:new Date().toISOString(),details:{text}})+"\\n");',
      'append("recording_started");console.log(JSON.stringify({kind:"recorder.state",state:"running"}));',
      'readline.createInterface({input:process.stdin}).on("line",line=>{',
      'if(line==="stop"){console.log(JSON.stringify({kind:"recorder.state",state:"stopped"}));process.exit(0);}',
      'const input=JSON.parse(line);append("accessibility_snapshot","BEFORE_MARKER");append("recording_checkpoint");',
      'const fd=fs.openSync(file,"r+");fs.fsyncSync(fd);fs.closeSync(fd);const bytes=fs.statSync(file).size;',
      'const result={id:input.id,complete:true,rangeEvaluated:true,through:input.through??new Date().toISOString(),issues:[],',
      'watermark:{nativeSessionId:"a".repeat(32),nativeSequence:sequence,captureSequence:sequence,recordingSequence:sequence,bytes}};',
      'append("accessibility_snapshot","AFTER_MARKER");console.log("[recorder-checkpoint] "+JSON.stringify(result));});',
    ].join("\n"));
    store.write({ version: 1, applications: [{ executable }] });
    const capture = await service.acquireEventCapture();
    const point = await capture.checkpoint({ from: new Date().toISOString() });
    expect(point).toMatchObject({ running: true, complete: true, rangeEvaluated: true, boundaryConfirmed: true });
    const stream = point.streams.at(-1)!, bytes = fs.readFileSync(stream.file);
    expect(bytes.length).toBeGreaterThan(stream.size);
    expect(bytes.subarray(0, stream.size).toString()).toContain("BEFORE_MARKER");
    expect(bytes.subarray(0, stream.size).toString()).not.toContain("AFTER_MARKER");
    expect(point.limitations.join(" ")).not.toContain("observer is still starting");
    await capture.release();
  });
  it("shares the Windows driver with plugin subscribers and accepts conservative persisted checkpoints", async () => {
    const { service, store } = setup([
      'import fs from "node:fs"; import readline from "node:readline";',
      'const file=process.argv[process.argv.indexOf("--out")+1];',
      'fs.appendFileSync(file,JSON.stringify({recordType:"human_event",eventType:"recording_started",timestamp:new Date().toISOString()})+"\\n");',
      'console.log(JSON.stringify({kind:"recorder.state",state:"running"}));',
      'readline.createInterface({input:process.stdin}).on("line",line=>{',
      'if(line==="stop"){console.log(JSON.stringify({kind:"recorder.state",state:"stopped"}));process.exit(0);}',
      'const input=JSON.parse(line);fs.appendFileSync(file,JSON.stringify({recordType:"human_event",eventType:"accessibility_snapshot",timestamp:new Date().toISOString()})+"\\n");',
      'const fd=fs.openSync(file,"r+");fs.fsyncSync(fd);fs.closeSync(fd);',
      'console.log("[recorder-checkpoint] "+JSON.stringify({id:input.id,complete:false}));});',
    ].join("\n"));
    store.write({ version: 1, applications: [{ executable }] });
    const first = await service.acquireEventCapture();
    const second = await service.acquireEventCapture();
    const point = await first.checkpoint({ from: new Date().toISOString() });
    expect(point).toMatchObject({ running: true, complete: false, rangeEvaluated: false });
    expect(fs.readFileSync(point.streams.at(-1)!.file, "utf8")).toContain("accessibility_snapshot");
    expect(service.snapshot().observation.state).toBe("stopped");
    await first.release();
    expect((await second.checkpoint()).running).toBe(true);
    await second.release();
    expect(service.recorderBusy).toBe(false);
  });
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
  it("applies the content-free message limit per line when checkpoint/health responses arrive in a batch", async () => {
    const { root, service, store } = setup();
    fs.appendFileSync(path.join(root, "recorder.mjs"), '\nprocess.stdout.write(Array(100).fill("[recorder-health] "+JSON.stringify({code:"event_recorded",timestamp:new Date().toISOString()})+"\\n").join(""));');
    store.write({ version: 1, applications: [{ executable }] });
    await service.startObservationWithPermissions();
    await vi.waitFor(() => expect(service.snapshot().observation.captureHealth?.lastEventAt).toEqual(expect.any(String)));
    expect(service.snapshot().observation.state).toBe("running");
    await service.stopObservation();
  });
  it("rejects content-bearing payloads on the content-free health channel", async () => {
    const { root, service, store } = setup();
    fs.appendFileSync(path.join(root, "recorder.mjs"), '\nsetTimeout(()=>console.log("[recorder-health] "+JSON.stringify({code:"event_recorded",timestamp:new Date().toISOString(),text:"PRIVATE_CONTENT"})),20);');
    store.write({ version: 1, applications: [{ executable }] });
    await service.startObservationWithPermissions();
    await vi.waitFor(() => expect(service.snapshot().observation.state).toBe("failed"));
  });
  it("preflights explicit consent without creating Mac defaults or a recording", async () => {
    const { root, service, store } = setup();
    store.write({ version: 1, applications: [] });
    const before = fs.readdirSync(root, { recursive: true });
    const result = await service.startObservationWithPermissions();
    expect(result.observation).toMatchObject({ state: "stopped", permissions: { platform: "windows", ready: false, reason: "authorization_required", accessibility: false, inputMonitoring: false } });
    expect(fs.readdirSync(root, { recursive: true })).toEqual(before);
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
    expect(fs.existsSync(path.join(root, "mac-settings.json"))).toBe(false);
  });
  it("rejects invalid consent without stopping the active child", async () => {
    const { service, store } = setup(); store.write({ version: 1, applications: [{ executable }] });
    await service.startObservationWithPermissions();
    await expect(service.updateWindowsSettings({ version: 1, applications: [{ executable: "relative.exe" }] })).rejects.toMatchObject({ status: 422 });
    expect(service.snapshot().observation.state).toBe("running");
    expect(store.read().applications).toHaveLength(1);
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
