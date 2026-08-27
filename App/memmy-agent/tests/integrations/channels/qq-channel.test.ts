import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { QQChannel, QQConfig } from "../../../src/integrations/channels/qq.js";

const qqSdkMock = vi.hoisted(() => {
  const api = {
    initApiConfig: vi.fn(),
    getAccessToken: vi.fn(async () => "qq-token"),
    sendC2CMessage: vi.fn(async () => ({ id: "sent-c2c" })),
    sendGroupMessage: vi.fn(async () => ({ id: "sent-group" })),
    sendC2CMediaMessage: vi.fn(async () => ({ id: "sent-c2c-media" })),
    sendGroupMediaMessage: vi.fn(async () => ({ id: "sent-group-media" })),
    uploadC2CMedia: vi.fn(async () => ({ file_info: "c2c-file-info" })),
    uploadGroupMedia: vi.fn(async () => ({ file_info: "group-file-info" })),
    apiRequest: vi.fn(async () => ({})),
    reset: () => undefined,
  };
  api.reset = () => {
    api.initApiConfig.mockReset();
    api.getAccessToken.mockReset().mockResolvedValue("qq-token");
    api.sendC2CMessage.mockReset().mockResolvedValue({ id: "sent-c2c" });
    api.sendGroupMessage.mockReset().mockResolvedValue({ id: "sent-group" });
    api.sendC2CMediaMessage.mockReset().mockResolvedValue({ id: "sent-c2c-media" });
    api.sendGroupMediaMessage.mockReset().mockResolvedValue({ id: "sent-group-media" });
    api.uploadC2CMedia.mockReset().mockResolvedValue({ file_info: "c2c-file-info" });
    api.uploadGroupMedia.mockReset().mockResolvedValue({ file_info: "group-file-info" });
    api.apiRequest.mockReset().mockResolvedValue({});
  };
  return api;
});

vi.mock("@tencent-connect/openclaw-qqbot", () => qqSdkMock);

const roots: string[] = [];

class FakeApi {
  c2cCalls: Record<string, any>[] = [];
  groupCalls: Record<string, any>[] = [];
  http = {
    request: vi.fn(async () => ({ file_info: "media-info" })),
  };

  async postC2cMessage(payload: Record<string, any>): Promise<void> {
    this.c2cCalls.push(payload);
  }

  async postGroupMessage(payload: Record<string, any>): Promise<void> {
    this.groupCalls.push(payload);
  }
}

class FakeClient {
  api = new FakeApi();
}

function tmpRoot(prefix = "memmy-qq-channel-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function tmpFile(suffix: string, content: Buffer): string {
  const root = tmpRoot();
  const file = path.join(root, `voice${suffix}`);
  fs.writeFileSync(file, content);
  return file;
}

function makeChannel(config: Partial<QQConfig> = {}): QQChannel {
  const channel = new QQChannel(
    new QQConfig({ appId: "app", secret: "secret", allowFrom: ["*"], mediaDir: tmpRoot("memmy-qq-media-root-"), ...config }),
    new MessageBus(),
  );
  channel.client = new FakeClient();
  return channel;
}

function namedError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

afterEach(() => {
  vi.restoreAllMocks();
  qqSdkMock.reset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("QQ channel", () => {
  it("creates the default OpenClaw QQBot API client when no client is injected", async () => {
    const channel = new QQChannel(new QQConfig({ appId: "app", secret: "secret", allowFrom: ["*"], mediaDir: tmpRoot() }), new MessageBus());

    await channel.start();
    await channel.send(new OutboundMessage({ channel: "qq", chatId: "user-openid", content: "hello", metadata: { messageId: "m1" } }));

    expect(qqSdkMock.initApiConfig).toHaveBeenCalledWith({ markdownSupport: false });
    expect(qqSdkMock.getAccessToken).toHaveBeenCalledWith("app", "secret");
    expect(qqSdkMock.sendC2CMessage).toHaveBeenCalledWith("qq-token", "user-openid", "hello", "m1");
  });

  it("routes group messages to the group chat id", async () => {
    const channel = new QQChannel(new QQConfig({ appId: "app", secret: "secret", allowFrom: ["user1"], mediaDir: tmpRoot() }), new MessageBus());
    const data = {
      id: "msg1",
      content: "hello",
      group_openid: "group123",
      author: { member_openid: "user1" },
      attachments: [],
    };

    await channel.onMessage(data, true);

    const msg = await channel.bus.consumeInbound();
    expect(msg.senderId).toBe("user1");
    expect(msg.chatId).toBe("group123");
  });

  it("sends group plain text with msg_seq", async () => {
    const channel = makeChannel();
    channel.chatTypeCache["group123"] = "group";

    await channel.send(
      new OutboundMessage({
        channel: "qq",
        chatId: "group123",
        content: "hello",
        metadata: { messageId: "msg1" },
      }),
    );

    const api = (channel.client as FakeClient).api;
    expect(api.groupCalls).toEqual([
      {
        group_openid: "group123",
        msg_type: 0,
        content: "hello",
        msg_id: "msg1",
        msg_seq: 2,
      },
    ]);
    expect(api.c2cCalls).toEqual([]);
  });

  it("sends c2c plain text with msg_seq", async () => {
    const channel = makeChannel();

    await channel.send(
      new OutboundMessage({
        channel: "qq",
        chatId: "user123",
        content: "hello",
        metadata: { messageId: "msg1" },
      }),
    );

    const api = (channel.client as FakeClient).api;
    expect(api.c2cCalls).toEqual([
      {
        openid: "user123",
        msg_type: 0,
        content: "hello",
        msg_id: "msg1",
        msg_seq: 2,
      },
    ]);
    expect(api.groupCalls).toEqual([]);
  });

  it("sends group markdown when configured", async () => {
    const channel = makeChannel({ msgFormat: "markdown" });
    channel.chatTypeCache["group123"] = "group";

    await channel.send(
      new OutboundMessage({
        channel: "qq",
        chatId: "group123",
        content: "**hello**",
        metadata: { messageId: "msg1" },
      }),
    );

    expect((channel.client as FakeClient).api.groupCalls).toEqual([
      {
        group_openid: "group123",
        msg_type: 2,
        markdown: { content: "**hello**" },
        msg_id: "msg1",
        msg_seq: 2,
      },
    ]);
  });

  it("reads media bytes from a local path", async () => {
    const channel = makeChannel();
    const file = tmpFile(".png", Buffer.from("\x89PNG\r\n"));

    const [data, filename] = await channel.readMediaBytes(file);

    expect(data?.toString()).toBe("\x89PNG\r\n");
    expect(filename).toBe(path.basename(file));
  });

  it("reads media bytes from a file uri", async () => {
    const channel = makeChannel();
    const file = tmpFile(".jpg", Buffer.from("JFIF"));

    const [data, filename] = await channel.readMediaBytes(pathToFileURL(file).toString());

    expect(data?.toString()).toBe("JFIF");
    expect(filename).toBe(path.basename(file));
  });

  it("returns nulls for missing media files", async () => {
    const channel = makeChannel();

    const [data, filename] = await channel.readMediaBytes("/nonexistent/path/image.png");

    expect(data).toBeNull();
    expect(filename).toBeNull();
  });

  it("propagates media network errors", async () => {
    const channel = makeChannel();
    const file = tmpFile(".png", Buffer.from("\x89PNG\r\n"));
    const error = namedError("DisconnectedError", "connection lost");
    (channel.client as FakeClient).api.http.request.mockRejectedValue(error);

    await expect(channel.sendMedia("user1", file, "msg1", false)).rejects.toBe(error);
  });

  it("propagates client connector errors", async () => {
    const channel = makeChannel();
    const file = tmpFile(".png", Buffer.from("\x89PNG\r\n"));
    const error = namedError("ConnectionError", "connection refused");
    (channel.client as FakeClient).api.http.request.mockRejectedValue(error);

    await expect(channel.sendMedia("user1", file, "msg1", false)).rejects.toBe(error);
  });

  it("propagates low-level os errors", async () => {
    const channel = makeChannel();
    const file = tmpFile(".png", Buffer.from("\x89PNG\r\n"));
    const error = Object.assign(new Error("Network is unreachable"), { name: "NetworkError", code: "ENETUNREACH" });
    (channel.client as FakeClient).api.http.request.mockRejectedValue(error);

    await expect(channel.sendMedia("user1", file, "msg1", false)).rejects.toBe(error);
  });

  it("returns false on api errors", async () => {
    const channel = makeChannel();
    const file = tmpFile(".png", Buffer.from("\x89PNG\r\n"));
    (channel.client as FakeClient).api.http.request.mockRejectedValue(namedError("ServerError", "internal server error"));

    await expect(channel.sendMedia("user1", file, "msg1", false)).resolves.toBe(false);
  });

  it("returns false on generic runtime errors", async () => {
    const channel = makeChannel();
    const file = tmpFile(".png", Buffer.from("\x89PNG\r\n"));
    (channel.client as FakeClient).api.http.request.mockRejectedValue(namedError("RuntimeFailure", "some API error"));

    await expect(channel.sendMedia("user1", file, "msg1", false)).resolves.toBe(false);
  });

  it("returns false on value errors", async () => {
    const channel = makeChannel();
    const file = tmpFile(".png", Buffer.from("\x89PNG\r\n"));
    (channel.client as FakeClient).api.http.request.mockRejectedValue(namedError("ValidationError", "bad response data"));

    await expect(channel.sendMedia("user1", file, "msg1", false)).resolves.toBe(false);
  });

  it("propagates media timeout errors", async () => {
    const channel = makeChannel();
    const file = tmpFile(".png", Buffer.from("\x89PNG\r\n"));
    const error = namedError("TimeoutError", "request timed out");
    (channel.client as FakeClient).api.http.request.mockRejectedValue(error);

    await expect(channel.sendMedia("user1", file, "msg1", false)).rejects.toBe(error);
  });

  it("sends fallback text on api-level media errors", async () => {
    const channel = makeChannel();
    const file = tmpFile(".png", Buffer.from("\x89PNG\r\n"));
    (channel.client as FakeClient).api.http.request.mockRejectedValue(namedError("ServerError", "internal server error"));

    await channel.send(
      new OutboundMessage({
        channel: "qq",
        chatId: "user1",
        content: "",
        media: [file],
        metadata: { messageId: "msg1" },
      }),
    );

    const calls = (channel.client as FakeClient).api.c2cCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0].content).toContain("Attachment send failed");
  });

  it("propagates network errors from send without fallback text", async () => {
    const channel = makeChannel();
    const file = tmpFile(".png", Buffer.from("\x89PNG\r\n"));
    const error = namedError("DisconnectedError", "connection lost");
    (channel.client as FakeClient).api.http.request.mockRejectedValue(error);

    await expect(
      channel.send(
        new OutboundMessage({
          channel: "qq",
          chatId: "user1",
          content: "hello",
          media: [file],
          metadata: { messageId: "msg1" },
        }),
      ),
    ).rejects.toBe(error);
    expect((channel.client as FakeClient).api.c2cCalls).toEqual([]);
  });
});
