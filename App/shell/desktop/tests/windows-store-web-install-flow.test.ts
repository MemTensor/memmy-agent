import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { relative, resolve, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createWindowsStoreMigrationOfferRegistry } from "../src/main/windows-store-migration-offer-registry.js";

const mainSource = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
const mainAst = ts.createSourceFile("main.ts", mainSource, ts.ScriptTarget.Latest, true);
const functions = ["downloadUpdate", "openWindowsStoreMigration", "prepareWindowsStoreMigrationOffer", "resolveDownloadedUpdatePath"];
const flowSource = mainAst.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && functions.includes(node.name?.text ?? "")
).map((node) => node.getText(mainAst)).join("\n");
const javascript = ts.transpile(flowSource, { target: ts.ScriptTarget.ES2022 });
const policy = { kind: "store-migration", edition: "cn", storeId: "9MZGLKWMZZV6",
  acquisitionUri: "https://get.microsoft.com/installer/download/9MZGLKWMZZV6" };
const owner = { id: 41 };
const filePath = "D:\\MemmyData\\updates\\store-web-install\\cn\\Memmy-WebInstall.exe";

const setup = (now?: () => number) => {
  const registry = createWindowsStoreMigrationOfferRegistry({ createToken: () => "a".repeat(43), now });
  const handle = registry.getOrCreate({ transactionId: "transaction", contextKey: "context",
    acquisitionUri: policy.acquisitionUri, policy, authority: {} });
  registry.bindOwner(handle, owner.id);
  const installer = { findPrepared: vi.fn(async (): Promise<string | null> => filePath),
    prepare: vi.fn(async () => filePath), launchPrepared: vi.fn(async () => filePath) };
  const bindings = {
    currentWindowsStoreWebInstaller: vi.fn(() => installer),
    windowsStoreMigrationOfferRegistry: registry,
    emitCompletedUpdateDownloadProgress: vi.fn(async () => undefined),
    ensureCurrentWindowsStoreLegacyCleanupBroker: vi.fn(async () => undefined),
    createCurrentWindowsStoreTransitionBinding: vi.fn(() => ({})),
    resolveCurrentWindowsStoreTransitionStatePath: vi.fn(() => "journal"),
    createWindowsStoreTransitionState: vi.fn(() => ({ phase: "authority-recorded" })),
    advanceWindowsStoreTransitionState: vi.fn(() => ({ phase: "store-install-launched" })),
    writeWindowsStoreTransitionState: vi.fn(async () => undefined),
    clearPreparedRequiredUpdate: vi.fn(async () => undefined),
    clearPreparedRequiredUpdateAttempt: vi.fn(async () => undefined),
    scheduleQuitForWindowsStoreMigration: vi.fn(),
    rename: vi.fn(async () => undefined), randomUUID: () => "transaction",
    isManagedUpdateInstallerRunning: false,
    openUpdateInstaller: vi.fn(),
    console: { warn: vi.fn() },
    process: { platform: "win32", execPath: "D:\\memmy\\Memmy.exe" },
    app: { isPackaged: true }, isWindowsStoreApp: () => false, windowsDataLayout: {},
    readCurrentDesktopEditionManifest: () => ({}),
    resolveDesktopWindowsStoreMigrationConfig: () => ({ internalEnabled: true, storeDestination: policy }),
    resolveCurrentDesktopEdition: () => "cn", resolveWindowsStoreMigrationPolicy: () => policy,
    resolveDesktopAppVersion: () => "1.1.4", readWindowsCurrentInstallAuthority: async () => ({}),
    createWindowsStoreMigrationOfferContextKey: () => "context",
    resolve, relative, sep, resolveUpdatesDirectory: () => resolve("updates"),
    realpathSync: { native: vi.fn((value: string) => value) }
  };
  const context = createContext(bindings);
  runInContext(javascript, context);
  const call = (name: string, ...args: unknown[]): Promise<any> =>
    runInContext(name, context)(...args);
  return { bindings, call, installer, handle, registry };
};

describe("main-process Store Web Install flow", () => {
  it("rejects passing a Web Installer path through the generic NSIS installer path", () => {
    const flow = setup();
    for (const folder of ["store-web-install", "STORE-WEB-INSTALL"]) {
      expect(() => flow.call("resolveDownloadedUpdatePath", resolve("updates", folder, "cn", "Memmy-WebInstall.exe")))
        .toThrow("main-owned migration handle");
    }
    expect(flow.call("resolveDownloadedUpdatePath", resolve("updates", "Memmy-1.1.4.exe")))
      .toBe(resolve("updates", "Memmy-1.1.4.exe"));
  });

  it("rejects filesystem aliases for Web Install and files outside the cache", () => {
    const flow = setup();
    const alias = resolve("updates", "STORE-~1", "cn", "Memmy-WebInstall.exe");
    flow.bindings.realpathSync.native.mockImplementation((value) => value === alias
      ? resolve("updates", "store-web-install", "cn", "Memmy-WebInstall.exe") : value);
    expect(() => flow.call("resolveDownloadedUpdatePath", alias)).toThrow("main-owned migration handle");
    flow.bindings.realpathSync.native.mockImplementation((value) => value.endsWith("linked.exe")
      ? resolve("outside", "Memmy.exe") : value);
    expect(() => flow.call("resolveDownloadedUpdatePath", resolve("updates", "linked.exe"))).toThrow("directly inside");
  });

  it("refreshes an offer if its download crosses the original expiry", async () => {
    let now = 1_000;
    const flow = setup(() => now);
    flow.installer.prepare.mockImplementationOnce(async () => {
      now += 60 * 60 * 1_000;
      flow.registry.prune();
      return filePath;
    });
    const result = await flow.call("downloadUpdate", { status: "available", provider: "store-migration",
      storeMigrationOffer: flow.handle }, { openInstaller: false }, owner);
    now += 60 * 60 * 1_000;
    expect(flow.registry.prune()).toBe(0);
    expect(flow.registry.read(owner.id, result.preparedUpdate).policy).toEqual(policy);
  });

  it("exposes a download offer before download, and a prepared handle only after verification", async () => {
    const flow = setup();
    flow.installer.findPrepared.mockResolvedValueOnce(null);
    const available = await flow.call("prepareWindowsStoreMigrationOffer");
    expect(available.storeMigrationOffer).toEqual(flow.handle);
    expect(available.preparedUpdate).toBeUndefined();
    const prepared = await flow.call("prepareWindowsStoreMigrationOffer");
    expect(prepared.preparedUpdate).toEqual(flow.handle);
    expect(flow.installer.prepare).not.toHaveBeenCalled();
  });

  it("waits for the real download and leaves the install token usable without opening anything", async () => {
    const flow = setup();
    let finish!: (path: string) => void;
    flow.installer.prepare.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    let completed = false;
    const result = flow.call("downloadUpdate", { status: "available", provider: "store-migration",
      storeMigrationOffer: flow.handle }, { openInstaller: false }, owner).then((value) => {
      completed = true;
      return value;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish(filePath);
    expect(await result).toEqual({ preparedUpdate: flow.handle, filePath, opened: false });
    expect(flow.registry.read(owner.id, flow.handle).policy).toEqual(policy);
    expect(flow.bindings.openUpdateInstaller).not.toHaveBeenCalled();
    expect(flow.bindings.scheduleQuitForWindowsStoreMigration).not.toHaveBeenCalled();
  });

  it("does not claim readiness or quit after a download error", async () => {
    const flow = setup();
    flow.installer.prepare.mockRejectedValueOnce(new Error("network failed"));
    await expect(flow.call("downloadUpdate", { status: "available", provider: "store-migration",
      storeMigrationOffer: flow.handle }, { openInstaller: false }, owner)).rejects.toThrow("network failed");
    expect(flow.bindings.emitCompletedUpdateDownloadProgress).not.toHaveBeenCalled();
    expect(flow.bindings.scheduleQuitForWindowsStoreMigration).not.toHaveBeenCalled();
  });

  it("refuses to launch an offer whose installer is missing", async () => {
    const flow = setup();
    flow.installer.findPrepared.mockResolvedValueOnce(null);
    await expect(flow.call("openWindowsStoreMigration", flow.handle, owner.id)).rejects.toThrow("not downloaded");
    expect(flow.installer.launchPrepared).not.toHaveBeenCalled();
    expect(flow.bindings.writeWindowsStoreTransitionState).not.toHaveBeenCalled();
    expect(flow.bindings.scheduleQuitForWindowsStoreMigration).not.toHaveBeenCalled();
  });

  it("keeps the app running and the offer retryable if the installer cannot start", async () => {
    const flow = setup();
    flow.installer.launchPrepared.mockRejectedValueOnce(new Error("access denied"));
    await expect(flow.call("openWindowsStoreMigration", flow.handle, owner.id)).rejects.toThrow("access denied");
    expect(flow.bindings.scheduleQuitForWindowsStoreMigration).not.toHaveBeenCalled();
    expect(flow.registry.size).toBe(1);
    const result = await flow.call("openWindowsStoreMigration", flow.handle, owner.id);
    expect(result).toEqual({ preparedUpdate: flow.handle, filePath, opened: true, willQuit: true });
    expect(flow.bindings.scheduleQuitForWindowsStoreMigration).toHaveBeenCalledOnce();
  });

  it("launches the downloaded installer even when optional migration journal writes fail", async () => {
    const flow = setup();
    flow.bindings.resolveCurrentWindowsStoreTransitionStatePath.mockImplementation(() => { throw new Error("no journal access"); });
    expect(await flow.call("openWindowsStoreMigration", flow.handle, owner.id)).toMatchObject({ opened: true, willQuit: true });
    expect(flow.installer.launchPrepared).toHaveBeenCalledWith(policy);
    expect(flow.bindings.scheduleQuitForWindowsStoreMigration).toHaveBeenCalledOnce();
  });
});
