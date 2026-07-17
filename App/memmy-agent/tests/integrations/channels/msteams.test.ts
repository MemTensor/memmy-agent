import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import {
  ConversationRef,
  MSTEAMS_REF_META_FILENAME,
  MSTEAMS_REF_TOUCH_INTERVAL_S,
  MSTEAMS_REF_TTL_DAYS,
  MSTeamsChannel,
  MSTeamsConfig,
  setMsteamsAvailableForTest,
} from "../../../src/integrations/channels/msteams.js";

const botbuilderMock = vi.hoisted(() => {
  const api: any = {};
  function Adapter(this: any, opts: any) {
    this.opts = opts;
    this.processActivity = api.processActivity;
  }
  api.processActivity = vi.fn(async () => undefined);
  api.BotFrameworkAdapter = vi.fn(Adapter);
  api.reset = () => {
    api.processActivity.mockClear();
    api.BotFrameworkAdapter.mockClear();
    api.BotFrameworkAdapter.mockImplementation(Adapter);
  };
  return api;
});

vi.mock("botbuilder", () => ({ BotFrameworkAdapter: botbuilderMock.BotFrameworkAdapter }));

const originalWorkspace = process.env.MEMMY_AGENT_WORKSPACE;
const roots: string[] = [];

class FakeResponse {
  constructor(
    private readonly payload: any = {},
    private readonly shouldRaise = false,
  ) {}

  raiseForStatus(): void {
    if (this.shouldRaise) throw new Error("boom");
  }

  json(): any {
    return this.payload;
  }
}

class FakeHttpClient {
  calls: Array<[string, any]> = [];

  constructor(
    private readonly payload: any = { access_token: "tok", expires_in: 3600 },
    private readonly shouldRaise = false,
  ) {}

  async post(url: string, kwargs: any = {}): Promise<FakeResponse> {
    this.calls.push([url, kwargs]);
    return new FakeResponse(this.payload, this.shouldRaise);
  }

  async get(url: string): Promise<FakeResponse> {
    this.calls.push([url, {}]);
    return new FakeResponse(this.payload, this.shouldRaise);
  }

  async close(): Promise<void> {}
}

function tmpWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-msteams-"));
  roots.push(root);
  process.env.MEMMY_AGENT_WORKSPACE = root;
  return root;
}

function makeChannel(config: Record<string, any> = {}, bus = new MessageBus()): MSTeamsChannel {
  tmpWorkspace();
  return new MSTeamsChannel(
    new MSTeamsConfig({
      enabled: true,
      appId: "app-id",
      appPassword: "secret",
      tenantId: "tenant-id",
      allowFrom: ["*"],
      ...config,
    }),
    bus,
  );
}

function personalActivity(overrides: Record<string, any> = {}): any {
  return {
    type: "message",
    id: "activity-1",
    text: "Hello from Teams",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversation: { id: "conv-123", conversationType: "personal" },
    from: { id: "29:user-id", aadObjectId: "aad-user-1", name: "Bob" },
    recipient: { id: "28:bot-id", name: "memmy" },
    channelData: { tenant: { id: "tenant-id" } },
    ...overrides,
  };
}

function stateFile(root: string, name: string): string {
  return path.join(root, "state", name);
}

function writeRefs(root: string, refs: Record<string, any>, meta?: Record<string, any>): void {
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(stateFile(root, "msteams_conversations.json"), JSON.stringify(refs, null, 2), "utf8");
  if (meta !== undefined) fs.writeFileSync(stateFile(root, MSTEAMS_REF_META_FILENAME), JSON.stringify(meta, null, 2), "utf8");
}

function signedJwt(claims: Record<string, any>, kid = "test-kid") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, any>;
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.kty = "RSA";
  jwk.alg = "RS256";
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid }), "utf8").toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return { token: `${header}.${payload}.${signature}`, jwk };
}

afterEach(() => {
  setMsteamsAvailableForTest(true);
  vi.restoreAllMocks();
  botbuilderMock.reset();
  if (originalWorkspace == null) delete process.env.MEMMY_AGENT_WORKSPACE;
  else process.env.MEMMY_AGENT_WORKSPACE = originalWorkspace;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("MSTeams runtime startup", () => {
  it("creates the botbuilder adapter, HTTP client, and inbound server", async () => {
    const channel = makeChannel({ host: "127.0.0.1", port: 0 });

    await channel.start();

    expect(botbuilderMock.BotFrameworkAdapter).toHaveBeenCalledWith({ appId: "app-id", appPassword: "secret" });
    expect(channel.http).toBeTruthy();
    expect(channel.server?.listening).toBe(true);
    await channel.stop();
  });
});

describe("MSTeams inbound activity handling", () => {
  it("publishes personal messages and stores conversation refs", async () => {
    const bus = new MessageBus();
    const channel = makeChannel({}, bus);
    const root = process.env.MEMMY_AGENT_WORKSPACE!;

    await channel.handleActivity(personalActivity());

    const msg = await bus.consumeInbound();
    expect(msg.channel).toBe("msteams");
    expect(msg.senderId).toBe("aad-user-1");
    expect(msg.chatId).toBe("conv-123");
    expect(msg.content).toBe("Hello from Teams");
    expect(msg.metadata.msteams.conversationId).toBe("conv-123");
    expect(channel.conversationRefs["conv-123"]).toMatchObject({ conversationId: "conv-123", tenantId: "tenant-id" });

    const saved = JSON.parse(fs.readFileSync(stateFile(root, "msteams_conversations.json"), "utf8"));
    expect(saved["conv-123"].conversation_id).toBe("conv-123");
    const savedMeta = JSON.parse(fs.readFileSync(stateFile(root, MSTEAMS_REF_META_FILENAME), "utf8"));
    expect(savedMeta["conv-123"].updated_at).toBeGreaterThan(0);
  });

  it("ignores group messages", async () => {
    const channel = makeChannel();

    await channel.handleActivity(personalActivity({ conversation: { id: "conv-group", conversationType: "channel" } }));

    expect(channel.bus.inbound.size).toBe(0);
    expect(channel.conversationRefs).toEqual({});
  });

  it("does not store refs for denied senders", async () => {
    const channel = makeChannel({ allowFrom: ["allowed-user"] });
    const root = process.env.MEMMY_AGENT_WORKSPACE!;

    await channel.handleActivity(personalActivity({ conversation: { id: "conv-denied", conversationType: "personal" } }));

    expect(channel.bus.inbound.size).toBe(0);
    expect(channel.conversationRefs).toEqual({});
    expect(fs.existsSync(stateFile(root, "msteams_conversations.json"))).toBe(false);
  });

  it("uses the default mention-only response", async () => {
    const bus = new MessageBus();
    const channel = makeChannel({}, bus);

    await channel.handleActivity(personalActivity({ id: "activity-3", text: "<at>Memmy</at>", conversation: { id: "conv-empty", conversationType: "personal" } }));

    expect((await bus.consumeInbound()).content).toBe("Hi — what can I help with?");
    expect(channel.conversationRefs["conv-empty"]).toBeDefined();
  });

  it("ignores mention-only messages when the fallback response is disabled", async () => {
    const channel = makeChannel({ mentionOnlyResponse: "   " });

    await channel.handleActivity(
      personalActivity({ id: "activity-4", text: "<at>Memmy</at>", conversation: { id: "conv-empty-disabled", conversationType: "personal" } }),
    );

    expect(channel.bus.inbound.size).toBe(0);
    expect(channel.conversationRefs).toEqual({});
  });
});

describe("MSTeams conversation ref persistence", () => {
  it("prunes stale, webchat, and non-personal refs on init", () => {
    const root = tmpWorkspace();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    writeRefs(
      root,
      {
        "conv-valid": { service_url: "https://smba.trafficmanager.net/amer/", conversation_id: "conv-valid", conversation_type: "personal" },
        "conv-webchat": { service_url: "https://webchat.botframework.com/", conversation_id: "conv-webchat", conversation_type: "personal" },
        "conv-group": { service_url: "https://smba.trafficmanager.net/amer/", conversation_id: "conv-group", conversation_type: "channel" },
        "conv-stale": { service_url: "https://smba.trafficmanager.net/amer/", conversation_id: "conv-stale", conversation_type: "personal" },
        "conv-missing-ts": { service_url: "https://smba.trafficmanager.net/amer/", conversation_id: "conv-missing-ts", conversation_type: "personal" },
      },
      {
        "conv-valid": { updated_at: now - 60 },
        "conv-webchat": { updated_at: now - 60 },
        "conv-group": { updated_at: now - 60 },
        "conv-stale": { updated_at: now - 30 * 24 * 60 * 60 - 1 },
      },
    );

    const channel = new MSTeamsChannel(new MSTeamsConfig({ appId: "app", appPassword: "secret", allowFrom: ["*"] }), new MessageBus());

    expect(Object.keys(channel.conversationRefs).sort()).toEqual(["conv-missing-ts", "conv-valid"]);
    const persisted = JSON.parse(fs.readFileSync(stateFile(root, "msteams_conversations.json"), "utf8"));
    expect(Object.keys(persisted).sort()).toEqual(["conv-missing-ts", "conv-valid"]);
  });

  it("prunes unsupported refs before saving", () => {
    const channel = makeChannel();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    channel.conversationRefs = {
      "conv-valid": new ConversationRef({ serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "conv-valid", conversationType: "personal", updatedAt: now }),
      "conv-webchat": new ConversationRef({ serviceUrl: "https://webchat.botframework.com/", conversationId: "conv-webchat", conversationType: "personal", updatedAt: now }),
      "conv-group": new ConversationRef({ serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "conv-group", conversationType: "groupChat", updatedAt: now }),
    };

    channel.saveRefs();

    expect(Object.keys(channel.conversationRefs)).toEqual(["conv-valid"]);
    const saved = JSON.parse(fs.readFileSync(stateFile(process.env.MEMMY_AGENT_WORKSPACE!, "msteams_conversations.json"), "utf8"));
    expect(Object.keys(saved)).toEqual(["conv-valid"]);
  });

  it("prunes webchat and stale refs before saving", () => {
    const channel = makeChannel();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    channel.conversationRefs = {
      "teams-good": new ConversationRef({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        conversationId: "teams-good",
        conversationType: "personal",
        updatedAt: now,
      }),
      "webchat-bad": new ConversationRef({
        serviceUrl: "https://webchat.botframework.com/",
        conversationId: "webchat-bad",
        conversationType: null,
        updatedAt: now,
      }),
      "teams-stale": new ConversationRef({
        serviceUrl: "https://smba.trafficmanager.net/amer/",
        conversationId: "teams-stale",
        conversationType: "personal",
        updatedAt: now - 31 * 24 * 60 * 60,
      }),
    };

    channel.saveRefs();

    expect(Object.keys(channel.conversationRefs)).toEqual(["teams-good"]);
    const saved = JSON.parse(fs.readFileSync(stateFile(process.env.MEMMY_AGENT_WORKSPACE!, "msteams_conversations.json"), "utf8"));
    expect(Object.keys(saved)).toEqual(["teams-good"]);
    const meta = JSON.parse(fs.readFileSync(stateFile(process.env.MEMMY_AGENT_WORKSPACE!, MSTEAMS_REF_META_FILENAME), "utf8"));
    expect(meta["teams-good"].updated_at).toBe(now);
  });

  it("respects prune toggle flags", () => {
    const root = tmpWorkspace();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    writeRefs(root, {
      "conv-webchat": { service_url: "https://webchat.botframework.com/", conversation_id: "conv-webchat", conversation_type: "personal", updated_at: now - 60 },
      "conv-group": { service_url: "https://smba.trafficmanager.net/amer/", conversation_id: "conv-group", conversation_type: "channel", updated_at: now - 60 },
    });

    const channel = new MSTeamsChannel(
      new MSTeamsConfig({ appId: "app", appPassword: "secret", allowFrom: ["*"], pruneWebChatRefs: false, pruneNonPersonalRefs: false }),
      new MessageBus(),
    );

    expect(Object.keys(channel.conversationRefs).sort()).toEqual(["conv-group", "conv-webchat"]);
  });

  it("respects custom ref TTL days", () => {
    const root = tmpWorkspace();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    writeRefs(
      root,
      {
        "conv-fresh": { service_url: "https://smba.trafficmanager.net/amer/", conversation_id: "conv-fresh", conversation_type: "personal" },
        "conv-old": { service_url: "https://smba.trafficmanager.net/amer/", conversation_id: "conv-old", conversation_type: "personal" },
      },
      {
        "conv-fresh": { updated_at: now - 12 * 60 * 60 },
        "conv-old": { updated_at: now - 10 * 24 * 60 * 60 },
      },
    );

    const channel = new MSTeamsChannel(new MSTeamsConfig({ appId: "app", appPassword: "secret", allowFrom: ["*"], refTtlDays: 1 }), new MessageBus());

    expect(Object.keys(channel.conversationRefs)).toEqual(["conv-fresh"]);
  });

  it("keeps legacy refs alive when the metadata sidecar is missing", () => {
    const root = tmpWorkspace();
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    writeRefs(root, {
      "conv-legacy": { service_url: "https://smba.trafficmanager.net/amer/", conversation_id: "conv-legacy", conversation_type: "personal" },
    });

    const channel = new MSTeamsChannel(new MSTeamsConfig({ appId: "app", appPassword: "secret", allowFrom: ["*"], refTtlDays: 1 }), new MessageBus());

    expect(Object.keys(channel.conversationRefs)).toEqual(["conv-legacy"]);
    expect(channel.conversationRefs["conv-legacy"].updatedAt).toBe(now);
    expect(fs.existsSync(stateFile(root, MSTEAMS_REF_META_FILENAME))).toBe(false);
  });

  it("keeps the existing refs file when atomic replace fails", () => {
    const channel = makeChannel();
    const root = process.env.MEMMY_AGENT_WORKSPACE!;
    writeRefs(root, {
      "conv-old": { service_url: "https://smba.trafficmanager.net/amer/", conversation_id: "conv-old", conversation_type: "personal", updated_at: 1_700_000_000 },
    });
    channel.conversationRefs = {
      "conv-new": new ConversationRef({ serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "conv-new", conversationType: "personal", updatedAt: 1_800_000_000 }),
    };
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("replace failed");
    });

    channel.saveRefs();

    const persisted = JSON.parse(fs.readFileSync(stateFile(root, "msteams_conversations.json"), "utf8"));
    expect(Object.keys(persisted)).toEqual(["conv-old"]);
    expect(fs.readdirSync(path.join(root, "state")).filter((name) => name.includes(".tmp"))).toEqual([]);
  });
});

describe("MSTeams text normalization", () => {
  it("strips generic bot mention tags", () => {
    const channel = makeChannel();

    expect(channel.stripPossibleBotMention("<at>Memmy</at> hello")).toBe("hello");
    expect(channel.stripPossibleBotMention("hi <at>Some Bot</at> there")).toBe("hi there");
  });

  it("keeps normal inline messages", () => {
    const channel = makeChannel();

    expect(channel.sanitizeInboundText({ text: "<at>Memmy</at> normal inline message", channelData: {} })).toBe("normal inline message");
  });

  it("normalizes nbsp entities", () => {
    const channel = makeChannel();

    expect(channel.sanitizeInboundText({ text: "Hello&nbsp;from&nbsp;Teams", channelData: {} })).toBe("Hello from Teams");
  });

  it("structures reply wrapper text without reply metadata", () => {
    const channel = makeChannel();

    expect(
      channel.sanitizeInboundText({
        text: "Reply wrapper \r\nQuoted prior message\r\n\r\nThis is a reply with quote test",
        channelData: {},
      }),
    ).toBe("User is replying to: Quoted prior message\nUser reply: This is a reply with quote test");
  });

  it("structures native reply quote prefixes", () => {
    const channel = makeChannel();

    expect(
      channel.sanitizeInboundText({
        text: "Replying to Bob Smith\nactual reply text",
        replyToId: "parent-activity",
        channelData: { messageType: "reply" },
      }),
    ).toBe("User is replying to: Bob Smith\nUser reply: actual reply text");
  });

  it("structures compact live reply wrapper shapes", () => {
    const channel = makeChannel();

    expect(
      channel.sanitizeInboundText({
        text: "Reply wrapper Got it. I’ll watch for the exact text reply with quote test and then inspect that turn specifically. Reply with quote test",
        replyToId: "parent-activity",
        channelData: { messageType: "reply" },
      }),
    ).toBe(
      "User is replying to: Got it. I’ll watch for the exact text reply with quote test and then inspect that turn specifically.\nUser reply: Reply with quote test",
    );
  });

  it("leaves plain text reply-test phrases untouched", () => {
    const channel = makeChannel();
    const text = "Normal message ending with Reply with quote test";

    expect(channel.normalizeTeamsReplyQuote(text)).toBe(text);
  });

  it("structures multiline reply wrapper shapes", () => {
    const channel = makeChannel();

    expect(
      channel.sanitizeInboundText({
        text:
          "Reply wrapper\r\n" +
          "Understood — then the restart already happened, and the new Teams quote normalization should now be live. " +
          "Next best step: • send one more real reply-with-quote message in Teams • I&rsquo…\r\n\r\n" +
          "This is a reply with quote",
        replyToId: "parent-activity",
        channelData: { messageType: "reply" },
      }),
    ).toBe(
      "User is replying to: Understood — then the restart already happened, and the new Teams quote normalization should now be live. " +
        "Next best step: • send one more real reply-with-quote message in Teams • I’…\nUser reply: This is a reply with quote",
    );
  });

  it("structures exact live CRLF reply wrapper shapes", () => {
    const channel = makeChannel();

    expect(
      channel.sanitizeInboundText({
        text:
          "Reply wrapper \r\n" +
          "Please send one real reply-with-quote message in Teams. That single test should be enough now: " +
          "• I’ll check the new MSTeams sanitized inbound text ... log • and compare it to the prompt…\r\n\r\n" +
          "This is a reply with quote test",
        replyToId: "parent-activity",
        channelData: { messageType: "reply" },
      }),
    ).toBe(
      "User is replying to: Please send one real reply-with-quote message in Teams. That single test should be enough now: " +
        "• I’ll check the new MSTeams sanitized inbound text ... log • and compare it to the prompt…\nUser reply: This is a reply with quote test",
    );
  });
});

describe("MSTeams outbound delivery", () => {
  it("fetches access tokens from the configured tenant", async () => {
    const channel = makeChannel({ tenantId: "tenant-123" });
    const fakeHttp = new FakeHttpClient();
    channel.http = fakeHttp;

    expect(await channel.getAccessToken()).toBe("tok");
    expect(await channel.getAccessToken()).toBe("tok");
    expect(fakeHttp.calls).toHaveLength(1);
    expect(fakeHttp.calls[0][0]).toBe("https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token");
    expect(fakeHttp.calls[0][1].data).toMatchObject({
      client_id: "app-id",
      client_secret: "secret",
      scope: "https://api.botframework.com/.default",
    });
  });

  it("posts replies with replyToId when thread replies are enabled", async () => {
    const channel = makeChannel({ replyInThread: true });
    const fakeHttp = new FakeHttpClient();
    channel.http = fakeHttp;
    channel.token = "tok";
    channel.tokenExpiresAt = 9_999_999_999;
    channel.conversationRefs["conv-123"] = new ConversationRef({
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversationId: "conv-123",
      activityId: "activity-1",
    });

    await channel.send(new OutboundMessage({ channel: "msteams", chatId: "conv-123", content: "Reply text" }));

    expect(fakeHttp.calls).toHaveLength(1);
    expect(fakeHttp.calls[0][0]).toBe("https://smba.trafficmanager.net/amer/v3/conversations/conv-123/activities");
    expect(fakeHttp.calls[0][1].headers.Authorization).toBe("Bearer tok");
    expect(fakeHttp.calls[0][1].json).toMatchObject({ text: "Reply text", replyToId: "activity-1" });
  });

  it("refreshes updatedAt and persists metadata after successful sends", async () => {
    const channel = makeChannel({ refTouchIntervalS: 0 });
    const fakeHttp = new FakeHttpClient();
    const root = process.env.MEMMY_AGENT_WORKSPACE!;
    channel.http = fakeHttp;
    channel.token = "tok";
    channel.tokenExpiresAt = 9_999_999_999;
    channel.conversationRefs["conv-123"] = new ConversationRef({
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversationId: "conv-123",
      activityId: "activity-1",
      updatedAt: 1_800_000_000,
    });
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_005_000);

    await channel.send(new OutboundMessage({ channel: "msteams", chatId: "conv-123", content: "Reply text" }));

    expect(channel.conversationRefs["conv-123"].updatedAt).toBe(1_800_000_005);
    const meta = JSON.parse(fs.readFileSync(stateFile(root, MSTEAMS_REF_META_FILENAME), "utf8"));
    expect(meta["conv-123"].updated_at).toBe(1_800_000_005);
  });

  it("omits replyToId when thread replies are disabled", async () => {
    const channel = makeChannel({ replyInThread: false });
    const fakeHttp = new FakeHttpClient();
    channel.http = fakeHttp;
    channel.token = "tok";
    channel.tokenExpiresAt = 9_999_999_999;
    channel.conversationRefs["conv-123"] = new ConversationRef({
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversationId: "conv-123",
      activityId: "activity-1",
    });

    await channel.send(new OutboundMessage({ channel: "msteams", chatId: "conv-123", content: "Reply text" }));

    expect(fakeHttp.calls[0][1].json.replyToId).toBeUndefined();
  });

  it("omits replyToId when thread replies are enabled but activityId is missing", async () => {
    const channel = makeChannel({ replyInThread: true });
    const fakeHttp = new FakeHttpClient();
    channel.http = fakeHttp;
    channel.token = "tok";
    channel.tokenExpiresAt = 9_999_999_999;
    channel.conversationRefs["conv-123"] = new ConversationRef({
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversationId: "conv-123",
      activityId: null,
    });

    await channel.send(new OutboundMessage({ channel: "msteams", chatId: "conv-123", content: "Reply text" }));

    expect(fakeHttp.calls[0][1].json.replyToId).toBeUndefined();
  });

  it("raises when a conversation ref is missing", async () => {
    const channel = makeChannel();
    channel.http = new FakeHttpClient();

    await expect(channel.send(new OutboundMessage({ channel: "msteams", chatId: "missing", content: "Reply text" }))).rejects.toThrow(
      /conversation ref not found/,
    );
  });

  it("raises delivery failures for retry", async () => {
    const channel = makeChannel();
    channel.http = new FakeHttpClient({}, true);
    channel.token = "tok";
    channel.tokenExpiresAt = 9_999_999_999;
    channel.conversationRefs["conv-123"] = new ConversationRef({
      serviceUrl: "https://smba.trafficmanager.net/amer/",
      conversationId: "conv-123",
      activityId: "activity-1",
    });

    await expect(channel.send(new OutboundMessage({ channel: "msteams", chatId: "conv-123", content: "Reply text" }))).rejects.toThrow(/boom/);
  });
});

describe("MSTeams inbound auth", () => {
  it("accepts observed Bot Framework token shapes", async () => {
    const channel = makeChannel({ validateInboundAuth: true });
    const serviceUrl = "https://smba.trafficmanager.net/amer/tenant/";
    const { token, jwk } = signedJwt({
      iss: "https://api.botframework.com",
      aud: "app-id",
      serviceurl: serviceUrl,
      nbf: 1_700_000_000,
      exp: 4_100_000_000,
    });
    channel.botFrameworkJwks = { keys: [jwk] };
    channel.botFrameworkJwksExpiresAt = 9_999_999_999;

    await expect(channel.validateInboundAuth(`Bearer ${token}`, { serviceUrl })).resolves.toBeUndefined();
  });

  it("rejects service URL mismatches", async () => {
    const channel = makeChannel({ validateInboundAuth: true });
    const { token, jwk } = signedJwt({
      iss: "https://api.botframework.com",
      aud: "app-id",
      serviceurl: "https://smba.trafficmanager.net/amer/tenant-a/",
      nbf: 1_700_000_000,
      exp: 4_100_000_000,
    });
    channel.botFrameworkJwks = { keys: [jwk] };
    channel.botFrameworkJwksExpiresAt = 9_999_999_999;

    await expect(
      channel.validateInboundAuth(`Bearer ${token}`, { serviceUrl: "https://smba.trafficmanager.net/amer/tenant-b/" }),
    ).rejects.toThrow(/serviceUrl claim mismatch/);
  });

  it("rejects missing bearer tokens", async () => {
    const channel = makeChannel({ validateInboundAuth: true });

    await expect(channel.validateInboundAuth("", { serviceUrl: "https://smba.trafficmanager.net/amer/tenant/" })).rejects.toThrow(
      /missing bearer token/,
    );
  });

  it("logs the install hint when MSTeams support is unavailable", async () => {
    const channel = makeChannel();
    setMsteamsAvailableForTest(false);
    const error = vi.spyOn(channel.logger, "error").mockImplementation(() => undefined);

    await channel.start();

    expect(error).toHaveBeenCalledWith("MSTeams support is unavailable in this build. Reinstall memmy-agent with MSTeams support enabled.");
    expect(channel.running).toBe(false);
  });
});

describe("MSTeams defaults", () => {
  it("includes ref pruning fields without restart notify fields", () => {
    const cfg = MSTeamsChannel.defaultConfig();

    expect(cfg.validateInboundAuth).toBe(true);
    expect(cfg.refTtlDays).toBe(MSTEAMS_REF_TTL_DAYS);
    expect(cfg.pruneWebChatRefs).toBe(true);
    expect(cfg.pruneNonPersonalRefs).toBe(true);
    expect(cfg.refTouchIntervalS).toBe(MSTEAMS_REF_TOUCH_INTERVAL_S);
    expect("restartNotifyEnabled" in cfg).toBe(false);
    expect("restartNotifyPreMessage" in cfg).toBe(false);
    expect("restartNotifyPostMessage" in cfg).toBe(false);
  });
});
