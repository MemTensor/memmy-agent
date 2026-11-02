import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import YAML from "yaml";
import { createLocalApiServer } from "../adapters/inbound/local-api/server.js";
import { createPermissionManager } from "../permission/index.js";
import { createProgressBus } from "../services/progress-bus.js";
import type { BackendServices } from "../services/index.js";
import { createAppStateStore } from "../infrastructure/app-state-store/index.js";
import { createMemoryScanPreferencesStore, ensureMemoryScanPreferences } from "../infrastructure/memmy-config/agent-access.js";
import { createAppConfigService } from "../services/app-config-service.js";
import { createAgentSourceExecutor } from "../../../../Memory/src/agent-source/runtime.js";
import { createSourceRegistry } from "../../../../Memory/src/agent-source/adapters/source-registry.js";
import type { MemoryService } from "../../../../Memory/src/service/memory-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const deny = { scanPermission: "none", currentStep: "product_tour_required", firstEncounterReportStatus: "skipped" } as const;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memmy-onboarding-permission-"));
  const configPath = join(root, "config.yaml");
  const store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
  cleanups.push(async () => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const bootstrapRepository = store.repositories.bootstrap;
  await ensureMemoryScanPreferences(configPath, bootstrapRepository.getScanPreferences(), "unset");
  const preferences = createMemoryScanPreferencesStore(configPath);
  const detect = vi.fn(async () => true);
  const scan = vi.fn();
  const addMemory = vi.fn(() => ({ id: "fixture", duplicate: false }));
  const makeExecutor = () => {
    const executor = createAgentSourceExecutor({
      service: { withAgentSourceScanPermit: async <T>(_source: unknown, signal: AbortSignal, run: () => Promise<T>) => { signal.throwIfAborted(); return run(); }, addMemory, enqueuePendingImportSummaries: vi.fn() } as unknown as MemoryService,
      configPath, statePath: join(root, "sources.json"), initialScanDelayMs: 1, scheduledScanIntervalMs: 10,
      sourceRegistry: createSourceRegistry([{
        descriptor: { sourceId: "fixture", displayName: "Fixture", builtin: true, dataPath: root }, detect,
        async *scan() { scan(); yield { sourceId: "fixture", messageId: "one", conversationId: "conversation", role: "user", content: "Synthetic onboarding regression", createdAt: "2026-10-23T00:00:00Z", workspacePath: null, gitRoot: null, rawMeta: {} }; yield { sourceId: "fixture", messageId: "two", conversationId: "conversation", role: "assistant", content: "Recorded", createdAt: "2026-10-23T00:01:00Z", workspacePath: null, gitRoot: null, rawMeta: {} }; }
      }])
    });
    cleanups.push(async () => { await executor.dispose(); });
    return executor;
  };
  const executor = makeExecutor();
  const reloadConfig = vi.fn(async () => { await executor.reconcileScanPermission!(); return {} as never; });
  const service = createAppConfigService({ bootstrapRepository, scanPreferencesStore: preferences, memoryClient: { reloadConfig } });
  const access = () => YAML.parse(readFileSync(configPath, "utf8")).memmyMemory.agentAccess;
  return { store, service, bootstrapRepository, preferences, executor, makeExecutor, reloadConfig, configPath, detect, scan, addMemory, access };
}

it("refusal disables automation and survives a new executor even if toggles are later enabled", async () => {
  const f = await fixture();
  await f.service.updateOnboarding(deny);
  expect(f.access()).toMatchObject({ scanPermission: "none", autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false });
  expect(f.bootstrapRepository.getOnboardingState()).toMatchObject(deny);
  await f.preferences.updateScanPreferences({ autoScanKnownAgents: true, watchFileChanges: true });
  await f.executor.dispose();
  const restarted = f.makeExecutor();
  restarted.startAutomation();
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(f.detect).not.toHaveBeenCalled();
  await expect(restarted.startScan({ sourceId: "all" })).rejects.toThrow("not authorized");
  expect(f.addMemory).not.toHaveBeenCalled();
});

it("failed config persistence does not advance onboarding and can be retried", async () => {
  const f = await fixture();
  vi.spyOn(f.preferences, "setScanPermission").mockRejectedValueOnce(new Error("disk full"));
  await expect(f.service.updateOnboarding(deny)).rejects.toThrow("disk full");
  expect(f.bootstrapRepository.getOnboardingState().currentStep).toBe("scan_permission_required");
  expect(f.reloadConfig).not.toHaveBeenCalled();
  await f.service.updateOnboarding(deny);
  expect(f.bootstrapRepository.getOnboardingState()).toMatchObject(deny);
});

it.each(["reload", "database"])("a %s failure after config publication remains denied after restart and supports retry", async failure => {
  const f = await fixture();
  if (failure === "reload") f.reloadConfig.mockRejectedValueOnce(new Error("offline"));
  else vi.spyOn(f.bootstrapRepository, "updateOnboarding").mockImplementationOnce(() => { throw new Error("database failure"); });
  await expect(f.service.updateOnboarding(deny)).rejects.toThrow();
  expect(f.bootstrapRepository.getOnboardingState().currentStep).toBe("scan_permission_required");
  await ensureMemoryScanPreferences(f.configPath, f.bootstrapRepository.getScanPreferences(), f.bootstrapRepository.getOnboardingState().scanPermission);
  await f.executor.dispose();
  const restarted = f.makeExecutor();
  restarted.startAutomation();
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(f.preferences.getScanPermission()).toBe("none");
  expect(f.access().scanPermission).toBe("none");
  expect(f.scan).not.toHaveBeenCalled();
  await f.service.updateOnboarding(deny);
  expect(f.bootstrapRepository.getOnboardingState()).toMatchObject(deny);
});

it("refusal during an active scan waits for cancellation and prevents history imports", async () => {
  const f = await fixture();
  await f.service.updateOnboarding({ scanPermission: "scan_only" });
  let release!: () => void;
  f.detect.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
  await f.executor.startScan({ sourceId: "all" });
  await vi.waitFor(() => expect(f.detect).toHaveBeenCalled());
  let saved = false;
  const saving = f.service.updateOnboarding(deny).then(() => { saved = true; });
  try {
    await vi.waitFor(() => expect(f.access().scanPermission).toBe("none"));
    expect(saved).toBe(false);
    release();
    await saving;
    expect(f.executor.scanStatus().running).toBe(false);
    expect(f.addMemory).not.toHaveBeenCalled();
    await expect(f.executor.startScan({ sourceId: "all" })).rejects.toThrow("not authorized");
  } finally { release(); await saving; }
});

it("allowed onboarding still scans and imports a synthetic history", async () => {
  const f = await fixture();
  await f.service.updateOnboarding({ scanPermission: "scan_only" });
  await f.executor.startScan({ sourceId: "all" });
  await vi.waitFor(() => expect(f.executor.scanStatus().running).toBe(false));
  expect(f.executor.scanStatus().error).toBeNull();
  expect(f.addMemory).toHaveBeenCalledOnce();
});


it("denial also cancels a paused scan and repeated refusal is idempotent", async () => {
  const f = await fixture();
  await f.service.updateOnboarding({ scanPermission: "scan_only" });
  let release!: () => void;
  f.detect.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = () => resolve(true); }));
  await f.executor.startScan({ sourceId: "all" });
  await vi.waitFor(() => expect(f.detect).toHaveBeenCalled());
  await f.executor.pauseScan();
  const saving = f.service.updateOnboarding(deny);
  try {
    await vi.waitFor(() => expect(f.access().scanPermission).toBe("none"));
    release();
    await saving;
    await f.service.updateOnboarding(deny);
    expect(f.executor.scanStatus()).toMatchObject({ running: false, status: "cancelled", error: null });
    expect(f.addMemory).not.toHaveBeenCalled();
  } finally { release(); await saving; }
});


it("explicit manual reauthorization preserves disabled automation; onboarding grant enables it", async () => {
  const f = await fixture();
  await f.service.updateOnboarding(deny);
  await f.service.updateOnboarding({ scanPermission: "scan_only" });
  expect(f.access()).toMatchObject({ scanPermission: "scan_only", autoScanKnownAgents: false, watchFileChanges: false });
  await f.executor.startScan({ sourceId: "all" });
  await vi.waitFor(() => expect(f.executor.scanStatus().running).toBe(false));
  expect(f.addMemory).toHaveBeenCalledOnce();
  await f.service.updateOnboarding({ scanPermission: "scan_only", currentStep: "scan_permission_required" });
  expect(f.access()).toMatchObject({ scanPermission: "scan_only", autoScanKnownAgents: true, watchFileChanges: true });
});


it.each([false, true])("desktop HTTP refusal drains the %s paused writer before acknowledging", async paused => {
  const f = await fixture();
  await f.service.updateOnboarding({ scanPermission: "scan_only" });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.detect.mockImplementationOnce(async () => { await held; return true; });
  const reconcile = vi.spyOn(f.executor, "reconcileScanPermission");
  const app = createLocalApiServer({
    composioMcpToken: "synthetic", permissionManager: createPermissionManager({ appStateStore: f.store, runtimeToken: "synthetic" }),
    services: {
      appConfig: f.service, progressBus: createProgressBus(), agentAdapterRegistry: { listAdapters: () => [] },
      agentSourceAutoInject: { reconcilePermission: vi.fn(async () => {}) },
      agentSources: {},
      memoryClient: { agentSources: {
        list: () => f.executor.list(),
        start: (input: unknown) => f.executor.startScan(input),
        status: async () => f.executor.scanStatus(),
        pause: () => f.executor.pauseScan(),
        cancel: () => f.executor.cancelScan(),
      } }

    } as unknown as BackendServices
  });
  const headers = { "x-memmy-local-token": "synthetic" };
  try {
    expect((await app.inject({ method: "POST", url: "/api/agent-sources/scan", headers })).statusCode).toBe(200);
    await vi.waitFor(() => expect(f.detect).toHaveBeenCalled());
    if (paused) await app.inject({ method: "POST", url: "/api/agent-sources/scan/stop", headers });
    let acknowledged = false;
    const saving = app.inject({ method: "PATCH", url: "/api/app/onboarding", headers, payload: deny }).then(response => { acknowledged = true; return response; });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalled());
    await vi.waitFor(() => expect(f.access().scanPermission).toBe("none"));
    expect(acknowledged).toBe(false);
    expect(f.bootstrapRepository.getOnboardingState().scanPermission).toBe("scan_only");
    expect((await app.inject({ method: "POST", url: "/api/agent-sources/scan", headers })).statusCode).toBe(403);
    release();
    expect((await saving).statusCode).toBe(200);
    expect(f.addMemory).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: "/api/agent-sources/scan/status", headers })).json()).toMatchObject({ active: false, progress: null, status: "cancelled" });
    expect((await app.inject({ method: "PATCH", url: "/api/app/onboarding", headers, payload: deny })).statusCode).toBe(200);
  } finally { release(); await app.close(); }
});
