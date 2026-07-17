/**
 * Feishu bot open_id fetch robustness tests.
 *
 * fetchBotOpenId runs at the end of start() and calls /open-apis/bot/v3/info on
 * open.feishu.cn. That SDK call is async: without await and catch, network
 * errors such as ECONNRESET become unhandled Promise rejections and can crash
 * the gateway during startup, which was observed as gateway exited with code 1.
 * This file verifies that a successful fetch returns open_id, while failures
 * safely return null and are reported without bubbling into a crash.
 */
import { describe, expect, it, vi } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { FeishuChannel } from "../../../src/integrations/channels/feishu.js";

function channelWithRequest(request: any): FeishuChannel {
  const channel = new FeishuChannel(
    { enabled: true, appId: "a", appSecret: "b", allowFrom: ["*"] },
    new MessageBus(),
  );
  channel.client = { request };
  return channel;
}

describe("FeishuChannel.fetchBotOpenId", () => {
  it("returns the bot open_id from the async SDK response", async () => {
    const request = vi.fn(async () => ({ data: { bot: { open_id: "ou_bot" } } }));
    const channel = channelWithRequest(request);

    await expect(channel.fetchBotOpenId()).resolves.toBe("ou_bot");
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", url: "/open-apis/bot/v3/info" }),
    );
  });

  it("does not crash when the SDK request rejects (ECONNRESET at startup)", async () => {
    const request = vi.fn(() =>
      Promise.reject(new Error("Client network socket disconnected (ECONNRESET)")),
    );
    const channel = channelWithRequest(request);
    const reportSpy = vi
      .spyOn(channel as any, "reportEventError")
      .mockImplementation(() => undefined);

    await expect(channel.fetchBotOpenId()).resolves.toBeNull();
    expect(reportSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("ECONNRESET") }),
    );
  });
});
