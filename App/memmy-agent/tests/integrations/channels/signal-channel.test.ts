import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { approveCode, generateCode, setStorePathForTests } from "../../../src/integrations/channel-auth/store.js";
import {
  SignalChannel,
  SignalConfig,
  SignalDMConfig,
  SignalGroupConfig,
  markdownToSignal,
  partitionStyles,
} from "../../../src/integrations/channels/signal.js";

const eventSourceMock = vi.hoisted(() => {
  const api: any = { instances: [] as any[] };
  api.EventSource = vi.fn(function MockEventSource(this: any, url: string) {
    this.url = url;
    this.close = vi.fn();
    api.instances.push(this);
  });
  api.reset = () => {
    api.instances = [];
    api.EventSource.mockClear();
    api.EventSource.mockImplementation(function MockEventSource(this: any, url: string) {
      this.url = url;
      this.close = vi.fn();
      api.instances.push(this);
    });
  };
  return api;
});

vi.mock("eventsource", () => ({ EventSource: eventSourceMock.EventSource }));

const oldConfig = process.env.MEMMY_CONFIG;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-signal-"));
  roots.push(root);
  process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  eventSourceMock.reset();
  process.env.MEMMY_CONFIG = oldConfig;
  setStorePathForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class FakeResponse {
  statusCode = 200;
  body: any;
  constructor(body: any = { result: { timestamp: 123 } }) {
    this.body = body;
  }
  raiseForStatus(): void {}
  json(): any {
    return this.body;
  }
}

class FakeHTTPClient {
  posts: any[] = [];
  closed = false;
  async post(pathname: string, kwargs: any): Promise<FakeResponse> {
    this.posts.push({ path: pathname, json: kwargs.json });
    return new FakeResponse();
  }
  async aclose(): Promise<void> {
    this.closed = true;
  }
}

class FakeStream {
  constructor(
    private readonly lines: string[],
    readonly statusCode = 200,
  ) {}

  async *iterLines(): AsyncGenerator<string> {
    for (const line of this.lines) yield line;
  }
}

class FakeStreamingClient {
  constructor(
    private readonly lines: string[],
    private readonly statusCode = 200,
  ) {}

  stream(): FakeStream {
    return new FakeStream(this.lines, this.statusCode);
  }
}

function makeChannel(overrides: Record<string, any> = {}): SignalChannel {
  const dm = new SignalDMConfig({
    enabled: overrides.dmEnabled ?? true,
    policy: overrides.dmPolicy ?? "open",
    allowFrom: overrides.dmAllowFrom ?? [],
  });
  const group = new SignalGroupConfig({
    enabled: overrides.groupEnabled ?? false,
    policy: overrides.groupPolicy ?? "open",
    allowFrom: overrides.groupAllowFrom ?? [],
    requireMention: overrides.requireMention ?? true,
  });
  return new SignalChannel(
    new SignalConfig({
      enabled: true,
      phoneNumber: overrides.phoneNumber ?? "+10000000000",
      groupMessageBufferSize: overrides.groupMessageBufferSize ?? 20,
      attachmentsDir: overrides.attachmentsDir ?? null,
      dm,
      group,
    }),
    new MessageBus(),
  );
}

function dmEnvelope(opts: Record<string, any> = {}): any {
  const dataMessage: Record<string, any> = {
    message: opts.message ?? "hello",
    timestamp: opts.timestamp ?? 1000,
  };
  if (opts.attachments) dataMessage.attachments = opts.attachments;
  if (opts.reaction) dataMessage.reaction = opts.reaction;
  return {
    envelope: {
      sourceNumber: opts.sourceNumber ?? "+19995550001",
      sourceName: opts.sourceName ?? "Alice",
      sourceUuid: opts.sourceUuid,
      dataMessage,
    },
  };
}

function groupEnvelope(opts: Record<string, any> = {}): any {
  const dataMessage: Record<string, any> = {
    message: opts.message ?? "hello group",
    timestamp: opts.timestamp ?? 2000,
    mentions: opts.mentions ?? [],
  };
  dataMessage[opts.useV2 ? "groupV2" : "groupInfo"] = { groupId: opts.groupId ?? "grp==" };
  return {
    envelope: {
      sourceNumber: opts.sourceNumber ?? "+19995550001",
      sourceName: opts.sourceName ?? "Bob",
      dataMessage,
    },
  };
}

function captureHandled(channel: SignalChannel): any[] {
  const handled: any[] = [];
  channel.startTyping = async () => undefined;
  channel.stopTyping = async () => undefined;
  channel.handleMessage = async (kwargs: any) => {
    handled.push(kwargs);
  };
  return handled;
}

describe("Signal markdown helpers", () => {
  it("converts common markdown to Signal plain text and textStyle ranges", () => {
    const [plain, styles] = markdownToSignal("say **hello** and `ls`");
    expect(plain).toBe("say hello and ls");
    expect(styles).toEqual(expect.arrayContaining(["4:5:BOLD", "14:2:MONOSPACE"]));

    const [tablePlain, tableStyles] = markdownToSignal("| A | B |\n| - | - |\n| 1 | 2 |");
    expect(tablePlain).toContain("A  B");
    expect(tableStyles.some((style) => style.includes("MONOSPACE"))).toBe(true);
  });

  it("rebases style ranges when long Signal messages are split", () => {
    const [plain, styles] = markdownToSignal("**head** middle and **tail**");
    const chunks = ["head middle", "and tail"];
    const partitioned = partitionStyles(plain, chunks, styles);
    expect(partitioned[0].some((style) => style.endsWith(":BOLD"))).toBe(true);
    expect(partitioned[1].some((style) => style.endsWith(":BOLD"))).toBe(true);
  });
});

describe("SignalChannel utilities and policy", () => {
  it("aggregates direct-message and group allowFrom values in config", () => {
    const config = new SignalConfig({
      dm: new SignalDMConfig({ allowFrom: ["+1"] }),
      group: new SignalGroupConfig({ allowFrom: ["grp=="] }),
    });

    expect(config.allowFrom).toEqual(["+1", "grp=="]);
  });

  it("propagates wildcard allowFrom entries", () => {
    const config = new SignalConfig({
      dm: new SignalDMConfig({ allowFrom: ["*"] }),
      group: new SignalGroupConfig({ allowFrom: ["grp=="] }),
    });

    expect(config.allowFrom).toEqual(["*", "grp=="]);
  });

  it("normalizes ids, extracts group ids, and builds recipient params", () => {
    expect(SignalChannel.normalizeSignalId("+12345678901")).toEqual(expect.arrayContaining(["+12345678901", "12345678901"]));
    expect(SignalChannel.normalizeSignalId("SOME-UUID")).toContain("some-uuid");
    expect(SignalChannel.collectSenderIdParts({ sourceNumber: "+1", sourceUuid: "uuid" })).toEqual(["+1", "uuid"]);
    expect(SignalChannel.primarySenderId(["uuid", "+1"])).toBe("+1");
    expect(SignalChannel.extractGroupId({ groupId: "g1" }, { id: "g2" })).toBe("g1");

    const channel = makeChannel();
    expect(channel.recipientParams("abc==")).toEqual({ groupId: "abc==" });
    expect(channel.recipientParams("+12345678901")).toEqual({ recipient: ["+12345678901"] });
  });

  it("keeps and strips phone-number variants during id normalization", () => {
    expect(SignalChannel.normalizeSignalId("+12345678901")).toEqual([
      "+12345678901",
      "12345678901",
    ]);
  });

  it("adds a plus-prefixed variant for digit-only ids", () => {
    expect(SignalChannel.normalizeSignalId("12345678901")).toEqual([
      "12345678901",
      "+12345678901",
    ]);
  });

  it("adds lowercase variants for mixed-case ids", () => {
    expect(SignalChannel.normalizeSignalId("ABC-Def")).toEqual(["ABC-Def", "abc-def"]);
  });

  it("returns no variants for empty ids", () => {
    expect(SignalChannel.normalizeSignalId("   ")).toEqual([]);
  });

  it("collects sender id parts from known envelope keys", () => {
    expect(
      SignalChannel.collectSenderIdParts({
        sourceNumber: "+1",
        source: "+2",
        sourceUuid: "uuid",
        sourceServiceId: "svc",
        sourceAci: "aci",
      }),
    ).toEqual(["+1", "+2", "uuid", "svc", "aci"]);
  });

  it("deduplicates sender id parts and ignores non-string values", () => {
    expect(
      SignalChannel.collectSenderIdParts({
        sourceNumber: "+1",
        source: "+1",
        sourceUuid: 42,
        sourceServiceId: "",
      }),
    ).toEqual(["+1"]);
  });

  it("prefers phone-like sender ids as primary", () => {
    expect(SignalChannel.primarySenderId(["uuid", "12345678901"])).toBe("12345678901");
    expect(SignalChannel.primarySenderId(["uuid", "+12345678901"])).toBe("+12345678901");
    expect(SignalChannel.primarySenderId(["uuid", "svc"])).toBe("uuid");
    expect(SignalChannel.primarySenderId([])).toBe("");
  });

  it("extracts group ids from groupInfo before groupV2", () => {
    expect(SignalChannel.extractGroupId({ groupId: "g1" }, { id: "g2" })).toBe("g1");
    expect(SignalChannel.extractGroupId(null, { id: "g2" })).toBe("g2");
    expect(SignalChannel.extractGroupId({}, {})).toBeNull();
  });

  it("distinguishes group chat ids from phone and uuid ids", () => {
    expect(SignalChannel.isGroupChatId("abc==")).toBe(true);
    expect(SignalChannel.isGroupChatId("a".repeat(44))).toBe(true);
    expect(SignalChannel.isGroupChatId("+12345678901")).toBe(false);
    expect(SignalChannel.isGroupChatId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("extracts mention id candidates from nested mention metadata", () => {
    expect(
      SignalChannel.mentionIdCandidates({
        number: "+123",
        user: { uuid: "UUID", profile: { serviceId: "svc" } },
      }),
    ).toEqual(["+123", "UUID", "svc"]);
  });

  it("validates mention spans", () => {
    expect(SignalChannel.mentionSpan({ start: 2, length: 3 })).toEqual([2, 3]);
    expect(SignalChannel.mentionSpan({ start: -1, length: 3 })).toBeNull();
    expect(SignalChannel.mentionSpan({ start: 0, length: 0 })).toBeNull();
    expect(SignalChannel.mentionSpan({})).toBeNull();
  });

  it("detects leading placeholder mention spans only at token boundaries", () => {
    expect(SignalChannel.leadingPlaceholderSpan("\ufffc hello")).toEqual([0, 1]);
    expect(SignalChannel.leadingPlaceholderSpan("  \ufffc hello")).toEqual([2, 1]);
    expect(SignalChannel.leadingPlaceholderSpan("x \ufffc hello")).toBeNull();
    expect(SignalChannel.leadingPlaceholderSpan("\ufffcword")).toBeNull();
    expect(SignalChannel.leadingPlaceholderSpan("")).toBeNull();
  });

  it("registers phone-number aliases on init and remembers uuid aliases", () => {
    const channel = makeChannel({ phoneNumber: "+12345678901" });

    expect(channel.idMatchesAccount("12345678901")).toBe(true);
    channel.rememberAccountIdAlias("Bot-UUID");
    expect(channel.idMatchesAccount("bot-uuid")).toBe(true);
    expect(channel.idMatchesAccount("other")).toBe(false);
    expect(channel.idMatchesAccount(null)).toBe(false);
  });

  it("matches allowlists across phone variants and composite ids", () => {
    const channel = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: ["19995550001", "uuid-abc"] });
    expect(channel.isAllowed("+19995550001|other")).toBe(true);
    expect(channel.isAllowed("+111|UUID-ABC")).toBe(true);
    expect(channel.isAllowed("+222|other")).toBe(false);
  });

  it("matches allowlist entries from group allowFrom values", () => {
    const channel = makeChannel({ groupAllowFrom: ["grp=="] });

    expect(channel.isAllowed("grp==")).toBe(true);
  });

  it("detects and strips bot mentions in groups", () => {
    const channel = makeChannel({ groupEnabled: true, requireMention: true });
    channel.rememberAccountIdAlias("bot-uuid");

    expect(channel.shouldRespondInGroup("￼ hello", [{ uuid: "bot-uuid", start: 0, length: 1 }])).toBe(true);
    expect(channel.shouldRespondInGroup("plain talk", [])).toBe(false);
    expect(channel.shouldRespondInGroup("hey +10000000000", [])).toBe(true);
    expect(channel.stripBotMention("￼ hello", [{ start: 0, length: 1 }])).toBe("hello");
  });

  it("does not require mentions when group mention requirement is disabled", () => {
    const channel = makeChannel({ groupEnabled: true, requireMention: false });

    expect(channel.shouldRespondInGroup("plain talk", [])).toBe(true);
  });

  it("accepts identifier-less leading mentions but rejects mid-text ones", () => {
    const channel = makeChannel({ groupEnabled: true, requireMention: true });

    expect(channel.shouldRespondInGroup("\ufffc hello", [{ start: 0, length: 1 }])).toBe(true);
    expect(channel.shouldRespondInGroup("hey \ufffc", [{ start: 4, length: 1 }])).toBe(false);
  });

  it("strips only bot mentions and keeps non-bot mid-text mentions", () => {
    const channel = makeChannel({ groupEnabled: true, requireMention: true });
    channel.rememberAccountIdAlias("bot-uuid");

    expect(channel.stripBotMention("\ufffc hello", [{ start: 0, length: 1, uuid: "bot-uuid" }])).toBe("hello");
    expect(channel.stripBotMention("hi \ufffc there", [{ start: 3, length: 1, uuid: "other" }])).toBe("hi \ufffc there");
    expect(channel.stripBotMention("", [])).toBe("");
  });

  it("keeps rolling group context and validates buffer size", () => {
    const channel = makeChannel({ groupMessageBufferSize: 3 });
    for (let index = 0; index < 5; index += 1) channel.addToGroupBuffer("g1", "Alice", "+1", `msg${index}`, index);
    expect(channel.groupBuffers.g1).toHaveLength(3);
    expect(channel.getGroupBufferContext("g1")).toContain("msg2");
    expect(channel.getGroupBufferContext("g1")).not.toContain("msg4");
    expect(() => makeChannel({ groupMessageBufferSize: 0 })).toThrow(/groupMessageBufferSize/);
  });

  it("returns empty group context for unknown or single-message groups", () => {
    const channel = makeChannel();

    expect(channel.getGroupBufferContext("missing")).toBe("");
    channel.addToGroupBuffer("g1", "Alice", "+1", "one", 1);
    expect(channel.getGroupBufferContext("g1")).toBe("");
  });

  it("truncates long group context messages", () => {
    const channel = makeChannel({ groupMessageBufferSize: 3 });
    channel.addToGroupBuffer("g1", "Alice", "+1", "x".repeat(250), 1);
    channel.addToGroupBuffer("g1", "Bob", "+2", "latest", 2);

    expect(channel.getGroupBufferContext("g1")).toBe(`Alice: ${"x".repeat(200)}`);
  });

  it("allows open direct messages through inbound policy", () => {
    const channel = makeChannel({ dmEnabled: true, dmPolicy: "open" });

    expect(
      channel.checkInboundPolicy({
        senderId: "+19995550001",
        senderNumber: "+19995550001",
        isGroupMessage: false,
        messageText: "hi",
      }),
    ).toEqual([true, "+19995550001"]);
  });

  it("blocks disabled or unknown allowlist direct messages", () => {
    const disabled = makeChannel({ dmEnabled: false });
    const allowlist = makeChannel({ dmEnabled: true, dmPolicy: "allowlist", dmAllowFrom: ["+12223334444"] });

    expect(
      disabled.checkInboundPolicy({
        senderId: "+19995550001",
        senderNumber: "+19995550001",
        isGroupMessage: false,
        messageText: "hi",
      })[0],
    ).toBe(false);
    expect(
      allowlist.checkInboundPolicy({
        senderId: "+19995550001",
        senderNumber: "+19995550001",
        isGroupMessage: false,
        messageText: "hi",
      })[0],
    ).toBe(false);
  });

  it("allows known allowlist direct-message senders", () => {
    const channel = makeChannel({ dmEnabled: true, dmPolicy: "allowlist", dmAllowFrom: ["19995550001"] });

    expect(
      channel.checkInboundPolicy({
        senderId: "+19995550001",
        senderNumber: "+19995550001",
        isGroupMessage: false,
        messageText: "hi",
      })[0],
    ).toBe(true);
  });

  it("blocks disabled groups and unknown allowlist groups", () => {
    const disabled = makeChannel({ groupEnabled: false });
    const allowlist = makeChannel({ groupEnabled: true, groupPolicy: "allowlist", groupAllowFrom: ["other=="] });

    expect(
      disabled.checkInboundPolicy({
        senderId: "+1",
        senderNumber: "+1",
        groupId: "grp==",
        isGroupMessage: true,
        messageText: "hi",
      })[0],
    ).toBe(false);
    expect(
      allowlist.checkInboundPolicy({
        senderId: "+1",
        senderNumber: "+1",
        groupId: "grp==",
        isGroupMessage: true,
        messageText: "hi",
      })[0],
    ).toBe(false);
  });

  it("allows mentioned or command group messages through inbound policy", () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: true });

    expect(
      channel.checkInboundPolicy({
        senderId: "+1",
        senderNumber: "+1",
        groupId: "g1",
        isGroupMessage: true,
        messageText: "hello @bot",
        mentions: [{ number: "+10000000000", start: 6, length: 4 }],
      }),
    ).toEqual([true, "g1"]);
    expect(
      channel.checkInboundPolicy({
        senderId: "+1",
        senderNumber: "+1",
        groupId: "g1",
        isGroupMessage: true,
        messageText: "/help",
      })[0],
    ).toBe(true);
  });

  it("blocks unmentioned group messages when mention is required", () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: true });

    expect(
      channel.checkInboundPolicy({
        senderId: "+1",
        senderNumber: "+1",
        groupId: "g1",
        isGroupMessage: true,
        messageText: "plain talk",
      })[0],
    ).toBe(false);
  });

  it("appends allowed group messages to the rolling buffer only", () => {
    const allowed = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: false });
    const blocked = makeChannel({ groupEnabled: false });

    allowed.checkInboundPolicy({
      senderId: "+1",
      senderNumber: "+1",
      groupId: "g1",
      isGroupMessage: true,
      messageText: "first",
      senderName: "Alice",
      timestamp: 1,
    });
    allowed.checkInboundPolicy({
      senderId: "+2",
      senderNumber: "+2",
      groupId: "g1",
      isGroupMessage: true,
      messageText: "second",
      senderName: "Bob",
      timestamp: 2,
    });
    blocked.checkInboundPolicy({
      senderId: "+1",
      senderNumber: "+1",
      groupId: "blocked==",
      isGroupMessage: true,
      messageText: "hi",
    });

    expect(allowed.groupBuffers.g1).toHaveLength(2);
    expect(blocked.groupBuffers["blocked=="]).toBeUndefined();
  });

  it("resolves default and configured Signal attachments directories", () => {
    expect(makeChannel().signalAttachmentsDir()).toBe(
      path.join(os.homedir(), ".local/share/signal-cli/attachments"),
    );
    expect(makeChannel({ attachmentsDir: "/tmp/signal-attachments" }).signalAttachmentsDir()).toBe(
      "/tmp/signal-attachments",
    );
    expect(makeChannel({ attachmentsDir: "~/signal-attachments" }).signalAttachmentsDir()).toBe(
      path.join(os.homedir(), "signal-attachments"),
    );
  });

  it("collects sourceNumber sender ids", () => {
    expect(SignalChannel.collectSenderIdParts({ sourceNumber: "+19995550001" })).toEqual(["+19995550001"]);
  });

  it("returns no sender id parts for empty envelopes", () => {
    expect(SignalChannel.collectSenderIdParts({})).toEqual([]);
  });

  it("extracts group ids from groupV2 metadata", () => {
    expect(SignalChannel.extractGroupId(null, { groupId: "grp-v2==" })).toBe("grp-v2==");
  });

  it("returns null when group metadata is not an object", () => {
    expect(SignalChannel.extractGroupId("bad", 42)).toBeNull();
  });

  it("rejects negative Signal group buffer sizes", () => {
    expect(() => makeChannel({ groupMessageBufferSize: -1 })).toThrow(/groupMessageBufferSize/);
  });

  it("keeps group context below the per-message limit", () => {
    const channel = makeChannel({ groupMessageBufferSize: 5 });
    channel.addToGroupBuffer("g1", "Alice", "+1111", "x".repeat(500), 1000);
    channel.addToGroupBuffer("g1", "Bob", "+2222", "short", 2000);

    const context = channel.getGroupBufferContext("g1");
    expect(context.split("Alice: ", 2)[1]).toHaveLength(200);
  });
});

describe("SignalChannel inbound routing", () => {
  it("routes open DMs with metadata and ignores reactions/receipts", async () => {
    const channel = makeChannel({ dmPolicy: "open" });
    const handled: any[] = [];
    channel.startTyping = async () => undefined;
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.handleReceiveNotification(dmEnvelope({ sourceUuid: "uuid-abc", sourceName: "Alice", timestamp: 9999 }));
    await channel.handleReceiveNotification(dmEnvelope({ reaction: { emoji: "👍" } }));
    await channel.handleReceiveNotification({ envelope: { sourceNumber: "+1", receiptMessage: { when: 1 } } });

    expect(handled).toHaveLength(1);
    expect(handled[0].senderId).toContain("+19995550001");
    expect(handled[0].senderId).toContain("uuid-abc");
    expect(handled[0].content).toBe("hello");
    expect(handled[0].metadata).toMatchObject({ senderName: "Alice", timestamp: 9999, isGroup: false });
  });

  it("sends a pairing reply for denied allowlist DMs", async () => {
    const channel = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: [] });
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550002" }));

    expect(http.posts).toHaveLength(1);
    expect(http.posts[0].json.method).toBe("send");
    expect(http.posts[0].json.params.message.toLowerCase()).toContain("pairing");
  });

  it("publishes open direct messages through the real bus path", async () => {
    const bus = new MessageBus();
    const channel = new SignalChannel(
      new SignalConfig({
        enabled: true,
        phoneNumber: "+10000000000",
        dm: new SignalDMConfig({ enabled: true, policy: "open" }),
      }),
      bus,
    );
    channel.startTyping = async () => undefined;

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550001", message: "hello" }));

    const inbound = await bus.nextInbound();
    expect(inbound.content).toBe("hello");
    expect(inbound.senderId).toBe("+19995550001");
  });

  it("does not leak denied direct messages through open group policy", async () => {
    const channel = makeChannel({
      dmEnabled: true,
      dmPolicy: "allowlist",
      dmAllowFrom: [],
      groupEnabled: true,
      groupPolicy: "open",
    });
    const http = new FakeHTTPClient();
    const handled = captureHandled(channel);
    channel.httpClient = http;

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550002", message: "hello" }));

    expect(handled).toEqual([]);
    expect(http.posts).toHaveLength(1);
  });

  it("allows paired direct-message senders without allowlist entries", () => {
    const root = tmpRoot();
    setStorePathForTests(path.join(root, "pairing.json"));
    const code = generateCode("signal", "+19995550002");
    approveCode(code);
    const channel = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: [] });

    expect(channel.isAllowed("+19995550002")).toBe(true);
    expect(channel.isAllowed("19995550002")).toBe(true);
    expect(channel.isAllowed("+19995559999")).toBe(false);
  });

  it("accepts explicitly allowlisted direct messages", async () => {
    const channel = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: ["+19995550001"] });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550001" }));

    expect(handled).toHaveLength(1);
  });

  it("accepts allowlisted direct messages across phone and uuid variants", async () => {
    const plusless = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: ["19995550001"] });
    const pluslessHandled = captureHandled(plusless);
    await plusless.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550001" }));

    const prefixed = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: ["+19995550001"] });
    const prefixedHandled = captureHandled(prefixed);
    const nonPrefixedEnvelope = dmEnvelope({ sourceNumber: "+19995550001" });
    nonPrefixedEnvelope.envelope.sourceNumber = "19995550001";
    await prefixed.handleReceiveNotification(nonPrefixedEnvelope);

    const uuid = "ABCDEF12-3456-7890-ABCD-EF1234567890";
    const uuidChannel = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: [uuid.toLowerCase()] });
    const uuidHandled = captureHandled(uuidChannel);
    await uuidChannel.handleReceiveNotification(dmEnvelope({ sourceUuid: uuid }));

    expect(pluslessHandled).toHaveLength(1);
    expect(prefixedHandled).toHaveLength(1);
    expect(uuidHandled).toHaveLength(1);
  });

  it("matches direct-message allowlists without plus prefixes", async () => {
    const channel = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: ["19995550001"] });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550001" }));

    expect(handled).toHaveLength(1);
  });

  it("matches direct-message allowlists with plus prefixes against non-prefixed senders", async () => {
    const channel = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: ["+19995550001"] });
    const handled = captureHandled(channel);
    const envelope = dmEnvelope({ sourceNumber: "+19995550001" });
    envelope.envelope.sourceNumber = "19995550001";

    await channel.handleReceiveNotification(envelope);

    expect(handled).toHaveLength(1);
  });

  it("matches direct-message uuid allowlists case-insensitively", async () => {
    const uuid = "ABCDEF12-3456-7890-ABCD-EF1234567890";
    const channel = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: [uuid.toLowerCase()] });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ sourceUuid: uuid }));

    expect(handled).toHaveLength(1);
  });

  it("accepts allowlist entries written as phone and uuid composites", async () => {
    const composite = "+19995550001|1872ba20-f52a-4bad-b434-bf7f808c8b22";
    const channel = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: [composite] });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(
      dmEnvelope({
        sourceNumber: "+19995550001",
        sourceUuid: "1872ba20-f52a-4bad-b434-bf7f808c8b22",
      }),
    );

    expect(handled).toHaveLength(1);
  });

  it("ignores disabled, empty, reaction, receipt, typing, and malformed direct notifications", async () => {
    const disabled = makeChannel({ dmEnabled: false });
    const disabledHandled = captureHandled(disabled);
    await disabled.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550001" }));

    const channel = makeChannel({ dmPolicy: "open" });
    const handled = captureHandled(channel);
    await channel.handleReceiveNotification(dmEnvelope({ message: "" }));
    await channel.handleReceiveNotification(dmEnvelope({ reaction: { emoji: "like" } }));
    await channel.handleReceiveNotification({ envelope: { sourceNumber: "+1", receiptMessage: { when: 1 } } });
    await channel.handleReceiveNotification({ envelope: { sourceNumber: "+1", typingMessage: { action: "STARTED" } } });
    await channel.handleReceiveNotification({});

    expect(disabledHandled).toEqual([]);
    expect(handled).toEqual([]);
  });

  it("rejects disabled direct messages", async () => {
    const channel = makeChannel({ dmEnabled: false });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550001" }));

    expect(handled).toEqual([]);
  });

  it("ignores direct-message reactions", async () => {
    const channel = makeChannel({ dmPolicy: "open" });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ reaction: { emoji: "like" } }));

    expect(handled).toEqual([]);
  });

  it("ignores empty direct messages without attachments", async () => {
    const channel = makeChannel({ dmPolicy: "open" });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ message: "" }));

    expect(handled).toEqual([]);
  });

  it("ignores direct-message receipts", async () => {
    const channel = makeChannel({ dmPolicy: "open" });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification({ envelope: { sourceNumber: "+1", receiptMessage: { when: 1 } } });

    expect(handled).toEqual([]);
  });

  it("ignores direct-message typing indicators", async () => {
    const channel = makeChannel({ dmPolicy: "open" });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification({ envelope: { sourceNumber: "+1", typingMessage: { action: "STARTED" } } });

    expect(handled).toEqual([]);
  });

  it("ignores notifications without envelopes", async () => {
    const channel = makeChannel({ dmPolicy: "open" });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification({});

    expect(handled).toEqual([]);
  });

  it("passes direct-message metadata to the handler", async () => {
    const channel = makeChannel({ dmPolicy: "open" });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ sourceName: "Alice", timestamp: 9999 }));

    expect(handled[0].metadata).toMatchObject({ senderName: "Alice", timestamp: 9999, isGroup: false });
  });

  it("combines direct-message sender number and uuid variants", async () => {
    const channel = makeChannel({ dmPolicy: "open" });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550001", sourceUuid: "uuid-abc" }));

    expect(handled[0].senderId).toContain("+19995550001");
    expect(handled[0].senderId).toContain("uuid-abc");
  });

  it("stops typing when direct-message handling fails", async () => {
    const channel = makeChannel({ dmPolicy: "open" });
    const stopped: string[] = [];
    channel.startTyping = async () => undefined;
    channel.stopTyping = async (chatId: string) => {
      stopped.push(chatId);
    };
    channel.handleMessage = async () => {
      throw new Error("boom");
    };

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550001" }));

    expect(stopped).toContain("+19995550001");
  });

  it("learns account uuid aliases from incoming self notifications", async () => {
    const channel = makeChannel({ dmPolicy: "open", phoneNumber: "+10000000000" });
    captureHandled(channel);

    await channel.handleReceiveNotification(
      dmEnvelope({ sourceNumber: "+10000000000", sourceUuid: "new-bot-uuid" }),
    );

    expect(channel.idMatchesAccount("new-bot-uuid")).toBe(true);
  });

  it("does not forward sync notifications or envelopes without a sender", async () => {
    const channel = makeChannel({ dmPolicy: "open" });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification({
      envelope: {
        sourceNumber: "+19995550001",
        syncMessage: { sentMessage: { message: "from self" } },
      },
    });
    await channel.handleReceiveNotification({ envelope: { dataMessage: { message: "missing sender" } } });

    expect(handled).toEqual([]);
  });

  it("routes group messages with mention rules and prepends context", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: false });
    const handled: any[] = [];
    channel.startTyping = async () => undefined;
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", sourceName: "Alice", message: "first" }));
    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", sourceName: "Bob", message: "second" }));

    expect(handled).toHaveLength(2);
    expect(handled[0].content).toContain("[Alice]: first");
    expect(handled[1].content).toContain("[Recent group messages for context:]");
    expect(handled[1].content).toContain("Alice: first");
    expect(handled[1].metadata).toMatchObject({ isGroup: true, groupId: "grp==" });
  });

  it("blocks group notifications when disabled, unmentioned, or not allowlisted", async () => {
    const disabled = makeChannel({ groupEnabled: false });
    const disabledHandled = captureHandled(disabled);
    await disabled.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hi" }));

    const requireMention = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: true });
    const requireMentionHandled = captureHandled(requireMention);
    await requireMention.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hey everyone" }));

    const allowlist = makeChannel({ groupEnabled: true, groupPolicy: "allowlist", groupAllowFrom: ["other=="] });
    const allowlistHandled = captureHandled(allowlist);
    await allowlist.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hi" }));

    expect(disabledHandled).toEqual([]);
    expect(requireMentionHandled).toEqual([]);
    expect(allowlistHandled).toEqual([]);
  });

  it("accepts allowlisted, mentioned, and groupV2 notifications", async () => {
    const allowlisted = makeChannel({
      groupEnabled: true,
      groupPolicy: "allowlist",
      groupAllowFrom: ["grp=="],
      requireMention: false,
    });
    const allowlistedHandled = captureHandled(allowlisted);
    await allowlisted.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hi" }));

    const mentioned = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: true });
    const mentionedHandled = captureHandled(mentioned);
    await mentioned.handleReceiveNotification(
      groupEnvelope({
        groupId: "grp==",
        message: "\ufffc hello",
        mentions: [{ number: "+10000000000", start: 0, length: 1 }],
      }),
    );

    const v2 = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: false });
    const v2Handled = captureHandled(v2);
    await v2.handleReceiveNotification(groupEnvelope({ groupId: "grpV2==", message: "hi", useV2: true }));

    expect(allowlistedHandled).toHaveLength(1);
    expect(mentionedHandled).toHaveLength(1);
    expect(v2Handled[0].chatId).toBe("grpV2==");
  });

  it("publishes open group messages through the real bus path", async () => {
    const bus = new MessageBus();
    const channel = new SignalChannel(
      new SignalConfig({
        enabled: true,
        phoneNumber: "+10000000000",
        group: new SignalGroupConfig({ enabled: true, policy: "open", requireMention: false }),
      }),
      bus,
    );
    channel.startTyping = async () => undefined;

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hello group" }));

    const inbound = await bus.nextInbound();
    expect(inbound.content).toContain("hello group");
    expect(inbound.chatId).toBe("grp==");
  });

  it("rejects disabled group messages", async () => {
    const channel = makeChannel({ groupEnabled: false });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hi" }));

    expect(handled).toEqual([]);
  });

  it("rejects unmentioned open group messages when mentions are required", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: true });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hey everyone" }));

    expect(handled).toEqual([]);
  });

  it("accepts open group messages when mentions are not required", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: false });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hey everyone" }));

    expect(handled).toHaveLength(1);
    expect(handled[0].chatId).toBe("grp==");
  });

  it("accepts allowlisted group messages", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "allowlist", groupAllowFrom: ["grp=="], requireMention: false });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hi" }));

    expect(handled).toHaveLength(1);
  });

  it("rejects non-allowlisted group messages", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "allowlist", groupAllowFrom: ["other=="], requireMention: false });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hi" }));

    expect(handled).toEqual([]);
  });

  it("responds to group mentions of the bot", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: true });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(
      groupEnvelope({
        groupId: "grp==",
        message: "\ufffc hello",
        mentions: [{ number: "+10000000000", start: 0, length: 1 }],
      }),
    );

    expect(handled).toHaveLength(1);
  });

  it("includes sender prefixes in group message content", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: false });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", sourceName: "Bob", message: "hello" }));

    expect(handled[0].content).toContain("[Bob]: hello");
  });

  it("prepends recent group context on later group messages", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: false });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", sourceName: "Alice", message: "msg1" }));
    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", sourceName: "Bob", message: "msg2" }));

    expect(handled[1].content).toContain("[Recent group messages for context:]");
    expect(handled[1].content).toContain("msg1");
  });

  it("marks group metadata and group ids on handled messages", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: false });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp==", message: "hi" }));

    expect(handled[0].metadata).toMatchObject({ isGroup: true, groupId: "grp==" });
  });

  it("copies Signal attachments from the daemon directory into channel media", async () => {
    const root = tmpRoot();
    const attachmentsDir = path.join(root, "signal-source");
    fs.mkdirSync(attachmentsDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentsDir, "att1"), "image-bytes");
    const channel = makeChannel({ dmPolicy: "open", attachmentsDir });
    const handled: any[] = [];
    channel.startTyping = async () => undefined;
    channel.handleMessage = async (kwargs: any) => {
      handled.push(kwargs);
    };

    await channel.handleReceiveNotification(
      dmEnvelope({
        message: "",
        attachments: [{ id: "att1", filename: "../../../photo.png", contentType: "image/png" }],
      }),
    );

    const dest = path.join(root, "media", "signal", "signal_photo.png");
    expect(handled[0].media).toEqual([dest]);
    expect(fs.readFileSync(dest, "utf8")).toBe("image-bytes");
    expect(handled[0].content).toContain(`[image: ${dest}]`);
  });
});

describe("SignalChannel lifecycle and SSE", () => {
  it("start returns early when the phone number is missing", async () => {
    const channel = makeChannel({ phoneNumber: "" });

    await channel.start();

    expect(channel.running).toBe(false);
    expect(channel.httpClient).toBeNull();
    expect(channel.sseTask).toBeNull();
  });

  it("starts the default EventSource SSE loop when a phone number is configured", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const channel = makeChannel({ phoneNumber: "+10000000000" });

    await channel.start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(channel.running).toBe(true);
    expect(eventSourceMock.EventSource).toHaveBeenCalledWith("http://localhost:8080/api/v1/events");
    await channel.stop();
  });

  it("dispatches valid SSE envelopes", async () => {
    const channel = makeChannel();
    const captured: any[] = [];
    channel.running = true;
    channel.handleReceiveNotification = async (params: any) => {
      captured.push(params);
    };
    channel.httpClient = new FakeStreamingClient(['data: {"envelope":{"sourceNumber":"+19995550001"}}', ""]);

    await expect(channel.sseReceiveLoop()).rejects.toThrow("closed by remote endpoint");

    expect(captured).toEqual([{ envelope: { sourceNumber: "+19995550001" } }]);
  });

  it("skips invalid SSE JSON frames and continues dispatching", async () => {
    const channel = makeChannel();
    const captured: any[] = [];
    channel.running = true;
    channel.handleReceiveNotification = async (params: any) => {
      captured.push(params);
    };
    channel.httpClient = new FakeStreamingClient([
      "data: this-is-not-json",
      "",
      'data: {"envelope":{"sourceNumber":"+1"}}',
      "",
    ]);

    await expect(channel.sseReceiveLoop()).rejects.toThrow("closed by remote endpoint");

    expect(captured).toEqual([{ envelope: { sourceNumber: "+1" } }]);
  });

  it("raises when the SSE stream returns a non-200 status", async () => {
    const channel = makeChannel();
    channel.running = true;
    channel.httpClient = new FakeStreamingClient([], 503);

    await expect(channel.sseReceiveLoop()).rejects.toThrow("status 503");
  });

  it("raises when the SSE loop has no HTTP client", async () => {
    const channel = makeChannel();

    await expect(channel.sseReceiveLoop()).rejects.toThrow("HTTP client not initialized");
  });

  it("stop cancels a cancellable SSE task", async () => {
    const channel = makeChannel();
    let cancelled = false;
    const task = {
      cancel() {
        cancelled = true;
      },
      then(resolve: (value: void) => void) {
        resolve();
      },
    };
    channel.sseTask = task as any;
    channel.running = true;

    await channel.stop();

    expect(cancelled).toBe(true);
    expect(channel.running).toBe(false);
    expect(channel.sseTask).toBeNull();
  });

  it("stop is safe when there is no SSE task", async () => {
    const channel = makeChannel();
    channel.running = true;

    await channel.stop();

    expect(channel.running).toBe(false);
    expect(channel.sseTask).toBeNull();
  });
});

describe("SignalChannel command handling", () => {
  it("forwards direct-message slash commands to the bus", async () => {
    const channel = makeChannel({ dmEnabled: true, dmPolicy: "open" });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550001", message: "/reset" }));

    expect(handled).toHaveLength(1);
    expect(handled[0].content.trim()).toBe("/reset");
  });

  it("lets group slash commands bypass mention requirements", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: true });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(groupEnvelope({ sourceNumber: "+19995550001", groupId: "grp==", message: "/reset" }));

    expect(handled).toHaveLength(1);
    expect(handled[0].content).toContain("/reset");
  });

  it("drops direct-message commands from disallowed senders", async () => {
    const channel = makeChannel({ dmEnabled: false });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+19995550001", message: "/reset" }));

    expect(handled).toEqual([]);
  });
});

describe("SignalChannel outbound", () => {
  it("posts plain text JSON-RPC send requests", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.send(new OutboundMessage({ channel: "signal", chatId: "+19995550001", content: "hello" }));

    expect(http.posts).toHaveLength(1);
    expect(http.posts[0].json).toMatchObject({
      method: "send",
      params: { message: "hello", recipient: ["+19995550001"] },
    });
  });

  it("includes markdown text styles and media attachments in send requests", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.send(
      new OutboundMessage({
        channel: "signal",
        chatId: "+19995550001",
        content: "**bold**",
        media: ["/tmp/a.png"],
      }),
    );

    expect(http.posts[0].json.params.message).toBe("bold");
    expect(http.posts[0].json.params.textStyle).toEqual(["0:4:BOLD"]);
    expect(http.posts[0].json.params.attachments).toEqual(["/tmp/a.png"]);
  });

  it("rebases text styles when long Signal messages are split", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;
    channel.maxMessageLength = 12;

    await channel.send(
      new OutboundMessage({
        channel: "signal",
        chatId: "+19995550001",
        content: "**head** middle and **tail**",
      }),
    );

    const boldChunks = http.posts
      .map((post) => post.json.params)
      .filter((params) => params.textStyle?.some((style: string) => style.includes("BOLD")));
    expect(boldChunks.length).toBeGreaterThanOrEqual(2);
    for (const params of boldChunks) {
      for (const entry of params.textStyle) {
        const [start, length] = entry.split(":").map(Number);
        expect(start + length).toBeLessThanOrEqual(params.message.length);
      }
    }
  });

  it("uses groupId for groups and recipient for direct messages", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.send(new OutboundMessage({ channel: "signal", chatId: "grp==", content: "hi group" }));
    await channel.send(new OutboundMessage({ channel: "signal", chatId: "+19995550001", content: "hi" }));

    expect(http.posts[0].json.params).toMatchObject({ groupId: "grp==" });
    expect(http.posts[0].json.params.recipient).toBeUndefined();
    expect(http.posts[1].json.params).toMatchObject({ recipient: ["+19995550001"] });
  });

  it("skips empty content without media", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.send(new OutboundMessage({ channel: "signal", chatId: "+19995550001", content: "" }));

    expect(http.posts).toEqual([]);
  });

  it("does not stop typing for progress messages but stops for final messages", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    const stopped: Array<[string, boolean | undefined]> = [];
    channel.httpClient = http;
    channel.stopTyping = async (chatId: string, sendStop?: boolean) => {
      stopped.push([chatId, sendStop]);
    };

    await channel.send(
      new OutboundMessage({
        channel: "signal",
        chatId: "+19995550001",
        content: "working",
        metadata: { agentProgress: true },
      }),
    );
    await channel.send(new OutboundMessage({ channel: "signal", chatId: "+19995550001", content: "done" }));

    expect(stopped).toEqual([["+19995550001", false]]);
  });

  it("raises when the daemon returns a send error", async () => {
    const channel = makeChannel();
    channel.httpClient = {
      post: async (pathname: string, kwargs: any) => {
        void pathname;
        void kwargs;
        return new FakeResponse({ error: { message: "fail" } });
      },
    };

    await expect(
      channel.send(new OutboundMessage({ channel: "signal", chatId: "+19995550001", content: "hello" })),
    ).rejects.toThrow("signal-cli send failed");
  });

  it("increments JSON-RPC request ids and requires an HTTP client", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.sendRequest("testMethod", { key: "val" });
    await channel.sendRequest("testMethod", { key: "val" });

    expect(http.posts.map((post) => post.json.id)).toEqual([1, 2]);
    const disconnected = makeChannel();
    await expect(disconnected.sendRequest("testMethod")).rejects.toThrow("Not connected");
  });

  it("stop closes the HTTP client and is safe without one", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;
    channel.running = true;

    await channel.stop();
    await makeChannel().stop();

    expect(http.closed).toBe(true);
    expect(channel.running).toBe(false);
    expect(channel.httpClient).toBeNull();
  });

  it("posts JSON-RPC send requests for DMs, groups, media, and markdown styles", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.send(
      new OutboundMessage({
        channel: "signal",
        chatId: "+19995550001",
        content: "**bold**",
        media: ["/tmp/a.png"],
      }),
    );
    await channel.send(new OutboundMessage({ channel: "signal", chatId: "grp==", content: "hi group" }));
    await channel.send(new OutboundMessage({ channel: "signal", chatId: "+19995550001", content: "" }));

    expect(http.posts).toHaveLength(2);
    expect(http.posts[0].json).toMatchObject({ method: "send", params: { message: "bold", recipient: ["+19995550001"] } });
    expect(http.posts[0].json.params.textStyle).toEqual(["0:4:BOLD"]);
    expect(http.posts[0].json.params.attachments).toEqual(["/tmp/a.png"]);
    expect(http.posts[1].json.params).toMatchObject({ message: "hi group", groupId: "grp==" });
  });
});

describe("SignalChannel additional parity cases", () => {
  it("strips whitespace before normalizing Signal ids", () => {
    expect(SignalChannel.normalizeSignalId("  +12345678901  ")).toEqual(["+12345678901", "12345678901"]);
  });

  it("collects source aliases from the source key", () => {
    expect(SignalChannel.collectSenderIdParts({ source: "+19995550001" })).toEqual(["+19995550001"]);
  });

  it("collects source aliases from sourceUuid", () => {
    expect(SignalChannel.collectSenderIdParts({ sourceUuid: "uuid-1" })).toEqual(["uuid-1"]);
  });

  it("collects source aliases from sourceServiceId", () => {
    expect(SignalChannel.collectSenderIdParts({ sourceServiceId: "service-1" })).toEqual(["service-1"]);
  });

  it("collects source aliases from sourceAci", () => {
    expect(SignalChannel.collectSenderIdParts({ sourceAci: "aci-1" })).toEqual(["aci-1"]);
  });

  it("prefers digit-only sender ids over uuid-like sender ids", () => {
    expect(SignalChannel.primarySenderId(["uuid-abc", "19995550001"])).toBe("19995550001");
  });

  it("extracts group ids from the id field", () => {
    expect(SignalChannel.extractGroupId({ id: "grp-id==" }, null)).toBe("grp-id==");
  });

  it("extracts group ids from the groupID field", () => {
    expect(SignalChannel.extractGroupId(null, { groupID: "grp-caps==" })).toBe("grp-caps==");
  });

  it("returns null for group metadata without ids", () => {
    expect(SignalChannel.extractGroupId({}, {})).toBeNull();
  });

  it("treats long dashless identifiers as group chats", () => {
    expect(SignalChannel.isGroupChatId("a".repeat(44))).toBe(true);
  });

  it("treats uuid-like identifiers as direct chats", () => {
    expect(SignalChannel.isGroupChatId("550e8400-e29b-41d4-a716-446655440000")).toBe(false);
  });

  it("extracts mention id candidates from nested service ids", () => {
    expect(SignalChannel.mentionIdCandidates({ user: { profile: { serviceId: "svc-1" } } })).toEqual(["svc-1"]);
  });

  it("deduplicates mention id candidates", () => {
    expect(SignalChannel.mentionIdCandidates({ number: "+1", user: { number: "+1" } })).toEqual(["+1"]);
  });

  it("rejects mention spans with missing coordinates", () => {
    expect(SignalChannel.mentionSpan({ start: 0 })).toBeNull();
  });

  it("accepts leading placeholder mentions after whitespace", () => {
    expect(SignalChannel.leadingPlaceholderSpan("  \ufffc hello")).toEqual([2, 1]);
  });

  it("matches digit-only aliases registered from a plus phone number", () => {
    expect(makeChannel({ phoneNumber: "+12345678901" }).idMatchesAccount("12345678901")).toBe(true);
  });

  it("remembers uuid aliases case-insensitively", () => {
    const channel = makeChannel();
    channel.rememberAccountIdAlias("ABC-UUID");

    expect(channel.idMatchesAccount("abc-uuid")).toBe(true);
  });

  it("responds to uuid mentions that match the bot account", () => {
    const channel = makeChannel({ groupEnabled: true, requireMention: true });
    channel.rememberAccountIdAlias("bot-uuid");

    expect(channel.shouldRespondInGroup("\ufffc hello", [{ uuid: "bot-uuid", start: 0, length: 1 }])).toBe(true);
  });

  it("rejects group messages without required mentions", () => {
    const channel = makeChannel({ groupEnabled: true, requireMention: true });

    expect(channel.shouldRespondInGroup("hello", [])).toBe(false);
  });

  it("strips bot phone-number mentions from group text", () => {
    const channel = makeChannel({ phoneNumber: "+10000000000", groupEnabled: true });

    expect(channel.stripBotMention("\ufffc hello", [{ number: "+10000000000", start: 0, length: 1 }])).toBe("hello");
  });

  it("strips leading placeholders even without mention metadata", () => {
    const channel = makeChannel({ groupEnabled: true });

    expect(channel.stripBotMention("\ufffc hello", [])).toBe("hello");
  });

  it("keeps group buffers within the configured maximum", () => {
    const channel = makeChannel({ groupMessageBufferSize: 2 });
    channel.addToGroupBuffer("grp==", "Alice", "+1", "one", 1);
    channel.addToGroupBuffer("grp==", "Bob", "+2", "two", 2);
    channel.addToGroupBuffer("grp==", "Cara", "+3", "three", 3);

    expect(channel.groupBuffers["grp=="].map((item) => item.content)).toEqual(["two", "three"]);
  });

  it("allows wildcard Signal allowlists", () => {
    const channel = makeChannel({ dmPolicy: "allowlist", dmAllowFrom: ["*"] });

    expect(channel.isAllowed("+19995550001")).toBe(true);
  });

  it("matches composite sender ids against composite allowlist entries", () => {
    const composite = "+19995550001|uuid-abc";
    expect(SignalChannel.senderMatchesAllowlist(composite, [composite])).toBe(true);
  });

  it("matches composite sender ids when only the uuid part is allowlisted", () => {
    expect(SignalChannel.senderMatchesAllowlist("+19995550001|UUID-ABC", ["uuid-abc"])).toBe(true);
  });

  it("denies composite sender ids when no allowlist part matches", () => {
    expect(SignalChannel.senderMatchesAllowlist("+19995550001|uuid-abc", ["+12223334444"])).toBe(false);
  });

  it("returns the sender number as chat id for allowed direct messages", () => {
    const channel = makeChannel({ dmEnabled: true, dmPolicy: "allowlist", dmAllowFrom: ["+19995550001"] });

    expect(
      channel.checkInboundPolicy({
        senderId: "+19995550001",
        senderNumber: "+19995550001",
        isGroupMessage: false,
        messageText: "hi",
      }),
    ).toEqual([true, "+19995550001"]);
  });

  it("returns the sender number as chat id for disabled direct messages", () => {
    const channel = makeChannel({ dmEnabled: false });

    expect(
      channel.checkInboundPolicy({
        senderId: "+19995550001",
        senderNumber: "+19995550001",
        isGroupMessage: false,
        messageText: "hi",
      }),
    ).toEqual([false, "+19995550001"]);
  });

  it("lets group slash commands bypass mention checks in policy", () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: true });

    expect(
      channel.checkInboundPolicy({
        senderId: "+1",
        senderNumber: "+1",
        groupId: "grp==",
        isGroupMessage: true,
        messageText: "/reset",
      }),
    ).toEqual([true, "grp=="]);
  });

  it("does not append blocked group messages to the rolling buffer", () => {
    const channel = makeChannel({ groupEnabled: false });

    channel.checkInboundPolicy({
      senderId: "+1",
      senderNumber: "+1",
      groupId: "blocked==",
      isGroupMessage: true,
      messageText: "hi",
    });

    expect(channel.groupBuffers["blocked=="]).toBeUndefined();
  });

  it("adds a not-found marker for missing inbound attachments", () => {
    const [content, media] = makeChannel().assembleInboundContent({
      senderName: "Alice",
      senderNumber: "+1",
      messageText: "",
      attachments: [{ id: "missing", filename: "photo.png", contentType: "image/png" }],
      mentions: [],
      isGroupMessage: false,
      chatId: "+1",
    });

    expect(media).toEqual([]);
    expect(content).toContain("[attachment: photo.png - not found]");
  });

  it("uses groupV2 ids as handled chat ids", async () => {
    const channel = makeChannel({ groupEnabled: true, groupPolicy: "open", requireMention: false });
    const handled = captureHandled(channel);

    await channel.handleReceiveNotification(groupEnvelope({ groupId: "grp-v2==", useV2: true }));

    expect(handled[0].chatId).toBe("grp-v2==");
  });

  it("learns self uuid aliases from incoming self notifications", async () => {
    const channel = makeChannel({ phoneNumber: "+10000000000", dmPolicy: "open" });
    captureHandled(channel);

    await channel.handleReceiveNotification(dmEnvelope({ sourceNumber: "+10000000000", sourceUuid: "self-uuid" }));

    expect(channel.idMatchesAccount("self-uuid")).toBe(true);
  });

  it("keeps start idle when Signal phone number is missing", async () => {
    const channel = makeChannel({ phoneNumber: "" });

    await channel.start();

    expect(channel.running).toBe(false);
    expect(channel.httpClient).toBeNull();
    expect(channel.sseTask).toBeNull();
  });

  it("raises the SSE loop when no HTTP client is initialized", async () => {
    await expect(makeChannel().sseReceiveLoop()).rejects.toThrow("HTTP client not initialized");
  });

  it("sends media-only messages with attachments", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.send(new OutboundMessage({ channel: "signal", chatId: "+19995550001", content: "", media: ["/tmp/file.jpg"] }));

    expect(http.posts[0].json.params).toMatchObject({ message: "", attachments: ["/tmp/file.jpg"] });
  });

  it("attaches media only to the first split outbound chunk", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;
    channel.maxMessageLength = 5;

    await channel.send(new OutboundMessage({ channel: "signal", chatId: "+19995550001", content: "hello world", media: ["/tmp/file.jpg"] }));

    expect(http.posts[0].json.params.attachments).toEqual(["/tmp/file.jpg"]);
    expect(http.posts[1].json.params.attachments).toBeUndefined();
  });

  it("stops typing after final sends with sendStop false", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    const stopped: Array<[string, boolean | undefined]> = [];
    channel.httpClient = http;
    channel.stopTyping = async (chatId: string, sendStop?: boolean) => {
      stopped.push([chatId, sendStop]);
    };

    await channel.send(new OutboundMessage({ channel: "signal", chatId: "+19995550001", content: "done" }));

    expect(stopped).toEqual([["+19995550001", false]]);
  });

  it("turns HTTP post exceptions into JSON-RPC errors", async () => {
    const channel = makeChannel();
    channel.httpClient = {
      post: async () => {
        throw new Error("network down");
      },
    };

    await expect(channel.sendHttpRequest({ jsonrpc: "2.0", method: "send", id: 1 })).resolves.toEqual({
      error: { message: "network down" },
    });
  });

  it("sends group typing indicators with groupId and stop flag", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.sendTyping("grp==", true);

    expect(http.posts[0].json).toMatchObject({ method: "sendTyping", params: { groupId: "grp==", stop: true } });
  });

  it("sends direct typing indicators with recipient lists", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.sendTyping("+19995550001");

    expect(http.posts[0].json).toMatchObject({ method: "sendTyping", params: { recipient: ["+19995550001"] } });
    expect(http.posts[0].json.params.stop).toBeUndefined();
  });

  it("omits params from JSON-RPC requests when no params are provided", async () => {
    const channel = makeChannel();
    const http = new FakeHTTPClient();
    channel.httpClient = http;

    await channel.sendRequest("listAccounts");

    expect(http.posts[0].json).toEqual({ jsonrpc: "2.0", method: "listAccounts", id: 1 });
  });
});
