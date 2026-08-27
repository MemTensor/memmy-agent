/**
 * Feishu send delivery tests.
 *
 * This file verifies that send() uses the params/data payload shape required by
 * the Lark SDK, otherwise the request body is empty and causes 400, and that
 * underlying SDK Promise rejections do not bubble into unhandled rejections that
 * crash the gateway.
 */
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { FeishuChannel } from "../../../src/integrations/channels/feishu.js";

function channelWithClient(create: any, reply: any = vi.fn(() => ({ code: 0 }))): FeishuChannel {
  const channel = new FeishuChannel(
    { enabled: true, appId: "a", appSecret: "b", allowFrom: ["*"] },
    new MessageBus(),
  );
  channel.client = { im: { v1: { message: { create, reply } } } };
  return channel;
}

function channelWithImageClient(imageCreate: any, messageCreate: any): FeishuChannel {
  const channel = new FeishuChannel(
    { enabled: true, appId: "a", appSecret: "b", allowFrom: ["*"] },
    new MessageBus(),
  );
  channel.client = {
    im: {
      v1: {
        message: { create: messageCreate, reply: vi.fn(() => ({ code: 0 })) },
        image: { create: imageCreate },
      },
    },
  };
  return channel;
}

describe("Feishu send delivery", () => {
  it("sends text using the lark params/data payload shape", async () => {
    const create = vi.fn(() => ({ code: 0, data: { message_id: "om_1" } }));
    const channel = channelWithClient(create);

    await channel.send(new OutboundMessage({ channel: "feishu", chatId: "ou_x", content: "hi" }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: "open_id" },
        data: expect.objectContaining({
          receive_id: "ou_x",
          msg_type: "text",
          content: JSON.stringify({ text: "hi" }),
        }),
      }),
    );
  });

  it("does not crash when the SDK promise rejects", async () => {
    const create = vi.fn(() => Promise.reject(new Error("feishu send failed with HTTP 400")));
    const channel = channelWithClient(create);
    const reportSpy = vi
      .spyOn(channel as any, "reportEventError")
      .mockImplementation(() => undefined);

    await expect(
      channel.send(new OutboundMessage({ channel: "feishu", chatId: "ou_x", content: "hi" })),
    ).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();

    expect(reportSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("400") }),
    );
  });
});

describe("Feishu image upload delivery", () => {
  const pngPath = "/fake/portrait.png";

  beforeEach(() => {
    // Mock the filesystem because send() checks existsSync/statSync and reads files with createReadStream.
    // The upload stream goes to the mocked SDK without a real file, avoiding lazy-stream cleanup races that cause ENOENT.
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statSync").mockReturnValue({ isFile: () => true } as any);
    vi.spyOn(fs, "createReadStream").mockReturnValue({ path: pngPath } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uploads image via the lark data payload shape and sends image_key", async () => {
    const imageCreate = vi.fn(async () => ({ code: 0, data: { image_key: "img_x" } }));
    const messageCreate = vi.fn(() => ({ code: 0, data: { message_id: "om_1" } }));
    const channel = channelWithImageClient(imageCreate, messageCreate);

    await channel.send(
      new OutboundMessage({ channel: "feishu", chatId: "ou_x", media: [pngPath] }),
    );

    // Upload fields must be under data, otherwise the SDK generates an empty multipart body (Content-Length: 0) and causes 400.
    expect(imageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ image_type: "message", image: expect.anything() }),
      }),
    );
    expect(messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          receive_id: "ou_x",
          msg_type: "image",
          content: JSON.stringify({ image_key: "img_x" }),
        }),
      }),
    );
  });

  it("does not crash the gateway when image upload rejects", async () => {
    const imageCreate = vi.fn(() =>
      Promise.reject(new Error("feishu image upload failed with HTTP 400")),
    );
    const messageCreate = vi.fn(() => ({ code: 0, data: { message_id: "om_1" } }));
    const channel = channelWithImageClient(imageCreate, messageCreate);
    const reportSpy = vi
      .spyOn(channel as any, "reportEventError")
      .mockImplementation(() => undefined);

    await expect(
      channel.send(new OutboundMessage({ channel: "feishu", chatId: "ou_x", media: [pngPath] })),
    ).resolves.toBeUndefined();
    await Promise.resolve();

    // Upload failure must not send a message with image_key=undefined.
    expect(messageCreate).not.toHaveBeenCalled();
    expect(reportSpy).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("400") }),
    );
  });
});
