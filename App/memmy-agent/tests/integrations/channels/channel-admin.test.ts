import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { createChannelAdmin } from "../../../src/entrypoints/frontend-bridge/channels-api.js";
import { BaseChannel } from "../../../src/integrations/channels/base.js";

class FakeManager {
  sections: Record<string, any> = {};
  configured: Array<{ name: string; section: Record<string, any> }> = [];
  stopped: string[] = [];
  channels: Record<string, BaseChannel> = {};
  ensured: Array<{ name: string; section: Record<string, any> }> = [];
  started: string[] = [];
  dispatchStarted = 0;
  nextEnsureChannel: BaseChannel | null = null;

  getStatus(): Record<string, any> {
    return Object.fromEntries(
      Object.entries(this.sections).map(([name, section]) => [
        name,
        { enabled: Boolean(section.enabled), running: Boolean(section.running) },
      ]),
    );
  }

  channelSection(name: string): any {
    return this.sections[name] ?? null;
  }

  getChannel(name: string): BaseChannel | null {
    return this.channels[name] ?? null;
  }

  async configureChannel(
    name: string,
    section: Record<string, any>,
  ): Promise<{ enabled: boolean; running: boolean }> {
    this.configured.push({ name, section });
    this.sections[name] = section;
    return {
      enabled: Boolean(section.enabled),
      running: Boolean(section.running ?? section.enabled),
    };
  }

  ensureChannelInstance(name: string, section: Record<string, any>): BaseChannel | null {
    this.ensured.push({ name, section });
    this.sections[name] = section;
    if (!this.channels[name] && this.nextEnsureChannel)
      this.channels[name] = this.nextEnsureChannel;
    return this.channels[name] ?? null;
  }

  ensureOutboundDispatchStarted(): void {
    this.dispatchStarted += 1;
  }

  async startChannel(name: string, channel: BaseChannel): Promise<void> {
    this.started.push(name);
    channel.running = true;
  }

  async stopChannelByName(name: string): Promise<void> {
    this.stopped.push(name);
    delete this.channels[name];
  }
}

describe("channel admin API", () => {
  it("returns product channel definitions with runtime channel mapping", () => {
    const admin = createChannelAdmin(new FakeManager() as any);

    expect(admin.definitions().channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "wechat",
          runtimeChannel: "weixin",
          authKind: "qrCode",
          enabled: true,
          fields: [],
        }),
        expect.objectContaining({
          id: "feishu",
          runtimeChannel: "feishu",
          authKind: "form",
          enabled: true,
        }),
        expect.objectContaining({
          id: "telegram",
          runtimeChannel: "telegram",
          authKind: "form",
          enabled: true,
          capabilities: expect.arrayContaining(["receiveText", "sendText", "streaming"]),
          fields: [{ key: "token", label: "Bot Token", kind: "secret", required: true }],
        }),
      ]),
    );
  });

  it("connects Telegram from the latest loaded bot token", async () => {
    const manager = new FakeManager();
    const loadChannelSection = vi.fn((name: string) => ({
      enabled: true,
      token: `${name}-bot-token`,
    }));
    const admin = createChannelAdmin(manager as any, { loadChannelSection });

    const result = await admin.configure("telegram");

    expect(loadChannelSection).toHaveBeenCalledWith("telegram");
    expect(manager.configured).toEqual([
      { name: "telegram", section: { enabled: true, token: "telegram-bot-token" } },
    ]);
    expect(result).toEqual({ status: "connected", running: true });
  });

  it("maps runtime status to product channel connections", () => {
    const manager = new FakeManager();
    manager.sections.feishu = { enabled: true, running: true };
    manager.sections.weixin = { enabled: true, running: false };
    const admin = createChannelAdmin(manager as any);

    expect(admin.status().connections).toEqual([
      expect.objectContaining({
        provider: "wechat",
        runtimeChannel: "weixin",
        status: "starting",
        running: false,
      }),
      expect.objectContaining({
        provider: "feishu",
        runtimeChannel: "feishu",
        status: "connected",
        running: true,
      }),
    ]);
  });

  it("configures a runtime channel from the latest loaded config", async () => {
    const manager = new FakeManager();
    const loadChannelSection = vi.fn((name: string) => ({
      enabled: true,
      running: true,
      token: `${name}-token`,
    }));
    const admin = createChannelAdmin(manager as any, { loadChannelSection });

    const result = await admin.configure("feishu");

    expect(loadChannelSection).toHaveBeenCalledWith("feishu");
    expect(manager.configured).toEqual([
      { name: "feishu", section: { enabled: true, running: true, token: "feishu-token" } },
    ]);
    expect(result).toEqual({ status: "connected", running: true });
  });

  it("starts and polls Weixin login through the runtime channel", async () => {
    const manager = new FakeManager();
    const channel = new BaseChannel("weixin", {}, new MessageBus()) as BaseChannel & {
      startLoginSession: (force?: boolean) => Promise<Record<string, any>>;
      pollLoginSession: (token: string) => Promise<Record<string, any>>;
    };
    channel.startLoginSession = vi.fn(async () => ({
      status: "pendingQr",
      qrCodeDataUrl: "data:image/png;base64,abc",
      pollToken: "poll-1",
    }));
    channel.pollLoginSession = vi.fn(async () => ({ status: "connected" }));
    manager.nextEnsureChannel = channel;
    const admin = createChannelAdmin(manager as any);

    await expect(admin.startWeixinLogin()).resolves.toMatchObject({
      status: "pendingQr",
      qrCodeDataUrl: "data:image/png;base64,abc",
      pollToken: "poll-1",
    });
    await expect(admin.pollWeixinLogin("poll-1")).resolves.toEqual({ status: "connected" });
  });

  it("prepares an idle Weixin channel for QR login without starting polling first", async () => {
    const manager = new FakeManager();
    const channel = new BaseChannel("weixin", {}, new MessageBus()) as BaseChannel & {
      startLoginSession: (force?: boolean) => Promise<Record<string, any>>;
    };
    channel.startLoginSession = vi.fn(async () => ({
      status: "pendingQr",
      qrCodeDataUrl: "data:image/png;base64,abc",
      pollToken: "poll-1",
    }));
    manager.nextEnsureChannel = channel;
    const loadChannelSection = vi.fn(() => ({ enabled: true, appId: "cli_memmy" }));
    const admin = createChannelAdmin(manager as any, { loadChannelSection });

    await expect(admin.startWeixinLogin()).resolves.toMatchObject({
      status: "pendingQr",
      pollToken: "poll-1",
    });

    expect(manager.ensured).toEqual([
      { name: "weixin", section: { enabled: true, appId: "cli_memmy" } },
    ]);
    expect(manager.configured).toEqual([]);
    expect(manager.started).toEqual([]);
  });

  it("starts Weixin polling after QR login is confirmed", async () => {
    const manager = new FakeManager();
    const channel = new BaseChannel("weixin", {}, new MessageBus()) as BaseChannel & {
      pollLoginSession: (token: string) => Promise<Record<string, any>>;
    };
    channel.running = false;
    channel.pollLoginSession = vi.fn(async () => ({ status: "connected" }));
    manager.channels.weixin = channel;
    const admin = createChannelAdmin(manager as any);

    await expect(admin.pollWeixinLogin("poll-1")).resolves.toMatchObject({ status: "connected" });

    expect(manager.dispatchStarted).toBe(1);
    expect(manager.started).toEqual(["weixin"]);
    expect(channel.running).toBe(true);
  });
});
