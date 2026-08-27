/** Channel service module. */
import {
  ChannelConnectionsResponseSchema,
  ChannelDefinitionsResponseSchema,
  ConnectChannelResponseSchema,
  OkResponseSchema,
  ReportIntegrationConnectionEventInputSchema,
  type ChannelConnectionsResponse,
  type ChannelDefinitionsResponse,
  type ChannelProvider,
  type ChannelRuntime,
  type ChannelStatus,
  type ConnectChannelInput,
  type ConnectChannelResponse,
  type OkResponse,
  type ReportIntegrationConnectionEventInput
} from "@memmy/local-api-contracts";
import type { MemmyAgentAdminClient } from "../adapters/outbound/memmy-agent-admin-client/index.js";
import {
  createToolConnectionAnalytics,
  type ToolConnectionAnalytics,
} from "../analytics/tool-connection-analytics.js";
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
    buildRuntimePatch: (input) => buildFeishuRuntimePatch(input)
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
  reportConnectionEvent(input: ReportIntegrationConnectionEventInput): Promise<OkResponse>;
}

export interface CreateChannelServiceOptions {
  /** Memmy config writer. */
  memmyConfigWriter: Pick<MemmyConfigWriter, "patchChannelConfig">;
  /** Memmy agent admin client. */
  memmyAgentAdminClient: MemmyAgentAdminClient;
  /** Tool connection analytics. */
  toolConnectionAnalytics?: ToolConnectionAnalytics;
}

/** Creates create channel service. */
export function createChannelService(options: CreateChannelServiceOptions): ChannelService {
  const toolConnectionAnalytics = options.toolConnectionAnalytics ?? createToolConnectionAnalytics();

  return {
    async listDefinitions() {
      return CHANNEL_DEFINITIONS;
    },

    async listConnections() {
      return ChannelConnectionsResponseSchema.parse(await options.memmyAgentAdminClient.getChannelConnections());
    },

    async connect(provider, input) {
      try {
        if (provider === "wechat") {
          await options.memmyConfigWriter.patchChannelConfig("weixin", {
            enabled: true,
            appId: input.appId?.trim() || WEIXIN_DEFAULT_APP_ID,
            allowFrom: ["*"]
          });
          const response = await options.memmyAgentAdminClient.startWeixinLogin();
          return trackChannelConnectResponse(
            toolConnectionAnalytics,
            provider,
            parseConnectResponse(provider, response.status, response)
          );
        }

        if (provider === "feishu" && !input.appId && !input.appSecret) {
          const response = await options.memmyAgentAdminClient.startFeishuLogin();
          return trackChannelConnectResponse(
            toolConnectionAnalytics,
            provider,
            parseConnectResponse(provider, response.status, response)
          );
        }

        const formConnect = FORM_CHANNEL_CONNECT[provider];
        if (formConnect) {
          await options.memmyConfigWriter.patchChannelConfig(formConnect.runtimeChannel, formConnect.buildRuntimePatch(input));
          const result = await options.memmyAgentAdminClient.configureChannel(formConnect.runtimeChannel);
          return trackChannelConnectResponse(
            toolConnectionAnalytics,
            provider,
            parseConnectResponse(provider, result.status)
          );
        }

        const localConnect = LOCAL_CHANNEL_CONNECT[provider];
        if (localConnect) {
          await options.memmyConfigWriter.patchChannelConfig(localConnect.runtimeChannel, localConnect.runtimePatch);
          const result = await options.memmyAgentAdminClient.configureChannel(localConnect.runtimeChannel);
          return trackChannelConnectResponse(
            toolConnectionAnalytics,
            provider,
            parseConnectResponse(provider, result.status)
          );
        }

        return trackChannelConnectResponse(
          toolConnectionAnalytics,
          provider,
          parseConnectResponse(provider, "unsupported")
        );
      } catch (error) {
        trackChannelConnectionFailed(toolConnectionAnalytics, provider, error);
        throw error;
      }
    },

    async pollConnect(provider, pollToken) {
      try {
        const normalizedPollToken = requireNonEmptyString(pollToken, "pollToken");
        if (provider === "feishu") {
          const response = await options.memmyAgentAdminClient.pollFeishuLogin(normalizedPollToken);
          if (response.status !== "connected") {
            return trackChannelConnectResponse(
              toolConnectionAnalytics,
              provider,
              parseConnectResponse(provider, response.status, response)
            );
          }
          const appId = requireNonEmptyString(response.appId ?? "", "appId");
          const appSecret = requireNonEmptyString(response.appSecret ?? "", "appSecret");
          await options.memmyConfigWriter.patchChannelConfig(
            "feishu",
            buildFeishuRuntimePatch({ appId, appSecret }, response.domain)
          );
          const result = await options.memmyAgentAdminClient.configureChannel("feishu");
          return trackChannelConnectResponse(
            toolConnectionAnalytics,
            provider,
            parseConnectResponse(provider, result.status)
          );
        }

        if (provider !== "wechat") {
          return trackChannelConnectResponse(
            toolConnectionAnalytics,
            provider,
            parseConnectResponse(provider, "unsupported")
          );
        }

        const response = await options.memmyAgentAdminClient.pollWeixinLogin(normalizedPollToken);
        return trackChannelConnectResponse(
          toolConnectionAnalytics,
          provider,
          parseConnectResponse(provider, response.status, response)
        );
      } catch (error) {
        trackChannelConnectionFailed(toolConnectionAnalytics, provider, error);
        throw error;
      }
    },

    async disconnect(provider) {
      try {
        const runtimeChannel = PRODUCT_TO_RUNTIME[provider];
        if (provider === "wechat" || FORM_CHANNEL_CONNECT[provider] || LOCAL_CHANNEL_CONNECT[provider]) {
          await options.memmyConfigWriter.patchChannelConfig(runtimeChannel, { enabled: false });
          await options.memmyAgentAdminClient.stopChannel(runtimeChannel);
        }

        toolConnectionAnalytics.trackConnection({
          surface: "channel",
          toolkit: provider,
          event: "disconnected",
        });
        return OkResponseSchema.parse({ ok: true });
      } catch (error) {
        trackChannelConnectionFailed(toolConnectionAnalytics, provider, error);
        throw error;
      }
    },

    async reportConnectionEvent(input) {
      const parsed = ReportIntegrationConnectionEventInputSchema.parse(input);
      if (parsed.surface !== "channel") {
        throw new Error(`channel reportConnectionEvent requires surface=channel, got ${parsed.surface}`);
      }
      toolConnectionAnalytics.trackConnection({
        surface: parsed.surface,
        toolkit: parsed.toolkit,
        event: parsed.event,
        errorCode: parsed.errorCode,
      });
      return OkResponseSchema.parse({ ok: true });
    }
  };
}

function trackChannelConnectResponse(
  analytics: ToolConnectionAnalytics,
  provider: ChannelProvider | string,
  response: ConnectChannelResponse
): ConnectChannelResponse {
  if (response.status === "connected") {
    analytics.trackConnection({
      surface: "channel",
      toolkit: provider,
      event: "connected",
    });
  } else if (
    response.status === "error" ||
    response.status === "expired" ||
    response.status === "unsupported"
  ) {
    analytics.trackConnection({
      surface: "channel",
      toolkit: provider,
      event: "failed",
      errorCode: response.status,
    });
  }
  return response;
}

function trackChannelConnectionFailed(
  analytics: ToolConnectionAnalytics,
  provider: ChannelProvider | string,
  error: unknown
): void {
  analytics.trackConnection({
    surface: "channel",
    toolkit: provider,
    event: "failed",
    error,
  });
}

function buildFeishuRuntimePatch(
  input: ConnectChannelInput,
  domain: "feishu" | "lark" = "feishu"
): Record<string, unknown> {
  return {
    enabled: true,
    appId: requireNonEmptyString(input.appId ?? "", "appId"),
    appSecret: requireNonEmptyString(input.appSecret ?? "", "appSecret"),
    domain,
    streaming: true,
    groupPolicy: "mention",
    allowFrom: ["*"]
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
