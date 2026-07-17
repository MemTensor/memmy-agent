import {
  ChannelConnectionsResponseSchema,
  ChannelDefinitionsResponseSchema,
  ConnectChannelResponseSchema,
  OkResponseSchema,
  PollChannelConnectResponseSchema,
  type ChannelConnectionsResponse,
  type ChannelDefinitionsResponse,
  type ChannelProvider,
  type ConnectChannelInput,
  type ConnectChannelResponse,
  type PollChannelConnectResponse,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface ChannelsClient {
  listDefinitions(): Promise<ChannelDefinitionsResponse>;
  listConnections(): Promise<ChannelConnectionsResponse>;
  connect(provider: ChannelProvider, input?: ConnectChannelInput): Promise<ConnectChannelResponse>;
  pollConnect(provider: ChannelProvider, pollToken: string): Promise<PollChannelConnectResponse>;
  disconnect(provider: ChannelProvider): Promise<void>;
}

export const channelEndpointPaths = {
  listDefinitions: "/api/v1/channels/definitions",
  listConnections: "/api/v1/channels/connections",
  connect: (provider: ChannelProvider) => `/api/v1/channels/${encodeURIComponent(provider)}/connect`,
  pollConnect: (provider: ChannelProvider, pollToken: string) =>
    `/api/v1/channels/${encodeURIComponent(provider)}/connect/${encodeURIComponent(pollToken)}`,
  disconnect: (provider: ChannelProvider) => `/api/v1/channels/${encodeURIComponent(provider)}/disconnect`
};

/**
 * Creates the default message-channel client backed by the real local API.
 *
 * @param config Local API runtime config.
 * @returns A client that calls the local channels API.
 */
export function createHttpChannelsClient(config: RuntimeConfig): ChannelsClient {
  return {
    async listDefinitions() {
      return requestJson({
        config,
        path: channelEndpointPaths.listDefinitions,
        schema: ChannelDefinitionsResponseSchema
      });
    },
    async listConnections() {
      return requestJson({
        config,
        path: channelEndpointPaths.listConnections,
        schema: ChannelConnectionsResponseSchema
      });
    },
    async connect(provider, input) {
      return requestJson({
        config,
        path: channelEndpointPaths.connect(provider),
        schema: ConnectChannelResponseSchema,
        init: { method: "POST" },
        body: input
      });
    },
    async pollConnect(provider, pollToken) {
      return requestJson({
        config,
        path: channelEndpointPaths.pollConnect(provider, pollToken),
        schema: PollChannelConnectResponseSchema
      });
    },
    async disconnect(provider) {
      await requestJson({
        config,
        path: channelEndpointPaths.disconnect(provider),
        schema: OkResponseSchema,
        init: { method: "POST" }
      });
    }
  };
}
