import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
const runtime = vi.hoisted(() => ({ service: null as RecordingSessionService | null }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), ...native }));
vi.mock("../../../src/tools/computer-recordings/service.js", () => ({
  getRecordingSessionService: () => runtime.service, markRecordingOcu: vi.fn(), shutdownRecordingService: vi.fn(),
}));
import { WindowsTaskRecordingDriver } from "../../../src/tools/computer-recordings/windows-driver.js";
import { RecordingSessionService, type TaskRecordingHandle } from "../../../src/tools/computer-recordings/session-service.js";
import { startAgentRecording } from "../../../src/tools/computer-recordings/agent-lifecycle.js";
import { ObservationSettingsStore } from "../../../src/tools/computer-history/core/settings-store.js";
import { CollectorGate } from "../../../src/tools/computer-history/core/collector-gate.js";
import { DEFAULT_OBSERVATION_SETTINGS, type ObservationSettings } from "../../../src/tools/computer-history/core/observation-settings.js";
import { WindowsSettingsStore } from "../../../src/tools/computer-history/win/settings.js";
import { windowsScopeAllows, windowsScopeRule } from "../../../src/tools/computer-history/win/unified-settings.js";
import { readNativePolicy } from "../../../src/tools/computer-history/win/policy.js";
import { envelope } from "../computer-history/win/fixtures.js";
import type { LLMProvider } from "../../../src/providers/base.js";

const app = "C:\\Apps\\one\\Code.exe", other = "C:\\Apps\\two\\Code.exe";
const bindings = [app, other].map((executable, index) => ({ executable, pid: 123 + index, processStart: "134000000000000001" }));
type Child = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
let root: string, directory: string, binary: string, shared: ObservationSettingsStore, legacy: WindowsSettingsStore, unified: WindowsSettingsStore;
let children: Child[], handles: TaskRecordingHandle[];
type DiscoverCallback = (error: Error | null, stdout?: Buffer) => void;
const discovery = () => Buffer.from(JSON.stringify({ protocol: "memmy.windows.computer-history", version: 1,
  platform: "windows", kind: "applications", applications: bindings }));

function rules(behavior: "observe" | "do_not_observe", entries: ObservationSettings["observation"]["rules"]) {
  const settings = structuredClone(DEFAULT_OBSERVATION_SETTINGS);
  settings.observation.defaultApplicationBehavior = behavior;
  settings.observation.rules = entries;
  return shared.write(settings);
}
function migrate(behavior: "observe" | "do_not_observe" = "observe") {
  legacy.write({ version: 1, defaultApplicationBehavior: behavior, applications: [{ executable: other }] });
  unified.readObservation();
}
async function start(applications = [app]) {
  // Use the production default settings constructor, not a pre-wired test store.
  const handle = await new WindowsTaskRecordingDriver(binary).start({ directory, applications, onEvent: vi.fn() });
  handles.push(handle);
  return readNativePolicy(path.join(directory, "policy.json")).policy;
}
function noCapture() {
  expect(native.spawn).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(directory, "policy.json"))).toBe(false);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-win-task-authorization-"));
  directory = path.join(root, "recording"); fs.mkdirSync(directory);
  binary = path.join(root, "recorder.exe"); fs.writeFileSync(binary, "native process boundary fixture");
  vi.stubEnv("MEMMY_HOME", root); vi.stubEnv("MEMMY_WINDOWS_HISTORY_BINARY", binary);
  shared = new ObservationSettingsStore();
  legacy = new WindowsSettingsStore();
  unified = new WindowsSettingsStore(legacy.filePath, shared);
  children = []; handles = []; runtime.service = null;
  native.execFile.mockReset().mockImplementation((_binary: string, args: string[], _options: unknown, callback: DiscoverCallback) => {
    if (args[0] === "applications") callback(null, discovery());
    else callback(new Error("no media in authorization fixture"));
  });
  native.spawn.mockReset().mockImplementation((_binary: string, args: string[]) => {
    const child: Child = Object.assign(new EventEmitter(), { pid: 555, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    children.push(child);
    const policyFile = args[args.indexOf("--policy") + 1]!;
    queueMicrotask(() => child.stdout.write(JSON.stringify({ ...envelope(), protocol: "memmy.windows.task-recording", monotonicMs: 0,
      kind: "session.started", collector: { version: "test", pid: child.pid, testHooks: false },
      policyRevision: readNativePolicy(policyFile).revision, segment: null,
      options: { seconds: 1200, rotateSeconds: 60, sampleMs: 200, inputHooks: true, parentPid: process.pid },
      task: { qpcOrigin: "1000", qpcFrequency: "10000", qpc: "1000", actionQpc: [], unsupportedActions: 0 },
    }) + "\n"));
    return child;
  });
});
afterEach(async () => {
  for (const child of children) child.emit("close", 0);
  await Promise.all(handles.map(handle => handle.finished));
  await runtime.service?.shutdown();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Windows task recording shared authorization", () => {
  it("rejects a newly revoked application even when the legacy policy allows every app", async () => {
    migrate(); rules("observe", [windowsScopeRule(app, "do_not_observe")]);
    await expect(start()).rejects.toThrow("recording_application_not_authorized");
    expect(native.execFile).not.toHaveBeenCalled(); noCapture();
  });

  it("records a newly allowed application after migration and binds only the selected real process", async () => {
    migrate("do_not_observe"); rules("do_not_observe", [windowsScopeRule(app, "observe"), windowsScopeRule(other, "observe")]);
    expect(legacy.read().applications.map(rule => rule.executable)).toEqual([other]);
    const policy = await start([app.toUpperCase()]);
    expect(policy.applications).toHaveLength(1);
    expect(policy.applications[0]).toMatchObject(bindings[0]!);
    expect(native.spawn).toHaveBeenCalledOnce();
  });

  it("does not authorize another same-named executable through the default-allow legacy file", async () => {
    migrate(); rules("do_not_observe", [windowsScopeRule(app, "observe")]);
    await expect(start([other])).rejects.toThrow("recording_application_not_authorized"); noCapture();
  });

  it("honors executable-name alias exclusions as well as exact-path rules", async () => {
    migrate(); rules("observe", [{ scope: "app", bundleID: "win32.code", behavior: "do_not_observe" }]);
    await expect(start()).rejects.toThrow("recording_application_not_authorized"); noCapture();
  });

  it("rejects the whole selection if any application is unauthorized", async () => {
    migrate(); rules("do_not_observe", [windowsScopeRule(app, "observe")]);
    await expect(start([app, other])).rejects.toThrow("recording_application_not_authorized"); noCapture();
  });

  it("preserves the legacy allowlist on the first migration", async () => {
    legacy.write({ version: 1, applications: [{ executable: other }] });
    await expect(start()).rejects.toThrow("recording_application_not_authorized"); noCapture();
    expect(windowsScopeAllows(shared.readStrict(), app)).toBe(false);
    expect(windowsScopeAllows(shared.readStrict(), other)).toBe(true);
  });

  it.each(["shared_corrupt", "shared_missing", "legacy_corrupt"])("fails closed for %s settings", async failure => {
    migrate();
    if (failure === "shared_corrupt") fs.writeFileSync(shared.filePath, "{broken");
    if (failure === "shared_missing") fs.unlinkSync(shared.filePath);
    if (failure === "legacy_corrupt") fs.writeFileSync(legacy.filePath, "{broken");
    await expect(start()).rejects.toThrow("recording_observation_policy_invalid");
    expect(native.execFile).not.toHaveBeenCalled(); noCapture();
  });

  it("does not accept an injected legacy-only store as an authorization source", async () => {
    migrate();
    await expect(new WindowsTaskRecordingDriver(binary, legacy).start({ directory, applications: [app], onEvent: vi.fn() }))
      .rejects.toThrow("recording_observation_policy_invalid"); noCapture();
  });

  it.each(["revoked", "corrupt", "missing"])("rechecks %s shared settings after asynchronous process discovery", async failure => {
    migrate();
    let complete!: DiscoverCallback;
    native.execFile.mockImplementationOnce((_binary: string, _args: string[], _options: unknown, callback: DiscoverCallback) => { complete = callback; });
    const starting = start();
    const rejected = expect(starting).rejects.toThrow(failure === "revoked" ? "recording_application_not_authorized" : "recording_observation_policy_invalid");
    await vi.waitFor(() => expect(complete).toBeTypeOf("function"));
    if (failure === "revoked") rules("observe", [windowsScopeRule(app, "do_not_observe")]);
    if (failure === "corrupt") fs.writeFileSync(shared.filePath, "{broken");
    if (failure === "missing") fs.unlinkSync(shared.filePath);
    complete(null, discovery());
    await rejected; noCapture();
  });

  it.each([false, true])("checks the saved message's application at the after-dequeue hook (revoked: %s)", async revoked => {
    migrate(); rules("do_not_observe", [windowsScopeRule(app, "observe")]);
    const gate = new CollectorGate();
    runtime.service = new RecordingSessionService({ driver: new WindowsTaskRecordingDriver(), directory: path.join(root, "sessions"),
      platform: "windows", gate, supported: true });
    const metadata = { task_recording: { title: "Queued demonstration", applications: [app], consent: true } };
    expect(windowsScopeAllows(shared.readStrict(), app)).toBe(true);
    if (revoked) rules("do_not_observe", []);
    const notify = vi.fn().mockResolvedValue(undefined);
    const id = await startAgentRecording({ runId: "turn", chatId: "chat", messageId: "message", metadata, notify });
    const sessions = await runtime.service.list();
    expect(sessions).toHaveLength(1);
    if (revoked) {
      expect(id).toBeNull();
      expect(notify).toHaveBeenCalledWith({ recording_state: "failed", recording_error: "recording_not_started" });
      expect(sessions[0]!.state).toBe("failed"); expect(gate.busy).toBe(false); noCapture();
    } else {
      expect(id).toBe(sessions[0]!.id);
      expect(sessions[0]).toMatchObject({ state: "recording", agent: { runId: "turn", chatId: "chat", messageId: "message" } });
      const policy = readNativePolicy(path.join(root, "sessions", id!, "policy.json")).policy;
      expect(policy.applications).toHaveLength(1); expect(policy.applications[0]).toMatchObject(bindings[0]!);
    }
  });

  it("rejects revoked consent after a real Agent queue dequeues the saved message, while still running the turn", async () => {
    const { AgentLoop } = await import("../../../src/core/agent-runtime/loop.js");
    const { Config } = await import("../../../src/config/schema.js");
    const { InboundMessage, MessageBus } = await import("../../../src/core/runtime-messages/index.js");
    migrate(); rules("observe", []);
    runtime.service = new RecordingSessionService({ driver: new WindowsTaskRecordingDriver(), directory: path.join(root, "sessions"),
      platform: "windows", gate: new CollectorGate(), supported: true });
    const loop = new AgentLoop({ bus: new MessageBus(), config: new Config({ memmyMemory: { enabled: false } }),
      provider: { getDefaultModel: () => "test-model" } as unknown as LLMProvider, workspace: path.join(root, "workspace"), model: "test-model" });
    loop.initializeRuntimeTools = vi.fn(async () => undefined);
    const sessionKey = "websocket:recording-consent-queue";
    loop.sessions.getOrCreate(sessionKey);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const processed: string[] = [];
    // Keep the actual queue and recording lifecycle; replace only the model's work.
    loop.processMessageInternal = vi.fn(async message => {
      processed.push(message.content);
      if (message.content === "active") await blocked;
      return null;
    });
    const outbound = vi.spyOn(loop.bus, "publishOutbound");
    const running = loop.run();
    const enqueue = (content: string, recording = false) => loop.bus.publishInbound(new InboundMessage({
      channel: "websocket", chatId: "recording-consent-queue", content, sessionKeyOverride: sessionKey,
      turnSource: { kind: "gui", channel: "websocket" }, metadata: { webui: true, client_request_id: content,
        webui_request_digest: `digest-${content}`, webui_queue_surface: "chat_composer",
        ...(recording ? { task_recording: { title: "Queued demonstration", applications: [app], consent: true } } : {}),
      },
    }));
    try {
      await enqueue("active");
      await vi.waitFor(() => expect(processed).toEqual(["active"]));
      await enqueue("queued", true);
      await vi.waitFor(async () => expect((await loop.getQueueSnapshot(sessionKey)).items.some(item => item.clientRequestId === "queued")).toBe(true));
      expect(native.spawn).not.toHaveBeenCalled();
      rules("observe", [windowsScopeRule(app, "do_not_observe")]);
      release();
      await vi.waitFor(() => expect(processed).toEqual(["active", "queued"]));
      await vi.waitFor(() => expect(loop.isSessionBusy(sessionKey)).toBe(false));
      expect(outbound.mock.calls.some(([message]) => message.metadata.taskRecordingStatus?.recording_state === "failed")).toBe(true);
      expect((await runtime.service.list()).map(session => session.state)).toEqual(["failed"]);
      noCapture();
    } finally {
      release();
      for (const child of children) child.emit("close", 0);
      loop.stop(); await loop.cancelActiveTasks(sessionKey); await running;
    }
  });
});
