import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import {
  WECOM_UPLOAD_MAX_BYTES,
  WecomChannel,
  WecomConfig,
  guessWecomMediaType,
  sanitizeFilename,
} from "../../../src/integrations/channels/wecom.js";

const wecomSdkMock = vi.hoisted(() => {
  const api: any = { instances: [] as any[] };
  function WSClient(this: any, opts: any) {
    this.opts = opts;
    this.handlers = new Map<string, any>();
    this.on = vi.fn((event: string, handler: any) => {
      this.handlers.set(event, handler);
      return this;
    });
    this.connect = vi.fn(async () => undefined);
    this.disconnect = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
    api.instances.push(this);
  }
  api.WSClient = vi.fn(WSClient);
  api.reset = () => {
    api.instances = [];
    api.WSClient.mockClear();
    api.WSClient.mockImplementation(WSClient);
  };
  return api;
});

vi.mock("@wecom/aibot-node-sdk", () => ({ WSClient: wecomSdkMock.WSClient }));

const oldConfig = process.env.MEMMY_CONFIG;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-wecom-"));
  roots.push(root);
  process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  wecomSdkMock.reset();
  process.env.MEMMY_CONFIG = oldConfig;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class FakeResponse {
  errcode: number;
  errmsg: string;
  body: any;
  constructor(errcode = 0, body: any = {}, errmsg = "ok") {
    this.errcode = errcode;
    this.errmsg = errmsg;
    this.body = body;
  }
}

class FakeWsManager {
  responses: FakeResponse[];
  calls: Array<[string, any, string]> = [];
  constructor(responses: FakeResponse[] = []) {
    this.responses = [...responses];
  }
  async sendReply(reqId: string, data: any, cmd: string): Promise<FakeResponse> {
    this.calls.push([reqId, data, cmd]);
    return this.responses.shift() ?? new FakeResponse();
  }
}

class FakeWeComClient {
  wsManager: FakeWsManager;
  downloadCalls: any[] = [];
  downloadResult: [Buffer | null, string | null] = [null, null];
  replyCalls: any[] = [];
  replyStreamCalls: any[] = [];
  sendMessageCalls: any[] = [];
  welcomeCalls: any[] = [];
  replyStreamThrows = false;
  constructor(responses: FakeResponse[] = []) {
    this.wsManager = new FakeWsManager(responses);
  }
  async downloadFile(url: string, key: string): Promise<[Buffer | null, string | null]> {
    this.downloadCalls.push([url, key]);
    return this.downloadResult;
  }
  async reply(...args: any[]): Promise<void> {
    this.replyCalls.push(args);
  }
  async replyStream(...args: any[]): Promise<void> {
    if (this.replyStreamThrows) throw new Error("boom");
    this.replyStreamCalls.push(args);
  }
  async sendMessage(...args: any[]): Promise<void> {
    this.sendMessageCalls.push(args);
  }
  async replyWelcome(...args: any[]): Promise<void> {
    this.welcomeCalls.push(args);
  }
}

class FakeFrame {
  body: any;
  constructor(body: any = {}) {
    this.body = body;
  }
}

function makeChannel(allowFrom: string[] = ["*"]): WecomChannel {
  return new WecomChannel(new WecomConfig({ enabled: true, botId: "b", secret: "s", allowFrom }), new MessageBus());
}

describe("WeCom runtime startup", () => {
  it("creates the default WeCom AI Bot WS client", async () => {
    const channel = new WecomChannel(new WecomConfig({ botId: "bot-id", secret: "secret", allowFrom: ["*"] }), new MessageBus());

    await channel.start();

    expect(wecomSdkMock.WSClient).toHaveBeenCalledWith({ botId: "bot-id", secret: "secret" });
    expect(wecomSdkMock.instances[0].on).toHaveBeenCalledWith("message.text", expect.any(Function));
    expect(wecomSdkMock.instances[0].connect).toHaveBeenCalled();
    expect(channel.running).toBe(true);
    await channel.stop();
  });
});

describe("WeCom helpers", () => {
  it("strips path traversal from filenames", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
  });

  it("keeps Chinese characters in filenames", () => {
    expect(sanitizeFilename("\u6587\u4ef6\uff081\uff09.jpg")).toBe("\u6587\u4ef6\uff081\uff09.jpg");
  });

  it("returns an empty string for empty filenames", () => {
    expect(sanitizeFilename("")).toBe("");
  });

  it("classifies image media by extension", () => {
    for (const ext of [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]) {
      expect(guessWecomMediaType(`photo${ext}`)).toBe("image");
    }
  });

  it("classifies video media by extension", () => {
    for (const ext of [".mp4", ".avi", ".mov"]) expect(guessWecomMediaType(`video${ext}`)).toBe("video");
  });

  it("classifies voice media by extension", () => {
    for (const ext of [".amr", ".mp3", ".wav", ".ogg"]) expect(guessWecomMediaType(`audio${ext}`)).toBe("voice");
  });

  it("falls back to file media for document extensions", () => {
    for (const ext of [".pdf", ".doc", ".xlsx", ".zip"]) expect(guessWecomMediaType(`doc${ext}`)).toBe("file");
  });

  it("classifies media extensions case-insensitively", () => {
    expect(guessWecomMediaType("photo.PNG")).toBe("image");
    expect(guessWecomMediaType("photo.Jpg")).toBe("image");
  });
});

describe("WeCom media download", () => {
  it("downloads and saves media with a sanitized path", async () => {
    const root = tmpRoot();
    const channel = makeChannel();
    const client = new FakeWeComClient();
    client.downloadResult = [Buffer.from("\x89PNG\r\nfake image"), "raw_photo.png"];
    channel.client = client;

    const saved = await channel.downloadAndSaveMedia("https://example.com/img.png", "aes-key", "image", "../../../photo.png");

    expect(saved).toBe(path.join(root, "media", "wecom", "photo.png"));
    expect(fs.existsSync(saved!)).toBe(true);
    expect(path.basename(saved!)).toBe("photo.png");
    expect(client.downloadCalls).toEqual([["https://example.com/img.png", "aes-key"]]);
  });

  it("rejects oversized downloaded media", async () => {
    tmpRoot();
    const channel = makeChannel();
    const client = new FakeWeComClient();
    client.downloadResult = [Buffer.alloc(WECOM_UPLOAD_MAX_BYTES + 1), "big.bin"];
    channel.client = client;

    await expect(channel.downloadAndSaveMedia("https://example.com/big.bin", "key", "file", "big.bin")).resolves.toBeNull();
  });

  it("returns null when the SDK download fails", async () => {
    tmpRoot();
    const channel = makeChannel();
    const client = new FakeWeComClient();
    client.downloadResult = [null, null];
    channel.client = client;

    await expect(channel.downloadAndSaveMedia("https://example.com/fail.png", "key", "image")).resolves.toBeNull();
  });
});

describe("WeCom media upload", () => {
  it("uploads local files through init, chunk, and finish steps", async () => {
    const root = tmpRoot();
    const file = path.join(root, "photo.png");
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const client = new FakeWeComClient([
      new FakeResponse(0, { upload_id: "up_1" }),
      new FakeResponse(0, {}),
      new FakeResponse(0, { media_id: "media_abc" }),
    ]);
    const channel = makeChannel();
    channel.generateReqId = (prefix) => `req-${prefix}`;

    await expect(channel.uploadMediaWs(client, file)).resolves.toEqual(["media_abc", "image"]);
    expect(client.wsManager.calls.map((call) => call[2])).toEqual([
      "aibot_upload_media_init",
      "aibot_upload_media_chunk",
      "aibot_upload_media_finish",
    ]);
  });

  it("returns null tuple for oversized local files", async () => {
    const root = tmpRoot();
    const file = path.join(root, "large.bin");
    fs.closeSync(fs.openSync(file, "w"));
    fs.truncateSync(file, WECOM_UPLOAD_MAX_BYTES + 1);

    await expect(makeChannel().uploadMediaWs(new FakeWeComClient(), file)).resolves.toEqual([null, null]);
  });

  it("returns null tuple when upload init fails", async () => {
    const root = tmpRoot();
    const file = path.join(root, "doc.txt");
    fs.writeFileSync(file, "hello");

    await expect(makeChannel().uploadMediaWs(new FakeWeComClient([new FakeResponse(50001, {}, "invalid")]), file)).resolves.toEqual([null, null]);
  });

  it("returns null tuple when an upload chunk fails", async () => {
    const root = tmpRoot();
    const file = path.join(root, "photo.png");
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await expect(
      makeChannel().uploadMediaWs(new FakeWeComClient([new FakeResponse(0, { upload_id: "up_1" }), new FakeResponse(50002, {}, "chunk fail")]), file),
    ).resolves.toEqual([null, null]);
  });

  it("returns null tuple when upload finish omits media_id", async () => {
    const root = tmpRoot();
    const file = path.join(root, "photo.png");
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    await expect(
      makeChannel().uploadMediaWs(
        new FakeWeComClient([new FakeResponse(0, { upload_id: "up_1" }), new FakeResponse(0, {}), new FakeResponse(0, {})]),
        file,
      ),
    ).resolves.toEqual([null, null]);
  });
});

describe("WeCom send", () => {
  it("uses replyStream for text when a frame is stored", async () => {
    const channel = makeChannel();
    const client = new FakeWeComClient();
    channel.client = client;
    channel.generateReqId = (prefix) => `req-${prefix}`;
    channel.chatFrames.chat1 = new FakeFrame();

    await channel.send(new OutboundMessage({ channel: "wecom", chatId: "chat1", content: "hello" }));

    expect(client.replyStreamCalls).toHaveLength(1);
    expect(client.replyStreamCalls[0][2]).toBe("hello");
  });

  it("keeps progress frame streams unfinished", async () => {
    const channel = makeChannel();
    const client = new FakeWeComClient();
    channel.client = client;
    channel.generateReqId = (prefix) => `req-${prefix}`;
    channel.chatFrames.chat1 = new FakeFrame();

    await channel.send(new OutboundMessage({ channel: "wecom", chatId: "chat1", content: "thinking...", metadata: { agentProgress: true } }));

    expect(client.replyStreamCalls[0][2]).toBe("thinking...");
    expect(client.replyStreamCalls[0][3]).toEqual({ finish: false });
  });

  it("uses proactive sendMessage when no frame is stored", async () => {
    const channel = makeChannel();
    const client = new FakeWeComClient();
    channel.client = client;

    await channel.send(new OutboundMessage({ channel: "wecom", chatId: "chat1", content: "proactive msg" }));

    expect(client.sendMessageCalls).toEqual([["chat1", { msgtype: "markdown", markdown: { content: "proactive msg" } }]]);
  });

  it("uploads and sends media before final text", async () => {
    const root = tmpRoot();
    const file = path.join(root, "photo.png");
    fs.writeFileSync(file, "png");
    const channel = makeChannel();
    const client = new FakeWeComClient([
      new FakeResponse(0, { upload_id: "up_1" }),
      new FakeResponse(0, {}),
      new FakeResponse(0, { media_id: "media_123" }),
    ]);
    channel.client = client;
    channel.generateReqId = (prefix) => `req-${prefix}`;
    channel.chatFrames.chat1 = new FakeFrame();

    await channel.send(new OutboundMessage({ channel: "wecom", chatId: "chat1", content: "see image", media: [file] }));

    expect(client.replyCalls[0][1]).toEqual({ msgtype: "image", image: { media_id: "media_123" } });
    expect(client.replyStreamCalls).toHaveLength(1);
    expect(client.replyStreamCalls[0][2]).toBe("see image");
  });

  it("skips missing media files and still sends text", async () => {
    const channel = makeChannel();
    const client = new FakeWeComClient();
    channel.client = client;
    channel.generateReqId = (prefix) => `req-${prefix}`;
    channel.chatFrames.chat1 = new FakeFrame();

    await channel.send(new OutboundMessage({ channel: "wecom", chatId: "chat1", content: "hello", media: ["/nonexistent/file.png"] }));

    expect(client.replyCalls).toEqual([]);
    expect(client.replyStreamCalls).toHaveLength(1);
  });

  it("swallows platform send exceptions", async () => {
    const channel = makeChannel();
    const client = new FakeWeComClient();
    client.replyStreamThrows = true;
    channel.client = client;
    channel.chatFrames.chat1 = new FakeFrame();

    await expect(channel.send(new OutboundMessage({ channel: "wecom", chatId: "chat1", content: "fail test" }))).resolves.toBeUndefined();
  });
});

describe("WeCom inbound processing", () => {
  it("processes text messages with correct bus fields", async () => {
    const channel = makeChannel(["user1"]);
    channel.client = new FakeWeComClient();

    await channel.processMessage(new FakeFrame({ msgid: "msg_text_1", chatid: "chat1", chattype: "single", from: { userid: "user1" }, text: { content: "hello wecom" } }), "text");

    const msg = await channel.bus.consumeInbound();
    expect(msg.senderId).toBe("user1");
    expect(msg.chatId).toBe("chat1");
    expect(msg.content).toBe("hello wecom");
    expect(msg.metadata.msgType).toBe("text");
  });

  it("ignores unauthorized enter-chat events before welcome", async () => {
    const channel = makeChannel(["allowed"]);
    const client = new FakeWeComClient();
    channel.client = client;
    channel.config.welcomeMessage = "hello";

    await channel.onEnterChat(new FakeFrame({ chatid: "blocked" }));

    expect(client.welcomeCalls).toEqual([]);
  });

  it("ignores unauthorized senders before downloading media", async () => {
    const channel = makeChannel(["allowed"]);
    const client = new FakeWeComClient();
    channel.client = client;

    await channel.processMessage(new FakeFrame({ msgid: "blocked", chatid: "chat1", from: { userid: "blocked" }, image: { url: "https://example.com/img.png", aeskey: "key123" } }), "image");

    expect(client.downloadCalls).toEqual([]);
    expect(channel.bus.inbound.size).toBe(0);
  });

  it("processes image messages with downloaded media paths", async () => {
    const root = tmpRoot();
    const channel = makeChannel(["user1"]);
    const client = new FakeWeComClient();
    client.downloadResult = [Buffer.from("\x89PNG\r\n"), "photo.png"];
    channel.client = client;

    await channel.processMessage(new FakeFrame({ msgid: "msg_img_1", chatid: "chat1", from: { userid: "user1" }, image: { url: "https://example.com/img.png", aeskey: "key123" } }), "image");

    const msg = await channel.bus.consumeInbound();
    expect(msg.media).toEqual([path.join(root, "media", "wecom", "photo.png")]);
    expect(msg.content).toContain("[image: photo.png]");
  });

  it("processes file messages with downloaded media paths", async () => {
    const root = tmpRoot();
    const channel = makeChannel(["user1"]);
    const client = new FakeWeComClient();
    client.downloadResult = [Buffer.from("%PDF-1.4 fake"), "report.pdf"];
    channel.client = client;

    await channel.processMessage(new FakeFrame({ msgid: "msg_file_1", chatid: "chat1", from: { userid: "user1" }, file: { url: "https://example.com/report.pdf", aeskey: "key456", name: "report.pdf" } }), "file");

    const msg = await channel.bus.consumeInbound();
    expect(msg.media).toEqual([path.join(root, "media", "wecom", "report.pdf")]);
    expect(msg.content).toContain("[file: report.pdf]");
  });

  it("uses the SDK filename when a file message omits name", async () => {
    const root = tmpRoot();
    const channel = makeChannel(["user1"]);
    const client = new FakeWeComClient();
    client.downloadResult = [Buffer.from("%PDF-1.4 fake"), "real_name.pdf"];
    channel.client = client;

    await channel.processMessage(new FakeFrame({ msgid: "msg_file_2", chatid: "chat1", from: { userid: "user1" }, file: { url: "https://example.com/x", aeskey: "key456" } }), "file");

    const msg = await channel.bus.consumeInbound();
    expect(msg.media).toEqual([path.join(root, "media", "wecom", "real_name.pdf")]);
    expect(msg.content).toContain("[file: real_name.pdf]");
  });

  it("processes voice messages with transcribed content", async () => {
    const channel = makeChannel(["user1"]);
    channel.client = new FakeWeComClient();

    await channel.processMessage(new FakeFrame({ msgid: "msg_voice_1", chatid: "chat1", from: { userid: "user1" }, voice: { content: "transcribed text here" } }), "voice");

    const msg = await channel.bus.consumeInbound();
    expect(msg.content).toContain("[voice]");
    expect(msg.content).toContain("transcribed text here");
  });

  it("processes mixed text and image messages", async () => {
    const root = tmpRoot();
    const channel = makeChannel(["user1"]);
    const client = new FakeWeComClient();
    client.downloadResult = [Buffer.from("\x89PNG\r\n"), "photo.png"];
    channel.client = client;

    await channel.processMessage(
      new FakeFrame({
        msgid: "msg_mixed_1",
        chatid: "chat1",
        msgtype: "mixed",
        from: { userid: "user1" },
        mixed: { msg_item: [{ msgtype: "text", text: { content: "hello wecom" } }, { msgtype: "image", image: { url: "https://example.com/img.png", aeskey: "key123" } }] },
      }),
      "mixed",
    );

    const msg = await channel.bus.consumeInbound();
    expect(msg.senderId).toBe("user1");
    expect(msg.chatId).toBe("chat1");
    expect(msg.content).toContain("hello wecom");
    expect(msg.content).toContain("[image: photo.png]");
    expect(msg.metadata.msgType).toBe("mixed");
    expect(msg.media).toEqual([path.join(root, "media", "wecom", "photo.png")]);
  });

  it("deduplicates repeated message ids", async () => {
    const channel = makeChannel(["user1"]);
    channel.client = new FakeWeComClient();
    const frame = new FakeFrame({ msgid: "msg_dup_1", chatid: "chat1", from: { userid: "user1" }, text: { content: "once" } });

    await channel.processMessage(frame, "text");
    await channel.processMessage(frame, "text");

    expect((await channel.bus.consumeInbound()).content).toBe("once");
    expect(channel.bus.inbound.size).toBe(0);
  });

  it("skips messages with empty content", async () => {
    const channel = makeChannel(["user1"]);
    channel.client = new FakeWeComClient();

    await channel.processMessage(new FakeFrame({ msgid: "msg_empty_1", chatid: "chat1", from: { userid: "user1" }, text: { content: "" } }), "text");

    expect(channel.bus.inbound.size).toBe(0);
  });
});
