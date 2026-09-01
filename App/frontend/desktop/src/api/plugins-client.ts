import {
  InstalledPluginSchema,
  InstalledPluginsSchema,
  InvokePluginCapabilityInputSchema,
  InvokePluginCapabilityResponseSchema,
  OkResponseSchema,
  PluginInteractionResponseInputSchema,
  PluginUiRendererResponseSchema,
  type InstalledPlugin,
  type PluginPermission,
  type InvokePluginCapabilityInput,
  type InvokePluginCapabilityResponse,
  type PluginUiSlot,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface PluginsClient {
  list(): Promise<InstalledPlugin[]>;
  install(pluginId: string, version?: string): Promise<InstalledPlugin>;
  approvePermissions(pluginId: string, permissions: PluginPermission[]): Promise<InstalledPlugin>;
  enable(pluginId: string): Promise<InstalledPlugin>;
  disable(pluginId: string): Promise<InstalledPlugin>;
  uninstall(pluginId: string): Promise<void>;
  getUi(pluginId: string, slot: PluginUiSlot): Promise<string>;
  invoke(pluginId: string, capabilityId: string, input: InvokePluginCapabilityInput): Promise<InvokePluginCapabilityResponse>;
  cancel(pluginId: string, callId: string): Promise<void>;
  respond(pluginId: string, callId: string, interactionId: string, response: unknown): Promise<void>;
}

export const pluginEndpointPaths = {
  list: "/api/v1/plugins",
  install: "/api/v1/plugins/install",
  permissions: (pluginId: string) => `/api/v1/plugins/${encodeURIComponent(pluginId)}/permissions`,
  enable: (pluginId: string) => `/api/v1/plugins/${encodeURIComponent(pluginId)}/enable`,
  disable: (pluginId: string) => `/api/v1/plugins/${encodeURIComponent(pluginId)}/disable`,
  plugin: (pluginId: string) => `/api/v1/plugins/${encodeURIComponent(pluginId)}`,
  ui: (pluginId: string, slot: PluginUiSlot) => `/api/v1/plugins/${encodeURIComponent(pluginId)}/ui/${slot}`,
  invoke: (pluginId: string, capabilityId: string) => (
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/capabilities/${encodeURIComponent(capabilityId)}/invoke`
  ),
  cancel: (pluginId: string, callId: string) => (
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/calls/${encodeURIComponent(callId)}/cancel`
  ),
  respond: (pluginId: string, callId: string, interactionId: string) => (
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/calls/${encodeURIComponent(callId)}/interactions/${encodeURIComponent(interactionId)}`
  )
};

export function createHttpPluginsClient(config: RuntimeConfig): PluginsClient {
  const uiCache = new Map<string, Promise<string>>();
  return {
    list() {
      return requestJson({ config, path: pluginEndpointPaths.list, schema: InstalledPluginsSchema });
    },
    install(pluginId, version) {
      return requestJson({
        config,
        path: pluginEndpointPaths.install,
        schema: InstalledPluginSchema,
        body: { pluginId, ...(version ? { version } : {}) }
      });
    },
    approvePermissions(pluginId, permissions) {
      return requestJson({
        config,
        path: pluginEndpointPaths.permissions(pluginId),
        init: { method: "PUT" },
        schema: InstalledPluginSchema,
        body: { permissions }
      });
    },
    enable(pluginId) {
      return requestJson({ config, path: pluginEndpointPaths.enable(pluginId), schema: InstalledPluginSchema, body: {} });
    },
    disable(pluginId) {
      return requestJson({ config, path: pluginEndpointPaths.disable(pluginId), schema: InstalledPluginSchema, body: {} });
    },
    async uninstall(pluginId) {
      await requestJson({ config, path: pluginEndpointPaths.plugin(pluginId), init: { method: "DELETE" }, schema: OkResponseSchema });
    },
    getUi(pluginId, slot) {
      const cacheKey = `${pluginId}:${slot}`;
      const cached = uiCache.get(cacheKey);
      if (cached) return cached;
      const request = requestJson({
        config,
        path: pluginEndpointPaths.ui(pluginId, slot),
        schema: PluginUiRendererResponseSchema
      }).then(({ html }) => html).catch((error) => {
        uiCache.delete(cacheKey);
        throw error;
      });
      uiCache.set(cacheKey, request);
      return request;
    },
    invoke(pluginId, capabilityId, input) {
      return requestJson({
        config,
        path: pluginEndpointPaths.invoke(pluginId, capabilityId),
        schema: InvokePluginCapabilityResponseSchema,
        body: InvokePluginCapabilityInputSchema.parse(input)
      });
    },
    async cancel(pluginId, callId) {
      await requestJson({
        config,
        path: pluginEndpointPaths.cancel(pluginId, callId),
        schema: OkResponseSchema,
        body: {}
      });
    },
    async respond(pluginId, callId, interactionId, response) {
      await requestJson({
        config,
        path: pluginEndpointPaths.respond(pluginId, callId, interactionId),
        schema: OkResponseSchema,
        body: PluginInteractionResponseInputSchema.parse({ response })
      });
    }
  };
}
