/** Channel service module. */
import {
  ChannelConnectionsResponseSchema,
  ChannelDefinitionsResponseSchema,
  ConnectChannelResponseSchema,
  OkResponseSchema,
  type ChannelConnectionsResponse,
  type ChannelDefinitionsResponse,
  type ChannelProvider,
  type ChannelRuntime,
  type ChannelStatus,
  type ConnectChannelInput,
  type ConnectChannelResponse,
  type OkResponse
} from "@memmy/local-api-contracts";
import type { MemmyAgentAdminClient } from "../adapters/outbound/memmy-agent-admin-client/index.js";
import type { MemmyConfigWriter } from "../infrastructure/memmy-config/index.js";
import { requireNonEmptyString } from "../shared/input-validation.js";

const IMESSAGE_ENABLED = process.platform === "darwin";

const WEIXIN_DEFAULT_APP_ID = "bot";

const CHANNEL_DEFINITIONS: ChannelDefinitionsResponse = ChannelDefinitionsResponseSchema.parse({
  channels: [
    {
      id: "wechat",
      runtimeChannel: "weixin",
      name: "WeChat",
      authKind: "qrCode",
      enabled: true,
      capabilities: ["receiveText", "sendText", "receiveMedia", "sendMedia"],
      fields: []
    },
    {
      id: "feishu",
      runtimeChannel: "feishu",
      name: "Feishu",
      authKind: "form",
      enabled: true,
      capabilities: ["receiveText", "sendText", "streaming"],
      fields: [
        { key: "appId", label: "App ID", kind: "text", required: true },
        { key: "appSecret", label: "App Secret", kind: "secret", required: true }
      ]
    },
    {
      id: "dingtalk",
      runtimeChannel: "dingtalk",
      name: "DingTalk",
      authKind: "form",
      enabled: true,
      capabilities: ["receiveText", "sendText", "streaming"],
      fields: [
        { key: "clientId", label: "Client ID", kind: "text", required: true },
        { key: "clientSecret", label: "Client Secret", kind: "secret", required: true }
      ]
    },
    {
      id: "telegram",
      runtimeChannel: "telegram",
      name: "Telegram",
      authKind: "form",
      enabled: true,
      capabilities: ["receiveText", "sendText", "receiveMedia", "sendMedia", "streaming"],
      fields: [{ key: "token", label: "Bot Token", kind: "secret", required: true }]
    },
    {
      id: "discord",
      runtimeChannel: "discord",
      name: "Discord",
      authKind: "form",
      enabled: true,
      capabilities: ["receiveText", "sendText", "receiveMedia", "sendMedia", "streaming"],
      fields: [{ key: "token", label: "Bot Token", kind: "secret", required: true }]
    },
    {
      id: "imessage",
      runtimeChannel: "imessage",
      name: "iMessage",
      authKind: "local",
      enabled: IMESSAGE_ENABLED,
      capabilities: ["receiveText", "sendText"],
      fields: []
    }
  ]
});

const PRODUCT_TO_RUNTIME: Record<ChannelProvider, ChannelRuntime> = {
  wechat: "weixin",
  feishu: "feishu",
  dingtalk: "dingtalk",
  telegram: "telegram",
  discord: "discord",
  imessage: "imessage"
};

/** Contract for form channel connect config. */
interface FormChannelConnectConfig {
  /** Runtime channel. */
  runtimeChannel: ChannelRuntime;
  /** Builds build runtime patch. */
  buildRuntimePatch(input: ConnectChannelInput): Record<string, unknown>;
}

const FORM_CHANNEL_CONNECT: Partial<Record<ChannelProvider, FormChannelConnectConfig>> = {
  feishu: {
    runtimeChannel: "feishu",
    buildRuntimePatch: (input) => ({
      enabled: true,
      appId: requireNonEmptyString(input.appId ?? "", "appId"),
      appSecret: requireNonEmptyString(input.appSecret ?? "", "appSecret"),
      domain: "feishu",
      streaming: true,
      groupPolicy: "mention",
      allowFrom: ["*"]
    })
  },
  dingtalk: {
    runtimeChannel: "dingtalk",
    buildRuntimePatch: (input) => ({
      enabled: true,
      clientId: requireNonEmptyString(input.clientId ?? "", "clientId"),
      clientSecret: requireNonEmptyString(input.clientSecret ?? "", "clientSecret"),
      allowFrom: ["*"]
    })
  },
  discord: {
    runtimeChannel: "discord",
    buildRuntimePatch: (input) => ({
      enabled: true,
      token: requireNonEmptyString(input.token ?? "", "token"),
      allowFrom: ["*"]
    })
  },
  telegram: {
    runtimeChannel: "telegram",
    buildRuntimePatch: (input) => ({
      enabled: true,
      token: requireNonEmptyString(input.token ?? "", "token"),
      allowFrom: ["*"]
    })
  }
};

const LOCAL_CHANNEL_CONNECT: Partial<Record<ChannelProvider, { runtimeChannel: ChannelRuntime; runtimePatch: Record<string, unknown> }>> = {
  imessage: {
    runtimeChannel: "imessage",
    runtimePatch: { enabled: true, allowFrom: ["*"] }
  }
};

export interface ChannelService {
  listDefinitions(): Promise<ChannelDefinitionsResponse>;
  listConnections(): Promise<ChannelConnectionsResponse>;
  connect(provider: ChannelProvider, input: ConnectChannelInput): Promise<ConnectChannelResponse>;
  pollConnect(provider: ChannelProvider, pollToken: string): Promise<ConnectChannelResponse>;
  disconnect(provider: ChannelProvider): Promise<OkResponse>;
}

export interface CreateChannelServiceOptions {
  /** Memmy config writer. */
  memmyConfigWriter: Pick<MemmyConfigWriter, "patchChannelConfig">;
  /** Memmy agent admin client. */
  memmyAgentAdminClient: MemmyAgentAdminClient;
}

/** Creates create channel service. */
export function createChannelService(options: CreateChannelServiceOptions): ChannelService {
  return {
    async listDefinitions() {
      return CHANNEL_DEFINITIONS;
    },

    async listConnections() {
      return ChannelConnectionsResponseSchema.parse(await options.memmyAgentAdminClient.getChannelConnections());
    },

    async connect(provider, input) {
      if (provider === "wechat") {
        await options.memmyConfigWriter.patchChannelConfig("weixin", {
          enabled: true,
          appId: input.appId?.trim() || WEIXIN_DEFAULT_APP_ID,
          allowFrom: ["*"]
        });
        const response = await options.memmyAgentAdminClient.startWeixinLogin();
        return parseConnectResponse(provider, response.status, response);
      }

      const formConnect = FORM_CHANNEL_CONNECT[provider];
      if (formConnect) {
        await options.memmyConfigWriter.patchChannelConfig(formConnect.runtimeChannel, formConnect.buildRuntimePatch(input));
        const result = await options.memmyAgentAdminClient.configureChannel(formConnect.runtimeChannel);
        return parseConnectResponse(provider, result.status);
      }

      const localConnect = LOCAL_CHANNEL_CONNECT[provider];
      if (localConnect) {
        await options.memmyConfigWriter.patchChannelConfig(localConnect.runtimeChannel, localConnect.runtimePatch);
        const result = await options.memmyAgentAdminClient.configureChannel(localConnect.runtimeChannel);
        return parseConnectResponse(provider, result.status);
      }

      return parseConnectResponse(provider, "unsupported");
    },

    async pollConnect(provider, pollToken) {
      if (provider !== "wechat") {
        return parseConnectResponse(provider, "unsupported");
      }

      const response = await options.memmyAgentAdminClient.pollWeixinLogin(requireNonEmptyString(pollToken, "pollToken"));
      return parseConnectResponse(provider, response.status, response);
    },

    async disconnect(provider) {
      const runtimeChannel = PRODUCT_TO_RUNTIME[provider];
      if (provider === "wechat" || FORM_CHANNEL_CONNECT[provider] || LOCAL_CHANNEL_CONNECT[provider]) {
        await options.memmyConfigWriter.patchChannelConfig(runtimeChannel, { enabled: false });
        await options.memmyAgentAdminClient.stopChannel(runtimeChannel);
      }

      return OkResponseSchema.parse({ ok: true });
    }
  };
}

function parseConnectResponse(
  provider: ChannelProvider,
  status: ChannelStatus,
  extra: { qrCodeDataUrl?: string; pollToken?: string } = {}
): ConnectChannelResponse {
  return ConnectChannelResponseSchema.parse({
    status,
    connectionId: `channel-${provider}-local`,
    ...extra
  });
}
