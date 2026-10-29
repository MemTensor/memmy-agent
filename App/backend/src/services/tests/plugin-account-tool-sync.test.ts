import { PluginManifestSchema } from "@memmy/local-api-contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAgentAdapterRegistry } from "../../adapters/outbound/agent-adapter/index.js";
import type { MemmyAgentAdminClient } from "../../adapters/outbound/memmy-agent-admin-client/index.js";
import { createInMemoryPluginRegistry } from "../../adapters/outbound/plugin-registry/index.js";
import { createAppStateStore, type AppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createMemmyConfigWriter } from "../../infrastructure/memmy-config/index.js";
import { createPermissionManager } from "../../permission/index.js";
import { createMockCloudClient } from "../../tests/support/mock-cloud-client.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";
import { createBackendServices, type BackendServices } from "../index.js";

let root: string;
let store: AppStateStore | undefined;
let services: BackendServices | undefined;
afterEach(async () => {
  await services?.plugins.shutdown();
  store?.close();
  services = undefined;
  store = undefined;
  vi.unstubAllEnvs();
  if (root) rmSync(root, { recursive: true, force: true });
});

function setup() {
  root = mkdtempSync(join(tmpdir(), "memmy-plugin-account-tools-"));
  vi.stubEnv("MEMMY_AGENT_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("MEMMY_AGENT_DATA_DIR", root);
  store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
  const reloadMcpConfig = vi.fn(async () => ({ ok: true, message: "reloaded", requires_restart: false }));
  const manifest = PluginManifestSchema.parse({
    apiVersion: "memmy/v1", id: "literature-review", name: "Review", version: "0.5.26",
    runtime: { adapter: "http", config: { baseUrl: "https://plugin.example" } },
    rules: { distribution: "public", installation: "automatic", requiresLogin: true },
    capabilities: [{ id: "review_create_task", name: "Create task", description: "Create a review",
      inputSchema: { type: "object" }, outputSchema: { type: "object" }, execution: "request" }],
    permissions: []
  });
  services = createBackendServices({
    appStateStore: store,
    agentAdapterRegistry: createDefaultAgentAdapterRegistry(),
    permissionManager: createPermissionManager({ appStateStore: store }),
    cloudClient: createMockCloudClient(), memoryClient: createMockMemoryClient(), accountChannel: "email",
    memmyConfigWriter: createMemmyConfigWriter({ configPath: join(root, "config.yaml"), accountChannel: "email" }),
    memmyConfigPath: join(root, "config.yaml"),
    memmyAgentAdminClient: { reloadMcpConfig } as unknown as MemmyAgentAdminClient,
    pluginRegistry: createInMemoryPluginRegistry([{ manifest }]),
    pluginArtifactManager: {
      install: async () => ({ artifactHash: null, rootPath: null }),
      readTextFile: async () => "", remove: async () => undefined
    },
    pluginRuntimeHost: {
      supports: () => true, activate: async () => undefined, deactivate: async () => undefined,
      async *invoke() { yield { type: "result", output: {} }; },
      cancel: async () => undefined, respond: async () => undefined
    }
  });
  const login = () => services!.account.verifyCode({ channel: "email", email: "test@example.com", code: "123456" });
  return { reloadMcpConfig, login };
}

describe("account plugin tool synchronization", () => {
  it("publishes auto-install, logout and restored eligibility without reloading on unchanged profile polls", async () => {
    const { reloadMcpConfig, login } = setup();
    await login();
    expect(services!.plugins.get("literature-review").state).toBe("active");
    expect(reloadMcpConfig).toHaveBeenCalledTimes(1);
    await services!.account.getSession();
    expect(reloadMcpConfig).toHaveBeenCalledTimes(1);
    await services!.account.logout();
    expect(services!.plugins.get("literature-review").state).toBe("disabled");
    expect(reloadMcpConfig).toHaveBeenCalledTimes(2);
    await login();
    expect(services!.plugins.get("literature-review").state).toBe("active");
    expect(reloadMcpConfig).toHaveBeenCalledTimes(3);
  });

  it("retries a failed tool publication on the next account refresh", async () => {
    const { reloadMcpConfig, login } = setup();
    reloadMcpConfig.mockResolvedValueOnce({ ok: false, message: "agent busy", requires_restart: false });
    await login();
    expect(services!.plugins.get("literature-review").state).toBe("active");
    await services!.account.getSession();
    expect(reloadMcpConfig).toHaveBeenCalledTimes(2);
    await services!.account.getSession();
    expect(reloadMcpConfig).toHaveBeenCalledTimes(2);
  });

  it("preserves login and retries when the agent reload transport throws", async () => {
    const { reloadMcpConfig, login } = setup();
    reloadMcpConfig.mockRejectedValueOnce(new Error("agent unavailable"));
    await login();
    expect(services!.plugins.get("literature-review").state).toBe("active");
    await services!.account.getSession();
    expect(reloadMcpConfig).toHaveBeenCalledTimes(2);
    await services!.account.getSession();
    expect(reloadMcpConfig).toHaveBeenCalledTimes(2);
  });

});
