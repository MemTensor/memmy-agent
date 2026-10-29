import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBackendServices } from "../index.js";
import { createAppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createPermissionManager } from "../../permission/index.js";
import { createDefaultAgentAdapterRegistry } from "../../adapters/outbound/agent-adapter/index.js";
import { createInMemoryPluginRegistry } from "../../adapters/outbound/plugin-registry/index.js";
import { createMockCloudClient } from "../../tests/support/mock-cloud-client.js";
import { createMockMemoryClient } from "../../tests/support/mock-memory-client.js";

afterEach(() => vi.unstubAllEnvs());

it("refreshes Agent tools when account grants install or disable a plugin, and keeps nickname edits usable", async () => {
  const root = mkdtempSync(join(tmpdir(), "memmy-account-plugin-"));
  vi.stubEnv("MEMMY_AGENT_WORKSPACE", join(root, "workspace"));
  vi.stubEnv("MEMMY_AGENT_DATA_DIR", root);
  const store = createAppStateStore({ databasePath: join(root, "app.sqlite") });
  const cloud = createMockCloudClient();
  const login = await cloud.login({ channel: "phone", phoneNumber: "13800000000", verificationCode: "123456", loginSource: "Memmy" });
  store.repositories.accountSession.upsert({
    uuid: login.accountUuid, cloudUuid: login.uuid, profile: login.profile, authChannel: "phone"
  });
  let grants = ["plugin:legal-labor"];
  const reloadMcpConfig = vi.fn(async () => ({ ok: true, message: "refreshed", requires_restart: false }));
  const services = createBackendServices({
    appStateStore: store,
    agentAdapterRegistry: createDefaultAgentAdapterRegistry(),
    permissionManager: createPermissionManager({ appStateStore: store }),
    memoryClient: createMockMemoryClient(),
    memmyConfigPath: join(root, "config.yaml"),
    cloudClient: {
      ...cloud,
      async getAccountInfo(input) {
        const profile = await cloud.getAccountInfo(input);
        return { ...profile, entitlements: grants, rawProfile: { ...profile.rawProfile, entitlements: grants } };
      }
    },
    memmyAgentAdminClient: {
      getChannelDefinitions: async () => ({ channels: [] }),
      getChannelConnections: async () => ({ connections: [] }),
      configureChannel: async () => ({ status: "connected", running: true }),
      stopChannel: async () => ({ status: "disabled", running: false }),
      startWeixinLogin: async () => ({ status: "pendingQr" }),
      pollWeixinLogin: async () => ({ status: "connected" }),
      startFeishuLogin: async () => ({ status: "pendingQr" }),
      pollFeishuLogin: async () => ({ status: "connected" }),
      reloadMcpConfig
    },
    pluginRegistry: createInMemoryPluginRegistry([{
      manifest: {
        apiVersion: "memmy/v1", id: "legal-labor", name: "Legal Test", version: "0.1.0",
        requiredEntitlement: "plugin:legal-labor",
        rules: { installation: "automatic" },
        runtime: { adapter: "command", config: {} }, permissions: [],
        capabilities: [{ id: "session-start", name: "Start", description: "Start diagnosis",
          inputSchema: { type: "object" }, outputSchema: { type: "object" }, execution: "request" }]
      }
    }]),
    pluginArtifactManager: {
      install: async () => ({ rootPath: null, artifactHash: null }),
      readTextFile: async () => "", remove: async () => undefined
    },
    pluginRuntimeHost: {
      supports: () => true, activate: async () => undefined, deactivate: async () => undefined,
      async *invoke() { yield { type: "result", output: { ok: true } }; },
      cancel: async () => undefined, respond: async () => undefined
    }
  });
  try {
    await services.account.getSession();
    expect(services.plugins.get("legal-labor").state).toBe("active");
    expect(reloadMcpConfig).toHaveBeenCalledTimes(1);
    await services.account.updateProfile({ nickname: "Legal Test" });
    const events = [];
    for await (const event of services.plugins.invoke({
      callId: "test-call", pluginId: "legal-labor", capabilityId: "session-start", conversationId: "test-chat", input: {}
    })) events.push(event);
    expect(events).toEqual([{ type: "result", output: { ok: true } }]);
    await services.account.getSession();
    expect(reloadMcpConfig).toHaveBeenCalledTimes(1);
    grants = [];
    await services.account.getSession();
    expect(services.plugins.get("legal-labor").state).toBe("disabled");
    expect(reloadMcpConfig).toHaveBeenCalledTimes(2);
  } finally {
    await services.plugins.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
