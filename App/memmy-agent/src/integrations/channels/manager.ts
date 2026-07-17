import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MessageBus, OutboundMessage } from "../../core/runtime-messages/index.js";
import { consumeRestartNoticeFromEnv, formatRestartCompletedMessage } from "../../utils/restart.js";
import { BaseChannel } from "./base.js";
import { discoverChannelNames, discoverEnabled, normalizeChannelName } from "./registry.js";

const SEND_RETRY_DELAYS = [1, 2, 4];
function defaultConfig(): any {
  return {
    channels: {
      sendProgress: true,
      sendToolHints: false,
      showReasoning: true,
      sendMaxRetries: 3,
    },
  };
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, seconds * 1000);
    timer.unref?.();
  });
}

function defaultWebuiDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "web", "dist"),
    path.resolve(here, "..", "..", "web", "dist"),
    path.resolve(here, "..", "webui", "dist"),
    path.resolve(here, "..", "..", "webui", "dist"),
  ];
  return (
    candidates.find(
      (candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory(),
    ) ?? null
  );
}

export class ChannelManager {
  config: any;
  bus: MessageBus;
  channels: Record<string, BaseChannel> = {};
  dispatchTask: Promise<void> | null = null;
  originReplyFingerprints = new Map<string, string>();
  sessionManager: any = null;
  webuiRuntimeModelName: (() => string | null) | null = null;
  cancelActiveTasks: ((sessionKey: string) => Promise<number>) | null = null;

  constructor(
    configOrBus: any = defaultConfig(),
    bus?: MessageBus,
    options: {
      sessionManager?: any;
      webuiRuntimeModelName?: (() => string | null) | null;
      cancelActiveTasks?: ((sessionKey: string) => Promise<number>) | null;
    } = {},
  ) {
    if (configOrBus instanceof MessageBus) {
      this.config = defaultConfig();
      this.bus = configOrBus;
    } else {
      this.config = configOrBus ?? defaultConfig();
      this.bus = bus ?? new MessageBus();
    }
    this.sessionManager = options.sessionManager ?? null;
    this.webuiRuntimeModelName = options.webuiRuntimeModelName ?? null;
    this.cancelActiveTasks = options.cancelActiveTasks ?? null;
    this.initChannels();
  }

  register(channel: BaseChannel): void {
    this.channels[channel.name] = channel;
  }

  getChannel(name: string): BaseChannel | null {
    return this.channels[name] ?? null;
  }

  channelSection(name: string): any {
    const channels = this.config?.channels ?? {};
    return channels[name] ?? channels.modelExtra?.[name] ?? null;
  }

  resolveTranscriptionKey(provider: string): string {
    const providers = this.config?.providers ?? {};
    const section = provider === "openai" ? providers.openai : providers.groq;
    return section?.apiKey ?? section?.api_key ?? "";
  }

  resolveTranscriptionBase(provider: string): string {
    const providers = this.config?.providers ?? {};
    const section = provider === "openai" ? providers.openai : providers.groq;
    return section?.apiBase ?? section?.api_base ?? "";
  }

  candidateChannelNames(): Set<string> {
    const channels = this.config?.channels ?? {};
    const builtinNames = discoverChannelNames();
    const candidateNames = new Set<string>(builtinNames);
    if (channels.modelExtra && typeof channels.modelExtra === "object") {
      for (const key of Object.keys(channels.modelExtra)) candidateNames.add(key);
    }
    for (const [key, value] of Object.entries(channels)) {
      if (value && typeof value === "object" && "enabled" in value) candidateNames.add(key);
    }
    return candidateNames;
  }

  channelRuntimeOptions(name: string): Record<string, any> {
    const options: Record<string, any> = {};
    if (name !== "websocket") return options;

    if (this.sessionManager) {
      options.sessionManager = this.sessionManager;
      const staticDistPath = defaultWebuiDist();
      if (staticDistPath) options.staticDistPath = staticDistPath;
    }
    const workspacePath = this.config?.workspacePath ?? this.config?.workspace_path;
    if (workspacePath) options.workspacePath = workspacePath;
    if (this.webuiRuntimeModelName) options.runtimeModelName = this.webuiRuntimeModelName;
    if (this.cancelActiveTasks) options.cancelActiveTasks = this.cancelActiveTasks;
    return options;
  }

  buildChannel(name: string, section: any): BaseChannel | null {
    const normalized = normalizeChannelName(name);
    const cls = discoverEnabled(new Set([normalized]), { names: discoverChannelNames() })[
      normalized
    ];
    if (!cls) return null;

    const channels = this.config?.channels ?? {};
    const transcriptionProvider = channels.transcriptionProvider ?? "groq";
    const transcriptionKey = this.resolveTranscriptionKey(transcriptionProvider);
    const transcriptionBase = this.resolveTranscriptionBase(transcriptionProvider);
    const transcriptionLanguage = channels.transcriptionLanguage ?? null;

    const channel = new cls(section, this.bus, this.channelRuntimeOptions(normalized));
    channel.transcriptionProvider = transcriptionProvider;
    channel.transcriptionApiKey = transcriptionKey;
    channel.transcriptionApiBase = transcriptionBase;
    channel.transcriptionLanguage = transcriptionLanguage;
    channel.sendProgress = this.resolveBoolOverride(
      section,
      "sendProgress",
      channels.sendProgress ?? true,
    );
    channel.sendToolHints = this.resolveBoolOverride(
      section,
      "sendToolHints",
      channels.sendToolHints ?? false,
    );
    channel.showReasoning = this.resolveBoolOverride(
      section,
      "showReasoning",
      channels.showReasoning ?? true,
    );
    return channel;
  }

  initChannels(): void {
    const candidateNames = this.candidateChannelNames();
    const enabledNames = new Set<string>();
    for (const name of candidateNames) {
      const section = this.channelSection(name);
      if (section && typeof section === "object" && Boolean(section.enabled))
        enabledNames.add(name);
    }
    for (const name of enabledNames) {
      const section = this.channelSection(name);
      if (!section) continue;
      try {
        const channel = this.buildChannel(name, section);
        if (!channel) continue;
        this.channels[normalizeChannelName(name)] = channel;
      } catch {
        // A channel with missing optional dependencies should not stop the gateway.
      }
    }
    this.validateAllowFrom();
  }

  validateAllowFrom(): void {
    for (const channel of Object.values(this.channels)) {
      const cfg = channel.config;
      const allow = cfg?.allowFrom;
      if (allow == null || Array.isArray(allow)) continue;
      throw new Error(`${channel.name}.allowFrom must be a list of sender ids`);
    }
  }

  async start(): Promise<void> {
    await this.startAll();
  }

  setChannelSection(name: string, section: Record<string, any>): void {
    const normalized = normalizeChannelName(name);
    const channels = (this.config.channels ??= {});
    if (
      channels.modelExtra &&
      typeof channels.modelExtra === "object" &&
      normalized in channels.modelExtra
    ) {
      channels.modelExtra[normalized] = section;
      return;
    }
    channels[normalized] = section;
  }

  async stopChannelByName(name: string): Promise<void> {
    const normalized = normalizeChannelName(name);
    const channel = this.channels[normalized];
    if (!channel) return;
    try {
      await channel.stop();
    } finally {
      delete this.channels[normalized];
    }
  }

  async configureChannel(
    name: string,
    section: Record<string, any>,
  ): Promise<{ enabled: boolean; running: boolean }> {
    const normalized = normalizeChannelName(name);
    this.setChannelSection(normalized, section);
    await this.stopChannelByName(normalized);

    if (!section.enabled) {
      return { enabled: false, running: false };
    }

    const channel = this.buildChannel(normalized, section);
    if (!channel) {
      return { enabled: false, running: false };
    }

    this.channels[normalized] = channel;
    await channel.start();
    return { enabled: true, running: channel.isRunning };
  }

  /**
   * Ensure the channel instance has been created with the latest configuration, without starting long polling or external connections.
   *
   * @param name Runtime channel name.
   * @param section Channel config section.
   * @returns Running, refreshed, or newly created channel instance; null when it cannot be built.
   */
  ensureChannelInstance(name: string, section: Record<string, any>): BaseChannel | null {
    const normalized = normalizeChannelName(name);
    this.setChannelSection(normalized, section);
    const existing = this.channels[normalized];
    if (existing?.isRunning) return existing;

    if (!section.enabled) {
      delete this.channels[normalized];
      return null;
    }
    const channel = this.buildChannel(normalized, section);
    if (!channel) return existing ?? null;
    this.channels[normalized] = channel;
    return channel;
  }

  /**
   * Ensure the outbound dispatch loop has started.
   *
   * @remarks When channels are added dynamically and the gateway started with no channels, the reply queue needs an explicit consumer loop start.
   */
  ensureOutboundDispatchStarted(): void {
    if (this.dispatchTask) return;
    this.dispatchTask = this.dispatchOutbound();
    this.notifyRestartDoneIfNeeded();
  }

  async startChannel(name: string, channel: BaseChannel): Promise<void> {
    try {
      await channel.start();
    } catch {
      // Keep other channels available when one integration fails to start.
    }
  }

  async startAll(): Promise<void> {
    if (!Object.keys(this.channels).length) return;
    this.ensureOutboundDispatchStarted();
    await Promise.all(
      Object.entries(this.channels).map(([name, channel]) => this.startChannel(name, channel)),
    );
  }

  async stop(): Promise<void> {
    await this.stopAll();
  }

  async stopAll(): Promise<void> {
    const dispatchTask: any = this.dispatchTask;
    if (dispatchTask) {
      if (typeof dispatchTask.cancel === "function") dispatchTask.cancel();
      else if (typeof dispatchTask.abort === "function") dispatchTask.abort();
      if (typeof dispatchTask.cancel === "function" || typeof dispatchTask.abort === "function") {
        try {
          await dispatchTask;
        } catch {
          // Dispatcher cancellation is expected during shutdown.
        }
      }
    }
    await Promise.all(
      Object.values(this.channels).map(async (channel) => {
        try {
          await channel.stop();
        } catch {
          // Best-effort shutdown.
        }
      }),
    );
    this.dispatchTask = null;
  }

  async dispatch(message: OutboundMessage): Promise<void> {
    const channel = this.channels[message.channel];
    if (channel) await this.sendWithRetry(channel, message);
  }

  shouldSendProgress(
    channelName: string,
    { toolHint = false }: { toolHint?: boolean } = {},
  ): boolean {
    const channel = this.channels[channelName];
    if (!channel) return false;
    return toolHint ? channel.sendToolHints : channel.sendProgress;
  }

  resolveBoolOverride(section: any, key: string, fallback: boolean): boolean {
    let value: any;
    if (section && typeof section === "object") {
      value = section[key];
    }
    return typeof value === "boolean" ? value : fallback;
  }

  static fingerprintContent(content: string): string {
    const normalized = content.split(/\s+/).filter(Boolean).join(" ");
    return normalized ? crypto.createHash("sha1").update(normalized).digest("hex") : "";
  }

  fingerprintContent(content: string): string {
    return ChannelManager.fingerprintContent(content);
  }

  shouldSuppressOutbound(msg: OutboundMessage): boolean {
    if (msg.metadata?.agentProgress) return false;
    const fingerprint = this.fingerprintContent(msg.content);
    if (!fingerprint) return false;
    const origin = msg.metadata?.originMessageId;
    if (typeof origin === "string" && origin) {
      const key = `${msg.channel}\0${msg.chatId}\0${origin}`;
      if (this.originReplyFingerprints.get(key) === fingerprint) return true;
      this.originReplyFingerprints.set(key, fingerprint);
    }
    const messageId = msg.metadata?.message_id;
    if (typeof messageId === "string" && messageId) {
      const key = `${msg.channel}\0${msg.chatId}\0${messageId}`;
      this.originReplyFingerprints.set(key, fingerprint);
    }
    return false;
  }

  coalesceStreamDeltas(firstMsg: OutboundMessage): [OutboundMessage, OutboundMessage[]] {
    const targetKey = `${firstMsg.channel}\0${firstMsg.chatId}`;
    let combined = firstMsg.content;
    const finalMetadata = { ...(firstMsg.metadata ?? {}) };
    const pending: OutboundMessage[] = [];
    while (true) {
      const next = this.bus.outbound.getNowait();
      if (!next) break;
      const sameTarget = `${next.channel}\0${next.chatId}` === targetKey;
      const isDelta = Boolean(next.metadata?.streamDelta);
      const isEnd = Boolean(next.metadata?.streamEnd);
      if (sameTarget && isDelta && !finalMetadata.streamEnd) {
        combined += next.content;
        if (isEnd) {
          finalMetadata.streamEnd = true;
          break;
        }
      } else {
        pending.push(next);
        break;
      }
    }
    return [
      new OutboundMessage({
        channel: firstMsg.channel,
        chatId: firstMsg.chatId,
        content: combined,
        metadata: finalMetadata,
      }),
      pending,
    ];
  }

  static async sendOnce(channel: BaseChannel, msg: OutboundMessage): Promise<void> {
    if (msg.metadata?.reasoningEnd) await channel.sendReasoningEnd(msg.chatId, msg.metadata);
    else if (msg.metadata?.reasoningDelta)
      await channel.sendReasoningDelta(msg.chatId, msg.content, msg.metadata);
    else if (msg.metadata?.reasoning) await channel.sendReasoning(msg);
    else if (msg.metadata?.streamDelta || msg.metadata?.streamEnd)
      await channel.sendDelta(msg.chatId, msg.content, msg.metadata);
    else if (!msg.metadata?.streamed) await channel.send(msg);
  }

  async sendWithRetry(channel: BaseChannel, msg: OutboundMessage): Promise<void> {
    const maxAttempts = Math.max(Number(this.config?.channels?.sendMaxRetries ?? 3), 1);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        await ChannelManager.sendOnce(channel, msg);
        return;
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || err.name === "CancelledError"))
          throw err;
        if (attempt === maxAttempts - 1) return;
        await sleep(SEND_RETRY_DELAYS[Math.min(attempt, SEND_RETRY_DELAYS.length - 1)]);
      }
    }
  }

  async dispatchOutbound(): Promise<void> {
    const pending: OutboundMessage[] = [];
    while (true) {
      let msg = pending.length ? pending.shift()! : await this.bus.consumeOutbound();
      if (msg.metadata?.reasoningDelta || msg.metadata?.reasoningEnd || msg.metadata?.reasoning) {
        const channel = this.channels[msg.channel];
        if (channel?.showReasoning) await this.sendWithRetry(channel, msg);
        continue;
      }
      if (msg.metadata?.agentProgress) {
        if (msg.metadata?.toolHint && !this.shouldSendProgress(msg.channel, { toolHint: true }))
          continue;
        if (!msg.metadata?.toolHint && !this.shouldSendProgress(msg.channel)) continue;
      }
      if (msg.metadata?.retryWait && msg.channel !== "websocket") continue;
      if (
        msg.metadata?.runtimeModelUpdated &&
        msg.channel === "websocket" &&
        !this.channels.websocket
      )
        continue;
      if (msg.metadata?.streamDelta && !msg.metadata?.streamEnd) {
        const [merged, extraPending] = this.coalesceStreamDeltas(msg);
        msg = merged;
        pending.push(...extraPending);
      }
      const channel = this.channels[msg.channel];
      if (!channel) continue;
      if (!msg.metadata?.streamDelta && !msg.metadata?.streamEnd && !msg.metadata?.streamed) {
        if (this.shouldSuppressOutbound(msg)) continue;
      }
      await this.sendWithRetry(channel, msg);
    }
  }

  notifyRestartDoneIfNeeded(): void {
    const notice = consumeRestartNoticeFromEnv();
    if (!notice) return;
    const channel = this.channels[notice.channel];
    if (!channel) return;
    void this.sendWithRetry(
      channel,
      new OutboundMessage({
        channel: notice.channel,
        chatId: notice.chatId,
        content: formatRestartCompletedMessage(notice.startedAtRaw),
        metadata: { ...(notice.metadata ?? {}) },
      }),
    );
  }

  getStatus(): Record<string, any> {
    return Object.fromEntries(
      Object.entries(this.channels).map(([name, channel]) => [
        name,
        // lastError currently mainly carries Feishu permission errors and similar user-actionable failures for frontend reminders.
        {
          enabled: true,
          running: channel.isRunning,
          lastError: (channel as any).lastError ?? null,
        },
      ]),
    );
  }

  get enabledChannels(): string[] {
    return Object.keys(this.channels);
  }
}
