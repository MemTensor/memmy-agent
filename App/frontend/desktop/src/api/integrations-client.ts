import {
  AuthorizeIntegrationResponseSchema,
  IntegrationCapabilitiesResponseSchema,
  IntegrationConnectionsResponseSchema,
  OkResponseSchema,
  type AuthorizeIntegrationResponse,
  type IntegrationCapabilitiesResponse,
  type IntegrationConnectionsResponse,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface IntegrationsClient {
  listCapabilities(): Promise<IntegrationCapabilitiesResponse>;
  authorize(slug: string): Promise<AuthorizeIntegrationResponse>;
  listConnections(): Promise<IntegrationConnectionsResponse>;
  deleteConnection(id: string): Promise<void>;
}

export const integrationEndpointPaths = {
  listCapabilities: "/api/v1/integrations/capabilities",
  authorize: (slug: string) => `/api/v1/integrations/${encodeURIComponent(slug)}/authorize`,
  listConnections: "/api/v1/integrations/connections",
  deleteConnection: (id: string) => `/api/v1/integrations/connections/${encodeURIComponent(id)}`
};

/**
 * Creates the tool-integrations client backed by the real local API.
 *
 * @param config Local API runtime config.
 * @returns An IntegrationsClient that calls the local API.
 */
export function createHttpIntegrationsClient(config: RuntimeConfig): IntegrationsClient {
  return {
    async listCapabilities() {
      return requestJson({
        config,
        path: integrationEndpointPaths.listCapabilities,
        schema: IntegrationCapabilitiesResponseSchema
      });
    },
    async authorize(slug) {
      return requestJson({
        config,
        path: integrationEndpointPaths.authorize(slug),
        schema: AuthorizeIntegrationResponseSchema,
        init: { method: "POST" }
      });
    },
    async listConnections() {
      return requestJson({
        config,
        path: integrationEndpointPaths.listConnections,
        schema: IntegrationConnectionsResponseSchema
      });
    },
    async deleteConnection(id) {
      await requestJson({
        config,
        path: integrationEndpointPaths.deleteConnection(id),
        schema: OkResponseSchema,
        init: { method: "DELETE" }
      });
    }
  };
}
