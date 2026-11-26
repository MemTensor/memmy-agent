import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginRulesSchema } from "@memmy/local-api-contracts";
import { reconcileEntitledPlugins } from "../plugin-entitlement-reconcile-service.js";
import { createInMemoryPluginRegistry, type PluginRelease } from "../../adapters/outbound/plugin-registry/index.js";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import {
  createPluginService,
  type PluginArtifactManager,
  type PluginRuntimeHost
} from "../plugin-service.js";
import type { PluginLocalArtifactService } from "../plugin-local-artifact-service.js";

let root: string | undefined;
let store: AppStateStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const release = {
  manifest: {
    apiVersion: "memmy/v1" as const,
    id: "com.example.review",
    name: "Review",
    version: "1.0.0",
    runtime: { adapter: "http" as const, config: { baseUrl: "https://plugin.example" } },
    capabilities: [{
      id: "run",
      name: "Run review",
      description: "Runs a review",
      inputSchema: { type: "object", required: ["topic"], properties: { topic: { type: "string" } } },
      outputSchema: { type: "object" },
      execution: "job" as const
    }],
    permissions: [
      { type: "network" as const, hosts: ["plugin.example"] },
      { type: "secret" as const, keys: ["api-key"] }
    ],
    configSchema: {
      type: "object",
      required: ["database"],
      properties: { database: { type: "string" } },
      additionalProperties: false
    }
  }
};

function createContext(
  releases: PluginRelease[] = [release],
  localArtifactService?: PluginLocalArtifactService,
  isAuthenticated?: () => boolean,
  catalogPluginIds?: () => readonly string[],
  isEntitlementGranted?: (entitlement: string) => boolean,
  hasActiveAgentTasks?: (signal: AbortSignal) => Promise<boolean>
) {
  root = mkdtempSync(join(tmpdir(), "memmy-plugin-service-"));
  store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
  const runtimeHost: PluginRuntimeHost = {
    supports: vi.fn(() => true),
    activate: vi.fn(async () => undefined),
    deactivate: vi.fn(async () => undefined),
    async *invoke() {
      yield { type: "result" as const, output: { ok: true } };
    },
    cancel: vi.fn(async () => undefined),
    respond: vi.fn(async () => undefined)
  };
  const artifactManager: PluginArtifactManager = {
    install: vi.fn(async (pluginRelease) => ({
      artifactHash: pluginRelease.artifact?.sha256.toLowerCase() ?? null,
      rootPath: null
    })),
    readTextFile: vi.fn(async () => "<main>renderer</main>"),
    remove: vi.fn(async () => undefined)
  };
  const skillManager = {
    activate: vi.fn(async () => undefined),
    deactivate: vi.fn(async () => undefined)
  };
  const registry = createInMemoryPluginRegistry(releases);
  return {
    registry,
    runtimeHost,
    artifactManager,
    skillManager,
    service: createPluginService({
      repository: store.repositories.plugins,
      secretStore: store.secretStore,
      registry,
      runtimeHost,
      artifactManager,
      skillManager,
      localArtifactService,
      isAuthenticated,
      catalogPluginIds,
      isEntitlementGranted,
      hasActiveAgentTasks
    })
  };
}

describe("PluginService", () => {
  const publicPlugin = {
    ...release.manifest, rules: PluginRulesSchema.parse({ autoUpdate: true, distribution: "public" }),
    permissions: [], configSchema: undefined
  };

  it("queues a public automatic update once and preserves a disabled installation after active work finishes", async () => {
    const next = { ...publicPlugin, version: "1.1.0" };
    let releaseTask!: (busy: boolean) => void;
    const busy = new Promise<boolean>(resolve => { releaseTask = resolve; });
    const { service, registry, artifactManager } = createContext([{ manifest: publicPlugin }, { manifest: next }],
      undefined, undefined, undefined, undefined, async () => busy);
    expect((await service.catalog())[0]?.autoUpdateFromVersion).toBeUndefined();
    await service.install(publicPlugin.id, "1.0.0");
    await service.disable(publicPlugin.id);
    expect((await service.catalog())[0]?.autoUpdateFromVersion).toBe("1.0.0");
    const resolveSpy = vi.spyOn(registry, "resolve");
    const updates = [service.update(next.id, next.version, "1.0.0"), service.update(next.id, next.version, "1.0.0")];
    expect(service.list()[0]?.update).toMatchObject({ status: "waiting", version: next.version });
    expect(resolveSpy).not.toHaveBeenCalled();
    releaseTask(false);
    for (const result of await Promise.all(updates)) {
      expect(result).toMatchObject({ version: "1.1.0", state: "disabled" });
    }
    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(artifactManager.install).toHaveBeenCalledTimes(2); // Initial installation and one update.
    expect((await service.catalog())[0]?.autoUpdateFromVersion).toBeUndefined();
    await expect(service.update(next.id, "1.0.0", "1.0.0")).rejects.toThrow(/eligible/);
    expect(service.get(next.id).version).toBe("1.1.0");
  });

  it.each(["installed", "disabled"] as const)("updates a %s plugin without reading secrets until activation", async state => {
    const current = { ...publicPlugin, permissions: release.manifest.permissions };
    const next = { ...current, version: "1.1.0" };
    const { service, runtimeHost, artifactManager } = createContext([{ manifest: current }, { manifest: next }]);
    await service.install(current.id, current.version);
    await service.approvePermissions(current.id, current.permissions);
    if (state === "disabled") await service.disable(current.id);
    const readSecret = vi.spyOn(store!.secretStore, "get");

    const [entry] = await service.catalog();
    expect(entry?.autoUpdateFromVersion).toBe(current.version);
    await expect(service.update(current.id, next.version, entry!.autoUpdateFromVersion))
      .resolves.toMatchObject({ version: next.version, state });
    expect((await service.catalog())[0]?.autoUpdateFromVersion).toBeUndefined();
    expect(artifactManager.install).toHaveBeenCalledTimes(2); // Initial install and one upgrade.
    expect(readSecret).not.toHaveBeenCalled();
    expect(runtimeHost.activate).not.toHaveBeenCalled();
    await expect(service.enable(current.id)).rejects.toThrow("Missing plugin secret");
  });

  it.each(["publisher opt-out", "installed opt-out", "new permissions", "unsupported", "account-only", "revoked access", "grant-only", "withdrawn"] as const)(
    "leaves %s releases to the manual path", async scenario => {
      const current = { ...publicPlugin, rules: { ...publicPlugin.rules, autoUpdate: scenario !== "installed opt-out" } };
      const next = { ...publicPlugin, version: "1.1.0",
        rules: { ...publicPlugin.rules, autoUpdate: scenario !== "publisher opt-out",
          distribution: scenario === "account-only" ? "account" as const : "public" as const,
          requiresLogin: scenario === "revoked access" },
        permissions: scenario === "new permissions" ? release.manifest.permissions : [] };
      const { service, registry, runtimeHost, artifactManager } = createContext([{ manifest: current }, { manifest: next }],
        undefined, () => false, () => scenario === "grant-only" ? [current.id] : []);
      await service.install(current.id, current.version);
      if (scenario === "unsupported") vi.mocked(runtimeHost.supports).mockReturnValue(false);
      if (scenario === "grant-only" || scenario === "withdrawn") vi.spyOn(registry, "list").mockResolvedValue([]);
      const [entry] = await service.catalog();
      if (scenario === "grant-only") expect(entry?.manifest.version).toBe(next.version);
      expect(entry?.autoUpdateFromVersion).toBeUndefined();
      await expect(service.update(current.id, next.version, current.version)).rejects.toThrow(/eligible/);
      expect(artifactManager.install).toHaveBeenCalledOnce();
      expect(service.get(current.id).version).toBe(current.version);
    }
  );

  it("keeps serving the old plugin when an Agent turn starts during the download", async () => {
    const next = { ...publicPlugin, version: "1.1.0" };
    let endTask!: (busy: boolean) => void;
    const task = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise(resolve => { endTask = resolve; }));
    const { service, artifactManager, runtimeHost } = createContext([{ manifest: publicPlugin }, { manifest: next }],
      undefined, undefined, undefined, undefined, task);
    await service.install(publicPlugin.id, publicPlugin.version);
    await service.enable(publicPlugin.id);
    let finishDownload!: () => void;
    vi.mocked(artifactManager.install).mockImplementationOnce(() => new Promise(resolve => {
      finishDownload = () => resolve({ artifactHash: null, rootPath: null });
    }));
    const updating = service.update(next.id, next.version, publicPlugin.version);
    await vi.waitFor(() => expect(finishDownload).toBeDefined());
    expect(service.get(next.id).update?.status).toBe("waiting");
    finishDownload();
    await vi.waitFor(() => expect(endTask).toBeDefined());
    expect(service.get(next.id).version).toBe(publicPlugin.version);
    const iterator = service.invoke({ callId: "mid-download", conversationId: "chat", pluginId: next.id,
      capabilityId: "run", input: {} })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "result" });
    await iterator.next();
    expect(runtimeHost.deactivate).not.toHaveBeenCalled();
    endTask(false);
    await expect(updating).resolves.toMatchObject({ version: next.version, state: "active" });
  });

  it.each(["deactivate", "activate"] as const)("honors a disable and permission revocation requested during %s", async phase => {
    const current = { ...publicPlugin, permissions: [release.manifest.permissions[0]!] };
    const next = { ...current, version: "1.1.0" };
    const { service, runtimeHost } = createContext([{ manifest: current }, { manifest: next }]);
    await service.install(current.id, current.version);
    await service.approvePermissions(current.id, current.permissions);
    await service.enable(current.id);
    let finishSwap!: () => void;
    const pausedSwap = new Promise<void>(resolve => { finishSwap = resolve; });
    const pausePoint = vi.mocked(runtimeHost[phase]).mockClear().mockReturnValueOnce(pausedSwap);
    const upgrading = service.update(next.id, next.version, current.version);
    await vi.waitFor(() => expect(pausePoint).toHaveBeenCalledOnce());
    const disable = service.disable(current.id);
    const revoke = service.approvePermissions(current.id, []);
    finishSwap();
    await upgrading;
    await Promise.all([disable, revoke]);
    expect(service.get(current.id)).toMatchObject({ version: next.version, state: "disabled", approvedPermissions: [] });
  });

  it.each(["update", "rollback"] as const)("keeps a login-required public plugin disabled after logout during %s activation", async phase => {
    let signedIn = true;
    const current = { ...publicPlugin, rules: { ...publicPlugin.rules, requiresLogin: true } };
    const next = { ...current, version: "1.1.0" };
    const { service, runtimeHost, skillManager } = createContext([{ manifest: current }, { manifest: next }], undefined, () => signedIn);
    await service.install(current.id, current.version);
    await service.enable(current.id);

    let resume!: () => void;
    vi.mocked(runtimeHost.activate).mockImplementation(async record => {
      if (phase === "rollback" && record.version === next.version) throw new Error("new version failed");
      await new Promise<void>(resolve => { resume = resolve; });
    });
    const updating = service.update(current.id, next.version, current.version);
    await vi.waitFor(() => expect(resume).toBeDefined());
    expect(service.get(current.id).state).toBe("disabled");
    signedIn = false;
    await reconcileEntitledPlugins({ plugins: service, entitlements: [] });
    vi.mocked(runtimeHost.deactivate).mockClear();
    vi.mocked(skillManager.deactivate).mockClear();
    resume();
    if (phase === "rollback") await expect(updating).rejects.toThrow("new version failed");
    else await expect(updating).resolves.toMatchObject({ state: "disabled" });
    expect(service.get(current.id)).toMatchObject({ version: phase === "rollback" ? current.version : next.version, state: "disabled" });
    expect(runtimeHost.deactivate).toHaveBeenCalledExactlyOnceWith(current.id);
    expect(skillManager.deactivate).toHaveBeenCalledExactlyOnceWith(current.id);
  });

  it("leaves a running plugin untouched when the new configuration is incompatible", async () => {
    const next = { ...publicPlugin, version: "1.1.0", configSchema: release.manifest.configSchema };
    const { service, artifactManager, runtimeHost } = createContext([{ manifest: publicPlugin }, { manifest: next }]);
    await service.install(publicPlugin.id, publicPlugin.version);
    await service.enable(publicPlugin.id);
    expect((await service.catalog())[0]?.autoUpdateFromVersion).toBeUndefined();
    await expect(service.update(next.id, next.version, publicPlugin.version)).rejects.toThrow(/eligible/);
    expect(service.get(next.id)).toMatchObject({ version: publicPlugin.version, state: "active" });
    expect(artifactManager.install).toHaveBeenCalledOnce();
    expect(runtimeHost.deactivate).not.toHaveBeenCalled();
  });

  it("rechecks the resolved release before an automatic update downloads it", async () => {
    const next = { ...publicPlugin, version: "1.1.0" };
    const { service, registry, artifactManager } = createContext([{ manifest: publicPlugin }, { manifest: next }]);
    await service.install(publicPlugin.id, publicPlugin.version);
    expect((await service.catalog())[0]?.autoUpdateFromVersion).toBe(publicPlugin.version);
    vi.spyOn(registry, "resolve").mockResolvedValue({ manifest: { ...next, permissions: release.manifest.permissions } });
    await expect(service.update(next.id, next.version, publicPlugin.version)).rejects.toThrow(/eligible/);
    expect(artifactManager.install).toHaveBeenCalledOnce();
    expect(service.get(next.id)).toMatchObject({ version: publicPlugin.version, approvedPermissions: [] });
  });

  it("hides a legacy private install after revocation and restores visibility when regranted", async () => {
    let granted = true;
    const legalRelease: PluginRelease = { manifest: {
      ...release.manifest, id: "legal-labor", requiredEntitlement: "plugin:legal-labor",
      permissions: [], configSchema: undefined
    } };
    const { service, artifactManager } = createContext([legalRelease], undefined, () => true,
      () => granted ? ["legal-labor"] : [], () => granted);
    await service.install("legal-labor");
    expect(service.list()[0]?.eligibility?.visible).toBe(true);

    granted = false;
    expect(service.list()[0]?.eligibility).toEqual({
      visible: false, canInstall: false, canUse: false, reason: "entitlement_required"
    });
    expect(await service.catalog()).toEqual([]);
    await expect(service.enable("legal-labor")).rejects.toThrow(/access denied/);
    expect(artifactManager.remove).not.toHaveBeenCalled();

    granted = true;
    expect(service.list()[0]?.eligibility?.visible).toBe(true);
    expect((await service.catalog())[0]?.manifest.id).toBe("legal-labor");
    expect(artifactManager.install).toHaveBeenCalledTimes(1);
  });

  it("does not expose a private plugin from the public registry without its entitlement", async () => {
    const publicRelease: PluginRelease = { manifest: {
      ...release.manifest, id: "office", permissions: [], configSchema: undefined
    } };
    const legalRelease: PluginRelease = { manifest: {
      ...release.manifest,
      id: "legal-labor",
      name: "用工合规诊断",
      permissions: [],
      configSchema: undefined,
      requiredEntitlement: "plugin:legal-labor",
      rules: { distribution: "account", installation: "automatic", requiresLogin: true,
        unavailableVisibility: "hidden", autoUpdate: true, recommendsOfficialModel: false }
    } };
    const { service } = createContext(
      [publicRelease, legalRelease],
      undefined,
      () => true,
      () => [],
      () => false
    );

    expect((await service.catalog()).map((entry) => entry.manifest.id)).toEqual(["office"]);
  });

  it("adds entitled private releases to the catalog and keeps them visible after uninstall", async () => {
    const publicRelease: PluginRelease = { manifest: {
      ...release.manifest, id: "office", permissions: [], configSchema: undefined
    } };
    const legalRelease: PluginRelease = { manifest: {
      ...release.manifest,
      id: "legal-labor",
      name: "用工合规诊断",
      permissions: [],
      configSchema: undefined,
      requiredEntitlement: "plugin:legal-labor",
      rules: { distribution: "account", installation: "automatic", requiresLogin: true,
        unavailableVisibility: "hidden", autoUpdate: true, recommendsOfficialModel: false }
    } };
    const { service, registry } = createContext(
      [publicRelease, legalRelease],
      undefined,
      () => true,
      () => ["legal-labor"],
      (entitlement) => entitlement === "plugin:legal-labor"
    );
    vi.spyOn(registry, "list").mockResolvedValue([publicRelease.manifest]);

    expect((await service.catalog()).map((entry) => entry.manifest.id)).toEqual(["office", "legal-labor"]);
    await service.install("legal-labor", legalRelease.manifest.version);
    await service.approvePermissions("legal-labor", []);
    await service.enable("legal-labor");
    expect((await service.catalog()).find((entry) => entry.manifest.id === "legal-labor")?.installed?.state).toBe("active");

    await service.uninstall("legal-labor");
    const uninstalled = (await service.catalog()).find((entry) => entry.manifest.id === "legal-labor");
    expect(uninstalled?.installed).toBeUndefined();
    expect(uninstalled?.eligibility).toMatchObject({ visible: true, canInstall: true, canUse: true });

    await service.install("legal-labor", legalRelease.manifest.version);
    expect(store!.repositories.plugins.listUserUninstalledIds()).toEqual([]);
  });

  it("does not download or reinstall an unchanged installed release on account refresh", async () => {
    const { service, artifactManager } = createContext();
    await service.install(release.manifest.id);
    vi.mocked(artifactManager.install).mockClear();
    await service.update(release.manifest.id);
    await service.update(release.manifest.id);
    expect(artifactManager.install).not.toHaveBeenCalled();
    expect(service.list()).toHaveLength(1);
  });

  it("automatically installs after login, drains calls on logout, restores without download, and respects uninstall", async () => {
    let authenticated = false;
    const literature: PluginRelease = { manifest: {
      ...release.manifest, id: "literature-review", permissions: [], configSchema: undefined,
      rules: { distribution: "account", installation: "automatic", requiresLogin: true,
        unavailableVisibility: "visible", autoUpdate: true, recommendsOfficialModel: true }
    } };
    const { service, artifactManager, runtimeHost } = createContext([literature], undefined, () => authenticated);
    const reconcile = () => reconcileEntitledPlugins({ plugins: service, entitlements: [],
      userUninstalledIds: new Set(store!.repositories.plugins.listUserUninstalledIds()) });
    expect((await service.catalog())[0]?.eligibility.reason).toBe("login_required");
    await expect(service.install("literature-review")).rejects.toThrow(/access denied/);
    await reconcile();
    expect(service.list()).toHaveLength(0);
    authenticated = true;
    await reconcile();
    expect(service.get("literature-review").state).toBe("active");
    runtimeHost.invoke = async function* () {
      yield { type: "progress", current: 1 };
      yield { type: "result", output: { ok: true } };
    };
    const call = service.invoke({ callId: "existing", pluginId: "literature-review", capabilityId: "run",
      conversationId: "chat", input: { topic: "memory" } })[Symbol.asyncIterator]();
    await call.next();
    authenticated = false;
    await reconcile();
    expect(runtimeHost.deactivate).not.toHaveBeenCalled();
    expect(service.list()[0]?.eligibility?.canUse).toBe(false);
    await expect(service.invoke({ callId: "new", pluginId: "literature-review", capabilityId: "run",
      conversationId: "chat", input: { topic: "memory" } })[Symbol.asyncIterator]().next()).rejects.toThrow(/access denied/);
    expect((await call.next()).value).toMatchObject({ type: "result" });
    await call.next();
    expect(service.get("literature-review").state).toBe("disabled");
    authenticated = true;
    await reconcile();
    expect(service.get("literature-review").state).toBe("active");
    expect(artifactManager.install).toHaveBeenCalledTimes(1);
    await service.uninstall("literature-review");
    await reconcile();
    expect(service.list()).toHaveLength(0);
    await service.install("literature-review");
    expect(store!.repositories.plugins.listUserUninstalledIds()).toEqual([]);
  });

  it("loads a declared renderer from the installed plugin artifact", async () => {
    const rendererRelease: PluginRelease = {
      manifest: { ...release.manifest, ui: { renderer: { entry: "ui/index.html", capabilities: ["run"] } } }
    };
    const { service, artifactManager } = createContext([rendererRelease]);
    await service.install(rendererRelease.manifest.id);

    await expect(service.readUi(rendererRelease.manifest.id, "renderer")).resolves.toBe("<main>renderer</main>");
    expect(artifactManager.readTextFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: rendererRelease.manifest.id }),
      "ui/index.html",
      512 * 1024
    );
  });

  it("installs, configures, approves, enables, disables, and uninstalls", async () => {
    const { service, runtimeHost, artifactManager, skillManager } = createContext();
    expect((await service.install(release.manifest.id)).state).toBe("pending_approval");
    expect(() => service.configure(release.manifest.id, { config: {} })).toThrow(/Invalid plugin config/);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    expect((await service.approvePermissions(release.manifest.id, release.manifest.permissions)).state).toBe("installed");
    expect((await service.enable(release.manifest.id)).state).toBe("active");
    expect(runtimeHost.activate).toHaveBeenCalledWith(expect.objectContaining({ id: release.manifest.id }), {
      "api-key": "secret"
    });
    expect(skillManager.activate).toHaveBeenCalledWith(expect.objectContaining({ id: release.manifest.id }));
    expect((await service.disable(release.manifest.id)).state).toBe("disabled");
    expect(skillManager.deactivate).toHaveBeenCalledWith(release.manifest.id);
    await service.uninstall(release.manifest.id);
    expect(service.list()).toEqual([]);
    expect(artifactManager.remove).toHaveBeenCalled();
  });

  it("rejects undeclared secrets and permissions", async () => {
    const { service } = createContext();
    await service.install(release.manifest.id);
    expect(() => service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { password: "nope" }
    })).toThrow(/not declared/);
    await expect(service.approvePermissions(release.manifest.id, [{
      type: "network",
      hosts: ["evil.example"]
    }])).rejects.toThrow(/did not declare/);
  });

  it.each(["install", "update"] as const)("rejects a changed artifact digest through %s", async (operation) => {
    const releases: PluginRelease[] = [{
      ...release,
      artifact: { url: "https://plugins.example/review.zip", sha256: "a".repeat(64) }
    }];
    const { service } = createContext(releases);
    await service.install(release.manifest.id);
    releases.push({
      ...release,
      artifact: { url: "https://plugins.example/review.zip", sha256: "b".repeat(64) }
    });

    await expect(service[operation](release.manifest.id)).rejects.toThrow(/digest changed/);
  });

  it("rejects a changed manifest for an installed version", async () => {
    const changed: PluginRelease = { manifest: { ...release.manifest, name: "Changed" } };
    const releases: PluginRelease[] = [release];
    const { service } = createContext(releases);
    await service.install(release.manifest.id);
    releases.push(changed);

    await expect(service.update(release.manifest.id)).rejects.toThrow(/manifest changed/);
  });

  it("compares permission scope independently of descriptions and list order", async () => {
    const declared = [
      { type: "network" as const, hosts: ["api.example", "cdn.example"], description: "Paper APIs" },
      { type: "secret" as const, keys: ["api-key", "client-id"], description: "Credentials" }
    ];
    const pluginRelease: PluginRelease = {
      manifest: { ...release.manifest, permissions: declared }
    };
    const { service } = createContext([pluginRelease]);
    await service.install(release.manifest.id);

    expect(await service.approvePermissions(release.manifest.id, [
      { type: "network", hosts: ["cdn.example", "api.example"] },
      { type: "secret", keys: ["client-id", "api-key"] }
    ])).toMatchObject({ state: "installed" });
  });

  it("marks activation failures without publishing the plugin as active", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    vi.mocked(runtimeHost.activate).mockRejectedValueOnce(new Error("offline"));
    await expect(service.enable(release.manifest.id)).rejects.toThrow(/offline/);
    expect(service.get(release.manifest.id)).toMatchObject({ state: "failed", lastError: "offline" });
  });

  it("marks an active plugin failed when a permission change cannot stop its runtime", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    vi.mocked(runtimeHost.deactivate).mockRejectedValueOnce(new Error("busy"));

    await expect(service.approvePermissions(release.manifest.id, [])).rejects.toThrow(/busy/);
    expect(service.get(release.manifest.id)).toMatchObject({
      state: "failed",
      approvedPermissions: release.manifest.permissions,
      lastError: "busy"
    });
  });

  it("waits for all calls before resolving/downloading, deduplicates manual updates and pins the target", async () => {
    const next = { manifest: { ...release.manifest, version: "2.0.0" } };
    const { service, runtimeHost, artifactManager, registry } = createContext([release, next]);
    await service.install(release.manifest.id, "1.0.0");
    service.configure(release.manifest.id, { config: { database: "crossref" }, secrets: { "api-key": "secret" } });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    const releaseCalls = new Map<string, () => void>();
    runtimeHost.invoke = async function* (call) {
      yield { type: "progress", current: 1 };
      await new Promise<void>(resolve => releaseCalls.set(call.callId, resolve));
      yield { type: "result", output: { ok: true } };
    };
    const call = (callId: string) => service.invoke({
      callId, pluginId: release.manifest.id, capabilityId: "run", conversationId: "chat", input: {}
    })[Symbol.asyncIterator]();
    const one = call("one"), two = call("two");
    await one.next();
    await two.next();
    const finishOne = one.next(), finishTwo = two.next();
    const resolveSpy = vi.spyOn(registry, "resolve");
    vi.mocked(artifactManager.install).mockClear();
    const updated = service.update(release.manifest.id, "2.0.0");
    const duplicate = service.update(release.manifest.id, "2.0.0");
    await expect(service.update(release.manifest.id, "3.0.0")).rejects.toThrow(/another version/);
    expect(service.get(release.manifest.id)).toMatchObject({
      version: "1.0.0", activeCallCount: 2, update: { status: "waiting", version: "2.0.0" }
    });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(artifactManager.install).not.toHaveBeenCalled();
    releaseCalls.get("one")!();
    await finishOne;
    await one.next();
    expect(artifactManager.install).not.toHaveBeenCalled();
    releaseCalls.get("two")!();
    await finishTwo;
    await two.next();
    expect((await updated).version).toBe("2.0.0");
    expect((await duplicate).version).toBe("2.0.0");
    expect(artifactManager.install).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith(release.manifest.id, "2.0.0");
    expect(service.get(release.manifest.id)).toMatchObject({ state: "active", activeCallCount: 0 });
    expect(service.get(release.manifest.id).update).toBeUndefined();
  });

  it("blocks new calls during installation and preserves the old active version on download failure", async () => {
    const next = { manifest: { ...release.manifest, version: "2.0.0" } };
    const { service, artifactManager } = createContext([release, next]);
    await service.install(release.manifest.id, "1.0.0");
    service.configure(release.manifest.id, { config: { database: "crossref" }, secrets: { "api-key": "secret" } });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    let rejectDownload!: (error: Error) => void;
    vi.mocked(artifactManager.install).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectDownload = reject; }));
    const update = service.update(release.manifest.id, "2.0.0");
    const failed = expect(update).rejects.toThrow("download failed");
    await vi.waitFor(() => expect(rejectDownload).toBeDefined());
    await expect(service.invoke({
      callId: "new", pluginId: release.manifest.id, capabilityId: "run", conversationId: "chat", input: {}
    })[Symbol.asyncIterator]().next()).rejects.toThrow(/being installed/);
    rejectDownload(new Error("download failed"));
    await failed;
    expect(service.get(release.manifest.id)).toMatchObject({ version: "1.0.0", state: "active" });
    expect(service.get(release.manifest.id).update).toBeUndefined();
  });

  it.each(["return", "error", "shutdown"] as const)("releases a queued update when a call ends via %s", async (ending) => {
    const next = { manifest: { ...release.manifest, version: "2.0.0" } };
    const { service, runtimeHost, artifactManager } = createContext([release, next]);
    await service.install(release.manifest.id, "1.0.0");
    service.configure(release.manifest.id, { config: { database: "crossref" }, secrets: { "api-key": "secret" } });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    runtimeHost.invoke = async function* () {
      yield { type: "progress", current: 1 };
      throw new Error("task failed");
    };
    const task = service.invoke({ callId: "running", pluginId: release.manifest.id, capabilityId: "run", conversationId: "chat", input: {} })[Symbol.asyncIterator]();
    await task.next();
    vi.mocked(artifactManager.install).mockClear();
    const update = service.update(release.manifest.id, "2.0.0");
    if (ending === "shutdown") {
      const rejected = expect(update).rejects.toThrow(/shutting down/);
      await service.shutdown();
      await rejected;
      await task.return?.();
      expect(artifactManager.install).not.toHaveBeenCalled();
    } else {
      if (ending === "error") await expect(task.next()).rejects.toThrow("task failed");
      else await task.return?.();
      expect((await update).version).toBe("2.0.0");
      expect(artifactManager.install).toHaveBeenCalledOnce();
    }
    expect(service.get(release.manifest.id).update).toBeUndefined();
  });

  it("keeps the old version between sequential calls until the entire Agent task finishes", async () => {
    vi.useFakeTimers();
    try {
      let agentBusy = true;
      const activity = vi.fn(async () => agentBusy);
      const next = { manifest: { ...release.manifest, version: "2.0.0" } };
      const { service, artifactManager, registry, runtimeHost } = createContext([release, next], undefined, undefined, undefined, undefined, activity);
      await service.install(release.manifest.id, "1.0.0");
      service.configure(release.manifest.id, { config: { database: "crossref" }, secrets: { "api-key": "secret" } });
      await service.approvePermissions(release.manifest.id, release.manifest.permissions);
      await service.enable(release.manifest.id);
      const invoke = async (callId: string) => {
        for await (const _event of service.invoke({ callId, pluginId: release.manifest.id, capabilityId: "run", conversationId: "chat", input: {} })) { /* drain */ }
      };
      await invoke("first-step");
      const resolve = vi.spyOn(registry, "resolve");
      vi.mocked(artifactManager.install).mockClear();
      const update = service.update(release.manifest.id, "2.0.0");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(service.get(release.manifest.id)).toMatchObject({ version: "1.0.0", activeCallCount: 0, update: { status: "waiting" } });
      expect(resolve).not.toHaveBeenCalled();
      expect(artifactManager.install).not.toHaveBeenCalled();
      expect(runtimeHost.deactivate).not.toHaveBeenCalled();
      // The same turn can think, wait for user input, then invoke another step.
      await invoke("second-step");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(artifactManager.install).not.toHaveBeenCalled();
      agentBusy = false;
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await update).version).toBe("2.0.0");
      expect(resolve).toHaveBeenCalledExactlyOnceWith(release.manifest.id, "2.0.0");
      expect(artifactManager.install).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("fails closed when the Agent task state cannot be confirmed", async () => {
    const next = { manifest: { ...release.manifest, version: "2.0.0" } };
    const { service, artifactManager, registry } = createContext([release, next], undefined, undefined, undefined, undefined, async () => { throw new Error("runtime unavailable"); });
    await service.install(release.manifest.id, "1.0.0");
    vi.mocked(artifactManager.install).mockClear();
    const resolve = vi.spyOn(registry, "resolve");
    await expect(service.update(release.manifest.id, "2.0.0")).rejects.toThrow("runtime unavailable");
    expect(artifactManager.install).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(service.get(release.manifest.id).version).toBe("1.0.0");
    expect(service.get(release.manifest.id).update).toBeUndefined();
  });

  it("cancels whole-task waiting on shutdown without downloading", async () => {
    vi.useFakeTimers();
    try {
      const next = { manifest: { ...release.manifest, version: "2.0.0" } };
      const { service, artifactManager } = createContext([release, next], undefined, undefined, undefined, undefined, async () => true);
      await service.install(release.manifest.id, "1.0.0");
      vi.mocked(artifactManager.install).mockClear();
      const updated = service.update(release.manifest.id, "2.0.0");
      const rejected = expect(updated).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      await service.shutdown();
      await rejected;
      expect(artifactManager.install).not.toHaveBeenCalled();
      expect(service.get(release.manifest.id).update).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("invokes only active declared capabilities", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    const events = [];
    for await (const event of service.invoke({
      callId: "call-1",
      pluginId: release.manifest.id,
      capabilityId: "run",
      conversationId: "conversation-1",
      input: {}
    })) events.push(event);
    expect(events).toEqual([{ type: "result", output: { ok: true } }]);
    expect(runtimeHost.invoke).toBeDefined();
    expect(store!.db.prepare("SELECT outcome, error_code FROM plugin_call_logs WHERE call_id = ?")
      .get("call-1")).toEqual({ outcome: "success", error_code: null });
    expect(() => service.configure(release.manifest.id, {
      config: { database: "pubmed" }
    })).toThrow(/Disable plugin/);
  });

  it("rewrites result paths to the copies published in the conversation workspace", async () => {
    const sourcePath = "/plugin-data/review-1/outputs/review.md";
    const publishedPath = "/workspace/outputs/com.example.review/review-1/review.md";
    const localArtifactService: PluginLocalArtifactService = {
      host: vi.fn(async (_plugin, artifact) => ({ ...artifact, path: publishedPath })),
      open: vi.fn(async () => ({ path: sourcePath, name: "review.md", mediaType: "text/markdown" })),
      revokePlugin: vi.fn()
    };
    const { service, runtimeHost } = createContext([release], localArtifactService);
    runtimeHost.invoke = async function* () {
      yield {
        type: "artifact",
        artifact: {
          id: "review",
          name: "review.md",
          mediaType: "text/markdown",
          uri: "file:///plugin-data/review-1/outputs/review.md"
        }
      };
      yield { type: "result", output: { data: { outputs: [{ path: sourcePath }] } } };
    };
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);

    const events = [];
    for await (const event of service.invoke({
      callId: "call-1",
      pluginId: release.manifest.id,
      capabilityId: "run",
      conversationId: "websocket:chat-1",
      input: { taskId: "review-1" }
    })) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({ type: "artifact", artifact: expect.objectContaining({ path: publishedPath }) }),
      { type: "result", output: { data: { outputs: [{ path: publishedPath }] } } }
    ]);
    expect(localArtifactService.host).toHaveBeenCalledWith(
      expect.objectContaining({ id: release.manifest.id }),
      expect.objectContaining({ id: "review" }),
      { conversationId: "websocket:chat-1", taskId: "review-1", callId: "call-1" }
    );
  });

  it("updates an active plugin and reactivates it atomically", async () => {
    const nextRelease: PluginRelease = {
      manifest: { ...release.manifest, version: "2.0.0" }
    };
    const { service, runtimeHost } = createContext([release, nextRelease]);
    await service.install(release.manifest.id, "1.0.0");
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    expect(await service.update(release.manifest.id, "2.0.0")).toMatchObject({
      version: "2.0.0",
      state: "active",
      config: { database: "crossref" }
    });
    expect(runtimeHost.deactivate).toHaveBeenCalledWith(release.manifest.id);
    expect(runtimeHost.activate).toHaveBeenCalledTimes(2);
  });

  it("restores the previous active version when an update cannot activate", async () => {
    const nextRelease: PluginRelease = { manifest: { ...release.manifest, version: "2.0.0" } };
    const { service, runtimeHost, artifactManager } = createContext([release, nextRelease]);
    vi.mocked(artifactManager.install).mockImplementation(async (pluginRelease) => ({
      artifactHash: pluginRelease.manifest.version,
      rootPath: `/plugins/${pluginRelease.manifest.version}`
    }));
    await service.install(release.manifest.id, "1.0.0");
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    vi.mocked(runtimeHost.activate).mockRejectedValueOnce(new Error("new version failed"));

    await expect(service.update(release.manifest.id, "2.0.0")).rejects.toThrow(/new version failed/);
    expect(service.get(release.manifest.id)).toMatchObject({ version: "1.0.0", state: "active" });
    expect(runtimeHost.activate).toHaveBeenCalledTimes(3);
    expect(artifactManager.remove).toHaveBeenCalledWith(expect.objectContaining({
      rootPath: "/plugins/2.0.0"
    }));
  });

  it("restores and closes persisted active runtimes without changing their state", async () => {
    const { service, runtimeHost } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    await service.enable(release.manifest.id);
    vi.mocked(runtimeHost.activate).mockClear();

    await service.restoreActive();
    await service.shutdown();

    expect(runtimeHost.activate).toHaveBeenCalledOnce();
    expect(runtimeHost.deactivate).toHaveBeenCalledWith(release.manifest.id);
    expect(service.get(release.manifest.id).state).toBe("active");
  });

  it.each(["success", "failure"])("shares concurrent activation and permits recovery after %s", async (outcome) => {
    const { service, runtimeHost, skillManager } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, { config: { database: "crossref" }, secrets: { "api-key": "secret" } });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    let finish!: () => void, fail!: (error: Error) => void;
    vi.mocked(runtimeHost.activate).mockImplementationOnce(() => new Promise<void>((resolve, reject) => {
      finish = resolve; fail = reject;
    }));
    const a = service.enable(release.manifest.id), b = service.enable(release.manifest.id);
    await Promise.resolve();
    expect(service.get(release.manifest.id).state).toBe("enabling");
    expect(runtimeHost.activate).toHaveBeenCalledTimes(1);
    const results = Promise.allSettled([a, b]);
    if (outcome === "success") finish(); else fail(new Error("runtime unavailable"));
    expect((await results).map(result => result.status)).toEqual(outcome === "success"
      ? ["fulfilled", "fulfilled"] : ["rejected", "rejected"]);
    expect(skillManager.activate).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    expect(service.get(release.manifest.id).state).toBe(outcome === "success" ? "active" : "failed");
    await service.enable(release.manifest.id);
    expect(service.get(release.manifest.id).state).toBe("active");
    expect(runtimeHost.activate).toHaveBeenCalledTimes(outcome === "success" ? 1 : 2);
  });

  it.each(["success", "failure"])("restores an interrupted activation after restart with %s", async (outcome) => {
    const { service, runtimeHost, registry, artifactManager, skillManager } = createContext();
    await service.install(release.manifest.id);
    service.configure(release.manifest.id, {
      config: { database: "crossref" },
      secrets: { "api-key": "secret" }
    });
    await service.approvePermissions(release.manifest.id, release.manifest.permissions);
    store!.repositories.plugins.setState(release.manifest.id, "enabling");

    // A fresh service has no in-memory activation promise, only persisted state.
    const restarted = createPluginService({ repository: store!.repositories.plugins,
      secretStore: store!.secretStore, registry, runtimeHost, artifactManager, skillManager });
    if (outcome === "failure") vi.mocked(runtimeHost.activate).mockRejectedValueOnce(new Error("runtime unavailable"));
    await restarted.restoreActive();

    expect(runtimeHost.activate).toHaveBeenCalledOnce();
    expect(restarted.get(release.manifest.id).state).toBe(outcome === "success" ? "active" : "failed");
    if (outcome === "failure") {
      expect(restarted.get(release.manifest.id).lastError).toContain("runtime unavailable");
      await restarted.enable(release.manifest.id);
      expect(restarted.get(release.manifest.id).state).toBe("active");
    }
  });
});
