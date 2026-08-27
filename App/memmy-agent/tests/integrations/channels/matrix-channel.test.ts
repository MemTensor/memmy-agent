import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import {
  MATRIX_HTML_CLEANER,
  MATRIX_HTML_FORMAT,
  MATRIX_MEDIA_EVENT_FILTER,
  TYPING_NOTICE_TIMEOUT_MS,
  DownloadError,
  MatrixChannel,
  MatrixConfig,
  MemoryDownloadResponse,
  RoomEncryptedMedia,
  RoomMessageMedia,
  RoomMessageText,
  RoomSendResponse,
  SyncError,
  StreamBuffer,
  buildMatrixTextContent,
  setMatrixAttachmentDecryptor,
} from "../../../src/integrations/channels/matrix.js";

const matrixSdkMock = vi.hoisted(() => {
  const api: any = {
    RoomEvent: { Timeline: "Room.timeline" },
    lastClient: null,
  };
  const makeClient = (opts: any) => {
    const client: any = {
      opts,
      credentials: {},
      deviceId: opts.deviceId ?? "",
      listeners: new Map<string, any>(),
      on: vi.fn((event: string, callback: any) => {
        client.listeners.set(event, callback);
      }),
      getRooms: vi.fn(() => []),
      getUserId: vi.fn(() => opts.userId),
      getAccessToken: vi.fn(() => opts.accessToken),
      getDeviceId: vi.fn(() => opts.deviceId),
      startClient: vi.fn(async () => undefined),
      stopClient: vi.fn(),
      removeAllListeners: vi.fn(),
      sendTyping: vi.fn(async () => undefined),
      sendEvent: vi.fn(async () => ({ event_id: "$sdk-event" })),
      joinRoom: vi.fn(async () => undefined),
      mxcUrlToHttp: vi.fn((mxc: string) => `https://matrix.example/_matrix/media/${encodeURIComponent(mxc)}`),
      uploadContent: vi.fn(async () => ({ content_uri: "mxc://matrix.example/uploaded" })),
      getMediaConfig: vi.fn(async () => ({ upload_size: 1024 })),
      loginWithPassword: vi.fn(async () => ({ access_token: "login-token", device_id: "login-device" })),
    };
    api.lastClient = client;
    return client;
  };
  api.createClient = vi.fn(makeClient);
  api.reset = () => {
    api.lastClient = null;
    api.createClient.mockClear();
    api.createClient.mockImplementation(makeClient);
  };
  return api;
});

vi.mock("matrix-js-sdk", () => matrixSdkMock);

const oldConfig = process.env.MEMMY_CONFIG;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-matrix-"));
  roots.push(root);
  process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  matrixSdkMock.reset();
  setMatrixAttachmentDecryptor(() => {
    throw new Error("not configured");
  });
  process.env.MEMMY_CONFIG = oldConfig;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class FakeMatrixClient {
  callbacks: any[] = [];
  responseCallbacks: any[] = [];
  rooms: Record<string, any> = {};
  typingCalls: any[] = [];
  roomSendCalls: any[] = [];
  downloadCalls: any[] = [];
  uploadCalls: any[] = [];
  joinCalls: string[] = [];
  loadStoreCalled = false;
  stopSyncForeverCalled = false;
  closeCalled = false;
  downloadResponse: any = null;
  downloadBytes = Buffer.from("media");
  uploadResponse: any = null;
  contentRepositoryConfigResponse: any = { upload_size: null };
  raiseOnSend = false;
  raiseOnUpload = false;
  roomSendResponse = new RoomSendResponse({ eventId: "$event", roomId: "!room:matrix.org" });

  addEventCallback(callback: any, eventType: any): void {
    this.callbacks.push([callback, eventType]);
  }
  addResponseCallback(callback: any, responseType: any): void {
    this.responseCallbacks.push([callback, responseType]);
  }
  loadStore(): void {
    this.loadStoreCalled = true;
  }
  stopSyncForever(): void {
    this.stopSyncForeverCalled = true;
  }
  async join(roomId: string): Promise<void> {
    this.joinCalls.push(roomId);
  }
  async roomTyping(args: any): Promise<void> {
    this.typingCalls.push([args.roomId, args.typingState, args.timeout]);
  }
  async roomSend(args: any): Promise<RoomSendResponse> {
    this.roomSendCalls.push(args);
    if (this.raiseOnSend) throw new Error("send failed");
    return this.roomSendResponse;
  }
  async download(args: any): Promise<any> {
    this.downloadCalls.push(args);
    return this.downloadResponse ?? new MemoryDownloadResponse({ body: this.downloadBytes, contentType: "application/octet-stream" });
  }
  async upload(dataProvider: any, options: any): Promise<any> {
    if (this.raiseOnUpload) throw new Error("upload failed");
    this.uploadCalls.push({ dataProvider, ...options });
    return this.uploadResponse ?? { content_uri: "mxc://example.org/uploaded" };
  }
  async contentRepositoryConfig(): Promise<any> {
    return this.contentRepositoryConfigResponse;
  }
  async close(): Promise<void> {
    this.closeCalled = true;
  }
}

function makeChannel(config: Partial<MatrixConfig> & Record<string, any> = {}, client = new FakeMatrixClient()): MatrixChannel {
  tmpRoot();
  const channel = new MatrixChannel(
    new MatrixConfig({
      enabled: true,
      homeserver: "https://matrix.org",
      accessToken: "token",
      userId: "@bot:matrix.org",
      allowFrom: ["*"],
      ...config,
    }),
    new MessageBus(),
  );
  channel.client = client;
  return channel;
}

describe("Matrix markdown and metadata", () => {
  it("builds plain text, markdown HTML, and replacement payloads", () => {
    expect(buildMatrixTextContent("Hello")).toEqual({ msgtype: "m.text", body: "Hello", "m.mentions": {} });

    const markdown = buildMatrixTextContent("*Hello* **World**");
    expect(markdown.format).toBe(MATRIX_HTML_FORMAT);
    expect(markdown.formatted_body).toContain("<em>Hello</em>");
    expect(markdown.formatted_body).toContain("<strong>World</strong>");

    const relatesTo = { rel_type: "m.thread", event_id: "$root", "m.in_reply_to": { event_id: "$reply" }, is_falling_back: true };
    const edit = buildMatrixTextContent("Updated", "$event", relatesTo);
    expect(edit["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$event" });
    expect(edit["m.new_content"]["m.relates_to"]).toEqual(relatesTo);
  });

  it("sanitizes Matrix HTML attributes and disallowed image sources", () => {
    const dirty = '<a href="https://example.com" onclick="evil()">x</a><a href="javascript:bad()">bad</a><script>x</script>';
    const cleaned = MATRIX_HTML_CLEANER.clean(dirty);
    expect(cleaned).toContain('<a href="https://example.com" rel="noopener noreferrer">');
    expect(cleaned).not.toContain("onclick");
    expect(cleaned).not.toContain("javascript:");
    expect(cleaned).not.toContain("<script");

    const image = buildMatrixTextContent("![ok](mxc://server/id) ![bad](https://example.com/a.png)");
    expect(image.formatted_body).toContain('src="mxc://server/id"');
    expect(image.formatted_body).not.toContain('src="https://example.com/a.png"');
  });

  it("preserves thread metadata from inbound events and outgoing metadata", () => {
    const channel = makeChannel();
    const event = {
      event_id: "$reply1",
      source: { content: { "m.relates_to": { rel_type: "m.thread", event_id: "$root1" } } },
    };
    expect(channel.threadMetadata(event)).toEqual({ threadRootEventId: "$root1", threadReplyToEventId: "$reply1" });
    expect(channel.buildThreadRelatesTo({ threadRootEventId: "$root1", threadReplyToEventId: "$reply1" })).toEqual({
      rel_type: "m.thread",
      event_id: "$root1",
      "m.in_reply_to": { event_id: "$reply1" },
      is_falling_back: true,
    });
  });
});

describe("MatrixChannel memmy parity cases", () => {
  it("creates a matrix-js-sdk client when no client is injected", async () => {
    tmpRoot();
    const channel = new MatrixChannel(
      new MatrixConfig({ homeserver: "https://matrix.example", accessToken: "token", deviceId: "device", userId: "@bot:matrix.example", allowFrom: ["*"] }),
      new MessageBus(),
    );

    await channel.start();
    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.example", content: "hello" }));

    expect(matrixSdkMock.createClient).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://matrix.example", userId: "@bot:matrix.example", accessToken: "token", deviceId: "device" }),
    );
    expect(matrixSdkMock.lastClient.startClient).toHaveBeenCalled();
    expect(matrixSdkMock.lastClient.sendEvent).toHaveBeenCalledWith("!room:matrix.example", "m.room.message", expect.objectContaining({ body: "hello" }), "");
    await channel.stop();
  });

  it("skips loading the store when deviceId is missing", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ deviceId: "" }, client);

    await channel.start();

    expect(client.loadStoreCalled).toBe(false);
    expect(client.callbacks).toHaveLength(3);
    expect(client.responseCallbacks).toHaveLength(3);
    await channel.stop();
  });

  it("registers media event callbacks with the media filter", () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    client.callbacks = [];

    channel.registerEventCallbacks();

    expect(client.callbacks).toHaveLength(3);
    expect(client.callbacks[1][0]).toBeInstanceOf(Function);
    expect(client.callbacks[1][1]).toBe(MATRIX_MEDIA_EVENT_FILTER);
  });

  it("does not include text events in the media event filter", () => {
    expect(MATRIX_MEDIA_EVENT_FILTER.includes(RoomMessageText as any)).toBe(false);
  });

  it("stops the sync loop on an unknown-token sync error", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.running = true;

    await channel.onSyncError(new SyncError("bad", { statusCode: "M_UNKNOWN_TOKEN" }));

    expect(channel.running).toBe(false);
    expect(client.stopSyncForeverCalled).toBe(true);
  });

  it("keeps running on a transient sync error", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.running = true;

    await channel.onSyncError(new SyncError("oops", { statusCode: "M_LIMIT_EXCEEDED" }));

    expect(channel.running).toBe(true);
    expect(client.stopSyncForeverCalled).toBe(false);
  });

  it("stops sync before closing the client", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ deviceId: "DEVICE" }, client);
    channel.running = true;

    await channel.stop();

    expect(channel.running).toBe(false);
    expect(client.stopSyncForeverCalled).toBe(true);
    expect(client.closeCalled).toBe(true);
  });

  it("joins invited rooms when the sender is allowed", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ allowFrom: ["@alice:matrix.org"] }, client);

    await channel.onRoomInvite({ room_id: "!room:matrix.org" }, { sender: "@alice:matrix.org" });

    expect(client.joinCalls).toEqual(["!room:matrix.org"]);
  });

  it("starts typing for allowed inbound senders", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMessage({ room_id: "!room:matrix.org", display_name: "Test room" }, { sender: "@alice:matrix.org", body: "Hello", source: {} });

    expect(handled.map((payload) => payload.senderId)).toEqual(["@alice:matrix.org"]);
    expect(client.typingCalls).toEqual([["!room:matrix.org", true, TYPING_NOTICE_TIMEOUT_MS]]);
  });

  it("skips typing for self messages", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await channel.onMessage({ room_id: "!room:matrix.org" }, { sender: "@bot:matrix.org", body: "Hello", source: {} });

    expect(client.typingCalls).toEqual([]);
  });

  it("skips pre-startup text events", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.startedAtMs = 1_000_000;
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMessage({ room_id: "!room:matrix.org" }, { sender: "@alice:matrix.org", body: "old", source: {}, server_timestamp: 999_999 });
    await channel.onMessage({ room_id: "!room:matrix.org" }, { sender: "@alice:matrix.org", body: "fresh", source: {}, server_timestamp: 1_000_001 });

    expect(handled.map((payload) => payload.content)).toEqual(["fresh"]);
    expect(client.typingCalls).toEqual([["!room:matrix.org", true, TYPING_NOTICE_TIMEOUT_MS]]);
  });

  it("skips pre-startup media events", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.startedAtMs = 1_000_000;
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMediaMessage(
      { room_id: "!room:matrix.org" },
      { sender: "@alice:matrix.org", body: "old", source: {}, server_timestamp: 999_999 },
    );

    expect(handled).toEqual([]);
    expect(client.typingCalls).toEqual([]);
  });

  it("requires Matrix mentions when group policy is mention", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ groupPolicy: "mention" }, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMessage({ room_id: "!room:matrix.org", member_count: 3 }, { sender: "@alice:matrix.org", body: "Hello", source: { content: {} } });

    expect(handled).toEqual([]);
    expect(client.typingCalls).toEqual([]);
  });

  it("accepts bot user mentions when group policy is mention", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ groupPolicy: "mention" }, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMessage(
      { room_id: "!room:matrix.org", member_count: 3 },
      { sender: "@alice:matrix.org", body: "Hello", source: { content: { "m.mentions": { user_ids: ["@bot:matrix.org"] } } } },
    );

    expect(handled.map((payload) => payload.senderId)).toEqual(["@alice:matrix.org"]);
    expect(client.typingCalls).toEqual([["!room:matrix.org", true, TYPING_NOTICE_TIMEOUT_MS]]);
  });

  it("requires allowed room ids when group policy is allowlist", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ groupPolicy: "allowlist", groupAllowFrom: ["!allowed:matrix.org"] }, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));
    const event = { sender: "@alice:matrix.org", body: "Hello", source: { content: {} } };

    await channel.onMessage({ room_id: "!denied:matrix.org", member_count: 3 }, event);
    await channel.onMessage({ room_id: "!allowed:matrix.org", member_count: 3 }, event);

    expect(handled.map((payload) => payload.chatId)).toEqual(["!allowed:matrix.org"]);
    expect(client.typingCalls).toEqual([["!allowed:matrix.org", true, TYPING_NOTICE_TIMEOUT_MS]]);
  });

  it("uses the server media limit when it is smaller than the local limit", async () => {
    const client = new FakeMatrixClient();
    client.contentRepositoryConfigResponse = { upload_size: 3 };
    const channel = makeChannel({ maxMediaBytes: 10 }, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMediaMessage(
      { room_id: "!room:matrix.org", member_count: 2 },
      { sender: "@alice:matrix.org", body: "large.bin", url: "mxc://example.org/large", event_id: "$event", source: { content: { msgtype: "m.file", info: { size: 5 } } } },
    );

    expect(client.downloadCalls).toEqual([]);
    expect(handled[0].media).toEqual([]);
    expect(handled[0].content).toContain("[attachment: large.bin - too large]");
  });

  it("uploads media and sends a file event", async () => {
    const root = tmpRoot();
    const file = path.join(root, "test.txt");
    fs.writeFileSync(file, "hello");
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "Please review.", media: [file] }));

    expect(client.uploadCalls[0]).toEqual(expect.objectContaining({ filename: "test.txt", filesize: 5 }));
    expect(client.roomSendCalls[0].content.msgtype).toBe("m.file");
    expect(client.roomSendCalls[0].content.url).toBe("mxc://example.org/uploaded");
    expect(client.roomSendCalls[1].content.body).toBe("Please review.");
  });

  it("reports upload failures when attachment upload throws", async () => {
    const root = tmpRoot();
    const file = path.join(root, "broken.txt");
    fs.writeFileSync(file, "hello");
    const client = new FakeMatrixClient();
    client.raiseOnUpload = true;
    const channel = makeChannel({}, client);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "Please review.", media: [file] }));

    expect(client.uploadCalls).toEqual([]);
    expect(client.roomSendCalls[0].content.body).toBe("Please review.\n[attachment: broken.txt - upload failed]");
  });

  it("uses the server upload limit when it is smaller than the local limit", async () => {
    const root = tmpRoot();
    const file = path.join(root, "tiny.txt");
    fs.writeFileSync(file, "hello");
    const client = new FakeMatrixClient();
    client.contentRepositoryConfigResponse = { upload_size: 3 };
    const channel = makeChannel({ maxMediaBytes: 10 }, client);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "", media: [file] }));

    expect(client.uploadCalls).toEqual([]);
    expect(client.roomSendCalls[0].content.body).toBe("[attachment: tiny.txt - too large]");
  });

  it("blocks all outbound media when the effective limit is zero", async () => {
    const root = tmpRoot();
    const file = path.join(root, "empty.txt");
    fs.writeFileSync(file, "");
    const client = new FakeMatrixClient();
    const channel = makeChannel({ maxMediaBytes: 0 }, client);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "", media: [file] }));

    expect(client.uploadCalls).toEqual([]);
    expect(client.roomSendCalls[0].content.body).toBe("[attachment: empty.txt - too large]");
  });

  it("stops typing keepalive after sending", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.running = true;
    await channel.startTypingKeepalive("!room:matrix.org");

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "Hi" }));

    expect(channel.typingTasks.has("!room:matrix.org")).toBe(false);
    expect(client.typingCalls.at(-1)).toEqual(["!room:matrix.org", false, TYPING_NOTICE_TIMEOUT_MS]);
  });

  it("adds formatted_body for markdown sends", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    const text = "# Headline\n\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |";

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: text }));

    const content = client.roomSendCalls[0].content;
    expect(content.format).toBe(MATRIX_HTML_FORMAT);
    expect(content.formatted_body).toContain("<h1>Headline</h1>");
    expect(content.formatted_body).toContain("<table>");
  });

  it("sanitizes disallowed link schemes", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "[click](javascript:alert(1))" }));

    const formatted = String(client.roomSendCalls[0].content.formatted_body);
    expect(formatted).not.toContain("javascript:");
    expect(formatted).toContain("<a");
    expect(formatted).not.toContain("href=");
  });

  it("keeps plain text sends plaintext-only", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    const text = "just a normal sentence without markdown markers";

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: text }));

    expect(client.roomSendCalls[0].content).toEqual({ msgtype: "m.text", body: text, "m.mentions": {} });
  });

  it("builds Matrix text content for basic text", () => {
    expect(buildMatrixTextContent("Hello, World!")).toEqual({ msgtype: "m.text", body: "Hello, World!", "m.mentions": {} });
  });

  it("builds replacement Matrix text content with an event id", () => {
    const eventId = "$event";
    const result = buildMatrixTextContent("Updated message", eventId);
    expect(result["m.new_content"].body).toBe("Updated message");
    expect(result["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: eventId });
  });

  it("builds non-replacement Matrix text content without an event id", () => {
    const result = buildMatrixTextContent("Regular message");
    expect(result.body).toBe("Regular message");
    expect(result["m.relates_to"]).toBeUndefined();
    expect(result["m.new_content"]).toBeUndefined();
  });

  it("returns the room send response from sendRoomContent", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await expect(channel.sendRoomContent("!room:matrix.org", { msgtype: "m.text", body: "Hello" })).resolves.toBe(
      client.roomSendResponse,
    );
  });

  it("sendDelta creates stream buffer and sends initial message", async () => {
    const client = new FakeMatrixClient();
    client.roomSendResponse = new RoomSendResponse({ eventId: "$stream", roomId: "!room:matrix.org" });
    const channel = makeChannel({}, client);

    await channel.sendDelta("!room:matrix.org", "Hello");

    expect(channel.streamBuffers["!room:matrix.org"].text).toBe("Hello");
    expect(channel.streamBuffers["!room:matrix.org"].eventId).toBe("$stream");
    expect(client.roomSendCalls[0].content.body).toBe("Hello");
  });

  it("sendDelta appends without sending before edit interval", async () => {
    const client = new FakeMatrixClient();
    client.roomSendResponse = new RoomSendResponse({ eventId: "$stream", roomId: "!room:matrix.org" });
    const channel = makeChannel({}, client);
    let now = 100;
    channel.monotonicTime = () => now;

    await channel.sendDelta("!room:matrix.org", "Hello");
    await channel.sendDelta("!room:matrix.org", " world");

    expect(client.roomSendCalls).toHaveLength(1);
    expect(channel.streamBuffers["!room:matrix.org"].text).toBe("Hello world");
  });

  it("sendDelta stream end replaces existing message", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.streamBuffers["!room:matrix.org"] = new StreamBuffer({ text: "Final text", eventId: "event-1", lastEdit: 100 });

    await channel.sendDelta("!room:matrix.org", "", { streamEnd: true });

    expect(channel.streamBuffers["!room:matrix.org"]).toBeUndefined();
    expect(client.roomSendCalls[0].content.body).toBe("Final text");
    expect(client.roomSendCalls[0].content["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "event-1" });
  });
});

describe("Matrix inbound and typing policy", () => {
  it("uses the media event filter without matching plain text events", () => {
    expect(MATRIX_MEDIA_EVENT_FILTER).toEqual([RoomMessageMedia, RoomEncryptedMedia]);
    expect(MATRIX_MEDIA_EVENT_FILTER.some((klass) => RoomMessageText.prototype instanceof klass)).toBe(false);
  });

  it("stops sync on fatal auth errors and joins invites only from allowed users", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ allowFrom: ["@alice:matrix.org"] }, client);
    channel.running = true;

    await channel.onSyncError(new SyncError("bad", { statusCode: "M_UNKNOWN_TOKEN" }));
    expect(channel.running).toBe(false);
    expect(client.stopSyncForeverCalled).toBe(true);

    await channel.onRoomInvite({ room_id: "!room:matrix.org" }, { sender: "@bob:matrix.org" });
    await channel.onRoomInvite({ room_id: "!room:matrix.org" }, { sender: "@alice:matrix.org" });
    expect(client.joinCalls).toEqual(["!room:matrix.org"]);
  });

  it("keeps the sync loop running for transient sync errors", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.running = true;

    await channel.onSyncError(new SyncError("oops", { statusCode: "M_LIMIT_EXCEEDED" }));

    expect(channel.running).toBe(true);
    expect(client.stopSyncForeverCalled).toBe(false);
  });

  it("ignores room invites when the allow list is empty", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ allowFrom: [] }, client);

    await channel.onRoomInvite({ room_id: "!room:matrix.org" }, { sender: "@alice:matrix.org" });

    expect(client.joinCalls).toEqual([]);
  });

  it("respects room invite allow lists when configured", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ allowFrom: ["@bob:matrix.org"] }, client);

    await channel.onRoomInvite({ room_id: "!room:matrix.org" }, { sender: "@alice:matrix.org" });
    await channel.onRoomInvite({ room_id: "!room:matrix.org" }, { sender: "@bob:matrix.org" });

    expect(client.joinCalls).toEqual(["!room:matrix.org"]);
  });

  it("applies mention and allowlist group policies before handling messages", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ groupPolicy: "mention" }, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    const room = { room_id: "!room:matrix.org", display_name: "Room", member_count: 3 };
    await channel.onMessage(room, { sender: "@alice:matrix.org", body: "hello", source: { content: {} } });
    expect(handled).toHaveLength(0);
    expect(client.typingCalls).toEqual([]);

    await channel.onMessage(room, {
      sender: "@alice:matrix.org",
      body: "hello",
      source: { content: { "m.mentions": { user_ids: ["@bot:matrix.org"] } } },
    });
    expect(handled[0].senderId).toBe("@alice:matrix.org");
    expect(client.typingCalls).toEqual([["!room:matrix.org", true, TYPING_NOTICE_TIMEOUT_MS]]);

    const allowClient = new FakeMatrixClient();
    const allowChannel = makeChannel({ groupPolicy: "allowlist", groupAllowFrom: ["!allowed:matrix.org"] }, allowClient);
    const allowHandled: any[] = [];
    (allowChannel as any).handleMessage = vi.fn(async (payload: any) => allowHandled.push(payload));
    await allowChannel.onMessage({ room_id: "!denied:matrix.org", member_count: 3 }, { sender: "@alice:matrix.org", body: "x", source: { content: {} } });
    await allowChannel.onMessage({ room_id: "!allowed:matrix.org", member_count: 3 }, { sender: "@alice:matrix.org", body: "x", source: { content: {} } });
    expect(allowHandled.map((item) => item.chatId)).toEqual(["!allowed:matrix.org"]);
  });

  it("skips self and pre-startup messages, and starts typing for fresh inbound text", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.startedAtMs = 1_000_000;
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));
    const room = { room_id: "!room:matrix.org", display_name: "Room", member_count: 2 };

    await channel.onMessage(room, { sender: "@bot:matrix.org", body: "self", source: {} });
    await channel.onMessage(room, { sender: "@alice:matrix.org", body: "old", source: {}, server_timestamp: 999_999 });
    await channel.onMessage(room, { sender: "@alice:matrix.org", body: "fresh", source: {}, server_timestamp: 1_000_001 });

    expect(handled.map((item) => item.content)).toEqual(["fresh"]);
    expect(client.typingCalls).toEqual([["!room:matrix.org", true, TYPING_NOTICE_TIMEOUT_MS]]);
  });

  it("refreshes typing keepalive periodically and clears it on stop", async () => {
    vi.useFakeTimers();
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.running = true;

    await channel.startTypingKeepalive("!room:matrix.org");
    await vi.advanceTimersByTimeAsync(20_000);
    await channel.stopTypingKeepalive("!room:matrix.org", { clearTyping: true });

    const trueUpdates = client.typingCalls.filter((call) => call[1] === true);
    expect(trueUpdates.length).toBeGreaterThanOrEqual(2);
    expect(client.typingCalls.at(-1)).toEqual(["!room:matrix.org", false, TYPING_NOTICE_TIMEOUT_MS]);
  });

  it("skips denied senders before setting typing", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ allowFrom: ["@bob:matrix.org"] }, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMessage({ room_id: "!room:matrix.org", member_count: 2 }, { sender: "@alice:matrix.org", body: "Hello", source: {} });

    expect(handled).toEqual([]);
    expect(client.typingCalls).toEqual([]);
  });

  it("allows direct rooms under mention policy without Matrix mentions", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ groupPolicy: "mention" }, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMessage({ room_id: "!dm:matrix.org", display_name: "DM", member_count: 2 }, { sender: "@alice:matrix.org", body: "Hello", source: { content: {} } });

    expect(handled[0]).toEqual(expect.objectContaining({ chatId: "!dm:matrix.org", isDm: true }));
    expect(client.typingCalls).toEqual([["!dm:matrix.org", true, TYPING_NOTICE_TIMEOUT_MS]]);
  });

  it("requires opt-in before room-wide mentions satisfy mention policy", async () => {
    const deniedClient = new FakeMatrixClient();
    const denied = makeChannel({ groupPolicy: "mention", allowRoomMentions: false }, deniedClient);
    const allowedClient = new FakeMatrixClient();
    const allowed = makeChannel({ groupPolicy: "mention", allowRoomMentions: true }, allowedClient);
    const deniedHandled: any[] = [];
    const allowedHandled: any[] = [];
    (denied as any).handleMessage = vi.fn(async (payload: any) => deniedHandled.push(payload));
    (allowed as any).handleMessage = vi.fn(async (payload: any) => allowedHandled.push(payload));
    const room = { room_id: "!room:matrix.org", member_count: 3 };
    const event = { sender: "@alice:matrix.org", body: "Hello everyone", source: { content: { "m.mentions": { room: true } } } };

    await denied.onMessage(room, event);
    await allowed.onMessage(room, event);

    expect(deniedHandled).toEqual([]);
    expect(deniedClient.typingCalls).toEqual([]);
    expect(allowedHandled).toHaveLength(1);
    expect(allowedClient.typingCalls).toEqual([["!room:matrix.org", true, TYPING_NOTICE_TIMEOUT_MS]]);
  });

  it("adds thread metadata from threaded text events", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMessage(
      { room_id: "!room:matrix.org", display_name: "Room", member_count: 3 },
      {
        sender: "@alice:matrix.org",
        body: "Hello",
        event_id: "$reply1",
        source: { content: { "m.relates_to": { rel_type: "m.thread", event_id: "$root1" } } },
      },
    );

    expect(handled[0].metadata).toEqual(expect.objectContaining({
      eventId: "$reply1",
      threadRootEventId: "$root1",
      threadReplyToEventId: "$reply1",
    }));
  });

  it("stops typing when text handling raises", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    (channel as any).handleMessage = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      channel.onMessage({ room_id: "!room:matrix.org", member_count: 2 }, { sender: "@alice:matrix.org", body: "Hello", source: {} }),
    ).rejects.toThrow("boom");

    expect(client.typingCalls.at(-1)).toEqual(["!room:matrix.org", false, TYPING_NOTICE_TIMEOUT_MS]);
  });
});

describe("Matrix media", () => {
  it("skips media events older than channel startup", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.startedAtMs = 1_000_000;
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMediaMessage(
      { room_id: "!room:matrix.org", member_count: 2 },
      { sender: "@alice:matrix.org", body: "old.png", server_timestamp: 999_999, url: "mxc://example.org/old", source: { content: { msgtype: "m.image" } } },
    );

    expect(handled).toEqual([]);
    expect(client.downloadCalls).toEqual([]);
    expect(client.typingCalls).toEqual([]);
  });

  it("downloads inbound media, saves it, and includes attachment metadata", async () => {
    const client = new FakeMatrixClient();
    client.downloadBytes = Buffer.from("image");
    const channel = makeChannel({}, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMediaMessage(
      { room_id: "!room:matrix.org", display_name: "Room", member_count: 2 },
      {
        sender: "@alice:matrix.org",
        body: "photo.png",
        url: "mxc://example.org/media",
        event_id: "$event1",
        source: { content: { msgtype: "m.image", info: { mimetype: "image/png", size: 5 } } },
      },
    );

    expect(client.downloadCalls).toEqual([{ mxc: "mxc://example.org/media" }]);
    const mediaPath = handled[0].media[0];
    expect(mediaPath).toContain(`${path.sep}media${path.sep}matrix${path.sep}`);
    expect(fs.readFileSync(mediaPath, "utf8")).toBe("image");
    expect(handled[0].metadata.attachments[0]).toEqual(expect.objectContaining({ type: "image", mxcUrl: "mxc://example.org/media", path: mediaPath }));
    expect(handled[0].content).toContain("[attachment: ");
  });

  it("passes thread metadata through inbound media events", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMediaMessage(
      { room_id: "!room:matrix.org", display_name: "Room", member_count: 3 },
      {
        sender: "@alice:matrix.org",
        body: "photo.png",
        url: "mxc://example.org/media",
        event_id: "$reply1",
        source: { content: { msgtype: "m.image", "m.relates_to": { rel_type: "m.thread", event_id: "$root1" } } },
      },
    );

    expect(handled[0].metadata).toEqual(expect.objectContaining({
      eventId: "$reply1",
      threadRootEventId: "$root1",
      threadReplyToEventId: "$reply1",
    }));
  });

  it("honors declared and server media limits before downloading", async () => {
    const client = new FakeMatrixClient();
    client.contentRepositoryConfigResponse = { upload_size: 3 };
    const channel = makeChannel({ maxMediaBytes: 10 }, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMediaMessage(
      { room_id: "!room:matrix.org", member_count: 2 },
      {
        sender: "@alice:matrix.org",
        body: "large.bin",
        url: "mxc://example.org/large",
        event_id: "$event2",
        source: { content: { msgtype: "m.file", info: { size: 5 } } },
      },
    );

    expect(client.downloadCalls).toEqual([]);
    expect(handled[0].media).toEqual([]);
    expect(handled[0].metadata.attachments).toEqual([]);
    expect(handled[0].content).toContain("[attachment: large.bin - too large]");
  });

  it("decrypts encrypted inbound media with injected decryptor", async () => {
    tmpRoot();
    setMatrixAttachmentDecryptor(() => Buffer.from("plain"));
    const client = new FakeMatrixClient();
    client.downloadBytes = Buffer.from("cipher");
    const channel = makeChannel({}, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMediaMessage(
      { room_id: "!room:matrix.org", member_count: 2 },
      {
        sender: "@alice:matrix.org",
        body: "secret.txt",
        url: "mxc://example.org/secret",
        event_id: "$event3",
        key: { k: "key" },
        hashes: { sha256: "hash" },
        iv: "iv",
        source: { content: { msgtype: "m.file" } },
      },
    );

    expect(fs.readFileSync(handled[0].media[0], "utf8")).toBe("plain");
    expect(handled[0].metadata.attachments[0]).toEqual(expect.objectContaining({ encrypted: true, sizeBytes: 5 }));
  });

  it("handles download errors without attaching media", async () => {
    const client = new FakeMatrixClient();
    client.downloadResponse = new DownloadError("download failed");
    const channel = makeChannel({}, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMediaMessage(
      { room_id: "!room:matrix.org", member_count: 2 },
      { sender: "@alice:matrix.org", body: "broken.png", url: "mxc://example.org/broken", event_id: "$broken", source: { content: { msgtype: "m.image" } } },
    );

    expect(handled[0].media).toEqual([]);
    expect(handled[0].metadata.attachments).toEqual([]);
    expect(handled[0].content).toContain("[attachment: broken.png - download failed]");
  });

  it("handles encrypted media decrypt failures without attaching media", async () => {
    const client = new FakeMatrixClient();
    client.downloadBytes = Buffer.from("cipher");
    const channel = makeChannel({}, client);
    const handled: any[] = [];
    (channel as any).handleMessage = vi.fn(async (payload: any) => handled.push(payload));

    await channel.onMediaMessage(
      { room_id: "!room:matrix.org", member_count: 2 },
      {
        sender: "@alice:matrix.org",
        body: "secret.txt",
        url: "mxc://example.org/secret",
        event_id: "$secret",
        key: { k: "key" },
        hashes: { sha256: "hash" },
        iv: "iv",
        source: { content: { msgtype: "m.file" } },
      },
    );

    expect(handled[0].media).toEqual([]);
    expect(handled[0].metadata.attachments).toEqual([]);
    expect(handled[0].content).toContain("[attachment: secret.txt - download failed]");
  });

  it("stops typing when media handling raises", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    (channel as any).handleMessage = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      channel.onMediaMessage(
        { room_id: "!room:matrix.org", member_count: 2 },
        { sender: "@alice:matrix.org", body: "photo.png", url: "mxc://example.org/media", event_id: "$event", source: { content: { msgtype: "m.image" } } },
      ),
    ).rejects.toThrow("boom");

    expect(client.typingCalls.at(-1)).toEqual(["!room:matrix.org", false, TYPING_NOTICE_TIMEOUT_MS]);
  });

  it("uploads outbound attachments and uses encrypted payloads in encrypted rooms", async () => {
    const root = tmpRoot();
    const file = path.join(root, "secret.txt");
    fs.writeFileSync(file, "topsecret");
    const client = new FakeMatrixClient();
    client.rooms["!encrypted:matrix.org"] = { encrypted: true };
    client.uploadResponse = [{ content_uri: "mxc://example.org/uploaded" }, { hashes: { sha256: "hash" }, key: { k: "key" }, iv: "iv" }];
    const channel = makeChannel({ e2eeEnabled: true }, client);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!encrypted:matrix.org", content: "see file", media: [file] }));

    expect(client.uploadCalls[0]).toEqual(expect.objectContaining({ filename: "secret.txt", filesize: 9, encrypt: true }));
    expect(typeof client.uploadCalls[0].dataProvider.read).toBe("function");
    expect(client.roomSendCalls[0].content.file.url).toBe("mxc://example.org/uploaded");
    expect(client.roomSendCalls[0].content.url).toBeUndefined();
    expect(client.roomSendCalls[1].content.body).toBe("see file");
  });

  it("blocks outbound media outside a restricted workspace and reports upload failures", async () => {
    const root = tmpRoot();
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const external = path.join(root, "external.txt");
    fs.writeFileSync(external, "outside");
    const client = new FakeMatrixClient();
    const channel = new MatrixChannel(new MatrixConfig({ allowFrom: ["*"], accessToken: "t", userId: "@bot:matrix.org" }), new MessageBus(), {
      restrictToWorkspace: true,
      workspace,
    });
    channel.client = client;

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "", media: [external] }));

    expect(client.uploadCalls).toEqual([]);
    expect(client.roomSendCalls[0].content.body).toBe("[attachment: external.txt - upload failed]");
  });
});

describe("Matrix send and streaming", () => {
  it("sends text with E2EE options and clears typing for final sends", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "Hi" }));

    expect(client.roomSendCalls[0]).toEqual({
      roomId: "!room:matrix.org",
      messageType: "m.room.message",
      content: { msgtype: "m.text", body: "Hi", "m.mentions": {} },
      ignoreUnverifiedDevices: true,
    });
    expect(client.typingCalls.at(-1)).toEqual(["!room:matrix.org", false, TYPING_NOTICE_TIMEOUT_MS]);
  });

  it("omits ignoreUnverifiedDevices when E2EE is disabled", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({ e2eeEnabled: false }, client);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "Hi" }));

    expect(client.roomSendCalls[0]).not.toHaveProperty("ignoreUnverifiedDevices");
  });

  it("does not send empty or whitespace-only text messages", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "" }));
    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "   " }));

    expect(client.roomSendCalls).toEqual([]);
    expect(client.typingCalls.at(-1)).toEqual(["!room:matrix.org", false, TYPING_NOTICE_TIMEOUT_MS]);
  });

  it("clears typing when a final send fails", async () => {
    const client = new FakeMatrixClient();
    client.raiseOnSend = true;
    const channel = makeChannel({}, client);

    await expect(channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "Hi" }))).rejects.toThrow("send failed");

    expect(client.typingCalls.at(-1)).toEqual(["!room:matrix.org", false, TYPING_NOTICE_TIMEOUT_MS]);
  });

  it("adds thread relations to final text sends", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await channel.send(new OutboundMessage({
      channel: "matrix",
      chatId: "!room:matrix.org",
      content: "thread reply",
      metadata: { threadRootEventId: "$root", threadReplyToEventId: "$reply" },
    }));

    expect(client.roomSendCalls[0].content["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: "$root",
      "m.in_reply_to": { event_id: "$reply" },
      is_falling_back: true,
    });
  });

  it("does not parse attachment markers when no outbound media is present", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "[attachment: /tmp/file.txt]" }));

    expect(client.uploadCalls).toEqual([]);
    expect(client.roomSendCalls[0].content.body).toBe("[attachment: /tmp/file.txt]");
  });

  it("passes thread relations to outbound attachment uploads", async () => {
    const root = tmpRoot();
    const file = path.join(root, "note.txt");
    fs.writeFileSync(file, "hello");
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await channel.send(new OutboundMessage({
      channel: "matrix",
      chatId: "!room:matrix.org",
      content: "",
      media: [file],
      metadata: { threadRootEventId: "$root", threadReplyToEventId: "$reply" },
    }));

    expect(client.roomSendCalls[0].content["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: "$root",
      "m.in_reply_to": { event_id: "$reply" },
      is_falling_back: true,
    });
  });

  it("keeps typing alive for progress sends and skips empty progress messages", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.running = true;
    await channel.startTypingKeepalive("!room:matrix.org");
    expect(channel.typingTasks.has("!room:matrix.org")).toBe(true);

    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "working", metadata: { agentProgress: true } }));
    expect(channel.typingTasks.has("!room:matrix.org")).toBe(true);
    expect(client.typingCalls.at(-1)).toEqual(["!room:matrix.org", true, TYPING_NOTICE_TIMEOUT_MS]);

    const before = client.roomSendCalls.length;
    await channel.send(new OutboundMessage({ channel: "matrix", chatId: "!room:matrix.org", content: "   ", metadata: { agentProgress: true } }));
    expect(client.roomSendCalls.length).toBe(before);
    await channel.stop();
  });

  it("streams by creating one event, throttling edits, and replacing at stream end", async () => {
    const client = new FakeMatrixClient();
    client.roomSendResponse = new RoomSendResponse({ eventId: "$stream", roomId: "!room:matrix.org" });
    const channel = makeChannel({}, client);
    const times = [100, 101, 103].reverse();
    channel.monotonicTime = () => times.pop() ?? 103;

    await channel.sendDelta("!room:matrix.org", "Hello");
    await channel.sendDelta("!room:matrix.org", " world");
    expect(client.roomSendCalls).toHaveLength(1);
    expect(channel.streamBuffers["!room:matrix.org"].text).toBe("Hello world");

    await channel.sendDelta("!room:matrix.org", "!");
    expect(client.roomSendCalls).toHaveLength(2);
    expect(client.roomSendCalls[1].content["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$stream" });

    await channel.sendDelta("!room:matrix.org", "", { streamEnd: true });
    expect(channel.streamBuffers["!room:matrix.org"]).toBeUndefined();
    expect(client.roomSendCalls[2].content.body).toBe("Hello world!");
    expect(client.typingCalls.at(-1)).toEqual(["!room:matrix.org", false, TYPING_NOTICE_TIMEOUT_MS]);
  });

  it("does nothing on stream end when no stream buffer exists", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await channel.sendDelta("!room:matrix.org", "", { streamEnd: true });

    expect(client.roomSendCalls).toEqual([]);
    expect(client.typingCalls).toEqual([]);
  });

  it("stops typing when streaming edits fail", async () => {
    const client = new FakeMatrixClient();
    client.raiseOnSend = true;
    const channel = makeChannel({}, client);
    await channel.startTypingKeepalive("!room:matrix.org");

    await channel.sendDelta("!room:matrix.org", "Hello");

    expect(client.typingCalls.at(-1)).toEqual(["!room:matrix.org", false, TYPING_NOTICE_TIMEOUT_MS]);
  });

  it("ignores whitespace-only streaming deltas", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);

    await channel.sendDelta("!room:matrix.org", "   ");

    expect(client.roomSendCalls).toEqual([]);
    expect(channel.streamBuffers["!room:matrix.org"].text).toBe("   ");
  });

  it("preserves thread relation inside streaming replacements", async () => {
    const client = new FakeMatrixClient();
    const channel = makeChannel({}, client);
    channel.streamBuffers["!room:matrix.org"] = new StreamBuffer({ text: "Final", eventId: "$event", lastEdit: 100 });
    const metadata = { threadRootEventId: "$root", threadReplyToEventId: "$reply", streamEnd: true };

    await channel.sendDelta("!room:matrix.org", "", metadata);

    expect(client.roomSendCalls[0].content["m.relates_to"]).toEqual({ rel_type: "m.replace", event_id: "$event" });
    expect(client.roomSendCalls[0].content["m.new_content"]["m.relates_to"]).toEqual({
      rel_type: "m.thread",
      event_id: "$root",
      "m.in_reply_to": { event_id: "$reply" },
      is_falling_back: true,
    });
  });
});
