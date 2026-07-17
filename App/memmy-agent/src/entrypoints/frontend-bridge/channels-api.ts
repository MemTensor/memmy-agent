import { ChannelManager } from "../../integrations/channels/manager.js";
import { loadConfig } from "../../config/loader.js";

/** Definition for imessage enabled. */
const IMESSAGE_ENABLED = process.platform === "darwin";

type ChannelStatus =
  | "disabled"
  | "pendingQr"
  | "starting"
  | "connected"
  | "restarting"
  | "expired"
  | "error"
  | "unsupported";
type ChannelDefinition = {
  id: "wechat" | "feishu" | "dingtalk" | "telegram" | "discord" | "imessage";
  runtimeChannel: "weixin" | "feishu" | "dingtalk" | "telegram" | "discord" | "imessage";
  name: string;
  authKind: "qrCode" | "form" | "disabled" | "local";
  enabled: boolean;
  capabilities: string[];
  fields: Array<{ key: string; label: string; kind: "text" | "secret"; required: boolean }>;
};

export interface ChannelAdminOptions {
  /**
   * Read the latest runtime channel configuration.
   */
  loadChannelSection?: (runtimeChannel: string) => Record<string, any> | null;
}

export interface ChannelAdminApi {
  definitions(): { channels: ChannelDefinition[] };
  status(): { connections: Array<Record<string, any>> };
  configure(runtimeChannel: string): Promise<{ status: ChannelStatus; running: boolean }>;
  stop(runtimeChannel: string): Promise<{ status: ChannelStatus; running: boolean }>;
  startWeixinLogin(): Promise<Record<string, any>>;
  pollWeixinLogin(pollToken: string): Promise<Record<string, any>>;
}

const CHANNEL_DEFINITIONS: ChannelDefinition[] = [
  {
    id: "wechat",
    runtimeChannel: "weixin",
    name: "WeChat",
    authKind: "qrCode",
    enabled: true,
    capabilities: ["receiveText", "sendText", "receiveMedia", "sendMedia"],
    fields: [],
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
      { key: "appSecret", label: "App Secret", kind: "secret", required: true },
    ],
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
      { key: "clientSecret", label: "Client Secret", kind: "secret", required: true },
    ],
  },
  {
    id: "telegram",
    runtimeChannel: "telegram",
    name: "Telegram",
    authKind: "form",
    enabled: true,
    capabilities: ["receiveText", "sendText", "receiveMedia", "sendMedia", "streaming"],
    fields: [{ key: "token", label: "Bot Token", kind: "secret", required: true }],
  },
  {
    id: "discord",
    runtimeChannel: "discord",
    name: "Discord",
    authKind: "disabled",
    enabled: false,
    capabilities: [],
    fields: [],
  },
  {
    id: "imessage",
    runtimeChannel: "imessage",
    name: "iMessage",
    authKind: "local",
    enabled: IMESSAGE_ENABLED,
    capabilities: ["receiveText", "sendText"],
    fields: [],
  },
];

/**
 * Create the memmy-agent channel admin API.
 *
 * @param manager Current gateway ChannelManager.
 * @param options Config read functions injectable by tests or runtime.
 * @returns Channel admin API.
 */
export function createChannelAdmin(
  manager: ChannelManager,
  options: ChannelAdminOptions = {},
): ChannelAdminApi {
  const loadChannelSection = options.loadChannelSection ?? loadRuntimeChannelSection;

  return {
    definitions() {
      return {
        channels: CHANNEL_DEFINITIONS.map((definition) => ({
          ...definition,
          fields: [...definition.fields],
        })),
      };
    },

    status() {
      const runtimeStatus = manager.getStatus();
      const connections = CHANNEL_DEFINITIONS.flatMap((definition) => {
        const section = manager.channelSection(definition.runtimeChannel);
        const status = runtimeStatus[definition.runtimeChannel];
        if (!section?.enabled && !status?.enabled && !status?.running) return [];

        return [
          {
            id: `channel-${definition.id}-local`,
            provider: definition.id,
            runtimeChannel: definition.runtimeChannel,
            status: deriveProductStatus(section, status),
            running: Boolean(status?.running),
            displayName: definition.name,
            lastError: status?.lastError ?? null,
            updatedAt: new Date().toISOString(),
          },
        ];
      });
      return { connections };
    },

    async configure(runtimeChannel) {
      const section = loadChannelSection(runtimeChannel);
      if (!section || !section.enabled) {
        await manager.stopChannelByName(runtimeChannel);
        return { status: "disabled", running: false };
      }
      const result = await manager.configureChannel(runtimeChannel, section);
      return { status: result.running ? "connected" : "starting", running: result.running };
    },

    async stop(runtimeChannel) {
      await manager.stopChannelByName(runtimeChannel);
      return { status: "disabled", running: false };
    },

    async startWeixinLogin() {
      const channel = await ensureWeixinChannel(manager, loadChannelSection);
      const startLoginSession = (channel as any)?.startLoginSession;
      if (typeof startLoginSession !== "function") {
        throw new Error("Weixin channel does not support UI login sessions");
      }
      return startLoginSession.call(channel, true);
    },

    async pollWeixinLogin(pollToken) {
      const channel = manager.getChannel("weixin");
      if (!channel) {
        throw new Error("Weixin login session is not available");
      }
      const pollLoginSession = (channel as any)?.pollLoginSession;
      if (typeof pollLoginSession !== "function") {
        throw new Error("Weixin login session is not available");
      }
      const result = await pollLoginSession.call(channel, pollToken);
      if (result?.status === "connected" && !channel.isRunning) {
        manager.ensureOutboundDispatchStarted();
        void manager.startChannel("weixin", channel);
      }
      return result;
    },
  };
}

function deriveProductStatus(section: any, runtimeStatus: any): ChannelStatus {
  if (!section?.enabled) return "disabled";
  // User-actionable errors such as insufficient permissions mean the channel is not truly usable even while the long connection is running, so downgrade to error to avoid false green status.
  if (runtimeStatus?.lastError) return "error";
  if (runtimeStatus?.running) return "connected";
  return "starting";
}

async function ensureWeixinChannel(
  manager: ChannelManager,
  loadChannelSection: (runtimeChannel: string) => Record<string, any> | null,
): Promise<any> {
  const section = loadChannelSection("weixin") ?? { enabled: true };
  return manager.ensureChannelInstance("weixin", { ...section, enabled: true });
}

function loadRuntimeChannelSection(runtimeChannel: string): Record<string, any> | null {
  const config = loadConfig();
  const channels = (config as any)?.channels ?? {};
  const section = channels[runtimeChannel] ?? channels.modelExtra?.[runtimeChannel] ?? null;
  return isRecord(section) ? { ...section } : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
