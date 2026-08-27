import { describe, expect, it } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { BaseChannel } from "../../../src/integrations/channels/base.js";
import { ChannelManager } from "../../../src/integrations/channels/manager.js";
import { registerChannel } from "../../../src/integrations/channels/registry.js";

class AdminTestChannel extends BaseChannel {
  override name = "admin_test";
  starts = 0;
  stops = 0;

  override async start(): Promise<void> {
    this.starts += 1;
    this.running = true;
  }

  override async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }
}

describe("ChannelManager channel admin controls", () => {
  it("configures one channel and exposes runtime status", async () => {
    registerChannel("admin_test", AdminTestChannel);
    const manager = new ChannelManager({ channels: { sendProgress: true } }, new MessageBus());

    const configured = await manager.configureChannel("admin_test", {
      enabled: true,
      token: "first"
    });

    expect(configured).toEqual({ enabled: true, running: true });
    expect(manager.channelSection("admin_test")).toMatchObject({ enabled: true, token: "first" });
    expect(manager.getStatus().admin_test).toEqual({ enabled: true, running: true, lastError: null });
  });

  it("restarts only the target channel when its config changes", async () => {
    registerChannel("admin_test", AdminTestChannel);
    const manager = new ChannelManager({ channels: {} }, new MessageBus());

    await manager.configureChannel("admin_test", { enabled: true, token: "first" });
    const first = manager.getChannel("admin_test") as AdminTestChannel;
    await manager.configureChannel("admin_test", { enabled: true, token: "second" });
    const second = manager.getChannel("admin_test") as AdminTestChannel;

    expect(first.stops).toBe(1);
    expect(second).not.toBe(first);
    expect(second.starts).toBe(1);
    expect(second.config.token).toBe("second");
  });

  it("stops and removes a channel when disabled", async () => {
    registerChannel("admin_test", AdminTestChannel);
    const manager = new ChannelManager({ channels: {} }, new MessageBus());

    await manager.configureChannel("admin_test", { enabled: true });
    const channel = manager.getChannel("admin_test") as AdminTestChannel;
    const result = await manager.configureChannel("admin_test", { enabled: false });

    expect(channel.stops).toBe(1);
    expect(result).toEqual({ enabled: false, running: false });
    expect(manager.getChannel("admin_test")).toBeNull();
    expect(manager.getStatus()).not.toHaveProperty("admin_test");
  });
});
