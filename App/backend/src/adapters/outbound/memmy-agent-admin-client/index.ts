/** Memmy agent admin client module. */
import type {
  ChannelConnectionsResponse,
  ChannelDefinitionsResponse,
  ChannelStatus
} from "@memmy/local-api-contracts";

export interface MemmyAgentAdminClient {
  getChannelDefinitions(): Promise<ChannelDefinitionsResponse>;
  getChannelConnections(): Promise<ChannelConnectionsResponse>;
  configureChannel(runtimeChannel: string): Promise<{ status: ChannelStatus; running: boolean }>;
  stopChannel(runtimeChannel: string): Promise<{ status: ChannelStatus; running: boolean }>;
  startWeixinLogin(): Promise<{ status: ChannelStatus; qrCodeDataUrl?: string; pollToken?: string }>;
  pollWeixinLogin(pollToken: string): Promise<{ status: ChannelStatus; qrCodeDataUrl?: string; pollToken?: string }>;
}
