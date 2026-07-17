import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import {
  BASE_INFO,
  ITEM_IMAGE,
  ITEM_TEXT,
  ITEM_VOICE,
  MESSAGE_TYPE_BOT,
  TYPING_STATUS_CANCEL,
  TYPING_STATUS_TYPING,
  UPLOAD_MEDIA_VOICE,
  WECHAT_BRIDGE_CLIENT_VERSION,
  WEIXIN_CHANNEL_VERSION,
  WeixinChannel,
  WeixinConfig,
  decryptAesEcb,
  encryptAesEcb,
} from "../../../src/integrations/channels/weixin.js";

const oldConfig = process.env.MEMMY_CONFIG;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-weixin-"));
  roots.push(root);
  process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.env.MEMMY_CONFIG = oldConfig;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeChannel(
  allowFrom: string[] = ["*"],
  config: Partial<WeixinConfig> = {},
): { channel: WeixinChannel; bus: MessageBus; root: string } {
  const root = tmpRoot();
  const bus = new MessageBus();
  const channel = new WeixinChannel(
    new WeixinConfig({ enabled: true, allowFrom, stateDir: path.join(root, "state"), ...config }),
    bus,
  );
  return { channel, bus, root };
}

class FakeResponse {
  content: Buffer;
  data: any;
  headers: Record<string, string>;
  status: number;
  constructor(init: { content?: Buffer | string; data?: any; headers?: Record<string, string>; status?: number } = {}) {
    this.content = Buffer.from(init.content ?? "");
    this.data = init.data;
    this.headers = init.headers ?? {};
    this.status = init.status ?? 200;
  }
  raiseForStatus(): void {
    if (this.status >= 400) {
      const err: any = new Error(`HTTP ${this.status}`);
      err.response = { status: this.status };
      throw err;
    }
  }
  json(): any {
    return this.data ?? {};
  }
}

function freshContext(channel: WeixinChannel, chatId = "wx-user", token = "ctx-1"): void {
  channel.contextTokens[chatId] = token;
  channel.contextTokenTimestamps[chatId] = Date.now() / 1000;
}

describe("Weixin protocol helpers", () => {
  it("builds bridge headers with version and route tag", () => {
    const bus = new MessageBus();
    const channel = new WeixinChannel(new WeixinConfig({ allowFrom: ["*"], routeTag: 123 }), bus);
    channel.authToken = "token";

    const headers = channel.makeHeaders();

    expect(headers.Authorization).toBe("Bearer token");
    expect(headers.SKRouteTag).toBe("123");
    expect(headers["iLink-App-Id"]).toBe("bot");
    expect(headers["iLink-App-ClientVersion"]).toBe(String(WECHAT_BRIDGE_CLIENT_VERSION));
    expect(WEIXIN_CHANNEL_VERSION).toBe("2.1.1");
  });

  it("uses configured Memmy WeChat app id instead of the protocol fallback app id", () => {
    const bus = new MessageBus();
    const channel = new WeixinChannel(new WeixinConfig({ allowFrom: ["*"], appId: "cli_memmy" }), bus);

    const headers = channel.makeHeaders();

    expect(headers["iLink-App-Id"]).toBe("cli_memmy");
  });

  it("matches the reference plugin channel version", () => {
    expect(WEIXIN_CHANNEL_VERSION).toBe("2.1.1");
  });

  it("saves and restores account state", () => {
    const { channel, root } = makeChannel();
    channel.authToken = "token";
    channel.getUpdatesBuffer = "cursor";
    channel.contextTokens = { "wx-user": "ctx-1" };
    channel.typingTickets = { "wx-user": { ticket: "ticket", nextFetchAt: 999 } };

    channel.saveState();

    const restored = new WeixinChannel(new WeixinConfig({ allowFrom: ["*"], stateDir: path.join(root, "state") }), new MessageBus());
    expect(restored.loadState()).toBe(true);
    expect(restored.contextTokens).toEqual({ "wx-user": "ctx-1" });
    expect(restored.typingTickets["wx-user"].ticket).toBe("ticket");
  });

  it("round-trips AES-ECB media encryption and valid PKCS7 padding", () => {
    const keyB64 = Buffer.from("0123456789abcdef").toString("base64");
    const ciphertext = encryptAesEcb(Buffer.from("hello-weixin-padding"), keyB64);

    expect(decryptAesEcb(ciphertext, keyB64).toString()).toBe("hello-weixin-padding");
  });

  it("starts and polls a UI QR login session", async () => {
    const { channel, root } = makeChannel(["*"], { appId: "cli_memmy" });
    channel.client = {};
    vi.spyOn(channel, "fetchQrCode").mockResolvedValue(["qr-1", "data:image/png;base64,qr"]);
    vi.spyOn(channel, "apiGetWithBase").mockResolvedValue({
      status: "confirmed",
      bot_token: "token-1",
      baseurl: "https://redirect.weixin.example"
    });

    const started = await channel.startLoginSession(true);
    const polled = await channel.pollLoginSession(started.pollToken);

    expect(started).toMatchObject({
      status: "pendingQr",
      qrCodeDataUrl: "data:image/png;base64,qr"
    });
    expect(polled).toEqual({ status: "connected" });
    expect(channel.authToken).toBe("token-1");
    const saved = JSON.parse(fs.readFileSync(path.join(root, "state", "account.json"), "utf8"));
    expect(saved.token).toBe("token-1");
    expect(saved.baseUrl).toBe("https://redirect.weixin.example");
  });

  it("rejects UI QR login when Memmy WeChat app id is not configured", async () => {
    const { channel } = makeChannel();
    const fetchQrCode = vi.spyOn(channel, "fetchQrCode").mockResolvedValue(["qr-1", "data:image/png;base64,qr"]);

    await expect(channel.startLoginSession(true)).rejects.toThrow("微信渠道还没有配置 Memmy 应用");
    expect(fetchQrCode).not.toHaveBeenCalled();
  });

  it("rejects QR generation without Memmy WeChat app id before calling the protocol API", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    const apiGet = vi.spyOn(channel, "apiGet").mockResolvedValue({
      qrcode: "qr-raw",
      qrcode_img_content: "iVBORw0KGgo="
    });

    await expect(channel.fetchQrCode()).rejects.toThrow("微信渠道还没有配置 Memmy 应用");
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("wraps raw QR image content as a browser-renderable data URL", async () => {
    const { channel } = makeChannel(["*"], { appId: "cli_memmy" });
    channel.client = {};
    vi.spyOn(channel, "apiGet").mockResolvedValue({
      qrcode: "qr-raw",
      qrcode_img_content: "iVBORw0KGgo="
    });

    await expect(channel.fetchQrCode()).resolves.toEqual([
      "qr-raw",
      "data:image/png;base64,iVBORw0KGgo="
    ]);
  });

  it("encodes QR login URLs as browser-renderable QR data URLs", async () => {
    const { channel } = makeChannel(["*"], { appId: "cli_memmy" });
    channel.client = {};
    vi.spyOn(channel, "apiGet").mockResolvedValue({
      qrcode: "qr-url",
      qrcode_img_content: "https://liteapp.weixin.qq.com/q/demo?qrcode=qr-url&bot_type=3"
    });

    const [, qrCodeDataUrl] = await channel.fetchQrCode();

    expect(qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
  });
});

describe("Weixin inbound processing", () => {
  it("deduplicates inbound ids and caches context tokens", async () => {
    const { channel, bus } = makeChannel();
    const msg = {
      message_type: 1,
      message_id: "m1",
      from_user_id: "wx-user",
      context_token: "ctx-1",
      item_list: [{ type: ITEM_TEXT, text_item: { text: "hello" } }],
    };

    await channel.processMessage(msg);
    await channel.processMessage(msg);
    const inbound = await bus.consumeInbound();

    expect(inbound.senderId).toBe("wx-user");
    expect(inbound.chatId).toBe("wx-user");
    expect(inbound.content).toBe("hello");
    expect(channel.contextTokens["wx-user"]).toBe("ctx-1");
    expect(bus.inbound.size).toBe(0);
  });

  it("uses cached context tokens for outbound replies", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.processMessage({
      message_type: 1,
      message_id: "m-cache-send",
      from_user_id: "wx-user",
      context_token: "ctx-cache-send",
      item_list: [{ type: ITEM_TEXT, text_item: { text: "ping" } }],
    });
    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "pong" }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "pong", "ctx-cache-send");
  });

  it("persists context tokens from inbound messages to the state file", async () => {
    const { channel, root } = makeChannel();

    await channel.processMessage({
      message_type: 1,
      message_id: "persist-token",
      from_user_id: "wx-user",
      context_token: "ctx-persisted",
      item_list: [{ type: ITEM_TEXT, text_item: { text: "ping" } }],
    });

    const saved = JSON.parse(fs.readFileSync(path.join(root, "state", "account.json"), "utf8"));
    expect(saved.contextTokens).toEqual({ "wx-user": "ctx-persisted" });
  });

  it("rejects unauthorized senders before media and typing side effects", async () => {
    const { channel, bus } = makeChannel(["allowed-user"]);
    const send = vi.spyOn(channel, "send").mockResolvedValue(undefined);
    (channel as any).downloadMediaItem = vi.fn();
    (channel as any).startTyping = vi.fn();

    await channel.processMessage({
      message_type: 1,
      message_id: "blocked",
      from_user_id: "blocked-user",
      context_token: "ctx-blocked",
      item_list: [{ type: ITEM_IMAGE, image_item: { media: { encrypt_query_param: "enc" } } }],
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0]?.[0] as OutboundMessage).content).toContain("pairing code");
    expect(channel.contextTokens).toEqual({ "blocked-user": "ctx-blocked" });
    expect(channel.downloadMediaItem).not.toHaveBeenCalled();
    expect(channel.startTyping).not.toHaveBeenCalled();
    expect(bus.inbound.size).toBe(0);
  });

  it("responds with a pairing code instead of silently dropping unauthorized direct messages", async () => {
    const { channel, bus } = makeChannel([]);
    const send = vi.spyOn(channel, "send").mockResolvedValue(undefined);
    (channel as any).downloadMediaItem = vi.fn();
    (channel as any).startTyping = vi.fn();

    await channel.processMessage({
      message_type: 1,
      message_id: "pairing-needed",
      from_user_id: "new-user",
      context_token: "ctx-pairing",
      item_list: [{ type: ITEM_TEXT, text_item: { text: "hello memmy" } }],
    });

    expect(send).toHaveBeenCalledTimes(1);
    const outbound = send.mock.calls[0]?.[0] as OutboundMessage;
    expect(outbound.channel).toBe("weixin");
    expect(outbound.chatId).toBe("new-user");
    expect(outbound.content).toContain("pairing code");
    expect(channel.contextTokens["new-user"]).toBe("ctx-pairing");
    expect(channel.downloadMediaItem).not.toHaveBeenCalled();
    expect(channel.startTyping).not.toHaveBeenCalled();
    expect(bus.inbound.size).toBe(0);
  });

  it("extracts top-level media and never falls back to referenced media when top-level exists", async () => {
    const { channel, bus } = makeChannel();
    (channel as any).downloadMediaItem = vi.fn().mockResolvedValueOnce("/tmp/top.jpg").mockResolvedValueOnce("/tmp/ref.jpg");

    await channel.processMessage({
      message_type: 1,
      message_id: "m-media",
      from_user_id: "wx-user",
      context_token: "ctx-media",
      item_list: [
        { type: ITEM_IMAGE, image_item: { media: { encrypt_query_param: "top" } } },
        {
          type: ITEM_TEXT,
          text_item: { text: "quoted image" },
          ref_msg: { message_item: { type: ITEM_IMAGE, image_item: { media: { encrypt_query_param: "ref" } } } },
        },
      ],
    });

    const inbound = await bus.consumeInbound();
    expect(channel.downloadMediaItem).toHaveBeenCalledTimes(1);
    expect(channel.downloadMediaItem).toHaveBeenCalledWith({ media: { encrypt_query_param: "top" } }, "image");
    expect(inbound.media).toEqual(["/tmp/top.jpg"]);
    expect(inbound.content).toContain("/tmp/top.jpg");
    expect(inbound.content).not.toContain("/tmp/ref.jpg");
  });

  it("extracts media and preserves downloaded paths", async () => {
    const { channel, bus } = makeChannel();
    (channel as any).downloadMediaItem = vi.fn().mockResolvedValue("/tmp/test.jpg");

    await channel.processMessage({
      message_type: 1,
      message_id: "m-preserve-media",
      from_user_id: "wx-user",
      context_token: "ctx-preserve-media",
      item_list: [{ type: ITEM_IMAGE, image_item: { media: { encrypt_query_param: "enc" } } }],
    });

    const inbound = await bus.consumeInbound();
    expect(inbound.content).toContain("[image]");
    expect(inbound.content).toContain("/tmp/test.jpg");
    expect(inbound.media).toEqual(["/tmp/test.jpg"]);
  });

  it("uses referenced media only when no top-level downloadable media exists", async () => {
    const { channel, bus } = makeChannel();
    (channel as any).downloadMediaItem = vi.fn().mockResolvedValue("/tmp/ref.jpg");

    await channel.processMessage({
      message_type: 1,
      message_id: "m-ref",
      from_user_id: "wx-user",
      context_token: "ctx-ref",
      item_list: [
        {
          type: ITEM_TEXT,
          text_item: { text: "reply to image" },
          ref_msg: { message_item: { type: ITEM_IMAGE, image_item: { media: { encrypt_query_param: "ref" } } } },
        },
      ],
    });

    const inbound = await bus.consumeInbound();
    expect(channel.downloadMediaItem).toHaveBeenCalledWith({ media: { encrypt_query_param: "ref" } }, "image");
    expect(inbound.media).toEqual(["/tmp/ref.jpg"]);
    expect(inbound.content).toContain("reply to image");
  });

  it("does not fallback to referenced media when top-level media download fails", async () => {
    const { channel, bus } = makeChannel();
    (channel as any).downloadMediaItem = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("/tmp/ref.jpg");

    await channel.processMessage({
      message_type: 1,
      message_id: "m-top-failed",
      from_user_id: "wx-user",
      context_token: "ctx-top-failed",
      item_list: [
        { type: ITEM_IMAGE, image_item: { media: { encrypt_query_param: "top" } } },
        {
          type: ITEM_TEXT,
          text_item: { text: "has failed top-level media" },
          ref_msg: { message_item: { type: ITEM_IMAGE, image_item: { media: { encrypt_query_param: "ref" } } } },
        },
      ],
    });

    const inbound = await bus.consumeInbound();
    expect(channel.downloadMediaItem).toHaveBeenCalledTimes(1);
    expect(inbound.media).toEqual([]);
    expect(inbound.content).toContain("[image]");
    expect(inbound.content).not.toContain("/tmp/ref.jpg");
  });

  it("skips bot messages and starts typing for active inbound user messages", async () => {
    const { channel, bus } = makeChannel();
    await channel.processMessage({
      message_type: MESSAGE_TYPE_BOT,
      message_id: "bot",
      from_user_id: "wx-user",
      item_list: [{ type: ITEM_TEXT, text_item: { text: "from bot" } }],
    });
    expect(bus.inbound.size).toBe(0);

    channel.running = true;
    channel.client = {};
    channel.authToken = "token";
    (channel as any).startTyping = vi.fn();
    await channel.processMessage({
      message_type: 1,
      message_id: "user",
      from_user_id: "wx-user",
      context_token: "ctx-typing",
      item_list: [{ type: ITEM_TEXT, text_item: { text: "hello" } }],
    });

    expect(channel.startTyping).toHaveBeenCalledWith("wx-user", "ctx-typing");
  });
});

describe("Weixin outbound and typing", () => {
  it("requires a fresh context token and refuses paused sessions", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";

    await expect(channel.send(new OutboundMessage({ channel: "weixin", chatId: "missing", content: "pong" }))).rejects.toThrow(
      /context_token missing/,
    );

    freshContext(channel);
    channel.pauseSession(60);
    await expect(channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "pong" }))).rejects.toThrow(
      /session paused/,
    );
  });

  it("fetches typing ticket once, sends text, and cancels final typing status", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel, "wx-user", "ctx-typing");
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);
    (channel as any).apiPost = vi
      .fn()
      .mockResolvedValueOnce({ ret: 0, typing_ticket: "ticket-1" })
      .mockResolvedValue({ ret: 0 });

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "pong" }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "pong", "ctx-typing");
    expect(channel.apiPost).toHaveBeenNthCalledWith(1, "ilink/bot/getconfig", {
      ilink_user_id: "wx-user",
      context_token: "ctx-typing",
      base_info: BASE_INFO,
    });
    const typingStatuses = (channel.apiPost as any).mock.calls
      .filter((call: any[]) => call[0] === "ilink/bot/sendtyping")
      .map((call: any[]) => call[1].status);
    expect(typingStatuses).toEqual([TYPING_STATUS_TYPING, TYPING_STATUS_CANCEL]);
  });

  it("clears typing indicator for final messages", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel, "wx-user", "ctx-final");
    channel.typingTickets["wx-user"] = { ticket: "ticket-final", nextFetchAt: 9_999_999_999 };
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);
    (channel as any).apiPost = vi.fn().mockResolvedValue({ ret: 0 });

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "pong" }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "pong", "ctx-final");
    const cancelCalls = (channel.apiPost as any).mock.calls.filter(
      (call: any[]) => call[0] === "ilink/bot/sendtyping" && call[1].status === TYPING_STATUS_CANCEL,
    );
    expect(cancelCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps typing indicator active for progress messages", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel, "wx-user", "ctx-progress");
    channel.typingTickets["wx-user"] = { ticket: "ticket-progress", nextFetchAt: 9_999_999_999 };
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);
    (channel as any).apiPost = vi.fn().mockResolvedValue({ ret: 0 });

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "thinking", metadata: { agentProgress: true } }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "thinking", "ctx-progress");
    const cancelCalls = (channel.apiPost as any).mock.calls.filter(
      (call: any[]) => call[0] === "ilink/bot/sendtyping" && call[1].status === TYPING_STATUS_CANCEL,
    );
    expect(cancelCalls).toHaveLength(0);
  });

  it("caches typing tickets per user", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    (channel as any).apiPost = vi.fn().mockResolvedValue({ ret: 0, typing_ticket: "ticket-1" });

    await expect(channel.getTypingTicket("wx-user", "ctx-1")).resolves.toBe("ticket-1");
    await expect(channel.getTypingTicket("wx-user", "ctx-1")).resolves.toBe("ticket-1");

    expect(channel.apiPost).toHaveBeenCalledTimes(1);
  });

  it("uses cached typing tickets and backoff when refreshing ticket config fails", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    channel.typingTickets["wx-user"] = { ticket: "cached-ticket", nextFetchAt: 1, retryDelaySeconds: 2 };
    (channel as any).apiPost = vi.fn().mockResolvedValue({ ret: 1 });

    await expect(channel.getTypingTicket("wx-user", "ctx-1")).resolves.toBe("cached-ticket");

    expect(channel.typingTickets["wx-user"].retryDelaySeconds).toBe(4);
    expect(channel.typingTickets["wx-user"].nextFetchAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("still sends text when no typing ticket is available", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    (channel as any).getTypingTicket = vi.fn().mockResolvedValue("");
    (channel as any).sendTyping = vi.fn();
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "pong" }));

    expect(channel.sendTyping).not.toHaveBeenCalled();
    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "pong", "ctx-1");
  });

  it("keeps typing alive until send finishes", async () => {
    vi.useFakeTimers();
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel, "wx-user", "ctx-keepalive");
    const statuses: number[] = [];
    (channel as any).apiPost = vi.fn(async (endpoint: string, body: any = {}) => {
      if (endpoint === "ilink/bot/getconfig") return { ret: 0, typing_ticket: "ticket-keepalive" };
      if (endpoint === "ilink/bot/sendtyping") statuses.push(Number(body.status));
      return { ret: 0 };
    });
    (channel as any).sendText = vi.fn(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "pong" }));

    expect(statuses.filter((status) => status === TYPING_STATUS_TYPING).length).toBeGreaterThanOrEqual(2);
    expect(statuses.at(-1)).toBe(TYPING_STATUS_CANCEL);
  });

  it("keeps progress typing active and buffers tool hints until visible output", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    channel.sendToolHints = true;
    freshContext(channel);
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);
    (channel as any).apiPost = vi.fn().mockResolvedValue({ ret: 1 });

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "search", metadata: { agentProgress: true, toolHint: true } }));
    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "hidden", metadata: { agentProgress: true, reasoningDelta: true } }));
    expect(channel.sendText).not.toHaveBeenCalled();
    expect(channel.pendingToolHints["wx-user"]).toEqual(["search"]);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "thinking", metadata: { agentProgress: true } }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "search", "ctx-1");
    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "thinking", "ctx-1");
    const cancelCalls = (channel.apiPost as any).mock.calls.filter((call: any[]) => call[0] === "ilink/bot/sendtyping" && call[1].status === 2);
    expect(cancelCalls).toHaveLength(0);
  });

  it("buffers a single tool hint without sending immediately", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    channel.sendToolHints = true;
    freshContext(channel);
    (channel as any).sendText = vi.fn();

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "Using tool", metadata: { agentProgress: true, toolHint: true } }));

    expect(channel.sendText).not.toHaveBeenCalled();
    expect(channel.pendingToolHints["wx-user"]).toEqual(["Using tool"]);
  });

  it("flushes multiple buffered tool hints on final answer", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    channel.sendToolHints = true;
    freshContext(channel);
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "tool1", metadata: { agentProgress: true, toolHint: true } }));
    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "tool2", metadata: { agentProgress: true, toolHint: true } }));
    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "Done" }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "tool1\n\ntool2", "ctx-1");
    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "Done", "ctx-1");
    expect(channel.pendingToolHints).toEqual({});
  });

  it("does not flush tool hints for hidden reasoning deltas", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    channel.sendToolHints = true;
    freshContext(channel);
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "search", metadata: { agentProgress: true, toolHint: true } }));
    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "hidden", metadata: { agentProgress: true, reasoningDelta: true } }));

    expect(channel.sendText).not.toHaveBeenCalled();
    expect(channel.pendingToolHints["wx-user"]).toEqual(["search"]);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "Done" }));
    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "search", "ctx-1");
    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "Done", "ctx-1");
  });

  it("does not flush tool hints for empty progress messages", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    channel.sendToolHints = true;
    freshContext(channel);
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "search", metadata: { agentProgress: true, toolHint: true } }));
    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "", metadata: { agentProgress: true, toolEvents: [{ phase: "end" }] } }));

    expect(channel.sendText).not.toHaveBeenCalled();
    expect(channel.pendingToolHints["wx-user"]).toEqual(["search"]);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "Done" }));
    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "search", "ctx-1");
  });

  it("refreshes context token while flushing buffered tool hints", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    channel.sendToolHints = true;
    channel.contextTokens["wx-user"] = "ctx-old";
    channel.contextTokenTimestamps["wx-user"] = Date.now() / 1000;
    (channel as any).refreshContextTokenIfStale = vi.fn().mockResolvedValue("ctx-refreshed");
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "hint", metadata: { agentProgress: true, toolHint: true } }));
    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "Done" }));

    expect(channel.refreshContextTokenIfStale).toHaveBeenCalledWith("wx-user", "ctx-old");
    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "hint", "ctx-refreshed");
  });

  it("does not block final answer when flushing buffered tool hints fails", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    channel.sendToolHints = true;
    freshContext(channel);
    (channel as any).sendText = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "hint", metadata: { agentProgress: true, toolHint: true } }));
    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "Done" }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "hint", "ctx-1");
    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "Done", "ctx-1");
  });

  it("refreshes stale context token before sending", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    channel.contextTokens["wx-user"] = "ctx-old";
    channel.contextTokenTimestamps["wx-user"] = 1;
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);
    (channel as any).apiPost = vi
      .fn()
      .mockResolvedValueOnce({ ret: 0, context_token: "ctx-new" })
      .mockResolvedValueOnce({ ret: 1 });

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "pong" }));

    expect(channel.contextTokens["wx-user"]).toBe("ctx-new");
    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "pong", "ctx-new");
  });

  it("drops tool hints when sendToolHints is false", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    channel.sendToolHints = false;
    freshContext(channel);
    (channel as any).sendText = vi.fn();

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "search", metadata: { agentProgress: true, toolHint: true } }));

    expect(channel.pendingToolHints).toEqual({});
    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("flushes buffered tool hints on stream end", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    channel.pendingToolHints["wx-user"] = ["hint one", "hint two"];
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.sendDelta("wx-user", "", { streamEnd: true });

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "hint one\n\nhint two", "ctx-1");
    expect(channel.pendingToolHints).toEqual({});
  });

  it("clears pending tool-hint buffers on stop", async () => {
    const { channel } = makeChannel();
    channel.client = { close: vi.fn() };
    channel.pendingToolHints["wx-user"] = ["hint"];

    await channel.stop();

    expect(channel.pendingToolHints).toEqual({});
  });
});

describe("Weixin polling and QR login", () => {
  it("pauses session on expired polling response and advances cursor on success", async () => {
    const { channel, bus } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    (channel as any).apiPost = vi.fn().mockResolvedValueOnce({ ret: 0, errcode: -14, errmsg: "expired" });

    await channel.pollOnce();
    expect(channel.sessionPauseRemainingSeconds()).toBeGreaterThan(0);

    channel.sessionPauseUntil = 0;
    (channel as any).apiPost = vi.fn().mockResolvedValueOnce({
      ret: 0,
      errcode: 0,
      longpolling_timeout_ms: 12000,
      get_updates_buf: "new-cursor",
      msgs: [{ message_type: 1, message_id: "m1", from_user_id: "wx-user", context_token: "ctx", item_list: [{ type: ITEM_TEXT, text_item: { text: "ping" } }] }],
    });
    await channel.pollOnce();
    expect(channel.getUpdatesBuffer).toBe("new-cursor");
    expect(channel.nextPollTimeoutSeconds).toBe(12);
    expect((await bus.consumeInbound()).content).toBe("ping");
  });

  it("handles QR expiration, redirect, and confirmation", async () => {
    const { channel } = makeChannel();
    channel.running = true;
    channel.printQrCode = vi.fn();
    (channel as any).fetchQrCode = vi.fn().mockResolvedValueOnce(["qr-1", "url-1"]).mockResolvedValueOnce(["qr-2", "url-2"]);
    (channel as any).apiGetWithBase = vi
      .fn()
      .mockResolvedValueOnce({ status: "scaned_but_redirect", redirect_host: "idc.redirect.test" })
      .mockResolvedValueOnce({ status: "expired" })
      .mockResolvedValueOnce({ status: "confirmed", bot_token: "token-2", baseurl: "https://example.test" });

    await expect(channel.qrLogin()).resolves.toBe(true);

    expect(channel.authToken).toBe("token-2");
    expect(channel.config.baseUrl).toBe("https://example.test");
    expect(channel.apiGetWithBase).toHaveBeenNthCalledWith(1, {
      baseUrl: "https://ilinkai.weixin.qq.com",
      endpoint: "ilink/bot/get_qrcode_status",
      params: { qrcode: "qr-1" },
      auth: false,
    });
    expect(channel.apiGetWithBase).toHaveBeenNthCalledWith(2, {
      baseUrl: "https://idc.redirect.test",
      endpoint: "ilink/bot/get_qrcode_status",
      params: { qrcode: "qr-1" },
      auth: false,
    });
    expect(channel.apiGetWithBase).toHaveBeenNthCalledWith(3, {
      baseUrl: "https://ilinkai.weixin.qq.com",
      endpoint: "ilink/bot/get_qrcode_status",
      params: { qrcode: "qr-2" },
      auth: false,
    });
  });

  it("refreshes expired QR code and then succeeds", async () => {
    const { channel } = makeChannel();
    channel.running = true;
    channel.printQrCode = vi.fn();
    (channel as any).fetchQrCode = vi.fn().mockResolvedValueOnce(["qr-1", "url-1"]).mockResolvedValueOnce(["qr-2", "url-2"]);
    (channel as any).apiGetWithBase = vi
      .fn()
      .mockResolvedValueOnce({ status: "expired" })
      .mockResolvedValueOnce({ status: "confirmed", bot_token: "token-2", baseurl: "https://example.test" });

    await expect(channel.qrLogin()).resolves.toBe(true);

    expect(channel.authToken).toBe("token-2");
    expect(channel.config.baseUrl).toBe("https://example.test");
    expect(channel.fetchQrCode).toHaveBeenCalledTimes(2);
  });

  it("returns false after too many expired QR codes", async () => {
    const { channel } = makeChannel();
    channel.running = true;
    channel.printQrCode = vi.fn();
    (channel as any).fetchQrCode = vi.fn().mockResolvedValue(["qr", "url"]);
    (channel as any).apiGetWithBase = vi.fn().mockResolvedValue({ status: "expired" });

    await expect(channel.qrLogin()).resolves.toBe(false);

    expect(channel.fetchQrCode).toHaveBeenCalledTimes(4);
  });

  it("keeps the current polling base URL when redirect status omits a host", async () => {
    const { channel } = makeChannel();
    channel.running = true;
    channel.printQrCode = vi.fn();
    (channel as any).fetchQrCode = vi.fn().mockResolvedValue(["qr", "url"]);
    (channel as any).apiGetWithBase = vi
      .fn()
      .mockResolvedValueOnce({ status: "scaned_but_redirect" })
      .mockResolvedValueOnce({ status: "confirmed", bot_token: "token" });

    await expect(channel.qrLogin()).resolves.toBe(true);

    expect(channel.apiGetWithBase).toHaveBeenNthCalledWith(2, {
      baseUrl: "https://ilinkai.weixin.qq.com",
      endpoint: "ilink/bot/get_qrcode_status",
      params: { qrcode: "qr" },
      auth: false,
    });
  });

  it("switches polling base URL on QR redirect status", async () => {
    const { channel } = makeChannel();
    channel.running = true;
    channel.printQrCode = vi.fn();
    (channel as any).fetchQrCode = vi.fn().mockResolvedValue(["qr", "url"]);
    (channel as any).apiGetWithBase = vi
      .fn()
      .mockResolvedValueOnce({ status: "scaned_but_redirect", redirect_host: "idc.redirect.test" })
      .mockResolvedValueOnce({ status: "confirmed", bot_token: "token-redirect" });

    await expect(channel.qrLogin()).resolves.toBe(true);

    expect(channel.apiGetWithBase).toHaveBeenNthCalledWith(2, {
      baseUrl: "https://idc.redirect.test",
      endpoint: "ilink/bot/get_qrcode_status",
      params: { qrcode: "qr" },
      auth: false,
    });
  });

  it("resets redirected polling base URL after QR refresh", async () => {
    const { channel } = makeChannel();
    channel.running = true;
    channel.printQrCode = vi.fn();
    (channel as any).fetchQrCode = vi.fn().mockResolvedValueOnce(["qr-1", "url-1"]).mockResolvedValueOnce(["qr-2", "url-2"]);
    (channel as any).apiGetWithBase = vi
      .fn()
      .mockResolvedValueOnce({ status: "scaned_but_redirect", redirect_host: "idc.redirect.test" })
      .mockResolvedValueOnce({ status: "expired" })
      .mockResolvedValueOnce({ status: "confirmed", bot_token: "token-reset" });

    await expect(channel.qrLogin()).resolves.toBe(true);

    expect(channel.apiGetWithBase).toHaveBeenNthCalledWith(2, {
      baseUrl: "https://idc.redirect.test",
      endpoint: "ilink/bot/get_qrcode_status",
      params: { qrcode: "qr-1" },
      auth: false,
    });
    expect(channel.apiGetWithBase).toHaveBeenNthCalledWith(3, {
      baseUrl: "https://ilinkai.weixin.qq.com",
      endpoint: "ilink/bot/get_qrcode_status",
      params: { qrcode: "qr-2" },
      auth: false,
    });
  });

  it("treats temporary QR connect errors as wait-and-recover", async () => {
    const { channel } = makeChannel();
    channel.running = true;
    channel.printQrCode = vi.fn();
    (channel as any).fetchQrCode = vi.fn().mockResolvedValue(["qr", "url"]);
    const err: any = new Error("temporary network");
    err.code = "ECONNRESET";
    (channel as any).apiGetWithBase = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ status: "confirmed", bot_token: "token-net-ok" });

    await expect(channel.qrLogin()).resolves.toBe(true);
    expect(channel.authToken).toBe("token-net-ok");
  });

  it("treats 5xx QR gateway errors as wait-and-recover", async () => {
    const { channel } = makeChannel();
    channel.running = true;
    channel.printQrCode = vi.fn();
    (channel as any).fetchQrCode = vi.fn().mockResolvedValue(["qr", "url"]);
    const err: any = new Error("gateway timeout");
    err.response = { status: 524 };
    (channel as any).apiGetWithBase = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce({ status: "confirmed", bot_token: "token-5xx-ok" });

    await expect(channel.qrLogin()).resolves.toBe(true);
    expect(channel.authToken).toBe("token-5xx-ok");
  });

  it("continues processing messages after one poll message fails", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    const seen: string[] = [];
    (channel as any).processMessage = vi.fn(async (msg: any) => {
      seen.push(msg.message_id);
      if (msg.message_id === "msg-1") throw new Error("processing failed");
    });
    (channel as any).apiPost = vi.fn().mockResolvedValue({
      ret: 0,
      errcode: 0,
      get_updates_buf: "new-buf",
      msgs: [
        { message_id: "msg-1", message_type: 1 },
        { message_id: "msg-2", message_type: 1 },
      ],
    });

    await channel.pollOnce();

    expect(seen).toEqual(["msg-1", "msg-2"]);
    expect(channel.getUpdatesBuffer).toBe("new-buf");
  });

  it("continues the poll loop after non-timeout poll failures", async () => {
    vi.useFakeTimers();
    const { channel } = makeChannel();
    channel.client = {};
    channel.config.token = "token";
    let calls = 0;
    (channel as any).pollOnce = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("poll exploded");
      channel.running = false;
    });

    const started = channel.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await started;

    expect(calls).toBe(2);
  });
});

describe("Weixin media transfer", () => {
  it("downloads media via full_url and falls back to encrypted CDN param on retryable failure", async () => {
    const { channel, root } = makeChannel();
    const fullUrl = "https://cdn.example.test/full";
    const get = vi
      .fn()
      .mockResolvedValueOnce(new FakeResponse({ status: 500 }))
      .mockResolvedValueOnce(new FakeResponse({ content: "fallback-bytes" }));
    channel.client = { get };

    const saved = await channel.downloadMediaItem(
      { media: { full_url: fullUrl, encrypt_query_param: "enc-fallback" } },
      "image",
    );

    expect(saved).toBe(path.join(root, "media", "weixin", path.basename(saved!)));
    expect(fs.readFileSync(saved!, "utf8")).toBe("fallback-bytes");
    expect(get).toHaveBeenNthCalledWith(1, fullUrl);
    expect(get.mock.calls[1][0]).toContain("/download?encrypted_query_param=enc-fallback");
  });

  it("downloads media via full_url when it succeeds", async () => {
    const { channel } = makeChannel();
    const get = vi.fn().mockResolvedValue(new FakeResponse({ content: "full-url-bytes" }));
    channel.client = { get };

    const saved = await channel.downloadMediaItem({ media: { full_url: "https://cdn.example.test/full" } }, "image");

    expect(fs.readFileSync(saved!, "utf8")).toBe("full-url-bytes");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("https://cdn.example.test/full");
  });

  it("falls back to encrypt_query_param download URL when full_url is absent", async () => {
    const { channel } = makeChannel();
    const get = vi.fn().mockResolvedValue(new FakeResponse({ content: "fallback-only" }));
    channel.client = { get };

    const saved = await channel.downloadMediaItem({ media: { encrypt_query_param: "enc-only" } }, "image");

    expect(fs.readFileSync(saved!, "utf8")).toBe("fallback-only");
    expect(get.mock.calls[0][0]).toContain("/download?encrypted_query_param=enc-only");
  });

  it("does not retry full_url failures when no fallback locator exists", async () => {
    const { channel } = makeChannel();
    const get = vi.fn().mockResolvedValue(new FakeResponse({ status: 500 }));
    channel.client = { get };

    await expect(channel.downloadMediaItem({ media: { full_url: "https://cdn.example.test/full" } }, "image")).resolves.toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("requires AES key for non-image media downloads", async () => {
    const { channel } = makeChannel();
    const get = vi.fn();
    channel.client = { get };

    await expect(channel.downloadMediaItem({ media: { full_url: "https://cdn.example.test/voice" } }, "voice")).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("uploads outbound media with upload_full_url and sends voice item for audio files", async () => {
    const { channel, root } = makeChannel();
    const voicePath = path.join(root, "voice.mp3");
    fs.writeFileSync(voicePath, "voice-bytes");
    const post = vi.fn().mockResolvedValue(new FakeResponse({ headers: { "x-encrypted-param": "download-param" } }));
    channel.client = { post };
    (channel as any).apiPost = vi
      .fn()
      .mockResolvedValueOnce({ upload_full_url: "https://upload-full.example.test/path", upload_param: "unused" })
      .mockResolvedValueOnce({ ret: 0 });

    await channel.sendMediaFile("wx-user", voicePath, "ctx-voice");

    expect(post).toHaveBeenCalledWith("https://upload-full.example.test/path", expect.objectContaining({ headers: { "Content-Type": "application/octet-stream" } }));
    const uploadBody = (channel.apiPost as any).mock.calls[0][1];
    expect(uploadBody.media_type).toBe(UPLOAD_MEDIA_VOICE);
    const sendBody = (channel.apiPost as any).mock.calls[1][1];
    const item = sendBody.msg.item_list[0];
    expect(item.type).toBe(ITEM_VOICE);
    expect(item.voice_item.media.encrypt_query_param).toBe("download-param");
    expect(item.file_item).toBeUndefined();
  });

  it("falls back to upload_param URL when upload_full_url is absent", async () => {
    const { channel, root } = makeChannel();
    const photoPath = path.join(root, "photo.jpg");
    fs.writeFileSync(photoPath, "photo-bytes");
    const post = vi.fn().mockResolvedValue(new FakeResponse({ headers: { "x-encrypted-param": "download-param" } }));
    channel.client = { post };
    (channel as any).apiPost = vi.fn().mockResolvedValueOnce({ upload_param: "enc-upload" }).mockResolvedValueOnce({ ret: 0 });

    await channel.sendMediaFile("wx-user", photoPath, "ctx-photo");

    expect(post.mock.calls[0][0]).toContain(`${channel.config.cdnBaseUrl}/upload?encrypted_query_param=enc-upload`);
    expect(post.mock.calls[0][0]).toContain("&filekey=");
  });

  it("falls back to text when outbound media is missing", async () => {
    const { channel, root } = makeChannel();
    const missing = path.join(root, "missing.jpg");
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "", media: [missing] }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "[Failed to send: missing.jpg]", "ctx-1");
  });

  it("propagates network-like media send errors without text fallback", async () => {
    const { channel, root } = makeChannel();
    const file = path.join(root, "photo.jpg");
    fs.writeFileSync(file, "photo");
    const err: any = new Error("network");
    err.code = "ECONNRESET";
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    (channel as any).sendMediaFile = vi.fn().mockRejectedValue(err);
    (channel as any).sendText = vi.fn();

    await expect(channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "", media: [file] }))).rejects.toThrow("network");
    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("propagates timeout media send errors without text fallback", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    const err = new Error("timed out");
    err.name = "TimeoutError";
    (channel as any).sendMediaFile = vi.fn().mockRejectedValue(err);
    (channel as any).sendText = vi.fn();

    await expect(channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", media: ["/tmp/photo.jpg"] }))).rejects.toThrow("timed out");
    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("propagates transport media send errors without text fallback", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    const err = new Error("connection reset");
    err.name = "TransportError";
    (channel as any).sendMediaFile = vi.fn().mockRejectedValue(err);
    (channel as any).sendText = vi.fn();

    await expect(channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", media: ["/tmp/photo.jpg"] }))).rejects.toThrow("connection reset");
    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("propagates 5xx media send errors without text fallback", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    const err: any = new Error("Service Unavailable");
    err.response = { status: 503 };
    (channel as any).sendMediaFile = vi.fn().mockRejectedValue(err);
    (channel as any).sendText = vi.fn();

    await expect(channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", media: ["/tmp/photo.jpg"] }))).rejects.toThrow("Service Unavailable");
    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("falls back to text for 4xx media send errors", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    const err: any = new Error("Bad Request");
    err.response = { status: 400 };
    (channel as any).sendMediaFile = vi.fn().mockRejectedValue(err);
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", media: ["/tmp/photo.jpg"] }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "[Failed to send: photo.jpg]", "ctx-1");
  });

  it("falls back to text for file-not-found media send errors", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    (channel as any).sendMediaFile = vi.fn().mockRejectedValue(new Error("Media file not found: /tmp/missing.jpg"));
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", media: ["/tmp/missing.jpg"] }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "[Failed to send: missing.jpg]", "ctx-1");
  });

  it("falls back to text for value-style media send errors", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    (channel as any).sendMediaFile = vi.fn().mockRejectedValue(new Error("Unsupported media format"));
    (channel as any).sendText = vi.fn().mockResolvedValue(undefined);

    await channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", media: ["/tmp/file.xyz"] }));

    expect(channel.sendText).toHaveBeenCalledWith("wx-user", "[Failed to send: file.xyz]", "ctx-1");
  });

  it("does not make a second API call after network-like media send errors", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    freshContext(channel);
    const err: any = new Error("connection refused");
    err.code = "ECONNREFUSED";
    (channel as any).sendMediaFile = vi.fn().mockRejectedValue(err);
    (channel as any).sendText = vi.fn();

    await expect(channel.send(new OutboundMessage({ channel: "weixin", chatId: "wx-user", content: "hello", media: ["/tmp/img.png"] }))).rejects.toThrow("connection refused");

    expect(channel.sendMediaFile).toHaveBeenCalledTimes(1);
    expect(channel.sendText).not.toHaveBeenCalled();
  });

  it("raises on send text API errors and succeeds on zero errcode", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    (channel as any).apiPost = vi.fn().mockResolvedValueOnce({ ret: 1, errcode: 0, errmsg: "bad" }).mockResolvedValueOnce({ ret: 0, errcode: 0 });

    await expect(channel.sendText("wx-user", "bad", "ctx")).rejects.toThrow(/send text error/);
    await expect(channel.sendText("wx-user", "ok", "ctx")).resolves.toBeUndefined();
  });

  it("raises when send text returns nonzero ret even with zero errcode", async () => {
    const { channel } = makeChannel();
    channel.client = {};
    channel.authToken = "token";
    (channel as any).apiPost = vi.fn().mockResolvedValue({ ret: 2, errcode: 0, errmsg: "ret failed" });

    await expect(channel.sendText("wx-user", "bad", "ctx")).rejects.toThrow(/ret=2/);
  });
});
