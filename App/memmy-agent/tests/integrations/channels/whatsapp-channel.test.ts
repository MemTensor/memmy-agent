import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { WhatsappChannel, WhatsappConfig, loadOrCreateBridgeToken } from "../../../src/integrations/channels/whatsapp.js";

const wsRuntimeMock = vi.hoisted(() => {
  const api: any = { instances: [] as any[] };
  class MockWebSocket {
    url: string;
    sent: string[] = [];
    handlers = new Map<string, any[]>();
    constructor(url: string) {
      this.url = url;
      api.instances.push(this);
      queueMicrotask(() => this.emit("open"));
    }
    once(event: string, callback: any): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), (...args: any[]) => {
        this.handlers.set(
          event,
          (this.handlers.get(event) ?? []).filter((fn) => fn !== callback),
        );
        callback(...args);
      }]);
    }
    on(event: string, callback: any): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
    }
    emit(event: string, ...args: any[]): void {
      for (const callback of this.handlers.get(event) ?? []) callback(...args);
    }
    send(raw: string, callback?: (error?: Error) => void): void {
      this.sent.push(raw);
      callback?.();
    }
    close(): void {
      this.emit("close");
    }
  }
  api.WebSocket = vi.fn(function WebSocket(this: any, url: string) {
    return new MockWebSocket(url);
  });
  api.reset = () => {
    api.instances = [];
    api.WebSocket.mockClear();
    api.WebSocket.mockImplementation(function WebSocket(this: any, url: string) {
      return new MockWebSocket(url);
    });
  };
  return api;
});

vi.mock("ws", () => ({ WebSocket: wsRuntimeMock.WebSocket }));

const oldConfig = process.env.MEMMY_CONFIG;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-whatsapp-"));
  roots.push(root);
  process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  wsRuntimeMock.reset();
  process.env.MEMMY_CONFIG = oldConfig;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class FakeWS {
  sent: string[] = [];
  closed = false;
  async send(raw: string): Promise<void> {
    this.sent.push(raw);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeChannel(config: Record<string, any> = {}): WhatsappChannel {
  const channel = new WhatsappChannel(new WhatsappConfig({ enabled: true, allowFrom: ["*"], ...config }), new MessageBus());
  channel.ws = new FakeWS();
  channel.connected = true;
  return channel;
}

describe("WhatsappChannel", () => {
  it("sends text only", async () => {
    const channel = makeChannel();

    await channel.send(new OutboundMessage({ channel: "whatsapp", chatId: "123@s.whatsapp.net", content: "hello" }));

    expect((channel.ws as FakeWS).sent).toHaveLength(1);
    expect(JSON.parse((channel.ws as FakeWS).sent[0])).toEqual({
      type: "send",
      to: "123@s.whatsapp.net",
      text: "hello",
    });
  });

  it("dispatches media through send_media commands", async () => {
    const channel = makeChannel();

    await channel.send(
      new OutboundMessage({
        channel: "whatsapp",
        chatId: "123@s.whatsapp.net",
        content: "check this out",
        media: ["/tmp/photo.jpg"],
      }),
    );

    const payloads = (channel.ws as FakeWS).sent.map((raw) => JSON.parse(raw));
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toEqual({ type: "send", to: "123@s.whatsapp.net", text: "check this out" });
    expect(payloads[1]).toMatchObject({
      type: "send_media",
      to: "123@s.whatsapp.net",
      filePath: "/tmp/photo.jpg",
      mimetype: "image/jpeg",
      fileName: "photo.jpg",
    });
  });

  it("sends media without text", async () => {
    const channel = makeChannel();

    await channel.send(new OutboundMessage({ channel: "whatsapp", chatId: "123@s.whatsapp.net", content: "", media: ["/tmp/doc.pdf"] }));

    const payloads = (channel.ws as FakeWS).sent.map((raw) => JSON.parse(raw));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      type: "send_media",
      to: "123@s.whatsapp.net",
      filePath: "/tmp/doc.pdf",
      mimetype: "application/pdf",
      fileName: "doc.pdf",
    });
  });

  it("sends multiple media payloads", async () => {
    const channel = makeChannel();

    await channel.send(
      new OutboundMessage({
        channel: "whatsapp",
        chatId: "123@s.whatsapp.net",
        content: "",
        media: ["/tmp/a.png", "/tmp/b.mp4"],
      }),
    );

    const payloads = (channel.ws as FakeWS).sent.map((raw) => JSON.parse(raw));
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ type: "send_media", mimetype: "image/png", fileName: "a.png" });
    expect(payloads[1]).toMatchObject({ type: "send_media", mimetype: "video/mp4", fileName: "b.mp4" });
  });

  it("does not send when disconnected", async () => {
    const channel = makeChannel();
    channel.connected = false;

    await channel.send(new OutboundMessage({ channel: "whatsapp", chatId: "123@s.whatsapp.net", content: "hello", media: ["/tmp/x.jpg"] }));

    expect((channel.ws as FakeWS).sent).toEqual([]);
  });

  it("skips unmentioned group messages when group policy requires a mention", async () => {
    const channel = new WhatsappChannel(new WhatsappConfig({ enabled: true, allowFrom: ["*"], groupPolicy: "mention" }), new MessageBus());
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.handleBridgeMessage(
      JSON.stringify({
        type: "message",
        id: "m1",
        sender: "12345@g.us",
        pn: "user@s.whatsapp.net",
        content: "hello group",
        timestamp: 1,
        isGroup: true,
        wasMentioned: false,
      }),
    );

    expect(handled).toEqual([]);
  });

  it("accepts mentioned group messages when group policy requires a mention", async () => {
    const channel = new WhatsappChannel(new WhatsappConfig({ enabled: true, allowFrom: ["*"], groupPolicy: "mention" }), new MessageBus());
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.handleBridgeMessage(
      JSON.stringify({
        type: "message",
        id: "m1",
        sender: "12345@g.us",
        pn: "user@s.whatsapp.net",
        content: "hello @bot",
        timestamp: 1,
        isGroup: true,
        wasMentioned: true,
      }),
    );

    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ chatId: "12345@g.us", senderId: "user", content: "hello @bot" });
    expect(handled[0].metadata).toMatchObject({ messageId: "m1", isGroup: true });
  });

  it("prefers phone JIDs over LIDs for sender IDs", async () => {
    const channel = new WhatsappChannel(new WhatsappConfig({ enabled: true, allowFrom: ["*"] }), new MessageBus());
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.handleBridgeMessage(
      JSON.stringify({
        type: "message",
        id: "lid1",
        sender: "ABC123@lid.whatsapp.net",
        pn: "5551234@s.whatsapp.net",
        content: "hi",
        timestamp: 1,
      }),
    );

    expect(handled[0]).toMatchObject({ senderId: "5551234", content: "hi" });
  });

  it("uses the LID-to-phone cache for LID-only messages", async () => {
    const channel = new WhatsappChannel(new WhatsappConfig({ enabled: true, allowFrom: ["*"] }), new MessageBus());
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.handleBridgeMessage(
      JSON.stringify({
        type: "message",
        id: "c1",
        sender: "LID99@lid.whatsapp.net",
        pn: "5559999@s.whatsapp.net",
        content: "first",
        timestamp: 1,
      }),
    );
    await channel.handleBridgeMessage(
      JSON.stringify({
        type: "message",
        id: "c2",
        sender: "LID99@lid.whatsapp.net",
        pn: "",
        content: "second",
        timestamp: 2,
      }),
    );

    expect(handled.map((item) => item.senderId)).toEqual(["5559999", "5559999"]);
    expect(handled.map((item) => item.content)).toEqual(["first", "second"]);
  });

  it("transcribes voice messages when media is available", async () => {
    const channel = new WhatsappChannel(new WhatsappConfig({ enabled: true, allowFrom: ["*"] }), new MessageBus());
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };
    channel.transcribeAudio = vi.fn(async () => "Hello world");

    await channel.handleBridgeMessage(
      JSON.stringify({
        type: "message",
        id: "v1",
        sender: "12345@s.whatsapp.net",
        content: "[Voice Message]",
        timestamp: 1,
        media: ["/tmp/voice.ogg"],
      }),
    );
    expect(channel.transcribeAudio).toHaveBeenCalledWith("/tmp/voice.ogg");
    expect(handled[0]).toMatchObject({ content: "Hello world", media: [] });
  });

  it("does not transcribe unauthorized voice messages", async () => {
    const channel = new WhatsappChannel(new WhatsappConfig({ enabled: true, allowFrom: ["allowed"] }), new MessageBus());
    channel.handleMessage = vi.fn(async () => undefined);
    channel.transcribeAudio = vi.fn(async () => "Nope");

    await channel.handleBridgeMessage(
      JSON.stringify({
        type: "message",
        id: "v-blocked",
        sender: "blocked@s.whatsapp.net",
        content: "[Voice Message]",
        timestamp: 1,
        media: ["/tmp/voice.ogg"],
      }),
    );

    expect(channel.transcribeAudio).not.toHaveBeenCalled();
    expect(channel.handleMessage).not.toHaveBeenCalled();
  });

  it("marks voice messages without media as unavailable", async () => {
    const channel = new WhatsappChannel(new WhatsappConfig({ enabled: true, allowFrom: ["*"] }), new MessageBus());
    const handled: any[] = [];
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.handleBridgeMessage(
      JSON.stringify({
        type: "message",
        id: "v2",
        sender: "12345@s.whatsapp.net",
        content: "[Voice Message]",
        timestamp: 2,
      }),
    );

    expect(handled[0].content).toBe("[Voice Message: Audio not available]");
  });

  it("persists generated bridge tokens", () => {
    const root = tmpRoot();
    const tokenPath = path.join(root, "whatsapp-auth", "bridge-token");

    const first = loadOrCreateBridgeToken(tokenPath);
    const second = loadOrCreateBridgeToken(tokenPath);

    expect(second).toBe(first);
    expect(fs.readFileSync(tokenPath, "utf8")).toBe(first);
    expect(first.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== "win32") expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("uses configured bridge tokens without creating a local token file", () => {
    const root = tmpRoot();
    const tokenPath = path.join(root, "whatsapp-auth", "bridge-token");

    const channel = new WhatsappChannel(new WhatsappConfig({ bridgeToken: "manual-secret" }), new MessageBus());
    expect(channel.effectiveBridgeToken()).toBe("manual-secret");
    expect(fs.existsSync(tokenPath)).toBe(false);
  });

  it("exports the effective bridge token when running login", async () => {
    const root = tmpRoot();
    const bridgeDir = path.join(root, "bridge");
    const calls: any[] = [];
    fs.mkdirSync(bridgeDir);
    const channel = new WhatsappChannel(
      new WhatsappConfig({
        enabled: true,
        bridgeSetup: () => bridgeDir,
        bridgeRunner: (call: any) => {
          calls.push(call);
          return { status: 0 };
        },
      }),
      new MessageBus(),
    );

    await expect(channel.login()).resolves.toBe(true);

    const tokenPath = path.join(root, "whatsapp-auth", "bridge-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ args: ["start"], cwd: bridgeDir, bridgeDir });
    expect(calls[0].env.AUTH_DIR).toBe(path.dirname(tokenPath));
    expect(calls[0].env.BRIDGE_TOKEN).toBe(fs.readFileSync(tokenPath, "utf8"));
  });

  it("sends bridge auth on start with an injected connector", async () => {
    tmpRoot();
    const ws = new FakeWS();
    const channel = new WhatsappChannel(
      new WhatsappConfig({
        enabled: true,
        bridgeUrl: "ws://localhost:3001",
        websocketConnector: async () => ws,
      } as any),
      new MessageBus(),
    );

    await channel.start();

    expect(JSON.parse(ws.sent[0])).toMatchObject({ type: "auth" });
    expect(JSON.parse(ws.sent[0]).token.length).toBeGreaterThanOrEqual(32);
    expect(channel.connected).toBe(true);
  });

  it("uses the ws package as the default bridge connector", async () => {
    tmpRoot();
    const channel = new WhatsappChannel(new WhatsappConfig({ enabled: true, bridgeUrl: "ws://bridge.local:3001" }), new MessageBus());

    await channel.start();

    expect(wsRuntimeMock.WebSocket).toHaveBeenCalledWith("ws://bridge.local:3001");
    expect(JSON.parse(wsRuntimeMock.instances[0].sent[0])).toMatchObject({ type: "auth" });
    await channel.stop();
  });
});
