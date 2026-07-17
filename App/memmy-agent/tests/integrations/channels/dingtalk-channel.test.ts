import fs from "node:fs";
import dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import {
  DingtalkChannel,
  DingtalkConfig,
  MemmyDingTalkHandler,
} from "../../../src/integrations/channels/dingtalk.js";

const dingtalkSdkMock = vi.hoisted(() => {
  const api: any = {
    instances: [] as any[],
    EventAck: { SUCCESS: "SUCCESS" },
    TOPIC_ROBOT: "/v1.0/im/bot/messages/get",
  };
  function DWClient(this: any, opts: any) {
    this.opts = opts;
    this.callbacks = {} as Record<string, any>;
    this.registerCallbackListener = vi.fn((topic: string, cb: any) => {
      this.callbacks[topic] = cb;
      return this;
    });
    this.socketCallBackResponse = vi.fn();
    this.start = vi.fn(async () => undefined);
    this.connect = vi.fn(async () => undefined);
    this.disconnect = vi.fn(async () => undefined);
    this.close = vi.fn(async () => undefined);
    this.on = vi.fn();
    api.instances.push(this);
  }
  api.DWClient = vi.fn(DWClient);
  api.reset = () => {
    api.instances = [];
    api.DWClient.mockClear();
    api.DWClient.mockImplementation(DWClient);
  };
  return api;
});

vi.mock("dingtalk-stream", () => ({
  DWClient: dingtalkSdkMock.DWClient,
  EventAck: dingtalkSdkMock.EventAck,
  TOPIC_ROBOT: dingtalkSdkMock.TOPIC_ROBOT,
}));

const oldConfig = process.env.MEMMY_CONFIG;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-dingtalk-"));
  roots.push(root);
  process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  dingtalkSdkMock.reset();
  process.env.MEMMY_CONFIG = oldConfig;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class FakeResponse {
  statusCode: number;
  body: any;
  content: Buffer;
  headers: Record<string, string>;
  url: string;
  text: string;
  constructor(
    statusCode = 200,
    body: any = {},
    {
      content = Buffer.alloc(0),
      headers = { "content-type": "application/json" },
      url = "https://example.com/file",
    }: { content?: Buffer; headers?: Record<string, string>; url?: string } = {},
  ) {
    this.statusCode = statusCode;
    this.body = body;
    this.content = content;
    this.headers = headers;
    this.url = url;
    this.text = content.length ? content.toString("utf8") : JSON.stringify(body);
  }
  json(): any {
    return this.body;
  }
  raiseForStatus(): void {
    if (this.statusCode >= 400) throw new Error(`HTTP ${this.statusCode}`);
  }
}

class FakeHttp {
  calls: any[] = [];
  responses: FakeResponse[];
  constructor(responses: FakeResponse[] = []) {
    this.responses = [...responses];
  }
  next(): FakeResponse {
    return this.responses.shift() ?? new FakeResponse();
  }
  async post(url: string, kwargs: any = {}): Promise<FakeResponse> {
    this.calls.push({ method: "POST", url, ...kwargs });
    return this.next();
  }
  async get(url: string, kwargs: any = {}): Promise<FakeResponse> {
    this.calls.push({ method: "GET", url, ...kwargs });
    return this.next();
  }
}

class NetworkErrorHttp {
  calls: any[] = [];
  async post(url: string, kwargs: any = {}): Promise<never> {
    this.calls.push({ method: "POST", url, ...kwargs });
    throw new Error("Connection refused");
  }
  async get(url: string, kwargs: any = {}): Promise<never> {
    this.calls.push({ method: "GET", url, ...kwargs });
    throw new Error("Connection refused");
  }
}

function makeChannel(http?: FakeHttp): DingtalkChannel {
  const channel = new DingtalkChannel(
    new DingtalkConfig({
      enabled: true,
      clientId: "app",
      clientSecret: "secret",
      allowFrom: ["*"],
    }),
    new MessageBus(),
  );
  if (http) channel.http = http;
  channel.validateRemoteMediaUrl = async (mediaRef: string) => !mediaRef.includes("127.0.0.1");
  channel.validateResolvedRemoteMediaUrl = async (mediaRef: string) =>
    !mediaRef.includes("127.0.0.1");
  return channel;
}

function allowTestRemoteMedia(channel: DingtalkChannel): DingtalkChannel {
  channel.validateRemoteMediaUrl = async (mediaRef: string) => !mediaRef.includes("127.0.0.1");
  channel.validateResolvedRemoteMediaUrl = async (mediaRef: string) =>
    !mediaRef.includes("127.0.0.1");
  return channel;
}

function allowInitialRemoteMedia(channel: DingtalkChannel): DingtalkChannel {
  channel.validateRemoteMediaUrl = async () => true;
  return channel;
}

function fakeResolve(host: string, results: string[]) {
  return vi.spyOn(dns, "lookup").mockImplementation(async (hostname: string) => {
    if (hostname === host)
      return results.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) as any;
    throw new Error(`cannot resolve ${hostname}`);
  });
}

describe("DingtalkChannel", () => {
  it("creates the default dingtalk-stream client on start", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const channel = makeChannel();

    await channel.start();

    expect(dingtalkSdkMock.DWClient).toHaveBeenCalledWith({
      clientId: "app",
      clientSecret: "secret",
    });
    expect(dingtalkSdkMock.instances[0].registerCallbackListener).toHaveBeenCalledWith(
      "/v1.0/im/bot/messages/get",
      expect.any(Function),
    );
    expect(dingtalkSdkMock.instances[0].start).toHaveBeenCalled();
    expect(channel.running).toBe(true);
    await channel.stop();
  });

  it("routes robot callback messages (CALLBACK topic, JSON string payload) into the bus and acks", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const bus = new MessageBus();
    const channel = new DingtalkChannel(
      new DingtalkConfig({
        enabled: true,
        clientId: "app",
        clientSecret: "secret",
        allowFrom: ["*"],
      }),
      bus,
    );

    await channel.start();
    const instance = dingtalkSdkMock.instances[0];
    const robotCallback = instance.callbacks["/v1.0/im/bot/messages/get"];
    expect(robotCallback).toBeTypeOf("function");

    await robotCallback({
      headers: { topic: "/v1.0/im/bot/messages/get", messageId: "m1" },
      data: JSON.stringify({
        text: { content: "hi memmy" },
        senderStaffId: "user1",
        senderNick: "Alice",
        conversationType: "2",
        conversationId: "cid1",
      }),
    });

    const msg = await bus.consumeInbound();
    expect(msg.content).toBe("hi memmy");
    expect(msg.senderId).toBe("user1");
    expect(msg.chatId).toBe("group:cid1");
    expect(instance.socketCallBackResponse).toHaveBeenCalledWith("m1", {});
    await channel.stop();
  });

  it("routes group messages with sender id preserved", async () => {
    const bus = new MessageBus();
    const channel = new DingtalkChannel(
      new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["user1"] }),
      bus,
    );

    await channel.onMessage("hello", "user1", "Alice", "2", "conv123");

    const msg = await bus.consumeInbound();
    expect(msg.senderId).toBe("user1");
    expect(msg.chatId).toBe("group:conv123");
    expect(msg.metadata).toMatchObject({
      conversationType: "2",
      senderName: "Alice",
      platform: "dingtalk",
    });
  });

  it("handler forwards text and recognition content", async () => {
    const bus = new MessageBus();
    const channel = new DingtalkChannel(
      new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["user1"] }),
      bus,
    );
    const handler = new MemmyDingTalkHandler(channel);

    await handler.process({
      data: {
        text: { content: "" },
        content: { recognition: "voice transcript" },
        senderStaffId: "user1",
        senderNick: "Alice",
        conversationType: "1",
      },
    });

    const msg = await bus.consumeInbound();
    expect(msg.content).toBe("voice transcript");
    expect(msg.senderId).toBe("user1");
  });

  it("handler processes file messages with downloaded paths", async () => {
    const bus = new MessageBus();
    const channel = new DingtalkChannel(
      new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["user1"] }),
      bus,
    );
    channel.downloadDingtalkFile = async (code, filename, senderId) =>
      `/tmp/memmy-dingtalk/${senderId}/${filename}`;
    const handler = new MemmyDingTalkHandler(channel);

    const status = await handler.process({
      data: {
        content: { downloadCode: "abc123", fileName: "report.xlsx" },
        text: { content: "" },
        senderStaffId: "user1",
        senderNick: "Alice",
        conversationType: "1",
      },
    });
    const msg = await bus.consumeInbound();

    expect(status).toEqual(["OK", "OK"]);
    expect(msg.content).toContain("[File]");
    expect(msg.content).toContain("/tmp/memmy-dingtalk/user1/report.xlsx");
  });

  it("sends group and direct payloads to the correct DingTalk APIs", async () => {
    const http = new FakeHttp([
      new FakeResponse(200, { errcode: 0 }),
      new FakeResponse(200, { errcode: 0 }),
    ]);
    const channel = makeChannel(http);

    expect(
      await channel.sendBatchMessage("token", "group:conv123", "sampleMarkdown", { text: "hello" }),
    ).toBe(true);
    expect(await channel.sendBatchMessage("token", "user1", "sampleMarkdown", { text: "hi" })).toBe(
      true,
    );

    expect(http.calls[0].url).toBe("https://api.dingtalk.com/v1.0/robot/groupMessages/send");
    expect(http.calls[0].json).toMatchObject({
      openConversationId: "conv123",
      msgKey: "sampleMarkdown",
    });
    expect(JSON.parse(http.calls[0].json.msgParam)).toEqual({ text: "hello" });
    expect(http.calls[1].url).toBe("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend");
    expect(http.calls[1].json.userIds).toEqual(["user1"]);
  });

  it("gets and caches access tokens", async () => {
    const http = new FakeHttp([new FakeResponse(200, { accessToken: "token-1", expireIn: 7200 })]);
    const channel = makeChannel(http);

    expect(await channel.getAccessToken()).toBe("token-1");
    expect(await channel.getAccessToken()).toBe("token-1");

    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].json).toEqual({ appKey: "app", appSecret: "secret" });
  });

  it("zips HTML upload payloads before media upload", () => {
    const channel = makeChannel();
    const [data, filename, contentType] = channel.normalizeUploadPayload(
      "report.html",
      Buffer.from("<html>Hello</html>"),
      "text/html",
    );

    expect(filename).toBe("report.zip");
    expect(contentType).toBe("application/zip");
    expect(data.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(data.includes(Buffer.from("report.html"))).toBe(true);
    expect(data.includes(Buffer.from("<html>Hello</html>"))).toBe(true);
  });

  it("reads local media and sends HTML as a zipped sampleFile", async () => {
    const root = tmpRoot();
    const htmlPath = path.join(root, "report.html");
    fs.writeFileSync(htmlPath, "<html>Hello</html>");
    const channel = makeChannel();
    const captured: any = {};
    channel.uploadMedia = async (token, data, mediaType, filename, contentType) => {
      captured.token = token;
      captured.data = data;
      captured.mediaType = mediaType;
      captured.filename = filename;
      captured.contentType = contentType;
      return "media-123";
    };
    channel.sendBatchMessage = async (token, chatId, msgKey, msgParam) => {
      captured.sent = { token, chatId, msgKey, msgParam };
      return true;
    };

    expect(await channel.sendMediaRef("token", "user1", htmlPath)).toBe(true);

    expect(captured.mediaType).toBe("file");
    expect(captured.filename).toBe("report.zip");
    expect(captured.contentType).toBe("application/zip");
    expect(captured.sent).toEqual({
      token: "token",
      chatId: "user1",
      msgKey: "sampleFile",
      msgParam: { mediaId: "media-123", fileName: "report.zip", fileType: "zip" },
    });
  });

  it("blocks private remote media targets before fetching", async () => {
    const http = new FakeHttp([
      new FakeResponse(
        200,
        {},
        { content: Buffer.from("secret"), url: "http://127.0.0.1/admin.txt" },
      ),
    ]);
    const channel = makeChannel(http);

    expect(await channel.readMediaBytes("http://127.0.0.1/admin.txt")).toEqual([null, null, null]);
    expect(http.calls).toEqual([]);
  });

  it("refuses redirects by default", async () => {
    const deniedHttp = new FakeHttp([
      new FakeResponse(
        302,
        {},
        {
          headers: { location: "https://example.com/final.txt" },
          url: "https://example.com/redirect.txt",
        },
      ),
    ]);
    const denied = makeChannel(deniedHttp);
    expect(await denied.readMediaBytes("https://example.com/redirect.txt")).toEqual([
      null,
      null,
      null,
    ]);
    expect(deniedHttp.calls[0].followRedirects).toBe(false);
  });

  it("follows safe same-host redirects when enabled", async () => {
    const allowedHttp = new FakeHttp([
      new FakeResponse(
        302,
        {},
        {
          headers: { location: "https://example.com/final.txt" },
          url: "https://example.com/redirect.txt",
        },
      ),
      new FakeResponse(
        200,
        {},
        {
          content: Buffer.from("media"),
          headers: { "content-type": "text/plain" },
          url: "https://example.com/final.txt",
        },
      ),
    ]);
    const allowed = allowTestRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({
          clientId: "app",
          clientSecret: "secret",
          allowFrom: ["*"],
          allowRemoteMediaRedirects: true,
        }),
        new MessageBus(),
      ),
    );
    allowed.http = allowedHttp;
    const [data, filename, contentType] = await allowed.readMediaBytes(
      "https://example.com/redirect.txt",
    );
    expect(data?.toString()).toBe("media");
    expect(filename).toBe("redirect.txt");
    expect(contentType).toBe("text/plain");
    expect(allowedHttp.calls.map((call) => call.url)).toEqual([
      "https://example.com/redirect.txt",
      "https://example.com/final.txt",
    ]);
  });

  it("blocks cross-host redirects unless allowlisted", async () => {
    const http = new FakeHttp([
      new FakeResponse(
        302,
        {},
        {
          headers: { location: "https://example.org/final.txt" },
          url: "https://example.com/redirect.txt",
        },
      ),
      new FakeResponse(
        200,
        {},
        {
          content: Buffer.from("cross-host media"),
          headers: { "content-type": "text/plain" },
          url: "https://example.org/final.txt",
        },
      ),
    ]);
    const channel = allowTestRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({
          clientId: "app",
          clientSecret: "secret",
          allowFrom: ["*"],
          allowRemoteMediaRedirects: true,
        }),
        new MessageBus(),
      ),
    );
    channel.http = http;

    expect(await channel.readMediaBytes("https://example.com/redirect.txt")).toEqual([
      null,
      null,
      null,
    ]);
    expect(http.calls.map((call) => call.url)).toEqual(["https://example.com/redirect.txt"]);
  });

  it("allows allowlisted cross-host redirects", async () => {
    const http = new FakeHttp([
      new FakeResponse(
        302,
        {},
        {
          headers: { location: "https://example.org/final.txt" },
          url: "https://example.com/redirect.txt",
        },
      ),
      new FakeResponse(
        200,
        {},
        {
          content: Buffer.from("cross-host media"),
          headers: { "content-type": "text/plain" },
          url: "https://example.org/final.txt",
        },
      ),
    ]);
    const channel = allowTestRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({
          clientId: "app",
          clientSecret: "secret",
          allowFrom: ["*"],
          allowRemoteMediaRedirects: true,
          remoteMediaRedirectAllowedHosts: ["example.org"],
        }),
        new MessageBus(),
      ),
    );
    channel.http = http;

    const [data, filename, contentType] = await channel.readMediaBytes(
      "https://example.com/redirect.txt",
    );

    expect(data?.toString()).toBe("cross-host media");
    expect(filename).toBe("redirect.txt");
    expect(contentType).toBe("text/plain");
    expect(http.calls.map((call) => call.url)).toEqual([
      "https://example.com/redirect.txt",
      "https://example.org/final.txt",
    ]);
  });

  it("blocks private redirects even when redirects are enabled", async () => {
    const http = new FakeHttp([
      new FakeResponse(
        302,
        {},
        {
          headers: { location: "http://127.0.0.1/metadata" },
          url: "https://example.com/redirect.txt",
        },
      ),
      new FakeResponse(
        200,
        {},
        {
          content: Buffer.from("internal secret"),
          headers: { "content-type": "text/plain" },
          url: "http://127.0.0.1/metadata",
        },
      ),
    ]);
    const channel = allowTestRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({
          clientId: "app",
          clientSecret: "secret",
          allowFrom: ["*"],
          allowRemoteMediaRedirects: true,
        }),
        new MessageBus(),
      ),
    );
    channel.http = http;

    expect(await channel.readMediaBytes("https://example.com/redirect.txt")).toEqual([
      null,
      null,
      null,
    ]);
    expect(http.calls.map((call) => call.url)).toEqual(["https://example.com/redirect.txt"]);
  });

  it("does not reject fetched remote media when the final URL cannot be resolved", async () => {
    const malformedHttp = new FakeHttp([
      new FakeResponse(
        200,
        {},
        {
          content: Buffer.from("malformed media"),
          headers: { "content-type": "text/plain" },
          url: "not a url",
        },
      ),
    ]);
    const malformed = allowInitialRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["*"] }),
        new MessageBus(),
      ),
    );
    malformed.http = malformedHttp;

    const [malformedData] = await malformed.readMediaBytes("https://example.com/file.txt");

    expect(malformedData?.toString()).toBe("malformed media");

    vi.spyOn(dns, "lookup").mockRejectedValue(new Error("cannot resolve"));
    const http = new FakeHttp([
      new FakeResponse(
        200,
        {},
        {
          content: Buffer.from("media"),
          headers: { "content-type": "text/plain" },
          url: "http://final.invalid/file.txt",
        },
      ),
    ]);
    const channel = allowInitialRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["*"] }),
        new MessageBus(),
      ),
    );
    channel.http = http;

    const [data, filename, contentType] = await channel.readMediaBytes(
      "https://example.com/file.txt",
    );

    expect(data?.toString()).toBe("media");
    expect(filename).toBe("file.txt");
    expect(contentType).toBe("text/plain");
  });

  it("blocks fetched remote media when the final URL is internal", async () => {
    const literalHttp = new FakeHttp([
      new FakeResponse(
        200,
        {},
        {
          content: Buffer.from("secret"),
          headers: { "content-type": "text/plain" },
          url: "http://127.0.0.1/metadata",
        },
      ),
    ]);
    const literal = allowInitialRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["*"] }),
        new MessageBus(),
      ),
    );
    literal.http = literalHttp;
    expect(await literal.readMediaBytes("https://example.com/safe.txt")).toEqual([
      null,
      null,
      null,
    ]);

    fakeResolve("metadata.local", ["169.254.169.254"]);
    const resolvedHttp = new FakeHttp([
      new FakeResponse(
        200,
        {},
        {
          content: Buffer.from("secret"),
          headers: { "content-type": "text/plain" },
          url: "http://metadata.local/latest",
        },
      ),
    ]);
    const resolved = allowInitialRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["*"] }),
        new MessageBus(),
      ),
    );
    resolved.http = resolvedHttp;
    expect(await resolved.readMediaBytes("https://example.com/safe.txt")).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("rejects oversized remote media responses", async () => {
    const http = new FakeHttp([
      new FakeResponse(
        200,
        {},
        {
          content: Buffer.alloc(20 * 1024 * 1024 + 1),
          headers: { "content-type": "text/plain" },
          url: "https://example.com/large.txt",
        },
      ),
    ]);
    const channel = makeChannel(http);

    expect(await channel.readMediaBytes("https://example.com/large.txt")).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("downloads DingTalk files into the channel media directory", async () => {
    const root = tmpRoot();
    const http = new FakeHttp([
      new FakeResponse(200, { downloadUrl: "https://example.com/file.xlsx" }),
      new FakeResponse(200, {}, { content: Buffer.from("fake file") }),
    ]);
    const channel = makeChannel(http);
    channel.getAccessToken = async () => "token";

    const saved = await channel.downloadDingtalkFile("code123", "../../../test.xlsx", "user1");

    expect(saved).toBe(path.join(root, "media", "dingtalk", "user1", "test.xlsx"));
    expect(fs.readFileSync(saved!, "utf8")).toBe("fake file");
    expect(http.calls[0].url).toContain("messageFiles/download");
    expect(http.calls[0].json.downloadCode).toBe("code123");
    expect(http.calls[1]).toMatchObject({ method: "GET", url: "https://example.com/file.xlsx" });
  });

  it("send obtains a token, sends text, and emits visible media failure fallback", async () => {
    const channel = makeChannel();
    const calls: any[] = [];
    channel.getAccessToken = async () => "token";
    channel.sendMarkdownText = async (token, chatId, content) => {
      calls.push({ kind: "text", token, chatId, content });
      return true;
    };
    channel.sendMediaRef = async () => false;

    await channel.send(
      new OutboundMessage({
        channel: "dingtalk",
        chatId: "user1",
        content: " hello ",
        media: ["/tmp/missing.pdf"],
      }),
    );

    expect(calls).toEqual([
      { kind: "text", token: "token", chatId: "user1", content: "hello" },
      {
        kind: "text",
        token: "token",
        chatId: "user1",
        content: "[Attachment send failed: missing.pdf]",
      },
    ]);
  });

  it("propagates transport errors from batch sends", async () => {
    const channel = allowTestRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["*"] }),
        new MessageBus(),
      ),
    );
    const http = new NetworkErrorHttp();
    channel.http = http;

    await expect(
      channel.sendBatchMessage("token", "user123", "sampleMarkdown", { text: "hello" }),
    ).rejects.toThrow("Connection refused");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].method).toBe("POST");
  });

  it("returns false on DingTalk API-level batch send errors", async () => {
    const channel = makeChannel(new FakeHttp([new FakeResponse(400, { errcode: 400 })]));
    expect(
      await channel.sendBatchMessage("token", "user123", "sampleMarkdown", { text: "hello" }),
    ).toBe(false);

    channel.http = new FakeHttp([new FakeResponse(200, { errcode: 100 })]);
    expect(
      await channel.sendBatchMessage("token", "user123", "sampleMarkdown", { text: "hello" }),
    ).toBe(false);

    channel.http = new FakeHttp([new FakeResponse(200, { errcode: 0 })]);
    expect(
      await channel.sendBatchMessage("token", "user123", "sampleMarkdown", { text: "hello" }),
    ).toBe(true);
  });

  it("records a permission hint on lastError when a send is forbidden, and clears it on success", async () => {
    const channel = makeChannel(
      new FakeHttp([
        new FakeResponse(200, { errcode: 88, errmsg: "no permission to send message" }),
      ]),
    );

    expect(
      await channel.sendBatchMessage("token", "user123", "sampleMarkdown", { text: "hi" }),
    ).toBe(false);
    expect(channel.lastError).toContain("钉钉机器人权限不足");

    channel.http = new FakeHttp([new FakeResponse(200, { errcode: 0 })]);
    expect(
      await channel.sendBatchMessage("token", "user123", "sampleMarkdown", { text: "hi" }),
    ).toBe(true);
    expect(channel.lastError).toBeNull();
  });

  it("does not set lastError for non-permission send failures", async () => {
    const channel = makeChannel(
      new FakeHttp([new FakeResponse(200, { errcode: 100, errmsg: "system busy" })]),
    );

    expect(
      await channel.sendBatchMessage("token", "user123", "sampleMarkdown", { text: "hi" }),
    ).toBe(false);
    expect(channel.lastError).toBeNull();
  });

  it("short-circuits media send on initial transport errors", async () => {
    const channel = allowTestRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["*"] }),
        new MessageBus(),
      ),
    );
    const http = new NetworkErrorHttp();
    channel.http = http;

    await expect(
      channel.sendMediaRef("token", "user123", "https://example.com/photo.jpg"),
    ).rejects.toThrow("Connection refused");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].method).toBe("POST");
  });

  it("short-circuits media send on download transport errors", async () => {
    const calls: any[] = [];
    const channel = allowTestRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["*"] }),
        new MessageBus(),
      ),
    );
    channel.http = {
      async post(url: string) {
        calls.push({ method: "POST", url });
        return new FakeResponse(200, { errcode: 100 });
      },
      async get(url: string) {
        calls.push({ method: "GET", url });
        throw new Error("Connection refused");
      },
    };

    await expect(
      channel.sendMediaRef("token", "user123", "https://example.com/photo.jpg"),
    ).rejects.toThrow("Connection refused");
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  });

  it("short-circuits media send on upload transport errors", async () => {
    const calls: any[] = [];
    const imageBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
    const channel = allowTestRemoteMedia(
      new DingtalkChannel(
        new DingtalkConfig({ clientId: "app", clientSecret: "secret", allowFrom: ["*"] }),
        new MessageBus(),
      ),
    );
    channel.http = {
      async post(url: string) {
        calls.push({ method: "POST", url });
        if (url.includes("media/upload")) throw new Error("Connection refused");
        return new FakeResponse(200, { errcode: 100 });
      },
      async get(url: string) {
        calls.push({ method: "GET", url });
        return new FakeResponse(
          200,
          {},
          { content: imageBytes, headers: { "content-type": "image/jpeg" }, url },
        );
      },
    };

    await expect(
      channel.sendMediaRef("token", "user123", "https://example.com/photo.jpg"),
    ).rejects.toThrow("Connection refused");
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "POST"]);
  });
});
