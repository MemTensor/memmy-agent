import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { BaseChannel } from "../../../src/integrations/channels/base.js";
import { ChannelManager } from "../../../src/integrations/channels/manager.js";
import {
  channelMetadata,
  discoverAll,
  discoverChannelNames,
  discoverEnabled,
  discoverPackagePlugins,
  discoverPlugins,
  getChannel,
  loadChannelClass,
  registerChannel,
} from "../../../src/integrations/channels/registry.js";
import { TelegramChannel } from "../../../src/integrations/channels/telegram.js";
import { ChannelsConfig, ProviderConfig } from "../../../src/config/schema.js";
import { GroqTranscriptionProvider, OpenAITranscriptionProvider } from "../../../src/providers/transcription.js";
import {
  RESTART_NOTIFY_CHANNEL_ENV,
  RESTART_NOTIFY_CHAT_ID_ENV,
  RESTART_NOTIFY_METADATA_ENV,
  RESTART_STARTED_AT_ENV,
} from "../../../src/utils/restart.js";

const tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.MEMMY_AGENT_CHANNEL_PLUGIN_PATHS;
  delete process.env[RESTART_NOTIFY_CHANNEL_ENV];
  delete process.env[RESTART_NOTIFY_CHAT_ID_ENV];
  delete process.env[RESTART_NOTIFY_METADATA_ENV];
  delete process.env[RESTART_STARTED_AT_ENV];
});

class CustomChannel extends BaseChannel {
  constructor(config: any = {}, bus?: any) {
    super("custom", config, bus);
  }
}

class FakePluginChannel extends BaseChannel {
  override name = "fakeplugin";
  override displayName = "Fake Plugin";
  loginCalls: boolean[] = [];
  sent: OutboundMessage[] = [];
  deltas: any[] = [];
  starts = 0;
  stops = 0;
  failSendCount = 0;
  failStart = false;
  failStop = false;

  override async start(): Promise<void> {
    this.starts += 1;
    if (this.failStart) throw new Error("start failed");
  }

  override async stop(): Promise<void> {
    this.stops += 1;
    if (this.failStop) throw new Error("stop failed");
  }

  override async send(msg: OutboundMessage): Promise<void> {
    this.sent.push(msg);
    if (this.failSendCount > 0) {
      this.failSendCount -= 1;
      throw new Error("send failed");
    }
  }

  override async sendDelta(chatId: string, delta: string, metadata: Record<string, any> = {}): Promise<void> {
    this.deltas.push({ chatId, delta, metadata });
  }

  override async login(force = false): Promise<boolean> {
    this.loginCalls.push(force);
    return true;
  }
}

function writePackagePlugin({
  packageName = "memmy-channel-auto",
  channels,
  moduleSource,
}: {
  packageName?: string;
  channels: Record<string, any>;
  moduleSource: string;
}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-channel-plugin-"));
  tmpDirs.push(root);
  const nodeModules = path.join(root, "node_modules");
  const packageDir = path.join(nodeModules, packageName);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: packageName,
    version: "0.0.0-test",
    main: "index.cjs",
    memmyAgent: { channels },
  }, null, 2));
  fs.writeFileSync(path.join(packageDir, "index.cjs"), moduleSource);
  process.env.MEMMY_AGENT_CHANNEL_PLUGIN_PATHS = nodeModules;
  return nodeModules;
}

function configWithChannels(channels: Record<string, any>, providerConfig: Record<string, any> = {}): any {
  return {
    channels: new ChannelsConfig(channels),
    providers: {
      groq: new ProviderConfig(providerConfig.groq ?? {}),
      openai: new ProviderConfig(providerConfig.openai ?? {}),
    },
    agents: { defaults: { workspace: os.tmpdir() } },
  };
}

describe("channel registry and plugins", () => {
  it("allows unknown channel config keys as plugin sections", () => {
    const cfg = ChannelsConfig.fromObject({ myplugin: { enabled: true, token: "abc" } });

    expect(cfg.modelExtra.myplugin).toEqual({ enabled: true, token: "abc" });
    expect((cfg as any).myplugin).toEqual({ enabled: true, token: "abc" });
  });

  it("does not expose built-in channel fields on common ChannelsConfig", () => {
    const cfg = new ChannelsConfig();

    expect((cfg as any).telegram).toBeUndefined();
    expect(cfg.sendProgress).toBe(true);
    expect(cfg.sendToolHints).toBe(false);
  });

  it("validates send retry bounds and transcription language format", () => {
    expect(new ChannelsConfig().sendMaxRetries).toBe(3);
    expect(new ChannelsConfig({ sendMaxRetries: 0 }).sendMaxRetries).toBe(0);
    expect(new ChannelsConfig({ sendMaxRetries: 10 }).sendMaxRetries).toBe(10);
    expect(() => new ChannelsConfig({ sendMaxRetries: -1 })).toThrow(/sendMaxRetries/);
    expect(() => new ChannelsConfig({ sendMaxRetries: 11 })).toThrow(/sendMaxRetries/);
    expect(new ChannelsConfig({ transcriptionLanguage: "en" }).transcriptionLanguage).toBe("en");
    expect(new ChannelsConfig({ transcriptionLanguage: "kor" }).transcriptionLanguage).toBe("kor");
    expect(() => new ChannelsConfig({ transcriptionLanguage: "EN" })).toThrow(/transcriptionLanguage/);
    expect(() => new ChannelsConfig({ transcriptionLanguage: "en-US" })).toThrow(/transcriptionLanguage/);
  });

  it("discovers built-in channel names and loads classes lazily by name", () => {
    const names = discoverChannelNames();

    expect(names).toEqual(expect.arrayContaining(["telegram", "websocket", "feishu", "qq"]));
    expect(names).not.toContain("base");
    expect(loadChannelClass("telegram")).toBe(TelegramChannel);
    expect(getChannel("telegram")).toBe(TelegramChannel);
    expect(getChannel("does-not-exist")).toBeUndefined();
  });

  it("discovers enabled channels and prevents plugins from shadowing built-ins", () => {
    registerChannel("custom-plugin", CustomChannel);
    registerChannel("telegram", CustomChannel);

    const enabled = discoverEnabled(new Set(["telegram", "custom_plugin"]));

    expect(enabled.telegram).toBe(TelegramChannel);
    expect(enabled.custom_plugin).toBe(CustomChannel);
    expect(discoverPlugins(new Set(["custom_plugin"]))).toEqual({ custom_plugin: CustomChannel });
  });

  it("auto-discovers external channel plugins from package metadata", () => {
    writePackagePlugin({
      channels: {
        autoplugin: "./index.cjs#AutoChannel",
        telegram: "./index.cjs#ShadowTelegram",
      },
      moduleSource: `
        class AutoChannel {
          constructor(config = {}, bus = null) {
            this.name = "autoplugin";
            this.config = config;
            this.bus = bus;
          }
        }
        class ShadowTelegram {}
        module.exports = { AutoChannel, ShadowTelegram };
      `,
    });

    const packagePlugins = discoverPackagePlugins(new Set(["autoplugin", "telegram"]));
    const enabled = discoverEnabled(new Set(["autoplugin", "telegram"]));

    expect(packagePlugins.get("autoplugin")?.name).toBe("AutoChannel");
    expect(packagePlugins.get("telegram")?.name).toBe("ShadowTelegram");
    expect(enabled.autoplugin.name).toBe("AutoChannel");
    expect(enabled.telegram).toBe(TelegramChannel);
  });

  it("skips plugin discovery for names outside the enabled set", () => {
    registerChannel("disabled-plugin", CustomChannel);

    expect(discoverPlugins(new Set(["enabled_plugin"]))).not.toHaveProperty("disabled_plugin");
  });

  it("merges built-ins and registered plugins in discoverAll metadata", () => {
    registerChannel("another-plugin", CustomChannel);

    const all = discoverAll();
    const metadata = channelMetadata();

    expect(all.telegram).toBe(TelegramChannel);
    expect(all.another_plugin).toBe(CustomChannel);
    expect(metadata).toEqual(expect.arrayContaining([expect.objectContaining({ name: "telegram", builtin: true })]));
    expect(metadata).toEqual(expect.arrayContaining([expect.objectContaining({ name: "another_plugin", builtin: false })]));
  });

  it("loads enabled plugin channels from object config", () => {
    registerChannel("fakeplugin", FakePluginChannel);
    const manager = new ChannelManager(configWithChannels({ fakeplugin: { enabled: true, allowFrom: ["*"] } }), new MessageBus());

    expect(manager.channels.fakeplugin).toBeInstanceOf(FakePluginChannel);
    expect(manager.channels.fakeplugin.config).toEqual({ enabled: true, allowFrom: ["*"] });
  });

  it("skips disabled plugin channels during manager initialization", () => {
    registerChannel("fakeplugin", FakePluginChannel);
    const manager = new ChannelManager(configWithChannels({ fakeplugin: { enabled: false } }), new MessageBus());

    expect(manager.channels.fakeplugin).toBeUndefined();
  });

  it("propagates Groq transcription config to channels", () => {
    registerChannel("fakeplugin", FakePluginChannel);
    const manager = new ChannelManager(
      configWithChannels(
        { fakeplugin: { enabled: true }, transcriptionLanguage: "en" },
        { groq: { apiKey: "groq-key", apiBase: "http://proxy.local/v1/audio/transcriptions" } },
      ),
      new MessageBus(),
    );
    const channel = manager.channels.fakeplugin;

    expect(channel.transcriptionProvider).toBe("groq");
    expect(channel.transcriptionApiKey).toBe("groq-key");
    expect(channel.transcriptionApiBase).toBe("http://proxy.local/v1/audio/transcriptions");
    expect(channel.transcriptionLanguage).toBe("en");
  });

  it("propagates OpenAI transcription config to channels", () => {
    registerChannel("fakeplugin", FakePluginChannel);
    const manager = new ChannelManager(
      configWithChannels(
        { fakeplugin: { enabled: true }, transcriptionProvider: "openai" },
        { openai: { apiKey: "openai-key", apiBase: "http://proxy.local/v1/audio/transcriptions" } },
      ),
      new MessageBus(),
    );
    const channel = manager.channels.fakeplugin;

    expect(channel.transcriptionProvider).toBe("openai");
    expect(channel.transcriptionApiKey).toBe("openai-key");
    expect(channel.transcriptionApiBase).toBe("http://proxy.local/v1/audio/transcriptions");
  });

  it("passes API base and language through BaseChannel transcription", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-transcribe-"));
    const audio = path.join(root, "sample.wav");
    fs.writeFileSync(audio, "audio");
    const fetchMock = vi.fn(async (url: string, init: any) => {
      expect(url).toBe("http://override/v1/audio/transcriptions");
      expect(init.headers.Authorization).toBe("Bearer k");
      expect(init.body.get("language")).toBe("en");
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const channel = new FakePluginChannel({ enabled: true }, new MessageBus());
    channel.transcriptionProvider = "openai";
    channel.transcriptionApiKey = "k";
    channel.transcriptionApiBase = "http://override/v1/audio/transcriptions";
    channel.transcriptionLanguage = "en";

    await expect(channel.transcribeAudio(audio)).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("honors custom transcription API bases in provider constructors", () => {
    expect(new OpenAITranscriptionProvider({ apiKey: "k" }).apiUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(new OpenAITranscriptionProvider({ apiKey: "k", apiBase: "http://override/v1/audio/transcriptions" }).apiUrl).toBe("http://override/v1/audio/transcriptions");
    expect(new GroqTranscriptionProvider({ apiKey: "k", apiBase: "http://groq-proxy/openai/v1" }).apiUrl).toBe("http://groq-proxy/openai/v1/audio/transcriptions");
  });

  it("includes transcription language only when configured", async () => {
    const data = Buffer.from("audio");
    const withLanguage = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.get("language")).toBe("ko");
      return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
    });
    const withoutLanguage = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(body.has("language")).toBe(false);
      return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
    });

    await expect(new GroqTranscriptionProvider({ apiKey: "k", language: "ko", fetchImpl: withLanguage }).transcribe(data)).resolves.toBe("hello");
    await expect(new OpenAITranscriptionProvider({ apiKey: "k", fetchImpl: withoutLanguage }).transcribe(data)).resolves.toBe("hello");
  });

  it("returns channels, status, and enabled channel names from manager", () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new FakePluginChannel({}, manager.bus);
    channel.running = true;
    manager.register(channel);

    expect(manager.getChannel("fakeplugin")).toBe(channel);
    expect(manager.getChannel("missing")).toBeNull();
    expect(manager.enabledChannels).toEqual(["fakeplugin"]);
    expect(manager.getStatus()).toEqual({ fakeplugin: { enabled: true, running: true, lastError: null } });
  });

  it("sends without retry when the first attempt succeeds", async () => {
    const manager = new ChannelManager({ channels: { sendMaxRetries: 3 } }, new MessageBus());
    const channel = new FakePluginChannel({}, manager.bus);

    await manager.sendWithRetry(channel, new OutboundMessage({ channel: "fakeplugin", chatId: "123", content: "test" }));

    expect(channel.sent).toHaveLength(1);
  });

  it("retries failed sends up to the configured maximum", async () => {
    vi.useFakeTimers();
    const manager = new ChannelManager({ channels: { sendMaxRetries: 3 } }, new MessageBus());
    const channel = new FakePluginChannel({}, manager.bus);
    channel.failSendCount = 2;

    const promise = manager.sendWithRetry(channel, new OutboundMessage({ channel: "fakeplugin", chatId: "123", content: "test" }));
    await vi.advanceTimersByTimeAsync(3_000);
    await promise;

    expect(channel.sent).toHaveLength(3);
  });

  it("does not retry when sendMaxRetries is zero", async () => {
    const manager = new ChannelManager({ channels: { sendMaxRetries: 0 } }, new MessageBus());
    const channel = new FakePluginChannel({}, manager.bus);
    channel.failSendCount = 5;

    await manager.sendWithRetry(channel, new OutboundMessage({ channel: "fakeplugin", chatId: "123", content: "test" }));

    expect(channel.sent).toHaveLength(1);
  });

  it("routes stream deltas through sendDelta", async () => {
    const channel = new FakePluginChannel({}, new MessageBus());

    await ChannelManager.sendOnce(channel, new OutboundMessage({ channel: "fakeplugin", chatId: "123", content: "delta", metadata: { streamDelta: true } }));

    expect(channel.sent).toEqual([]);
    expect(channel.deltas).toEqual([{ chatId: "123", delta: "delta", metadata: { streamDelta: true } }]);
  });

  it("skips normal send when a message was already streamed", async () => {
    const channel = new FakePluginChannel({}, new MessageBus());

    await ChannelManager.sendOnce(channel, new OutboundMessage({ channel: "fakeplugin", chatId: "123", content: "done", metadata: { streamed: true } }));

    expect(channel.sent).toEqual([]);
  });

  it("suppresses duplicate outbound replies only within the same origin message", () => {
    const manager = new ChannelManager(new MessageBus());
    const first = new OutboundMessage({ channel: "fakeplugin", chatId: "123", content: "hello   world", metadata: { originMessageId: "m1" } });
    const duplicate = new OutboundMessage({ channel: "fakeplugin", chatId: "123", content: "hello world", metadata: { originMessageId: "m1" } });
    const otherOrigin = new OutboundMessage({ channel: "fakeplugin", chatId: "123", content: "hello world", metadata: { originMessageId: "m2" } });

    expect(manager.shouldSuppressOutbound(first)).toBe(false);
    expect(manager.shouldSuppressOutbound(duplicate)).toBe(true);
    expect(manager.shouldSuppressOutbound(otherOrigin)).toBe(false);
  });

  it("continues start and stop all when a channel throws", async () => {
    const manager = new ChannelManager(new MessageBus());
    const ok = new FakePluginChannel({}, manager.bus);
    const failing = new FakePluginChannel({}, manager.bus);
    failing.name = "failing";
    failing.failStart = true;
    failing.failStop = true;
    manager.register(ok);
    manager.register(failing);

    await expect(manager.startAll()).resolves.toBeUndefined();
    await expect(manager.stopAll()).resolves.toBeUndefined();
    expect(ok.starts).toBe(1);
    expect(ok.stops).toBe(1);
  });

  it("keeps sendMaxRetries default at three", () => {
    expect(new ChannelsConfig().sendMaxRetries).toBe(3);
  });

  it("rejects sendMaxRetries outside the bounded range", () => {
    expect(() => new ChannelsConfig({ sendMaxRetries: 100 })).toThrow(/sendMaxRetries/);
    expect(() => new ChannelsConfig({ sendMaxRetries: -1 })).toThrow(/sendMaxRetries/);
    expect(() => new ChannelsConfig({ sendMaxRetries: 11 })).toThrow(/sendMaxRetries/);
  });

  it("accepts null or ISO-639 transcription language values", () => {
    expect(new ChannelsConfig({ transcriptionLanguage: "en" }).transcriptionLanguage).toBe("en");
    expect(new ChannelsConfig({ transcriptionLanguage: "kor" }).transcriptionLanguage).toBe("kor");
    expect(new ChannelsConfig({ transcriptionLanguage: null }).transcriptionLanguage).toBeNull();
  });

  it("rejects invalid transcription language values", () => {
    expect(() => new ChannelsConfig({ transcriptionLanguage: "EN" })).toThrow(/transcriptionLanguage/);
    expect(() => new ChannelsConfig({ transcriptionLanguage: "english" })).toThrow(/transcriptionLanguage/);
    expect(() => new ChannelsConfig({ transcriptionLanguage: "en-US" })).toThrow(/transcriptionLanguage/);
  });

  it("includes external plugins in discoverAll", () => {
    registerChannel("line-plugin", FakePluginChannel);

    expect(discoverAll().line_plugin).toBe(FakePluginChannel);
  });

  it("keeps built-ins ahead of plugins with the same name", () => {
    registerChannel("telegram", FakePluginChannel);

    expect(discoverAll().telegram).toBe(TelegramChannel);
  });

  it("loads only enabled built-ins from a supplied name list", () => {
    const enabled = discoverEnabled(new Set(["telegram"]), { names: ["telegram", "slack"] });

    expect(enabled.telegram).toBe(TelegramChannel);
    expect(enabled.slack).toBeUndefined();
  });

  it("passes language through BaseChannel Groq transcription", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-transcribe-groq-"));
    const audio = path.join(root, "sample.wav");
    fs.writeFileSync(audio, "audio");
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as FormData;
      expect(String(url)).toBe("http://override/v1/audio/transcriptions");
      expect(body.get("language")).toBe("ko");
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const channel = new FakePluginChannel({ enabled: true }, new MessageBus());
    channel.transcriptionProvider = "groq";
    channel.transcriptionApiKey = "k";
    channel.transcriptionApiBase = "http://override/v1/audio/transcriptions";
    channel.transcriptionLanguage = "ko";

    try {
      await expect(channel.transcribeAudio(audio)).resolves.toBe("ok");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes language for OpenAI transcription when configured", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect((init?.body as FormData).get("language")).toBe("en");
      return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
    });

    await expect(
      new OpenAITranscriptionProvider({ apiKey: "k", language: "en", fetchImpl: fetchMock }).transcribe(Buffer.from("audio")),
    ).resolves.toBe("hello");
  });

  it("omits language for Groq transcription when not configured", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect((init?.body as FormData).has("language")).toBe(false);
      return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
    });

    await expect(new GroqTranscriptionProvider({ apiKey: "k", fetchImpl: fetchMock }).transcribe(Buffer.from("audio"))).resolves.toBe("hello");
  });

  it("exposes Telegram defaultConfig with disabled default", () => {
    const cfg = TelegramChannel.defaultConfig();

    expect(cfg.enabled).toBe(false);
    expect(cfg.token).toBeDefined();
  });

  it("initializes TelegramChannel from a raw object config", () => {
    const channel = new TelegramChannel({ enabled: false, token: "test-tok", allowFrom: ["*"] }, new MessageBus());

    expect(channel.config.token).toBe("test-tok");
    expect(channel.config.allowFrom).toEqual(["*"]);
  });

  it("propagates cancellation-style send errors from retry handling", async () => {
    class CancellingChannel extends FakePluginChannel {
      override async send(): Promise<void> {
        const error = new Error("simulated cancellation");
        error.name = "CancelledError";
        throw error;
      }
    }
    const manager = new ChannelManager({ channels: { sendMaxRetries: 3 } }, new MessageBus());
    const channel = new CancellingChannel({}, manager.bus);

    await expect(
      manager.sendWithRetry(channel, new OutboundMessage({ channel: "fakeplugin", chatId: "123", content: "test" })),
    ).rejects.toMatchObject({ name: "CancelledError" });
  });

  it("allows empty allowFrom lists", () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new FakePluginChannel({ allowFrom: [] }, manager.bus);
    manager.channels = { fakeplugin: channel };

    expect(() => manager.validateAllowFrom()).not.toThrow();
  });

  it("allows wildcard allowFrom lists", () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new FakePluginChannel({ allowFrom: ["*"] }, manager.bus);
    manager.channels = { fakeplugin: channel };

    expect(() => manager.validateAllowFrom()).not.toThrow();
  });

  it("allows object-backed empty allowFrom lists", () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new FakePluginChannel({ enabled: true, allowFrom: [] }, manager.bus);
    manager.channels = { fakeplugin: channel };

    expect(() => manager.validateAllowFrom()).not.toThrow();
  });

  it("allows missing allowFrom for pairing-only mode", () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new FakePluginChannel({ enabled: true }, manager.bus);
    manager.channels = { fakeplugin: channel };

    expect(() => manager.validateAllowFrom()).not.toThrow();
  });

  it("returns an existing channel and null for missing channels", () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new FakePluginChannel({}, manager.bus);
    manager.register(channel);

    expect(manager.getChannel("fakeplugin")).toBe(channel);
    expect(manager.getChannel("missing")).toBeNull();
  });

  it("reports channel running state in status", () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new FakePluginChannel({}, manager.bus);
    channel.running = false;
    manager.register(channel);

    expect(manager.getStatus().fakeplugin).toEqual({ enabled: true, running: false, lastError: null });
  });

  it("lists enabled channel names", () => {
    const manager = new ChannelManager(new MessageBus());
    const first = new FakePluginChannel({}, manager.bus);
    const second = new FakePluginChannel({}, manager.bus);
    second.name = "second";
    manager.register(first);
    manager.register(second);

    expect(manager.enabledChannels).toEqual(expect.arrayContaining(["fakeplugin", "second"]));
  });

  it("cancels a cancellable dispatch task while stopping channels", async () => {
    const manager = new ChannelManager(new MessageBus());
    const task: any = Promise.resolve();
    task.cancel = vi.fn();
    manager.dispatchTask = task;

    await manager.stopAll();

    expect(task.cancel).toHaveBeenCalledOnce();
    expect(manager.dispatchTask).toBeNull();
  });

  it("handles channel start failures through startChannel", async () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new FakePluginChannel({}, manager.bus);
    channel.failStart = true;

    await expect(manager.startChannel("fakeplugin", channel)).resolves.toBeUndefined();
  });

  it("handles channel stop failures in stopAll", async () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new FakePluginChannel({}, manager.bus);
    channel.failStop = true;
    manager.register(channel);

    await expect(manager.stopAll()).resolves.toBeUndefined();
  });

  it("does not start a dispatcher when no channels are enabled", async () => {
    const manager = new ChannelManager(new MessageBus());
    manager.channels = {};

    await manager.startAll();

    expect(manager.dispatchTask).toBeNull();
  });

  it("creates a dispatcher task when channels are enabled", async () => {
    const manager = new ChannelManager(new MessageBus());
    const pending = new Promise<void>(() => {});
    manager.dispatchOutbound = vi.fn(() => pending) as any;
    manager.register(new FakePluginChannel({}, manager.bus));

    await manager.startAll();

    expect(manager.dispatchTask).toBe(pending);
  });

  it("sends restart completion notices to the target channel", async () => {
    const manager = new ChannelManager(new MessageBus());
    const channel = new FakePluginChannel({}, manager.bus);
    manager.register(channel);
    const send = vi.fn(async (channel: BaseChannel, message: OutboundMessage) => undefined);
    manager.sendWithRetry = send as any;
    process.env[RESTART_NOTIFY_CHANNEL_ENV] = "fakeplugin";
    process.env[RESTART_NOTIFY_CHAT_ID_ENV] = "chat-1";
    process.env[RESTART_STARTED_AT_ENV] = "100.0";
    process.env[RESTART_NOTIFY_METADATA_ENV] = JSON.stringify({ reason: "test" });

    manager.notifyRestartDoneIfNeeded();

    expect(send).toHaveBeenCalledOnce();
    const [sentChannel, sentMessage] = send.mock.calls[0];
    expect(sentChannel).toBe(channel);
    expect(sentMessage.channel).toBe("fakeplugin");
    expect(sentMessage.chatId).toBe("chat-1");
    expect(sentMessage.content).toContain("Restart completed");
    expect(sentMessage.metadata).toEqual({ reason: "test" });
  });
});
