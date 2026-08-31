import {
  InstalledPluginsSchema,
  OkResponseSchema,
  PluginInteractionResponseInputSchema,
  PluginUiRendererResponseSchema,
  type InstalledPlugin,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface PluginsClient {
  list(): Promise<InstalledPlugin[]>;
  getRenderer(pluginId: string): Promise<string>;
  cancel(pluginId: string, callId: string): Promise<void>;
  respond(pluginId: string, callId: string, interactionId: string, response: unknown): Promise<void>;
}

export const pluginEndpointPaths = {
  list: "/api/v1/plugins",
  renderer: (pluginId: string) => `/api/v1/plugins/${encodeURIComponent(pluginId)}/ui/renderer`,
  cancel: (pluginId: string, callId: string) => (
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/calls/${encodeURIComponent(callId)}/cancel`
  ),
  respond: (pluginId: string, callId: string, interactionId: string) => (
    `/api/v1/plugins/${encodeURIComponent(pluginId)}/calls/${encodeURIComponent(callId)}/interactions/${encodeURIComponent(interactionId)}`
  )
};

export function createHttpPluginsClient(config: RuntimeConfig): PluginsClient {
  const rendererCache = new Map<string, Promise<string>>();
  return {
    list() {
      return requestJson({ config, path: pluginEndpointPaths.list, schema: InstalledPluginsSchema });
    },
    getRenderer(pluginId) {
      const cached = rendererCache.get(pluginId);
      if (cached) return cached;
      const request = requestJson({
        config,
        path: pluginEndpointPaths.renderer(pluginId),
        schema: PluginUiRendererResponseSchema
      }).then(({ html }) => html).catch((error) => {
        rendererCache.delete(pluginId);
        throw error;
      });
      rendererCache.set(pluginId, request);
      return request;
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
