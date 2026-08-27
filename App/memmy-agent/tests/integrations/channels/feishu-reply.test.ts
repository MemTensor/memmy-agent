import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { FeishuChannel, FeishuConfig } from "../../../src/integrations/channels/feishu.js";

const larkSdkMock = vi.hoisted(() => {
  const api: any = {
    AppType: { SelfBuild: 1 },
    Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
    LoggerLevel: { fatal: "fatal" },
    clientInstances: [] as any[],
    wsInstances: [] as any[],
    dispatchers: [] as any[],
  };
  const runtimeClient = () => ({
    request: vi.fn((req?: any) => {
      if (typeof req?.url === "string" && req.url.includes("tenant_access_token")) {
        return { code: 0, msg: "ok", tenant_access_token: "t-xxx", expire: 7200 };
      }
      return { data: { bot: { open_id: "ou_bot" } } };
    }),
    im: { v1: { message: {}, image: {}, file: {}, message_reaction: {}, message_resource: {} } },
  });
  function Client(this: any, opts: any) {
    Object.assign(this, runtimeClient(), { opts });
    api.clientInstances.push(this);
  }
  function WSClient(this: any, opts: any) {
    this.opts = opts;
    this.handlers = new Map<string, any>();
    this.on = vi.fn((event: string, handler: any) => {
      this.handlers.set(event, handler);
      return this;
    });
    this.start = vi.fn(async (params?: any) => {
      if (!params?.eventDispatcher) throw new Error("client need to start with a eventDispatcher");
    });
    this.close = vi.fn(async () => undefined);
    api.wsInstances.push(this);
  }
  api.Client = vi.fn(Client);
  api.WSClient = vi.fn(WSClient);
  api.EventDispatcher = vi.fn(function EventDispatcher(this: any, opts: any) {
    this.opts = opts;
    this.handlers = {};
    this.register = vi.fn((handlers: Record<string, any>) => {
      Object.assign(this.handlers, handlers);
      return this;
    });
    this.invoke = vi.fn(async (event: any) => {
      const handler = this.handlers["im.message.receive_v1"];
      return handler?.(event);
    });
    api.dispatchers.push(this);
  });
  api.reset = () => {
    api.clientInstances = [];
    api.wsInstances = [];
    api.dispatchers = [];
    api.Client.mockClear();
    api.Client.mockImplementation(Client);
    api.WSClient.mockClear();
    api.WSClient.mockImplementation(WSClient);
    api.EventDispatcher.mockClear();
  };
  return api;
});

vi.mock("@larksuiteoapi/node-sdk", () => larkSdkMock);

function response({
  success = true,
  data = {},
  code,
  msg = "ok",
}: { success?: boolean; data?: any; code?: number; msg?: string } = {}) {
  return {
    success: vi.fn(() => success),
    data,
    code: code ?? (success ? 0 : 400),
    msg,
    get_log_id: vi.fn(() => "log_x"),
  };
}

function makeGetMessageResponse(text: string, msgType = "text", success = true) {
  return response({
    success,
    data: {
      items: [
        {
          msg_type: msgType,
          body: { content: JSON.stringify({ text }) },
        },
      ],
    },
  });
}

function makeClient() {
  return {
    im: {
      v1: {
        message: {
          get: vi.fn(),
          reply: vi.fn(() => response()),
          create: vi.fn(() => response({ data: { message_id: "om_out" } })),
        },
        image: {
          create: vi.fn(() => response({ data: { image_key: "image-key" } })),
        },
        file: {
          create: vi.fn(() => response({ data: { file_key: "file-key" } })),
        },
        message_reaction: {
          create: vi.fn(() => response({ data: { reaction_id: "reaction_abc" } })),
          delete: vi.fn(() => response()),
        },
        message_resource: {
          get: vi.fn(),
        },
      },
    },
  };
}

function makeFeishuChannel(replyToMessage = false, groupPolicy = "mention", topicIsolation = true) {
  const channel = new FeishuChannel(
    {
      enabled: true,
      appId: "cli_test",
      appSecret: "secret",
      allowFrom: ["*"],
      replyToMessage,
      groupPolicy,
      topicIsolation,
    },
    new MessageBus(),
  );
  channel.client = makeClient();
  channel.loop = null;
  return channel;
}

function makeFeishuEvent({
  messageId = "om_001",
  chatId = "oc_abc",
  chatType = "p2p",
  msgType = "text",
  content = '{"text": "hello"}',
  senderOpenId = "ou_alice",
  parentId = null,
  rootId = null,
}: {
  messageId?: string;
  chatId?: string;
  chatType?: string;
  msgType?: string;
  content?: string;
  senderOpenId?: string;
  parentId?: string | null;
  rootId?: string | null;
} = {}) {
  return {
    event: {
      message: {
        message_id: messageId,
        chat_id: chatId,
        chat_type: chatType,
        message_type: msgType,
        content,
        parent_id: parentId,
        root_id: rootId,
        mentions: [],
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: senderOpenId },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  larkSdkMock.reset();
  delete process.env.MEMMY_AGENT_DATA_DIR;
});

describe("Feishu runtime startup", () => {
  it("creates the default Lark client and websocket client", async () => {
    const channel = new FeishuChannel(
      { enabled: true, appId: "cli_test", appSecret: "secret", allowFrom: ["*"] },
      new MessageBus(),
    );

    await channel.start();

    expect(larkSdkMock.Client).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "cli_test",
        appSecret: "secret",
        appType: larkSdkMock.AppType.SelfBuild,
        domain: larkSdkMock.Domain.Feishu,
      }),
    );
    expect(larkSdkMock.WSClient).toHaveBeenCalledWith({ appId: "cli_test", appSecret: "secret" });
    expect(larkSdkMock.EventDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ verificationToken: "", encryptKey: "" }),
    );
    expect(larkSdkMock.dispatchers[0].register).toHaveBeenCalledWith({
      "im.message.receive_v1": expect.any(Function),
    });
    expect(larkSdkMock.wsInstances[0].on).toHaveBeenCalledWith("event", expect.any(Function));
    expect(larkSdkMock.wsInstances[0].start).toHaveBeenCalledWith({
      eventDispatcher: expect.objectContaining({
        invoke: expect.any(Function),
      }),
    });
  });
});

describe("Feishu reply config", () => {
  it("defaults replyToMessage to false", () => {
    expect(new FeishuConfig().replyToMessage).toBe(false);
  });

  it("can enable replyToMessage", () => {
    expect(new FeishuConfig({ replyToMessage: true }).replyToMessage).toBe(true);
  });

  it("defaults topicIsolation to true", () => {
    expect(new FeishuConfig().topicIsolation).toBe(true);
  });

  it("can disable topicIsolation", () => {
    expect(new FeishuConfig({ topicIsolation: false }).topicIsolation).toBe(false);
  });

  it("accepts topicIsolation through fromObject", () => {
    expect(FeishuConfig.fromObject({ topicIsolation: false }).topicIsolation).toBe(false);
  });
});

describe("Feishu parent message content", () => {
  it("returns a reply prefix for text messages", () => {
    const channel = makeFeishuChannel();
    channel.client.im.v1.message.get.mockReturnValue(makeGetMessageResponse("what time is it?"));

    expect(channel.getMessageContentSync("om_parent")).toBe("[Reply to: what time is it?]");
  });

  it("truncates long reply context", () => {
    const channel = makeFeishuChannel();
    const longText = "x".repeat(FeishuChannel.REPLY_CONTEXT_MAX_LEN + 50);
    channel.client.im.v1.message.get.mockReturnValue(makeGetMessageResponse(longText));

    const result = channel.getMessageContentSync("om_parent");

    expect(result).not.toBeNull();
    expect(result).toMatch(/\.\.\.\]$/);
    const inner = result!.slice("[Reply to: ".length, -1);
    expect(inner).toHaveLength(FeishuChannel.REPLY_CONTEXT_MAX_LEN + "...".length);
  });

  it("returns null on API failure", () => {
    const channel = makeFeishuChannel();
    channel.client.im.v1.message.get.mockReturnValue(
      response({ success: false, code: 230002, msg: "bot not in group" }),
    );

    expect(channel.getMessageContentSync("om_parent")).toBeNull();
  });

  it("returns null for non-text message types", () => {
    const channel = makeFeishuChannel();
    channel.client.im.v1.message.get.mockReturnValue(
      response({
        data: {
          items: [{ msg_type: "image", body: { content: JSON.stringify({ image_key: "img_1" }) } }],
        },
      }),
    );

    expect(channel.getMessageContentSync("om_parent")).toBeNull();
  });

  it("returns null for empty parent text", () => {
    const channel = makeFeishuChannel();
    channel.client.im.v1.message.get.mockReturnValue(makeGetMessageResponse("   "));

    expect(channel.getMessageContentSync("om_parent")).toBeNull();
  });
});

describe("Feishu reply sync", () => {
  it("returns true on successful reply", () => {
    const channel = makeFeishuChannel();

    expect(channel.replyMessageSync("om_parent", "text", '{"text":"hi"}')).toBe(true);
    expect(channel.client.im.v1.message.reply).toHaveBeenCalledOnce();
  });

  it("returns false on reply API errors", () => {
    const channel = makeFeishuChannel();
    channel.client.im.v1.message.reply.mockReturnValue(
      response({ success: false, code: 400, msg: "bad request" }),
    );

    expect(channel.replyMessageSync("om_parent", "text", '{"text":"hi"}')).toBe(false);
  });

  it("returns false on reply exceptions", () => {
    const channel = makeFeishuChannel();
    channel.client.im.v1.message.reply.mockImplementation(() => {
      throw new Error("network error");
    });

    expect(channel.replyMessageSync("om_parent", "text", '{"text":"hi"}')).toBe(false);
  });
});

describe("Feishu send media types", () => {
  async function sendSingleMedia(filename: string, tmpDir: string) {
    const channel = makeFeishuChannel();
    const filePath = path.join(tmpDir, filename);
    fs.writeFileSync(filePath, "demo");

    await channel.send(
      new OutboundMessage({ channel: "feishu", chatId: "oc_test", media: [filePath] }),
    );

    return channel.client.im.v1.message.create.mock.calls[0][0];
  }

  it("uses audio msg_type for opus files", async () => {
    const call = await sendSingleMedia(
      "voice.opus",
      fs.mkdtempSync(path.join(os.tmpdir(), "feishu-")),
    );

    expect(call).toMatchObject({
      receive_id_type: "chat_id",
      receive_id: "oc_test",
      msg_type: "audio",
    });
    expect(JSON.parse(call.content)).toEqual({ file_key: "file-key" });
  });

  it("uses media msg_type for mp4 files", async () => {
    const call = await sendSingleMedia(
      "clip.mp4",
      fs.mkdtempSync(path.join(os.tmpdir(), "feishu-")),
    );

    expect(call).toMatchObject({
      receive_id_type: "chat_id",
      receive_id: "oc_test",
      msg_type: "media",
    });
    expect(JSON.parse(call.content)).toEqual({ file_key: "file-key" });
  });

  it("uses file msg_type for document files", async () => {
    const call = await sendSingleMedia(
      "report.pdf",
      fs.mkdtempSync(path.join(os.tmpdir(), "feishu-")),
    );

    expect(call).toMatchObject({
      receive_id_type: "chat_id",
      receive_id: "oc_test",
      msg_type: "file",
    });
    expect(JSON.parse(call.content)).toEqual({ file_key: "file-key" });
  });
});

describe("Feishu send reply routing", () => {
  it("uses reply API when configured", async () => {
    const channel = makeFeishuChannel(true);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        metadata: { message_id: "om_001" },
      }),
    );

    expect(channel.client.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).not.toHaveBeenCalled();
  });

  it("uses create API when reply is disabled", async () => {
    const channel = makeFeishuChannel(false);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        metadata: { message_id: "om_001" },
      }),
    );

    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.reply).not.toHaveBeenCalled();
  });

  it("uses create API when no message id is available", async () => {
    const channel = makeFeishuChannel(true);

    await channel.send(
      new OutboundMessage({ channel: "feishu", chatId: "oc_abc", content: "hello", metadata: {} }),
    );

    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.reply).not.toHaveBeenCalled();
  });

  it("skips reply API for progress messages", async () => {
    const channel = makeFeishuChannel(true);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "thinking...",
        metadata: { message_id: "om_001", agentProgress: true },
      }),
    );

    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.reply).not.toHaveBeenCalled();
  });

  it("falls back to create when reply fails", async () => {
    const channel = makeFeishuChannel(true);
    channel.client.im.v1.message.reply.mockReturnValue(
      response({ success: false, code: 400, msg: "error" }),
    );

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        metadata: { message_id: "om_001" },
      }),
    );

    expect(channel.client.im.v1.message.reply).toHaveBeenCalledOnce();
    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
  });

  it("uses reply for all chunks when sending into an existing topic", async () => {
    const channel = makeFeishuChannel(false);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-"));
    const file1 = path.join(tmpDir, "file1.png");
    const file2 = path.join(tmpDir, "file2.png");
    fs.writeFileSync(file1, "demo1");
    fs.writeFileSync(file2, "demo2");

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        media: [file1, file2],
        metadata: { message_id: "om_001", thread_id: "om_thread", chat_type: "group" },
      }),
    );

    expect(channel.client.im.v1.message.reply).toHaveBeenCalledTimes(3);
    expect(channel.client.im.v1.message.create).not.toHaveBeenCalled();
  });

  it("uses reply only for the first chunk when quoting outside a topic", async () => {
    const channel = makeFeishuChannel(true);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-"));
    const file1 = path.join(tmpDir, "file1.png");
    const file2 = path.join(tmpDir, "file2.png");
    fs.writeFileSync(file1, "demo1");
    fs.writeFileSync(file2, "demo2");

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        media: [file1, file2],
        metadata: { message_id: "om_001", chat_type: "group" },
      }),
    );

    expect(channel.client.im.v1.message.reply).toHaveBeenCalledTimes(1);
    expect(channel.client.im.v1.message.create).toHaveBeenCalledTimes(2);
  });
});

describe("Feishu inbound reply metadata", () => {
  it("captures parent_id and root_id in metadata", async () => {
    const channel = makeFeishuChannel();
    const captured: any[] = [];
    channel.handleMessage = vi.fn(async (kwargs: any) => {
      captured.push(kwargs);
    }) as any;

    await channel.onMessage(makeFeishuEvent({ parentId: "om_parent", rootId: "om_root" }));

    expect(captured).toHaveLength(1);
    expect(captured[0].metadata).toMatchObject({
      parent_id: "om_parent",
      root_id: "om_root",
      message_id: "om_001",
    });
  });

  it("sets parent_id and root_id to null when absent", async () => {
    const channel = makeFeishuChannel();
    const captured: any[] = [];
    channel.handleMessage = vi.fn(async (kwargs: any) => {
      captured.push(kwargs);
    }) as any;

    await channel.onMessage(makeFeishuEvent());

    expect(captured[0].metadata.parent_id).toBeNull();
    expect(captured[0].metadata.root_id).toBeNull();
  });

  it("prepends reply context when parent_id is present", async () => {
    const channel = makeFeishuChannel();
    const captured: any[] = [];
    channel.client.im.v1.message.get.mockReturnValue(makeGetMessageResponse("original question"));
    channel.handleMessage = vi.fn(async (kwargs: any) => {
      captured.push(kwargs);
    }) as any;

    await channel.onMessage(
      makeFeishuEvent({ content: '{"text": "my answer"}', parentId: "om_parent" }),
    );

    expect(captured[0].content).toMatch(/^\[Reply to: original question\]/);
    expect(captured[0].content).toContain("my answer");
  });

  it("does not fetch parent content when parent_id is absent", async () => {
    const channel = makeFeishuChannel();
    channel.handleMessage = vi.fn(async () => undefined) as any;

    await channel.onMessage(makeFeishuEvent());

    expect(channel.client.im.v1.message.get).not.toHaveBeenCalled();
    expect(channel.handleMessage).toHaveBeenCalledOnce();
  });
});

describe("Feishu inbound media", () => {
  it("publishes downloaded audio path and transcription", async () => {
    const bus = new MessageBus();
    const channel = makeFeishuChannel();
    channel.bus = bus;
    channel.downloadAndSaveMedia = vi.fn(async () => [
      String.raw`C:\Users\dodre\.memmy\media\feishu\voice.ogg`,
      "[audio: voice.ogg]",
    ]) as any;
    channel.transcribeAudio = vi.fn(async () => "hello from voice");

    await channel.onMessage(
      makeFeishuEvent({
        msgType: "audio",
        content: '{"file_key": "audio_key", "duration": 1000}',
        messageId: "om_audio",
      }),
    );

    const inbound = await bus.nextInbound();
    expect(channel.downloadAndSaveMedia).toHaveBeenCalledWith(
      "audio",
      { file_key: "audio_key", duration: 1000 },
      "om_audio",
    );
    expect(channel.transcribeAudio).toHaveBeenCalledWith(
      String.raw`C:\Users\dodre\.memmy\media\feishu\voice.ogg`,
    );
    expect(inbound.media).toEqual([String.raw`C:\Users\dodre\.memmy\media\feishu\voice.ogg`]);
    expect(inbound.content).toBe("[transcription: hello from voice]");
  });

  it("saves downloaded media with an absolute path in content text", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-data-"));
    process.env.MEMMY_AGENT_DATA_DIR = tmpDir;
    const channel = makeFeishuChannel();
    channel.downloadFileSync = vi.fn(() => [Buffer.from("voice-bytes"), null]) as any;

    const [filePath, contentText] = await channel.downloadAndSaveMedia(
      "audio",
      { file_key: "voice_key" },
      "om_audio",
    );

    const expectedPath = path.join(tmpDir, "media", "feishu", "voice_key.ogg");
    expect(filePath).toBe(expectedPath);
    expect(fs.readFileSync(expectedPath)).toEqual(Buffer.from("voice-bytes"));
    expect(contentText).toBe(`[audio: ${expectedPath}]`);
  });
});

describe("Feishu session keys", () => {
  it("uses root_id for group topic session keys", async () => {
    const bus = new MessageBus();
    const channel = makeFeishuChannel(false, "open");
    channel.bus = bus;

    await channel.onMessage(
      makeFeishuEvent({ chatType: "group", rootId: "om_root123", messageId: "om_child456" }),
    );

    const inbound = await bus.nextInbound();
    expect(inbound.sessionKey).toBe("feishu:oc_abc:om_root123");
  });

  it("uses message_id when group messages have no root_id", async () => {
    const bus = new MessageBus();
    const channel = makeFeishuChannel(false, "open");
    channel.bus = bus;

    await channel.onMessage(
      makeFeishuEvent({ chatType: "group", rootId: null, messageId: "om_001" }),
    );

    const inbound = await bus.nextInbound();
    expect(inbound.sessionKey).toBe("feishu:oc_abc:om_001");
  });

  it("does not set a session override for private chat", async () => {
    const bus = new MessageBus();
    const channel = makeFeishuChannel();
    channel.bus = bus;

    await channel.onMessage(
      makeFeishuEvent({ chatType: "p2p", rootId: null, messageId: "om_001" }),
    );

    const inbound = await bus.nextInbound();
    expect(inbound.sessionKeyOverride).toBeNull();
  });
});

describe("Feishu reply_in_thread", () => {
  it("sets reply_in_thread when replyToMessage is enabled for group chat", async () => {
    const channel = makeFeishuChannel(true);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        metadata: { message_id: "om_001", chat_type: "group" },
      }),
    );

    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.request_body.reply_in_thread).toBe(true);
  });

  it("sends without reply_in_thread when reply is disabled", async () => {
    const channel = makeFeishuChannel(false);

    await channel.send(
      new OutboundMessage({ channel: "feishu", chatId: "oc_abc", content: "hello" }),
    );

    expect(channel.client.im.v1.message.create).toHaveBeenCalledOnce();
  });

  it("does not force reply_in_thread for existing topics when replyToMessage is disabled", async () => {
    const channel = makeFeishuChannel(false);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        metadata: { message_id: "om_child456", chat_type: "group", thread_id: "om_root123" },
      }),
    );

    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.request_body.reply_in_thread).not.toBe(true);
  });

  it("keeps fallback to create when reply_in_thread reply fails", async () => {
    const channel = makeFeishuChannel(true);
    channel.client.im.v1.message.reply.mockReturnValue(
      response({ success: false, code: 99991400, msg: "rate limited" }),
    );

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        metadata: { message_id: "om_001" },
      }),
    );

    expect(channel.client.im.v1.message.reply).toHaveBeenCalled();
    expect(channel.client.im.v1.message.create).toHaveBeenCalled();
  });

  it("does not set reply_in_thread for p2p chat", async () => {
    const channel = makeFeishuChannel(true);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        metadata: { message_id: "om_001", chat_type: "p2p" },
      }),
    );

    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.request_body.reply_in_thread).not.toBe(true);
  });

  it("sets reply_in_thread for group chat", async () => {
    const channel = makeFeishuChannel(true);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        metadata: { message_id: "om_001", chat_type: "group" },
      }),
    );

    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.request_body.reply_in_thread).toBe(true);
  });

  it("targets inbound message_id when replying inside a topic", async () => {
    const channel = makeFeishuChannel(true);

    await channel.send(
      new OutboundMessage({
        channel: "feishu",
        chatId: "oc_abc",
        content: "hello",
        metadata: { message_id: "om_child456", chat_type: "group", root_id: "om_root123" },
      }),
    );

    const request = channel.client.im.v1.message.reply.mock.calls[0][0];
    expect(request.message_id).toBe("om_child456");
    expect(request.request_body.reply_in_thread).toBe(true);
  });
});

describe("Feishu reaction callbacks", () => {
  it("stores reaction ids when add reaction completes", async () => {
    const channel = makeFeishuChannel();

    await channel.onReactionAdded("om_001", Promise.resolve("reaction_abc"));

    expect(channel.reactionIds.om_001).toBe("reaction_abc");
  });

  it("skips empty reaction results", async () => {
    const channel = makeFeishuChannel();

    await channel.onReactionAdded("om_001", Promise.resolve(null));

    expect(channel.reactionIds.om_001).toBeUndefined();
  });

  it("removes completed background tasks from tracking", async () => {
    const channel = makeFeishuChannel();
    const task = Promise.reject(new Error("test failure"));
    channel.backgroundTasks.add(task);

    await channel.onBackgroundTaskDone(task);

    expect(channel.backgroundTasks.has(task)).toBe(false);
  });
});

describe("Feishu authorization side effects", () => {
  it("sends pairing code for unauthorized DM before media side effects", async () => {
    const channel = makeFeishuChannel(false, "open");
    channel.config.allowFrom = ["ou_allowed"];
    channel.downloadAndSaveMedia = vi.fn(async () => ["/tmp/audio.ogg", "[audio]"]) as any;
    channel.transcribeAudio = vi.fn(async () => "transcript");
    channel.handleMessage = vi.fn(async () => undefined) as any;

    await channel.onMessage(
      makeFeishuEvent({
        msgType: "audio",
        content: '{"file_key": "file_1"}',
        senderOpenId: "ou_blocked",
      }),
    );

    expect(channel.downloadAndSaveMedia).not.toHaveBeenCalled();
    expect(channel.transcribeAudio).not.toHaveBeenCalled();
    expect(channel.handleMessage).toHaveBeenCalledOnce();
  });

  it("ignores unauthorized group messages before side effects", async () => {
    const channel = makeFeishuChannel(false, "open");
    channel.config.allowFrom = ["ou_allowed"];
    channel.downloadAndSaveMedia = vi.fn(async () => ["/tmp/audio.ogg", "[audio]"]) as any;
    channel.transcribeAudio = vi.fn(async () => "transcript");
    channel.handleMessage = vi.fn(async () => undefined) as any;

    await channel.onMessage(
      makeFeishuEvent({
        chatType: "group",
        msgType: "audio",
        content: '{"file_key": "file_1"}',
        senderOpenId: "ou_blocked",
      }),
    );

    expect(channel.downloadAndSaveMedia).not.toHaveBeenCalled();
    expect(channel.transcribeAudio).not.toHaveBeenCalled();
    expect(channel.handleMessage).not.toHaveBeenCalled();
  });
});

describe("Feishu topic isolation", () => {
  it("uses thread-scoped session keys when topic isolation is enabled", async () => {
    const bus = new MessageBus();
    const channel = makeFeishuChannel(false, "open", true);
    channel.bus = bus;

    await channel.onMessage(
      makeFeishuEvent({ chatType: "group", rootId: "om_root123", messageId: "om_child456" }),
    );
    await channel.onMessage(
      makeFeishuEvent({
        chatType: "group",
        rootId: null,
        messageId: "om_001",
        content: '{"text": "another"}',
      }),
    );

    const first = await bus.nextInbound();
    const second = await bus.nextInbound();
    expect(first.sessionKeyOverride).toBe("feishu:oc_abc:om_root123");
    expect(second.sessionKeyOverride).toBe("feishu:oc_abc:om_001");
  });

  it("uses group-scoped session keys when topic isolation is disabled", async () => {
    const bus = new MessageBus();
    const channel = makeFeishuChannel(false, "open", false);
    channel.bus = bus;

    await channel.onMessage(
      makeFeishuEvent({ chatType: "group", rootId: "om_root123", messageId: "om_child456" }),
    );
    await channel.onMessage(
      makeFeishuEvent({
        chatType: "group",
        rootId: null,
        messageId: "om_001",
        content: '{"text": "another"}',
      }),
    );
    await channel.onMessage(
      makeFeishuEvent({
        chatType: "p2p",
        rootId: null,
        messageId: "om_private",
        content: '{"text": "private"}',
      }),
    );

    const first = await bus.nextInbound();
    const second = await bus.nextInbound();
    const third = await bus.nextInbound();
    expect(first.sessionKeyOverride).toBe("feishu:oc_abc");
    expect(second.sessionKeyOverride).toBe("feishu:oc_abc");
    expect(third.sessionKeyOverride).toBeNull();
  });
});
