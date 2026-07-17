import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMediaDir } from "../../../src/config/paths.js";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { WebSocketChannel, WebSocketConfig, extractDataUrlMime, sniffImageMime } from "../../../src/integrations/channels/websocket.js";

const roots: string[] = [];
const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-ws-envelope-media-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  return root;
}

function tinyPngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function dataUrl(mime: string, payload: Buffer): string {
  return `data:${mime};base64,${payload.toString("base64")}`;
}

function makeChannel(): WebSocketChannel {
  const channel = new WebSocketChannel({ enabled: true, allowFrom: ["*"], websocketRequiresToken: false }, new MessageBus());
  channel.handleMessage = vi.fn(async () => undefined) as any;
  channel.hydrateAfterSubscribe = vi.fn(async () => undefined) as any;
  return channel;
}

function makeConnection() {
  return { send: vi.fn(async (raw: string) => undefined), remoteAddress: ["127.0.0.1"] };
}

function sentError(connection: ReturnType<typeof makeConnection>): any {
  return JSON.parse(connection.send.mock.calls[0][0]);
}

function writeWebuiImage(name = "shot.png", bytes = tinyPngBytes()): string {
  const dir = path.join(getMediaDir("websocket"), "webui");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, bytes);
  return fs.realpathSync(filePath);
}

function writeWebuiFile(name = "report.txt", text = "Quarterly revenue is $5M"): string {
  const dir = path.join(getMediaDir("websocket"), "webui");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, text, "utf8");
  return fs.realpathSync(filePath);
}

afterEach(() => {
  vi.restoreAllMocks();
  if (oldDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("WebSocket envelope media helpers", () => {
  it("extracts data URL MIME types and sniffs supported image signatures", () => {
    expect(extractDataUrlMime("data:image/png;base64,AAAA")).toBe("image/png");
    expect(extractDataUrlMime("data:image/jpeg;base64,AAAA")).toBe("image/jpeg");
    expect(extractDataUrlMime("data:IMAGE/PNG;base64,AAAA")).toBe("image/png");
    expect(extractDataUrlMime("data:image/svg+xml;base64,AAAA")).toBe("image/svg+xml");
    expect(extractDataUrlMime("data:text/plain;base64,AAAA")).toBe("text/plain");
    expect(extractDataUrlMime("http://evil.example/x.png")).toBeNull();
    expect(extractDataUrlMime("data:image/png,AAAA")).toBeNull();
    expect(extractDataUrlMime("")).toBeNull();
    expect(extractDataUrlMime(null as any)).toBeNull();
    expect(sniffImageMime(tinyPngBytes())).toBe("image/png");
    expect(sniffImageMime(Buffer.from("<svg />"))).toBeNull();
  });

  it("defaults maxMessageBytes high enough for media path frames", () => {
    expect(new WebSocketConfig().maxMessageBytes).toBeGreaterThanOrEqual(33 * 1024 * 1024);
    expect(() => new WebSocketConfig({ maxMessageBytes: 41_943_041 })).toThrow();
  });
});

describe("WebSocket message envelopes with media paths", () => {
  it("keeps media-less message frames backward compatible", async () => {
    const channel = makeChannel();
    const connection = makeConnection();

    await channel.dispatchEnvelope(connection, "client-1", { type: "message", chat_id: "abc123", content: "hello" });

    expect(channel.handleMessage).toHaveBeenCalledTimes(1);
    const opts = (channel.handleMessage as any).mock.calls[0][0];
    expect(opts.chatId).toBe("abc123");
    expect(opts.content).toBe("hello");
    expect(opts.media).toBeUndefined();
  });

  it("forwards normalized MCP preset attachments", async () => {
    const channel = makeChannel();
    const connection = makeConnection();

    await channel.dispatchEnvelope(connection, "client-1", {
      type: "message",
      chat_id: "abc123",
      content: "please use @browserbase",
      webui: true,
      mcp_presets: [
        {
          name: "Browserbase",
          display_name: "Browserbase",
          category: "browser",
          transport: "streamableHttp",
          logo_url: "https://example.invalid/browserbase.svg",
          brand_color: "#111111",
          configured: true,
        },
        { name: "unknown-mcp", transport: "stdio" },
      ],
    });

    const metadata = (channel.handleMessage as any).mock.calls[0][0].metadata;
    expect(metadata.webui).toBe(true);
    expect(metadata.mcp_presets).toEqual([
      {
        name: "browserbase",
        display_name: "Browserbase",
        category: "browser",
        transport: "streamableHttp",
        logo_url: "https://example.invalid/browserbase.svg",
        brand_color: "#111111",
        configured: true,
      },
    ]);
  });

  it("accepts image media_paths that point inside the websocket media directory", async () => {
    tmpRoot();
    const imagePath = writeWebuiImage();
    const channel = makeChannel();
    const connection = makeConnection();

    await channel.dispatchEnvelope(connection, "client-1", {
      type: "message",
      chat_id: "abc123",
      content: "look at this",
      media_paths: [imagePath],
    });

    const opts = (channel.handleMessage as any).mock.calls[0][0];
    expect(opts.media).toEqual([imagePath]);
    expect(connection.send).not.toHaveBeenCalled();
  });

  it("accepts document and text media_paths that point inside the websocket media directory", async () => {
    tmpRoot();
    const textPath = writeWebuiFile("report.txt");
    const pdfPath = writeWebuiFile("report.pdf", "%PDF-1.7\nbody");
    const channel = makeChannel();
    const connection = makeConnection();

    await channel.dispatchEnvelope(connection, "client-1", {
      type: "message",
      chat_id: "abc123",
      content: "summarize these",
      media_paths: [textPath, pdfPath],
    });

    const opts = (channel.handleMessage as any).mock.calls[0][0];
    expect(opts.media).toEqual([textPath, pdfPath]);
    expect(connection.send).not.toHaveBeenCalled();
  });

  it("allows image-only messages with empty text", async () => {
    tmpRoot();
    const imagePath = writeWebuiImage();
    const channel = makeChannel();
    const connection = makeConnection();

    await channel.dispatchEnvelope(connection, "client-1", {
      type: "message",
      chat_id: "abc123",
      content: "",
      media_paths: [imagePath],
    });

    expect(channel.handleMessage).toHaveBeenCalledTimes(1);
    expect(connection.send).not.toHaveBeenCalled();
  });

  it("rejects media_paths outside the websocket media directory", async () => {
    const root = tmpRoot();
    const outside = path.join(root, "outside.png");
    fs.writeFileSync(outside, tinyPngBytes());
    const channel = makeChannel();
    const connection = makeConnection();

    await channel.dispatchEnvelope(connection, "client-1", {
      type: "message",
      chat_id: "abc123",
      content: "outside",
      media_paths: [outside],
    });

    expect(channel.handleMessage).not.toHaveBeenCalled();
    expect(sentError(connection)).toMatchObject({ chat_id: "abc123", detail: "attachment_rejected", reason: "path" });
  });

  it("rejects video or disguised image media_paths", async () => {
    tmpRoot();
    const fakePng = writeWebuiImage("fake.png", Buffer.from("not a png"));
    const channel = makeChannel();
    const connection = makeConnection();

    await channel.dispatchEnvelope(connection, "client-1", {
      type: "message",
      chat_id: "abc123",
      content: "fake",
      media_paths: [fakePng],
    });

    expect(channel.handleMessage).not.toHaveBeenCalled();
    expect(sentError(connection)).toMatchObject({ chat_id: "abc123", detail: "attachment_rejected", reason: "mime" });
  });

  it("rejects too many media_paths", async () => {
    tmpRoot();
    const channel = makeChannel();
    const connection = makeConnection();

    await channel.dispatchEnvelope(connection, "client-1", {
      type: "message",
      chat_id: "abc123",
      content: "hi",
      media_paths: Array.from({ length: 5 }, (_, index) => writeWebuiImage(`shot-${index}.png`)),
    });

    expect(channel.handleMessage).not.toHaveBeenCalled();
    expect(sentError(connection)).toMatchObject({ chat_id: "abc123", detail: "attachment_rejected", reason: "too_many_attachments" });
  });

  it("rejects deprecated WebUI image and video data URL media payloads", async () => {
    tmpRoot();
    const channel = makeChannel();
    const connection = makeConnection();

    await channel.dispatchEnvelope(connection, "client-1", {
      type: "message",
      chat_id: "abc123",
      content: "old image",
      webui: true,
      media: [{ data_url: dataUrl("image/png", tinyPngBytes()), name: "shot.png" }],
    });

    expect(channel.handleMessage).not.toHaveBeenCalled();
    expect(sentError(connection)).toMatchObject({ chat_id: "abc123", detail: "attachment_rejected", reason: "deprecated_payload" });

    connection.send.mockClear();
    await channel.dispatchEnvelope(connection, "client-1", {
      type: "message",
      chat_id: "abc123",
      content: "old video",
      webui: true,
      media: [{ data_url: dataUrl("video/mp4", Buffer.from("mp4")), name: "clip.mp4" }],
    });

    expect(sentError(connection)).toMatchObject({ chat_id: "abc123", detail: "attachment_rejected", reason: "mime" });
  });

  it("rejects malformed media fields and empty text without media", async () => {
    const channel = makeChannel();
    const connection = makeConnection();

    await channel.dispatchEnvelope(connection, "client-1", {
      type: "message",
      chat_id: "abc123",
      content: "huh",
      media_paths: "not-a-list",
    });

    expect(channel.handleMessage).not.toHaveBeenCalled();
    expect(sentError(connection)).toMatchObject({ detail: "attachment_rejected", reason: "malformed" });

    connection.send.mockClear();
    await channel.dispatchEnvelope(connection, "client-1", { type: "message", chat_id: "abc123", content: "   " });
    expect(sentError(connection).detail).toBe("missing content");

    connection.send.mockClear();
    await channel.dispatchEnvelope(connection, "client-1", { type: "message", chat_id: "abc123", content: 42 });
    expect(sentError(connection).detail).toBe("missing content");
  });
});
