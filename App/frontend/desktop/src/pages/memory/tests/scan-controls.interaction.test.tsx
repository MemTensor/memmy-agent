// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppClients } from "../../../api/client-types.js";
import { AppProviders, useApiClients } from "../../../app/providers.js";
import { useAppState } from "../../../state/app-state.js";
import { appActions as a } from "../../../state/app-actions.js";
import { SourcesSubPage } from "../sources-sub-page.js";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const progress = (sequence: number, phase: "scan" | "stopped" = "scan") => ({ jobId: "job", attemptId: "a", sourceId: "all", version: { generation: 1, sequence }, phase, current: 2, total: 10 });
const status = (sequence: number, phase: "scan" | "stopped" = "scan") => ({ active: phase === "scan", progress: progress(sequence, phase), version: { generation: 1, sequence } });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let root: Root, container: HTMLDivElement, stateApi: ReturnType<typeof useAppState>;
let clients: AppClients;
let legacyService = false;
function Harness() {
  const { setClients } = useApiClients(); stateApi = useAppState();
  useEffect(() => { setClients(clients); stateApi.dispatch(a.agentSourceScanProgressReceived({ ...progress(1), ...(legacyService ? { version: undefined, attemptId: undefined } : {}) })); }, [setClients]);
  return <SourcesSubPage />;
}
beforeEach(() => {
  legacyService = false;
  vi.useFakeTimers();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  clients = { runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "test", memory: { baseUrl: "http://127.0.0.1:18960" } },
    localData: { getPath: async () => ({ ok: true, dataPath: "/test" }) }, memoryRuntime: { health: async () => ({ ok: true, storage: { ready: true } }) },
    config: { updateOnboarding: async () => ({ scanPermission: "scan_only" }), getScanPreferences: async () => ({ autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false }) },
    agentSources: { listSources: vi.fn(async () => []), getScanStatus: vi.fn(async () => status(1)), stopScan: vi.fn(), cancelScan: vi.fn(), startScan: vi.fn() }
  } as unknown as AppClients;
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
const mount = async () => { await act(async () => { root.render(<AppProviders><Harness /></AppProviders>); }); };
const button = (label: string) => { const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label")?.includes(label)); if (!found) throw new Error(`missing ${label}`); return found; };
it("cancels an older service using its post-control idle query and rejects delayed progress", async () => {
  legacyService = true;
  vi.mocked(clients.agentSources.cancelScan).mockResolvedValue({ ok: true });
  vi.mocked(clients.agentSources.getScanStatus).mockResolvedValue({ active: false, progress: null });
  await mount();
  await act(async () => { button("停止").click(); });
  expect(clients.agentSources.getScanStatus).toHaveBeenCalled();
  expect(stateApi.state.agentSources.scanProgress).toBeNull();
  expect(stateApi.state.agentSources.isScanning).toBe(false);
  expect(stateApi.state.agentSources.scanControl).toBeNull();
  await act(async () => { stateApi.dispatch(a.agentSourceScanProgressReceived({ ...progress(1), version: undefined, attemptId: undefined })); });
  expect(stateApi.state.agentSources.scanProgress).toBeNull();
});
it("1/2/4: pause, resume and cancel apply snapshots and reject late states", async () => {
  await mount();
  const pause = deferred<Awaited<ReturnType<AppClients["agentSources"]["stopScan"]>>>();
  vi.mocked(clients.agentSources.stopScan).mockReturnValue(pause.promise);
  await act(async () => { button("暂停").click(); });
  expect(stateApi.state.agentSources.scanProgress?.phase).toBe("scan"); expect(button("暂停").disabled).toBe(true);
  await act(async () => { pause.resolve({ ok: true, outcome: "applied", snapshot: status(2, "stopped") }); });
  expect(clients.agentSources.stopScan).toHaveBeenCalledWith({ expectedExecution: { jobId: "job", attemptId: "a" } });
  await act(async () => { stateApi.dispatch(a.agentSourceScanProgressReceived(progress(1))); });
  expect(button("继续").disabled).toBe(false);
  vi.mocked(clients.agentSources.startScan).mockResolvedValue({ jobId: "job", attemptId: "a", version: { generation: 1, sequence: 3 } });
  vi.mocked(clients.agentSources.getScanStatus).mockResolvedValue(status(3));
  await act(async () => { button("继续").click(); });
  await act(async () => { stateApi.dispatch(a.agentSourceScanProgressReceived(progress(2, "stopped"))); });
  expect(button("暂停").disabled).toBe(false);
  vi.mocked(clients.agentSources.cancelScan).mockResolvedValue({ ok: true, outcome: "applied", snapshot: { active: false, progress: null, status: "cancelled", version: { generation: 1, sequence: 4 }, execution: { jobId: "job", attemptId: "a" } } });
  await act(async () => { button("停止").click(); });
  await act(async () => { stateApi.dispatch(a.agentSourceScanProgressReceived(progress(3))); });
  expect(stateApi.state.agentSources.scanProgress).toBeNull(); expect(stateApi.state.agentSources.isScanning).toBe(false);
});
it("3: normal completion is accepted while pause is pending; old response cannot undo it", async () => {
  await mount(); const pause = deferred<Awaited<ReturnType<AppClients["agentSources"]["stopScan"]>>>();
  vi.mocked(clients.agentSources.stopScan).mockReturnValue(pause.promise);
  await act(async () => { button("暂停").click(); });
  await act(async () => { stateApi.dispatch(a.agentSourceScanCompleted({ ...progress(3), succeeded: true, completedAt: "2026-10-21T00:01:00Z" })); });
  expect(stateApi.state.agentSources.scanControl).toBeNull(); expect(stateApi.state.agentSources.recentScanCompletions).toHaveLength(1);
  await act(async () => { pause.resolve({ ok: true, snapshot: status(2, "stopped") }); });
  expect(stateApi.state.agentSources.scanProgress).toBeNull(); expect(stateApi.state.agentSources.recentScanCompletions).toHaveLength(1);
});
it("6: delayed source list does not remove scanning progress", async () => {
  const list = deferred<never[]>(); vi.mocked(clients.agentSources.listSources).mockReturnValue(list.promise);
  await mount(); await act(async () => { stateApi.dispatch(a.agentSourceScanProgressReceived(progress(3))); list.resolve([]); });
  expect(stateApi.state.agentSources.scanProgress).toEqual(progress(3)); expect(button("暂停").disabled).toBe(false);
});
it("control failure leaves running state and releases the button", async () => {
  await mount(); vi.mocked(clients.agentSources.stopScan).mockRejectedValue(new Error("offline"));
  await act(async () => { button("暂停").click(); });
  expect(stateApi.state.agentSources.scanProgress).toEqual(progress(1)); expect(button("暂停").disabled).toBe(false);
});

it("accepts a successful legacy resume without accepting unsolicited running progress", async () => {
  legacyService = true;
  await mount();
  const paused = { ...progress(2, "stopped"), version: undefined, attemptId: undefined };
  await act(async () => { stateApi.dispatch(a.agentSourceScanProgressReceived(paused)); });
  const running = { ...paused, phase: "scan" as const };
  await act(async () => { stateApi.dispatch(a.agentSourceScanProgressReceived(running)); });
  expect(stateApi.state.agentSources.scanProgress?.phase).toBe("stopped");
  vi.mocked(clients.agentSources.startScan).mockRejectedValueOnce(new Error("offline"));
  vi.mocked(clients.agentSources.getScanStatus).mockResolvedValue({ active: false, progress: paused });
  await act(async () => { button("继续").click(); });
  expect(stateApi.state.agentSources.scanProgress?.phase).toBe("stopped");
  vi.mocked(clients.agentSources.startScan).mockResolvedValue({ jobId: "job" });
  vi.mocked(clients.agentSources.getScanStatus).mockResolvedValue({ active: true, progress: running });
  await act(async () => { button("继续").click(); });
  expect(stateApi.state.agentSources.scanProgress?.phase).toBe("scan");
  expect(button("暂停").disabled).toBe(false);
});

it("adjacent: resume must not reuse a previous full scan mode for an external incremental task", async () => {
 await mount();
 await act(async () => {stateApi.dispatch(a.agentSourceScanStatusReceived({active:false,progress:null,status:"cancelled",version:{generation:1,sequence:2},execution:{jobId:"job",attemptId:"a"}}));});
 const clickText=async (label:string)=>{await act(async()=>{const b=[...container.querySelectorAll<HTMLButtonElement>("button")].find(x=>x.textContent?.includes(label));if(!b)throw Error("missing "+label);b.click();});};
 vi.mocked(clients.agentSources.startScan).mockResolvedValue({jobId:"full",attemptId:"f"});
 vi.mocked(clients.agentSources.getScanStatus).mockResolvedValue({active:true,progress:{...progress(3),jobId:"full",attemptId:"f"},version:{generation:1,sequence:3}});
 await clickText("高级");await clickText("扫描全部历史");
 await act(async()=>{(container.querySelector('input[type="radio"]') as HTMLElement).click();});
 await clickText("开始全量扫描");
 expect(clients.agentSources.startScan).toHaveBeenLastCalledWith(expect.objectContaining({mode:"full"}));
 await act(async()=>{stateApi.dispatch(a.agentSourceScanProgressReceived({...progress(5,"stopped"),jobId:"external-incremental",attemptId:"e",mode:"incremental"}));});
 vi.mocked(clients.agentSources.startScan).mockClear();
 await act(async()=>{button("继续").click();});
 expect(vi.mocked(clients.agentSources.startScan).mock.calls[0]?.[0].mode).toBe("incremental");
});


it.each(["full", "incremental", "initial_subset"] as const)("resumes the service-confirmed %s mode after page remount", async mode => {
  await mount();
  await act(async () => { stateApi.dispatch(a.agentSourceScanProgressReceived({ ...progress(2, "stopped"), mode })); });
  vi.mocked(clients.agentSources.startScan).mockResolvedValue({ jobId: "job", attemptId: "a" });
  vi.mocked(clients.agentSources.getScanStatus).mockResolvedValue(status(3));
  await act(async () => { button("继续").click(); });
  expect(clients.agentSources.startScan).toHaveBeenLastCalledWith({ sourceId: "all", mode, expectedExecution: { jobId: "job", attemptId: "a" } });
});


it("continues an all-source execution paused on one source without narrowing its scope", async () => {
  await mount();
  await act(async () => { stateApi.dispatch(a.agentSourceScanProgressReceived({ ...progress(2, "stopped"), sourceId: "pi", requestedSourceId: "all", mode: "full" })); });
  vi.mocked(clients.agentSources.startScan).mockResolvedValue({ jobId: "job", attemptId: "a" });
  vi.mocked(clients.agentSources.getScanStatus).mockResolvedValue(status(3));
  await act(async () => { button("继续").click(); });
  expect(clients.agentSources.startScan).toHaveBeenLastCalledWith({ sourceId: "all", mode: "full", expectedExecution: { jobId: "job", attemptId: "a" } });
});
