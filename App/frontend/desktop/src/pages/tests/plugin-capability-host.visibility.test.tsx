// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { InstalledPluginSchema } from "@memmy/local-api-contracts";
import { expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginUiProvider, usePluginUi, type PluginUiCall } from "../../app/plugin-ui-context.js";
import { PluginCapabilityHost, selectVisiblePluginCalls, selectRegionPluginCalls } from "../plugin-capability-host.js";
import { InterviewRecordingPanel } from "../interview-recording-panel.js";
import { pressPinnedPluginCommand } from "../home-page.js";

const recorder = vi.hoisted(() => ({ cancel: vi.fn(), unmount: vi.fn(), start: vi.fn(), pause: vi.fn(), resume: vi.fn(), finishAndTranscribe: vi.fn() }));
vi.mock("../asr-recorder.js", async (original) => {
  const actual = await original<typeof import("../asr-recorder.js")>();
  const { useEffect } = await import("react");
  return { ...actual, useAsrRecorder: () => {
    useEffect(() => recorder.unmount, []);
    return { ...recorder, status: "recording", isRecording: true, isTranscribing: false, isStarting: false, error: null };
  } };
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const plugin = InstalledPluginSchema.parse({
  id: "legal-labor", version: "1.0.0", manifest: {
    apiVersion: "memmy/v1", id: "legal-labor", name: "Legal", version: "1.0.0", runtime: { adapter: "http" },
    capabilities: [{ id: "interview-record", name: "Record", description: "Record", inputSchema: {}, outputSchema: {}, execution: "job" }],
    commands: [{ command: "/record", name: "Record", description: "Record", capabilityId: "interview-record", pinned: true }], permissions: []
  }, state: "active", approvedPermissions: [], config: {}, lastError: null,
  createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z"
});

it("moves the model's session-start guide into the recording panel without a pinned session-start command", async () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  const legal = { ...plugin, manifest: { ...plugin.manifest, commands: [
    { command: "/legal-guide", name: "诊断指引", description: "Guide", capabilityId: "guide-open", pinned: true }
  ] } };
  const guide: PluginUiCall = { pluginId: "legal-labor", capabilityId: "session-start", callId: "model-start", origin: "agent", events: [
    { type: "artifact", artifact: { id: "template", name: "准备清单.xlsx", role: "setup", uri: "plugin-artifact://template", mediaType: "application/vnd.ms-excel" } },
    { type: "interaction", request: { interactionId: "choice", type: "question", payload: { title: "诊断指引",
      options: [{ label: "我在现场，要录音", value: "record" }, { label: "已完成调研，上传资料", value: "upload" }] } } }
  ] };
  const client = { getUi: vi.fn(), cancel: vi.fn(), respond: vi.fn(async () => undefined) };
  const render = (call: PluginUiCall) => root.render(<PluginUiProvider><I18nProvider language="zh-CN">
    {(["pinned", "panel", "flow"] as const).map(region => <PluginCapabilityHost key={region} region={region} dockInteractions
      calls={[call]} plugins={[legal]} client={client} />)}
  </I18nProvider></PluginUiProvider>);
  try {
    await act(async () => render(guide));
    await act(async () => container.querySelector<HTMLButtonElement>(".diagnostic-guidance-card__footer button")!.click());
    expect(client.respond).toHaveBeenCalledWith("legal-labor", "model-start", "choice", "record");
    const recording: PluginUiCall = { ...guide, events: [...guide.events,
      { type: "interaction", request: { interactionId: "audio", type: "audio-record", payload: { title: "记录现场访谈" } } }
    ] };
    const prepared = selectVisiblePluginCalls([recording]);
    expect(selectRegionPluginCalls(prepared, "panel", new Set(["legal-labor:guide-open"]))).toHaveLength(1);
    await act(async () => render(recording));
    expect(container.querySelectorAll(".recording-bar")).toHaveLength(1);
    expect(container.querySelector(".diagnostic-guidance-card")).toBeNull();
    expect(container.querySelector(".plugin-artifact-row")).toBeNull();
  } finally { act(() => root.unmount()); container.remove(); }
});

it.each(["user", "agent"] as const)("keeps templates out of the %s recorder and restores it without stopping audio", async (origin) => {
  vi.clearAllMocks();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = { getUi: vi.fn(), cancel: vi.fn(), respond: vi.fn() };
  const open = vi.fn(async () => undefined);
  const call: PluginUiCall = { pluginId: plugin.id, capabilityId: "interview-record", callId: "recording", origin, events: [
    { type: "artifact", artifact: { id: "checklist", name: "准备清单.xlsx", role: "setup", uri: "plugin-artifact://legal-labor/checklist", mediaType: "application/vnd.ms-excel" } },
    { type: "artifact", artifact: { id: "table", name: "诊断表.xlsx", role: "setup", uri: "plugin-artifact://legal-labor/table", mediaType: "application/vnd.ms-excel" } },
    { type: "interaction", request: { interactionId: "guide", type: "question", payload: { options: [{ label: "Record", value: "record" }, { label: "Upload", value: "upload" }] } } },
    { type: "interaction", request: { interactionId: "audio", type: "audio-record", payload: { title: "Recording" } } }
  ] };
  function Page() {
    const [hidden, setHidden] = useState(new Set<string>());
    const toggle = () => void pressPinnedPluginCommand({ calls: [call], pluginId: plugin.id, capabilityId: call.capabilityId,
      pinnedCapabilities: new Set([`${plugin.id}:${call.capabilityId}`]), open,
      toggleVisibility: (id) => setHidden((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }) });
    return <><button data-testid="toggle" onClick={toggle}>Toggle</button><InterviewRecordingPanel session={null} hidden={hidden.has(call.callId)} bar={
      <PluginCapabilityHost region="panel" calls={[call]} plugins={[plugin]} client={client} hiddenCallIds={hidden}
        answeredInteractions={new Set([`${plugin.id}:recording:guide`])}
        onCallHidden={(id) => setHidden((current) => new Set(current).add(id))} />
    } /></>;
  }
  try {
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="en-US"><Page /></I18nProvider></PluginUiProvider>));
    const bar = container.querySelector(".recording-bar")!;
    expect(bar).not.toBeNull();
    expect(container.textContent).not.toContain(".xlsx");
    expect(container.querySelector(".plugin-artifact-card")).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="toggle"]')!;
    await act(async () => toggle.click());
    expect(container.querySelector<HTMLElement>("section")!.style.display).toBe("none");
    expect(container.querySelector<HTMLElement>("aside")!.style.display).toBe("none");
    expect(container.querySelector(".sidebar-resize-handle")).toBeNull();
    await act(async () => toggle.click());
    expect(container.querySelector(".recording-bar")).toBe(bar);
    expect(container.textContent).not.toContain(".xlsx");
    expect(container.querySelector<HTMLElement>("aside")!.hidden).toBe(false);
    expect(container.querySelector(".sidebar-resize-handle")).not.toBeNull();
    if (origin === "user") {
      await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close card"]')!.click());
    } else {
      await act(async () => toggle.click());
    }
    expect(container.querySelector<HTMLElement>("section")!.style.display).toBe("none");
    await act(async () => toggle.click());
    expect(container.querySelector(".recording-bar")).toBe(bar);
    expect(recorder.unmount).not.toHaveBeenCalled();
    expect(recorder.cancel).not.toHaveBeenCalled();
    expect(recorder.start).not.toHaveBeenCalled();
    expect(client.cancel).not.toHaveBeenCalled();
    expect(client.respond).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("reopens diagnosis guidance beside an old recording without replacing the recorder or answering the Agent", async () => {
  const { selectVisiblePluginCalls, selectRegionPluginCalls } = await import("../plugin-capability-host.js");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = { getUi: vi.fn(), cancel: vi.fn(), respond: vi.fn() };
  const pinned = new Set([`${plugin.id}:interview-record`]);
  const old: PluginUiCall = { pluginId: plugin.id, capabilityId: "interview-record", callId: "old-guide", origin: "user", events: [
    { type: "interaction", request: { interactionId: "choice", type: "question", payload: { prompt: "Old guidance", options: ["Record"] } } },
    { type: "interaction", request: { interactionId: "audio", type: "audio-record", payload: { title: "Existing recording" } } }
  ] };
  const fresh: PluginUiCall = { ...old, callId: "new-guide", events: [
    { type: "interaction", request: { interactionId: "guide", type: "question", payload: { prompt: "Diagnosis guidance", options: ["Upload", "Record"] } } }
  ] };
  const waiting: PluginUiCall = { ...old, callId: "agent-question", capabilityId: "gap-resolve", origin: "agent", events: [
    { type: "interaction", request: { interactionId: "gap", type: "question", payload: { prompt: "Agent question", options: ["Answer"] } } }
  ] };
  const answered = new Set([`${plugin.id}:old-guide:choice`]);
  const open = vi.fn();
  function Page() {
    const [calls, setCalls] = useState([old, waiting]);
    const [hidden, setHidden] = useState(new Set<string>());
    const toggle = () => void pressPinnedPluginCommand({
      calls: selectRegionPluginCalls(selectVisiblePluginCalls(calls, answered), "pinned", pinned),
      pluginId: plugin.id, capabilityId: old.capabilityId, pinnedCapabilities: pinned,
      open: async () => { open(); setCalls((current) => [...current, fresh]); },
      toggleVisibility: (id) => setHidden((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; })
    });
    return <><button data-testid="guide" onClick={toggle}>Guide</button>
      {(["panel", "pinned", "flow"] as const).map((region) => <PluginCapabilityHost key={region} region={region}
        calls={calls} plugins={[plugin]} client={client} answeredInteractions={answered} hiddenCallIds={hidden} />)}
    </>;
  }
  try {
    vi.clearAllMocks();
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="en-US"><Page /></I18nProvider></PluginUiProvider>));
    const bar = container.querySelector(".recording-bar");
    expect(bar).not.toBeNull();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="guide"]')!;
    await act(async () => button.click());
    expect(container.textContent).toContain("Diagnosis guidance");
    expect(container.textContent).toContain("Agent question");
    expect(container.querySelector(".recording-bar")).toBe(bar);
    await act(async () => button.click());
    expect(container.querySelector<HTMLElement>(".plugin-capability-region--pinned")!.style.display).toBe("none");
    await act(async () => button.click());
    expect(container.querySelector<HTMLElement>(".plugin-capability-region--pinned")!.style.display).toBe("");
    expect(open).toHaveBeenCalledTimes(1);
    expect(recorder.unmount).not.toHaveBeenCalled();
    expect(recorder.cancel).not.toHaveBeenCalled();
    expect(client.respond).not.toHaveBeenCalled();
    expect(client.cancel).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("keeps every pending confirmation reachable when another call uses the same capability", async () => {
  const { selectCurrentPluginCalls } = await import("../plugin-capability-host.js");
  const waiting: PluginUiCall = { pluginId: plugin.id, capabilityId: "session-start", callId: "agent-waiting", conversationId: "websocket:chat-1", origin: "agent", events: [
    { type: "interaction", request: { type: "question", interactionId: "guide", payload: {} } }
  ] };
  const later: PluginUiCall = { ...waiting, callId: "user-opened", origin: "user" };
  expect(selectCurrentPluginCalls([waiting, later]).map((call) => call.callId)).toEqual([waiting.callId, later.callId]);
  const { selectPinnedToggleCall } = await import("../home-page.js");
  expect(selectPinnedToggleCall([waiting, later], plugin.id, waiting.capabilityId, new Set(), new Set([`${plugin.id}:${waiting.capabilityId}`]))).toBe(waiting.callId);
});

it("reopens the upload step after closing guidance without reopening the same closed step", async () => {
  const { pluginInteractionSignature, reconcileHiddenPluginCalls, buildLegalDiagnosisContinuation } = await import("../home-page.js");
  const call: PluginUiCall = { pluginId: plugin.id, capabilityId: "session-start", callId: "workflow", conversationId: "websocket:chat-1", origin: "agent", events: [
    { type: "interaction", request: { type: "question", interactionId: "guide", payload: {} } }
  ] };
  const hidden = new Set([call.callId]);
  const steps = new Map([[call.callId, pluginInteractionSignature(call)]]);
  expect(reconcileHiddenPluginCalls(hidden, steps, [call])).toBe(hidden);
  const next: PluginUiCall = { ...call, events: [{ type: "interaction", request: { type: "file-input", interactionId: "upload", payload: {} } }] };
  expect(reconcileHiddenPluginCalls(hidden, steps, [next]).size).toBe(0);
  const done: PluginUiCall = { ...next, events: [{ type: "result", output: { sessionId: "the-uploaded-session" } }] };
  expect(buildLegalDiagnosisContinuation(done)).toContain('sessionId="the-uploaded-session"');
  expect(buildLegalDiagnosisContinuation(done)).toContain("跳过 skill 中新建会话");
  expect(() => buildLegalDiagnosisContinuation(next)).toThrow("会话 ID");
});

it("opens only one workflow on rapid repeated presses and permits retry after failure", async () => {
  let complete!: () => void;
  const open = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
  const opening = new Set<string>();
  const options = { calls: [], pluginId: plugin.id, capabilityId: "session-start", pinnedCapabilities: new Set<string>(), toggleVisibility: vi.fn(), opening, open };
  const first = pressPinnedPluginCommand(options);
  await Promise.all([pressPinnedPluginCommand(options), pressPinnedPluginCommand(options)]);
  expect(open).toHaveBeenCalledTimes(1);
  const otherConversation = vi.fn(async () => undefined);
  await pressPinnedPluginCommand({ ...options, conversationId: "another-chat", open: otherConversation });
  expect(otherConversation).toHaveBeenCalledTimes(1);
  complete();
  await first;
  expect(opening.size).toBe(0);
  await expect(pressPinnedPluginCommand({ ...options, open: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
  expect(opening.size).toBe(0);
});

it("skips an Agent upload round on close without starting another collection", async () => {
  const { selectRegionPluginCalls } = await import("../plugin-capability-host.js");
  const { selectOpenPinnedCapabilities } = await import("../home-page.js");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = { getUi: vi.fn(), cancel: vi.fn(), respond: vi.fn(async () => undefined) };
  const open = vi.fn(async () => undefined);
  const pinned = new Set(["legal-labor:material-collect"]);
  const legal = { ...plugin, manifest: { ...plugin.manifest, commands: [
    ...(plugin.manifest.commands ?? []), { command: "/legal-record", name: "Record", description: "Record", capabilityId: "material-collect", pinned: true }
  ] } };
  const upload: PluginUiCall = { pluginId: plugin.id, capabilityId: "material-collect", callId: "agent-upload",
    conversationId: "chat", origin: "agent", events: [{ type: "interaction", request: {
      interactionId: "upload", type: "file-input", payload: { title: "Supplement diagnosis materials", multiple: true }
    } }] };
  expect(selectRegionPluginCalls([upload], "flow", pinned)).toEqual([]);
  expect(selectRegionPluginCalls([upload], "pinned", pinned)).toEqual([upload]);
  expect(selectOpenPinnedCapabilities([upload], new Set(), pinned)).toEqual(new Set(["legal-labor:material-collect"]));
  function Page() {
    const [hidden, setHidden] = useState(new Set<string>());
    const hide = (id: string) => setHidden((current) => new Set(current).add(id));
    return <><button data-testid="guide" onClick={() => void pressPinnedPluginCommand({
      calls: [upload], pluginId: plugin.id, capabilityId: "material-collect", pinnedCapabilities: pinned,
      open, toggleVisibility: (id) => setHidden((current) => {
        const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next;
      })
    })}>Guide</button><PluginCapabilityHost calls={[upload]} plugins={[legal]} client={client}
      region="pinned" hiddenCallIds={hidden} onCallHidden={hide} /></>;
  }
  try {
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="en-US"><Page /></I18nProvider></PluginUiProvider>));
    const button = container.querySelector<HTMLButtonElement>('[data-testid="guide"]')!;
    const card = container.querySelector(".diagnostic-upload-card");
    expect(card).not.toBeNull();
    for (let index = 0; index < 6; index++) await act(async () => button.click());
    expect(container.querySelectorAll(".diagnostic-upload-card")).toHaveLength(1);
    expect(container.querySelector(".diagnostic-upload-card")).toBe(card);
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Close card"]')!.click());
    expect(container.querySelector(".diagnostic-upload-card")).toBeNull();
    expect(open).not.toHaveBeenCalled();
    expect(client.respond).toHaveBeenCalledWith(plugin.id, "agent-upload", "upload", { action: "skip", files: [] });
    expect(client.cancel).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); container.remove(); }
});

it.each([false, true])("automatically lists saved recording files, scopes them to the chat and avoids another upload (already collected: %s)", async (collected) => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let ui!: ReturnType<typeof usePluginUi>;
  const respond = vi.fn(async () => undefined); const upload = vi.fn();
  const receipts = [
    { kind: "audio" as const, path: "/media/audio.webm", name: "访谈录音.webm", mime: "audio/webm" as const, bytes: 10, url: "/audio", collected },
    { kind: "file" as const, path: "/media/transcript.txt", name: "访谈转写.txt", mime: "text/plain" as const, bytes: 20, url: "/text", collected }
  ];
  const call: PluginUiCall = { pluginId: plugin.id, capabilityId: "material-collect", callId: "upload-files", conversationId: "chat-materials", origin: "agent",
    events: [{ type: "interaction", request: { type: "file-input", interactionId: "files", payload: { title: "补充诊断材料", multiple: true } } }] };
  const legal = { ...plugin, manifest: { ...plugin.manifest, commands: [
    { command: "/legal-guide", name: "Guide", description: "Guide", capabilityId: "session-start", pinned: true }
  ] } };
  function Page() { ui=usePluginUi(); return <PluginCapabilityHost calls={[call]} plugins={[legal]} region="pinned"
    client={{ respond, cancel: vi.fn(), getUi: vi.fn() }} uploadFiles={upload} />; }
  try {
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="zh-CN"><Page /></I18nProvider></PluginUiProvider>));
    await act(async () => ui.addRecordingMaterials(plugin.id, "another-chat", receipts));
    expect(container.querySelectorAll(".diagnostic-upload-card__file")).toHaveLength(0);
    await act(async () => { ui.addRecordingMaterials(plugin.id, "websocket:chat-materials", receipts); ui.addRecordingMaterials(plugin.id, "chat-materials", receipts); });
    expect(container.querySelectorAll(".diagnostic-upload-card__file")).toHaveLength(2);
    expect(container.textContent).toContain("访谈转写.txt");
    const submit=container.querySelector<HTMLButtonElement>(".diagnostic-upload-card__footer button")!;
    expect(submit.disabled).toBe(false);
    await act(async () => { submit.click(); submit.click(); });
    expect(upload).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(plugin.id, call.callId, "files", { files: collected ? [] : receipts.map(({ collected: _collected, ...file }) => file) });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("lets the user submit while a staged recording is still transcribing, then continues with its transcript", async () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let ui!: ReturnType<typeof usePluginUi>;
  const respond = vi.fn(async () => undefined);
  const audio = { kind: "audio" as const, path: "/media/interview.webm", name: "访谈录音.webm", mime: "audio/webm" as const, bytes: 10, url: "/audio" };
  const transcriptFile = { kind: "file" as const, path: "/media/interview.txt", name: "访谈转写-2026-10-15T00-00-00-000Z.txt", mime: "text/plain" as const, bytes: 20, url: "/text" };
  const call: PluginUiCall = { pluginId: plugin.id, capabilityId: "material-collect", callId: "pending-upload", conversationId: "chat-pending", origin: "agent",
    events: [{ type: "interaction", request: { type: "file-input", interactionId: "files", payload: { title: "补充诊断材料", multiple: true } } }] };
  let finish!: () => void;
  function Page() { ui=usePluginUi(); return <PluginCapabilityHost calls={[call]} plugins={[plugin]} region="pinned"
    client={{ respond, cancel: vi.fn(), getUi: vi.fn() }} uploadFiles={vi.fn()} />; }
  try {
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="zh-CN"><Page /></I18nProvider></PluginUiProvider>));
    await act(async () => {
      ui.startTranscription(audio.path, () => new Promise((resolve) => {
        finish = () => resolve({ text: "现场访谈内容", segments: [], transcribedAt: "2026-10-14T00:00:00Z", transcriptFile });
      }));
      // The row stands for the transcript ASR is still writing, not the audio.
      ui.addRecordingMaterials(plugin.id, "chat-pending", [{
        kind: "file", path: audio.path, url: audio.url, name: transcriptFile.name, mime: "text/plain", bytes: 0,
        collected: false, pending: true, pendingAudio: audio
      }]);
    });
    // Listed and submittable while ASR is still running.
    expect(container.querySelectorAll(".diagnostic-upload-card__file")).toHaveLength(1);
    expect(container.textContent).toContain(transcriptFile.name);
    expect(container.textContent).toContain("正在转写");
    const submit = container.querySelector<HTMLButtonElement>(".diagnostic-upload-card__footer button")!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    // Pressing it does not send a gap where the interview should be.
    expect(respond).not.toHaveBeenCalled();
    expect(container.textContent).toContain("完成后会自动继续");
    await act(async () => finish());
    // The plugin never saw this recording, so its transcript arrives as the
    // file itself — not also as attached text, which would double it.
    expect(respond).toHaveBeenCalledWith(plugin.id, call.callId, "files", {
      files: [transcriptFile], recordingDeliverables: [audio, transcriptFile]
    });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("attaches a staged recording's transcript to the recording the plugin already holds", async () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let ui!: ReturnType<typeof usePluginUi>;
  const respond = vi.fn(async () => undefined);
  const open = vi.fn();
  const audio = { kind: "audio" as const, path: "/media/handed.webm", name: "访谈录音.webm", mime: "audio/webm" as const, bytes: 10, url: "/audio" };
  const transcriptFile = { kind: "file" as const, path: "/media/handed.txt", name: "访谈转写-2026-10-15T00-00-00-000Z.txt", mime: "text/plain" as const, bytes: 20, url: "/text" };
  const call: PluginUiCall = { pluginId: plugin.id, capabilityId: "material-collect", callId: "collected-upload", conversationId: "chat-collected", origin: "agent",
    events: [{ type: "interaction", request: { type: "file-input", interactionId: "files", payload: { title: "补充诊断材料", multiple: true } } }] };
  function Page() { ui=usePluginUi(); return <PluginCapabilityHost calls={[call]} plugins={[plugin]} region="pinned"
    client={{ respond, cancel: vi.fn(), getUi: vi.fn() }} uploadFiles={vi.fn()} onOpenArtifact={open} />; }
  try {
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="zh-CN"><Page /></I18nProvider></PluginUiProvider>));
    await act(async () => {
      ui.startTranscription(audio.path, async () => ({ text: "现场访谈内容", segments: [], transcribedAt: "2026-10-14T00:00:00Z", transcriptFile }));
      ui.addRecordingMaterials(plugin.id, "chat-collected", [{
        kind: "file", path: audio.path, url: audio.url, name: transcriptFile.name, mime: "text/plain", bytes: 0,
        collected: true, pending: true, pendingAudio: audio
      }, { ...transcriptFile, collected: true }]);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const row = container.querySelector(".diagnostic-upload-card__file")!;
    expect(container.querySelectorAll(".diagnostic-upload-card__file")).toHaveLength(1);
    expect(row.textContent).toContain("20 B");
    await act(async () => row.querySelector<HTMLButtonElement>(".diagnostic-upload-card__file-info button")!.click());
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ path: transcriptFile.path, name: transcriptFile.name }));
    await act(async () => container.querySelector<HTMLButtonElement>(".diagnostic-upload-card__footer button")!.click());
    expect(respond).toHaveBeenCalledWith(plugin.id, call.callId, "files", {
      files: [],
      transcripts: { [audio.path]: { text: "现场访谈内容", segments: [] } },
      recordingDeliverables: [audio, transcriptFile]
    });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps a lightweight retry action after automatic transcription retries are spent", async () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  let ui!: ReturnType<typeof usePluginUi>;
  const respond = vi.fn(async () => undefined);
  const audio = { kind: "audio" as const, path: "/media/broken.webm", name: "访谈录音.webm", mime: "audio/webm" as const, bytes: 10, url: "/audio" };
  const transcriptFile = { kind: "file" as const, path: "/media/recovered.txt", name: "访谈转写.txt", mime: "text/plain" as const, bytes: 20, url: "/text" };
  const call: PluginUiCall = { pluginId: plugin.id, capabilityId: "material-collect", callId: "failed-upload", conversationId: "chat-failed", origin: "agent",
    events: [{ type: "interaction", request: { type: "file-input", interactionId: "files", payload: { title: "补充诊断材料", multiple: true } } }] };
  let attempts = 0;
  const attempt = vi.fn(async () => {
    if (++attempts <= 3) throw new Error("ASR down");
    return { text: "现场访谈内容", segments: [], transcribedAt: "2026-10-27T00:00:00Z", transcriptFile };
  });
  function Page() { ui=usePluginUi(); return <PluginCapabilityHost calls={[call]} plugins={[plugin]} region="pinned"
    client={{ respond, cancel: vi.fn(), getUi: vi.fn() }} uploadFiles={vi.fn()} />; }
  try {
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="zh-CN"><Page /></I18nProvider></PluginUiProvider>));
    await act(async () => {
      ui.startTranscription(audio.path, attempt);
      ui.addRecordingMaterials(plugin.id, "chat-failed", [{ ...audio, collected: true, pending: true }]);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("转写失败（已自动重试 3 次）");
    await act(async () => container.querySelector<HTMLButtonElement>(".diagnostic-upload-card__footer button")!.click());
    expect(respond).not.toHaveBeenCalled();
    const actions = [...container.querySelectorAll<HTMLButtonElement>(".diagnostic-upload-card__transcription button")];
    expect(actions.map((button) => button.textContent)).toEqual(["重试转写"]);
    expect(actions[0]?.disabled).toBe(false);
    await act(async () => actions[0]!.click());
    expect(attempt).toHaveBeenCalledTimes(4);
    expect(respond).toHaveBeenCalledWith(plugin.id, call.callId, "files", {
      files: [], transcripts: { [audio.path]: { text: "现场访谈内容", segments: [] } },
      recordingDeliverables: [transcriptFile]
    });
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it("keeps the microphone owner mounted while its composer bar is occluded", async () => {
  const { RecordingBarPortalContext } = await import("../plugin-capability-host.js");
  vi.clearAllMocks();
  const container = document.createElement("div"); const dock = document.createElement("div"); document.body.append(container, dock);
  const root = createRoot(container);
  const call: PluginUiCall = { pluginId: plugin.id, capabilityId: "interview-record", callId: "portal-recorder", conversationId: "chat", origin: "agent",
    events: [{ type: "interaction", request: { interactionId: "audio", type: "audio-record", payload: {} } }] };
  const client = { getUi: vi.fn(), cancel: vi.fn(), respond: vi.fn(async () => undefined) };
  const render = (hidden: boolean) => <I18nProvider language="en-US"><RecordingBarPortalContext.Provider value={{ target: dock, hidden }}>
    <InterviewRecordingPanel hidden session={null} bar={<PluginCapabilityHost region="panel" calls={[call]} plugins={[plugin]} client={client} />} />
  </RecordingBarPortalContext.Provider></I18nProvider>;
  try {
    await act(async () => root.render(render(false)));
    const bar = dock.querySelector(".recording-bar"); expect(bar).not.toBeNull();
    expect(container.querySelector(".recording-bar")).toBeNull();
    await act(async () => root.render(render(true)));
    expect(dock.firstElementChild?.getAttribute("hidden")).toBe("");
    await act(async () => root.render(render(false)));
    expect(dock.querySelector(".recording-bar")).toBe(bar);
    expect(recorder.unmount).not.toHaveBeenCalled(); expect(recorder.cancel).not.toHaveBeenCalled();
    expect(client.cancel).not.toHaveBeenCalled(); expect(client.respond).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); container.remove(); dock.remove(); }
});

it("does not show a diagnosis report until the assistant delivers it", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const report: PluginUiCall = { pluginId: plugin.id, capabilityId: "report-render", callId: "report-final",
    conversationId: "chat-1", origin: "agent", events: [
      { type: "artifact", artifact: { id: "final", name: "企业-诊断报告.docx", role: "deliverable",
        uri: "plugin-artifact://legal-labor/final", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", path: "/ws/report.docx" } },
      { type: "result", output: {} }
    ] };
  try {
    await act(async () => root.render(<PluginUiProvider><I18nProvider language="zh-CN">
      <PluginCapabilityHost region="flow" calls={[report]} plugins={[plugin]}
        client={{ getUi: vi.fn(), cancel: vi.fn(), respond: vi.fn() }} />
    </I18nProvider></PluginUiProvider>));
    expect(container.querySelector(".agent-delivered-files")).toBeNull();
    expect(container.textContent ?? "").not.toContain("企业-诊断报告");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it.each(["user", "agent"] as const)("keeps %s review failures in their owning result surface", async (origin) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const failed: PluginUiCall = { pluginId: "literature-review", capabilityId: "review_fetch_fulltext", callId: "failed", origin, events: [{ type: "error", code: "download_failed", message: "全文获取失败" }] };
  const render = async (calls: PluginUiCall[]) => act(async () => root.render(<I18nProvider language="zh-CN"><PluginCapabilityHost calls={calls} plugins={[]} /></I18nProvider>));
  try {
    await render([failed]);
    if (origin === "user") expect(container.querySelector('[role="alert"]')?.textContent).toContain("全文获取失败");
    else expect(container.textContent).not.toContain("全文获取失败");
    await render([failed, { ...failed, callId: "recovered", events: [{ type: "result", output: { ok: true } }] }]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); }
});
