/** Artifact-only conformance entry. This fixture contains no plugin business code. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBackendServices } from "../../services/index.js";
import { createAppStateStore } from "../../infrastructure/app-state-store/index.js";
import { createPermissionManager } from "../../permission/index.js";
import { createDefaultAgentAdapterRegistry } from "../../adapters/outbound/agent-adapter/index.js";
import { createHttpPluginRegistry } from "../../adapters/outbound/plugin-registry/index.js";
import { createMockCloudClient } from "./mock-cloud-client.js";
import { createMockMemoryClient } from "./mock-memory-client.js";
import { createNativePluginServices } from "../../../../memmy-agent/src/tools/plugin-host/native-services.js";
import { SkillsLoader } from "../../../../memmy-agent/src/core/agent-runtime/skills.js";
import type { EventCaptureSource } from "../../../../memmy-agent/src/tools/computer-history/core/event-capture-source.js";
import type { BrowserCaptureProvider } from "../../../../memmy-agent/src/tools/computer-history/browser-event-capture.js";

export { MEMMY_VERSION } from "../../project-version.js";
export { PLUGIN_HOST_CAPABILITIES } from "../../services/plugin-host-capabilities.js";
export { EventCaptureSessionSchema, PluginManifestSchema } from "@memmy/local-api-contracts";

export function createPluginHostHarness(options: {
  root: string; registryUrl: string; platform?: NodeJS.Platform;
  source: EventCaptureSource; availableTools?: string[]; browser?: BrowserCaptureProvider;
}) {
  const assetRoot = path.dirname(fileURLToPath(import.meta.url));
  const workspace = path.join(options.root, "workspace"), data = path.join(options.root, "agent-data");
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(data, { recursive: true });
  const previous = { workspace: process.env.MEMMY_AGENT_WORKSPACE, data: process.env.MEMMY_AGENT_DATA_DIR, cloud: process.env.MEMMY_CLOUD_URL, registry: process.env.MEMMY_PLUGIN_REGISTRY_URL };
  process.env.MEMMY_AGENT_WORKSPACE = workspace; process.env.MEMMY_AGENT_DATA_DIR = data;
  process.env.MEMMY_CLOUD_URL = options.registryUrl; process.env.MEMMY_PLUGIN_REGISTRY_URL = options.registryUrl;
  const store = createAppStateStore({ databasePath: path.join(options.root, "app.sqlite") });
  const loader = new SkillsLoader(workspace, path.join(assetRoot, "skills"), null,
    { pluginDataRoot: path.join(options.root, "plugin-data"), pluginSkillsRoot: path.join(options.root, "plugin-skills"), includePlugins: true });
  loader.availableTools = () => options.availableTools ?? ["read_file", "write_file"];
  const native = createNativePluginServices({ dataRoot: path.join(options.root, "plugin-data"),
    platform: options.platform ?? process.platform, history: options.source, browser: options.browser,
    // A cross-platform fixture controls the OS version as well as its event source.
    ...(options.platform === "darwin" && process.platform !== "darwin" ? { osRelease: "23.0.0" } : {}),
    toolNames: loader.availableTools, skills: () => loader.listSkills(false).map(({ name, path }) => ({ name, path })),
    skillCreatorFile: path.join(assetRoot, "skills", "skill-creator", "SKILL.md") });
  let reloads = 0;
  const services = createBackendServices({ appStateStore: store,
    agentAdapterRegistry: createDefaultAgentAdapterRegistry(),
    permissionManager: createPermissionManager({ appStateStore: store }),
    memoryClient: createMockMemoryClient(), cloudClient: createMockCloudClient(),
    memmyConfigPath: path.join(options.root, "config.yaml"),
    pluginPlatform: options.platform, trustedNativeRegistryOrigins: [new URL(options.registryUrl).origin],
    pluginRegistry: createHttpPluginRegistry({ baseUrl: options.registryUrl, trustedNativeOrigin: options.registryUrl }),
    memmyAgentAdminClient: {
      getChannelDefinitions: async () => ({ channels: [] }), getChannelConnections: async () => ({ connections: [] }),
      configureChannel: async () => ({ status: "connected", running: true }), stopChannel: async () => ({ status: "disabled", running: false }),
      startWeixinLogin: async () => ({ status: "pendingQr" }), pollWeixinLogin: async () => ({ status: "connected" }),
      startFeishuLogin: async () => ({ status: "pendingQr" }), pollFeishuLogin: async () => ({ status: "connected" }),
      reloadMcpConfig: async () => { reloads++; return { ok: true, message: "", requires_restart: false }; },
      invokePluginHostService: (pluginId, service, input) => native.invoke({ pluginId, service, input })
    }
  });
  return {
    plugins: services.plugins, store, loader,
    skillCreatorValidator: path.join(assetRoot, "skills", "skill-creator", "scripts", "quick-validate.py"),
    reloadCount: () => reloads,
    start: async () => { await services.pluginLifecycle?.start(); await services.plugins.restoreActive(); },
    async close() {
      try { await services.pluginLifecycle?.close(); await native.shutdown(); }
      finally {
        store.close();
        for (const [key, value] of [["MEMMY_AGENT_WORKSPACE", previous.workspace], ["MEMMY_AGENT_DATA_DIR", previous.data], ["MEMMY_CLOUD_URL", previous.cloud], ["MEMMY_PLUGIN_REGISTRY_URL", previous.registry]] as const) {
          if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
      }
    }
  };
}
