// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { InstalledPluginSchema } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { PluginCapabilityHost } from "../plugin-capability-host.js";
import { RecordingEntryPage, useRecordingEntry, type RecordingEntryController } from "../recording-entry.js";
import { readRecordingArchive, saveRecordingArchiveEntry } from "../../lib/recording-archive.js";
import { PluginUiProvider, usePluginUi, type PluginUiCall } from "../../app/plugin-ui-context.js";
import type { RecordingPanelSession } from "../interview-recording-panel.js";

const mock = vi.hoisted(() => ({ status: "idle", isRecording: false, isStarting: false, isTranscribing: false,
  error: null, start: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn(), stop: vi.fn(), finishAndTranscribe: vi.fn() }));
vi.mock("../asr-recorder.js", async (original) => ({ ...await original<typeof import("../asr-recorder.js")>(), useAsrRecorder: () => mock }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

it("removes a local recording and transcript only after the row's confirmation succeeds", async () => {
  const scope = `recording-delete-${crypto.randomUUID()}`;
  const audioPath = "/workspace/recordings/interview.webm";
  const transcriptPath = "/workspace/recordings/interview.txt";
  saveRecordingArchiveEntry(scope, {
    id: "recording-1", title: "现场访谈", recordedAt: "2026-10-26T11:00:00Z",
    durationMs: 4_000, speakerCount: 1, audioUrl: null, audioPath,
    transcript: { text: "记录", segments: [] },
    files: [
      { path: audioPath, name: "interview.webm", kind: "audio", mime: "audio/webm", bytes: 10, url: "" },
      { path: transcriptPath, name: "interview.txt", kind: "file", mime: "text/plain", bytes: 6, url: "" }
    ]
  });
  const deleteFiles = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  let controller!: RecordingEntryController;
  function Page() {
    controller = useRecordingEntry({} as never, undefined, undefined, {
      scope, resolveAudio: async () => null, deleteFiles
    });
    return <RecordingEntryPage session={controller.session} />;
  }
  try {
    await act(async () => root.render(<I18nProvider language="zh-CN"><Page /></I18nProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__more-trigger")!.click());
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes("删除"))!.click());
    expect(deleteFiles).not.toHaveBeenCalled();
    expect(container.textContent).toContain("删除本地录音和转写文件？");
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__delete-confirm-action")!.click());
    expect(readRecordingArchive(scope)).toHaveLength(1);
    expect(container.textContent).toContain("offline");
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__delete-confirm-action")!.click());
    expect(deleteFiles).toHaveBeenLastCalledWith([audioPath, transcriptPath]);
    expect(readRecordingArchive(scope)).toHaveLength(0);
    expect(container.querySelectorAll(".recording-page__list-row")).toHaveLength(0);
  } finally {
    await act(async () => root.unmount()); container.remove();
    window.localStorage.removeItem(`memmy.recordingArchive.v1:${scope}`);
  }
});

it("archives a guidance recording before its card disappears, reopens it from the list and retains it across route remounts", async () => {
  const storage=new Map<string,string>();
  Object.defineProperty(window,"localStorage",{ configurable:true,value:{
    getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),
    removeItem:(key:string)=>storage.delete(key),clear:()=>storage.clear()
  } });
  const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
  let controller!: RecordingEntryController;let panel: RecordingPanelSession | null=null;
  const scope=`recording-integration-${crypto.randomUUID()}`;
  // The audio is stored the moment the interview stops, the transcript file
  // once ASR has finished — two separate uploads.
  const upload=vi.fn(async (files: Array<{ kind: string }>) => files.map((file) => file.kind === "audio"
    ? { kind: "audio" as const, path: "/media/interview.webm", name: "访谈录音.webm", mime: "audio/webm" as const, bytes: 10, url: "http://127.0.0.1/api/media/initial/audio" }
    : { kind: "file" as const, path: "/media/interview.txt", name: "访谈转写.txt", mime: "text/plain" as const, bytes: 10, url: "http://127.0.0.1/api/media/initial/text" }));
  const asr={ transcribe: vi.fn(async () => ({ text:"录音测试",segments:[],transcribedAt:"2026-10-12T06:58:14Z",modelId:"asr",provider:"memmy_account" as const,source:"account" as const })) };
  const resolveAudio=vi.fn(async () => "http://127.0.0.1/api/media/renewed/audio");
  const respond=vi.fn(async () => {});
  const plugin=InstalledPluginSchema.parse({ id:"legal-labor",version:"1.0.0",state:"active",config:{},approvedPermissions:[],lastError:null,
    createdAt:"2026-10-12T00:00:00.000Z",updatedAt:"2026-10-12T00:00:00.000Z",manifest:{apiVersion:"memmy/v1",id:"legal-labor",name:"法律",version:"1.0.0",
      runtime:{adapter:"http"},permissions:[],capabilities:[{id:"session-start",name:"诊断",description:"开始诊断",inputSchema:{},outputSchema:{},execution:"job"}],
      commands:[{command:"/legal-guide",name:"诊断指引",description:"诊断指引",capabilityId:"session-start",pinned:true}] } });
  const call: PluginUiCall={ pluginId: "legal-labor", capabilityId: "session-start", callId: "interview-call", conversationId: "chat-test", origin: "agent",
    events: [{ type: "interaction", request: { interactionId: "interview-question", type: "audio-record", payload: { title: "访谈录音" } } }] };
  function Page() {
    controller=useRecordingEntry({} as never,upload as never,undefined,{ scope,sessionKey:"websocket:chat-test",resolveAudio });
    const [calls,setCalls]=useState([call]);
    const ui=usePluginUi();
    const client={ respond: async (_plugin: string, _call: string, interactionId: string) => {
      expect(readRecordingArchive(scope)).toHaveLength(1);
      await respond();
      setCalls(interactionId === "interview-question" ? [{ ...call, events: [{ type:"interaction", request:{
        type:"file-input", interactionId:"material-files", payload:{title:"补充诊断材料", multiple:true}
      } }] }] : []);
    } };
    return <>
      <PluginCapabilityHost region="panel" calls={calls} plugins={[plugin]} client={client as never} asrClient={asr as never} uploadFiles={upload as never}
        onRecordingArchived={(entry) => {
          controller.archive(entry);
          // As selectRecordingMaterialFiles does: a handed-over recording is already its own row.
          if (!entry.handedOver) ui.addRecordingMaterials("legal-labor", entry.sessionKey!, (entry.files ?? []).map((file) => ({...file,collected:entry.collected === true})));
        }} onRecordingSession={(value) => { panel=value; }} />
      <PluginCapabilityHost region="pinned" calls={calls} plugins={[plugin]} client={client as never} uploadFiles={upload as never} />
      <button data-testid="back" onClick={() => controller.toggle()}>返回</button>
      {controller.open ? <RecordingEntryPage session={controller.session} /> : null}
    </>;
  }
  mock.status="idle";mock.isRecording=false;
  mock.start.mockImplementation(async () => { mock.status="recording";mock.isRecording=true; });
  mock.stop.mockImplementation(async () => { mock.status="idle";mock.isRecording=false;
    return { recording:new Blob(["audio"],{ type:"audio/webm" }),recordingMimeType:"audio/webm",durationMs:4000 }; });
  const render=async (shown=true) => act(async () => root.render(<PluginUiProvider><I18nProvider language="zh-CN">{shown ? <Page /> : <span>设置</span>}</I18nProvider></PluginUiProvider>));
  try {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-bar__button--primary")!.click());
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-bar__button--primary")!.click());
    // Answered straight away, before the transcript exists: the upload card
    // lists the interview itself and can be submitted.
    expect(respond).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll(".diagnostic-upload-card__file")).toHaveLength(1);
    expect(container.querySelector(".diagnostic-upload-card")?.textContent).toContain("录音转写-");
    expect(container.querySelector<HTMLButtonElement>(".diagnostic-upload-card__footer button")!.disabled).toBe(false);
    await act(async () => container.querySelector<HTMLButtonElement>(".diagnostic-upload-card__footer button")!.click());
    expect(respond).toHaveBeenCalledTimes(2);
    expect(asr.transcribe).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(panel!.audioUrl).toBe("http://127.0.0.1/api/media/initial/audio");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="back"]')!.click());
    expect(container.querySelectorAll(".recording-page__list-row")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>(".recording-page__list-open")!.click());
    expect(container.textContent).toContain("录音测试");
    expect(resolveAudio).toHaveBeenCalledWith(expect.objectContaining({ audioPath:"/media/interview.webm",sessionKey:"websocket:chat-test" }));
    expect(container.querySelector("audio")?.getAttribute("src")).toContain("renewed/audio");
    const player=container.querySelector("audio")!;
    Object.defineProperty(player,"duration",{configurable:true,value:Infinity});
    await act(async () => player.dispatchEvent(new Event("loadedmetadata")));
    expect(container.querySelectorAll(".recording-panel__player-time")[1]?.textContent).toBe("00:04");
    expect(container.querySelector<HTMLInputElement>('input[type="range"]')?.max).toBe("4000");
    await render(false);await render();
    expect(controller.session.recordings).toHaveLength(1);
    const saved=window.localStorage.getItem(`memmy.recordingArchive.v1:${scope}`)!;
    expect(saved).toContain("/media/interview.webm");
    expect(saved).not.toContain("/api/media/");expect(saved).not.toContain("blob:");
    expect(readRecordingArchive(`${scope}-other-account`)).toHaveLength(0);
    // A new renderer must read the persisted path, not reuse a previous URL.
    vi.resetModules();
    const restarted=await import("../../lib/recording-archive.js");
    const restored=restarted.readRecordingArchive(scope);
    expect(restored).toHaveLength(1);expect(restored[0]?.audioUrl).toBeNull();
    expect(restored[0]?.transcript.text).toBe("录音测试");
    expect(restored[0]?.files?.map((file)=>file.name)).toEqual(["访谈录音.webm","访谈转写.txt"]);
  } finally { await act(async () => root.unmount());window.localStorage.removeItem(`memmy.recordingArchive.v1:${scope}`); }
});


it("automatically stages a recording from the compact/list controller into the current diagnosis without another upload", async () => {
  vi.clearAllMocks(); mock.status="idle"; mock.isRecording=false;
  const storage=new Map<string,string>();
  Object.defineProperty(window,"localStorage",{configurable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}});
  const container=document.createElement("div"); document.body.append(container); const root=createRoot(container);
  let controller!: RecordingEntryController;
  const scope=`compact-materials-${crypto.randomUUID()}`;
  const receipts=[
    {kind:"audio" as const,path:"/compact/audio.webm",name:"现场录音.webm",mime:"audio/webm" as const,bytes:10,url:"/audio"},
    {kind:"file" as const,path:"/compact/transcript.txt",name:"现场转写.txt",mime:"text/plain" as const,bytes:20,url:"/text"}
  ];
  const upload=vi.fn(async()=>receipts); const respond=vi.fn(async()=>undefined);
  const plugin=InstalledPluginSchema.parse({id:"legal-labor",version:"1.0.0",state:"active",config:{},approvedPermissions:[],lastError:null,
    createdAt:"2026-10-13T00:00:00Z",updatedAt:"2026-10-13T00:00:00Z",manifest:{apiVersion:"memmy/v1",id:"legal-labor",name:"法律",version:"1.0.0",
      runtime:{adapter:"http"},permissions:[],capabilities:[{id:"session-start",name:"开始",description:"开始",inputSchema:{},outputSchema:{},execution:"job"}],
      commands:[{command:"/guide",name:"指引",description:"指引",capabilityId:"session-start",pinned:true}]}});
  const call:PluginUiCall={pluginId:plugin.id,callId:"compact-upload",capabilityId:"material-collect",conversationId:"compact-chat",origin:"agent",
    events:[{type:"interaction",request:{type:"file-input",interactionId:"files",payload:{title:"补充诊断材料",multiple:true}}}]};
  function Page(){
    const ui=usePluginUi();
    controller=useRecordingEntry({} as never,upload,undefined,{scope,sessionKey:"websocket:compact-chat",resolveAudio:async()=>null,
      onArchived:entry=>ui.addRecordingMaterials(plugin.id,entry.sessionKey!,entry.files??[])});
    return <PluginCapabilityHost region="pinned" calls={[call]} plugins={[plugin]} client={{respond} as never} uploadFiles={upload}/>;
  }
  mock.start.mockImplementation(async()=>{mock.status="recording";mock.isRecording=true;});
  mock.finishAndTranscribe.mockImplementation(async()=>{mock.status="idle";mock.isRecording=false;return {recording:new Blob(["audio"]),recordingMimeType:"audio/webm",durationMs:3000,text:"访谈内容",segments:[],transcribedAt:"2026-10-13T03:00:00Z"};});
  try{
    await act(async()=>root.render(<PluginUiProvider><I18nProvider language="zh-CN"><Page/></I18nProvider></PluginUiProvider>));
    await act(async()=>controller.session.start());
    await act(async()=>controller.session.finish());
    expect(container.querySelectorAll(".diagnostic-upload-card__file")).toHaveLength(2);
    await act(async()=>container.querySelector<HTMLButtonElement>(".diagnostic-upload-card__footer button")!.click());
    expect(upload).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(plugin.id,call.callId,"files",{files:receipts});
  }finally{await act(async()=>root.unmount());window.localStorage.removeItem(`memmy.recordingArchive.v1:${scope}`);}
});
