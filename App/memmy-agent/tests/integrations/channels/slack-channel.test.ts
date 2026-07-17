import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { SLACK_MAX_MESSAGE_LEN, SlackChannel, SlackConfig } from "../../../src/integrations/channels/slack.js";
import { getMediaDir } from "../../../src/config/paths.js";

const slackSdkMock = vi.hoisted(() => {
  const api: any = { webClients: [] as any[], socketClients: [] as any[] };
  function WebClient(this: any, token: string) {
    this.token = token;
    this.auth = { test: vi.fn(async () => ({ user_id: "U_BOT" })) };
    api.webClients.push(this);
  }
  function SocketModeClient(this: any, opts: any) {
    this.opts = opts;
    this.handlers = new Map<string, any>();
    this.on = vi.fn((event: string, handler: any) => {
      this.handlers.set(event, handler);
      return this;
    });
    this.start = vi.fn(async () => undefined);
    this.disconnect = vi.fn(async () => undefined);
    api.socketClients.push(this);
  }
  api.WebClient = vi.fn(WebClient);
  api.SocketModeClient = vi.fn(SocketModeClient);
  api.reset = () => {
    api.webClients = [];
    api.socketClients = [];
    api.WebClient.mockClear();
    api.WebClient.mockImplementation(WebClient);
    api.SocketModeClient.mockClear();
    api.SocketModeClient.mockImplementation(SocketModeClient);
  };
  return api;
});

vi.mock("@slack/web-api", () => ({ WebClient: slackSdkMock.WebClient }));
vi.mock("@slack/socket-mode", () => ({ SocketModeClient: slackSdkMock.SocketModeClient }));

class FakeSlackWebClient {
  chatPostCalls: any[] = [];
  fileUploadCalls: any[] = [];
  reactionsAddCalls: any[] = [];
  reactionsRemoveCalls: any[] = [];
  conversationsListCalls: any[] = [];
  conversationsRepliesCalls: any[] = [];
  usersListCalls: any[] = [];
  conversationsOpenCalls: any[] = [];
  conversationsPages: any[] = [];
  usersPages: any[] = [];
  conversationsRepliesResponse: any = { messages: [] };
  openDmResponse: any = { channel: { id: "D_OPENED" } };

  async chatPostMessage(kwargs: any): Promise<void> {
    this.chatPostCalls.push(kwargs);
  }

  async filesUploadV2(kwargs: any): Promise<void> {
    this.fileUploadCalls.push(kwargs);
  }

  async reactionsAdd(kwargs: any): Promise<void> {
    this.reactionsAddCalls.push(kwargs);
  }

  async reactionsRemove(kwargs: any): Promise<void> {
    this.reactionsRemoveCalls.push(kwargs);
  }

  async conversationsList(kwargs: any): Promise<any> {
    this.conversationsListCalls.push(kwargs);
    return this.conversationsPages.shift() ?? { channels: [], response_metadata: { next_cursor: "" } };
  }

  async conversationsReplies(kwargs: any): Promise<any> {
    this.conversationsRepliesCalls.push(kwargs);
    return this.conversationsRepliesResponse;
  }

  async usersList(kwargs: any): Promise<any> {
    this.usersListCalls.push(kwargs);
    return this.usersPages.shift() ?? { members: [], response_metadata: { next_cursor: "" } };
  }

  async conversationsOpen(kwargs: any): Promise<any> {
    this.conversationsOpenCalls.push(kwargs);
    return this.openDmResponse;
  }
}

const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const tmpDirs: string[] = [];

function tempDataDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-slack-test-"));
  tmpDirs.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  slackSdkMock.reset();
  vi.unstubAllGlobals();
  if (originalDataDir === undefined) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("SlackChannel", () => {
  it("creates official Slack Web API and Socket Mode clients on start", async () => {
    const channel = new SlackChannel(new SlackConfig({ botToken: "xoxb-token", appToken: "xapp-token", allowFrom: ["*"] }), new MessageBus());

    await channel.start();

    expect(slackSdkMock.WebClient).toHaveBeenCalledWith("xoxb-token");
    expect(slackSdkMock.SocketModeClient).toHaveBeenCalledWith({ appToken: "xapp-token" });
    expect(slackSdkMock.socketClients[0].on).toHaveBeenCalledWith("slack_event", expect.any(Function));
    expect(slackSdkMock.socketClients[0].on).toHaveBeenCalledWith("interactive", expect.any(Function));
    expect(slackSdkMock.socketClients[0].start).toHaveBeenCalled();
    expect(channel.botUserId).toBe("U_BOT");
    await channel.stop();
  });

  it("converts Markdown to Slack mrkdwn including tables while preserving code", () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());

    const result = channel.toMrkdwn([
      "# Title",
      "",
      "**bold**",
      "",
      "| Name | Score |",
      "| --- | --- |",
      "| Ada | 42 |",
      "",
      "`**literal**`",
      "",
      "https://example.com?a=1&amp;b=2",
    ].join("\n"));

    expect(result).toContain("*Title*");
    expect(result).toContain("*bold*");
    expect(result).toContain("*Name*: Ada");
    expect(result).toContain("*Score*: 42");
    expect(result).toContain("`**literal**`");
    expect(result).toContain("https://example.com?a=1&b=2");
    expect(result).not.toContain("| --- |");
  });

  it("sends channel and DM messages with correct thread handling and media uploads", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    channel.webClient = fake;

    await channel.send(new OutboundMessage({
      channel: "slack",
      chatId: "C123",
      content: "hello",
      media: ["/tmp/demo.txt"],
      metadata: { slack: { thread_ts: "1700000000.000100", event: { channel: "C123" } } },
    }));

    expect(fake.chatPostCalls[0]).toMatchObject({ channel: "C123", text: "hello", thread_ts: "1700000000.000100" });
    expect(fake.fileUploadCalls[0]).toMatchObject({ channel: "C123", file: "/tmp/demo.txt", thread_ts: "1700000000.000100" });

    await channel.send(new OutboundMessage({
      channel: "slack",
      chatId: "C999",
      content: "cross",
      metadata: { slack: { thread_ts: "1700000000.000200", event: { channel: "C_ORIGIN" } } },
    }));
    expect(fake.chatPostCalls.at(-1).thread_ts).toBeNull();
  });

  it("splits long messages and renders buttons on the last chunk", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    channel.webClient = fake;

    await channel.send(new OutboundMessage({ channel: "slack", chatId: "C123", content: "x".repeat(SLACK_MAX_MESSAGE_LEN + 10) }));
    expect(fake.chatPostCalls).toHaveLength(2);
    expect(fake.chatPostCalls.every((call) => call.text.length <= SLACK_MAX_MESSAGE_LEN)).toBe(true);

    fake.chatPostCalls = [];
    await channel.send(new OutboundMessage({
      channel: "slack",
      chatId: "C123",
      content: "Choose one",
      buttons: [["Yes", "No"]],
    }));
    expect(fake.chatPostCalls[0].blocks.at(-1)).toEqual({
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Yes" }, value: "Yes", action_id: "btn_Yes" },
        { type: "button", text: { type: "plain_text", text: "No" }, value: "No", action_id: "btn_No" },
      ],
    });
  });

  it("updates reactions on final responses", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true, reactEmoji: "eyes" }), new MessageBus());
    const fake = new FakeSlackWebClient();
    channel.webClient = fake;

    await channel.send(new OutboundMessage({
      channel: "slack",
      chatId: "C123",
      content: "done",
      metadata: { slack: { event: { ts: "1700000000.000100", channel: "C123" } } },
    }));

    expect(fake.reactionsRemoveCalls).toEqual([{ channel: "C123", name: "eyes", timestamp: "1700000000.000100" }]);
    expect(fake.reactionsAddCalls).toEqual([{ channel: "C123", name: "white_check_mark", timestamp: "1700000000.000100" }]);
  });

  it("resolves channel names and user handles", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    fake.conversationsPages = [{ channels: [{ id: "C999", name: "channel_x" }], response_metadata: { next_cursor: "" } }];
    fake.usersPages = [{ members: [{ id: "U234", name: "alice", profile: { display_name: "Alice" } }], response_metadata: { next_cursor: "" } }];
    fake.openDmResponse = { channel: { id: "D234" } };
    channel.webClient = fake;

    await channel.send(new OutboundMessage({ channel: "slack", chatId: "#channel_x", content: "hello" }));
    expect(fake.chatPostCalls[0]).toMatchObject({ channel: "C999", text: "hello" });

    await channel.send(new OutboundMessage({ channel: "slack", chatId: "@alice", content: "hi" }));
    expect(fake.conversationsOpenCalls).toEqual([{ users: "U234" }]);
    expect(fake.chatPostCalls.at(-1)).toMatchObject({ channel: "D234", text: "hi" });

    await expect(channel.resolveTargetChatId("#missing")).rejects.toThrow(/not found/);
  });

  it("adds Slack thread context only once per thread/current message", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    fake.conversationsRepliesResponse = {
      messages: [
        { ts: "111.000", user: "UROOT", text: "drink water" },
        { ts: "112.000", user: "U2", text: "good idea" },
        { ts: "112.500", user: "UBOT", text: "I'll remind you." },
        { ts: "113.000", user: "U3", text: "current" },
      ],
    };
    channel.botUserId = "UBOT";
    channel.webClient = fake;

    const content = await channel.withThreadContext("what did you see?", "C123", "channel", "111.000", "111.000", "113.000");
    expect(fake.conversationsRepliesCalls).toEqual([{ channel: "C123", ts: "111.000", limit: 20 }]);
    expect(content).toContain("Slack thread context before this mention:");
    expect(content).toContain("- <@UROOT>: drink water");
    expect(content).toContain("- bot: I'll remind you.");
    expect(content).not.toContain("current");

    const second = await channel.withThreadContext("again", "C123", "channel", "111.000", "111.000", "113.000");
    expect(second).toBe("again");
    expect(fake.conversationsRepliesCalls).toHaveLength(1);
  });

  it("detects Slack login HTML downloads and produces actionable failure markers", () => {
    expect(SlackChannel.looksLikeHtmlDownload({
      headers: { "content-type": "text/html; charset=utf-8" },
      content: Buffer.from("<!doctype html><html><title>Sign in to Slack</title>"),
    })).toBe(true);
    expect(SlackChannel.looksLikeHtmlDownload({
      headers: { "content-type": "text/markdown" },
      content: Buffer.from("# PR Extraction Guide\n"),
    })).toBe(false);

    const marker = SlackChannel.downloadFailureMarker("image", "screenshot.png", "download failed");
    expect(marker).toContain("not available to memmy-agent");
    expect(marker).toContain("files:read");
    expect(marker).toContain("reinstall the Slack app");
  });

  it("uses channel-aware allow policy", () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true, allowFrom: [] }), new MessageBus());
    expect(channel.isSlackAllowed("U1", "C123", "channel")).toBe(true);
    expect(channel.isSlackAllowed("U1", "D123", "im")).toBe(true);
  });

  it("sends channel messages in the original thread", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    channel.webClient = fake;

    await channel.send(new OutboundMessage({
      channel: "slack",
      chatId: "C123",
      content: "hello",
      media: ["/tmp/demo.txt"],
      metadata: { slack: { thread_ts: "1700000000.000100", channel_type: "channel", event: { channel: "C123" } } },
    }));

    expect(fake.chatPostCalls).toHaveLength(1);
    expect(fake.chatPostCalls[0].thread_ts).toBe("1700000000.000100");
    expect(fake.fileUploadCalls[0].thread_ts).toBe("1700000000.000100");
  });

  it("omits thread_ts for root DM messages", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    channel.webClient = fake;

    await channel.send(new OutboundMessage({
      channel: "slack",
      chatId: "D123",
      content: "hello",
      media: ["/tmp/demo.txt"],
      metadata: { slack: { thread_ts: null, channel_type: "im" } },
    }));

    expect(fake.chatPostCalls[0].thread_ts).toBeNull();
    expect(fake.fileUploadCalls[0].thread_ts).toBeNull();
  });

  it("keeps thread_ts for real DM thread messages", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    channel.webClient = fake;

    await channel.send(new OutboundMessage({
      channel: "slack",
      chatId: "D123",
      content: "hello",
      media: ["/tmp/demo.txt"],
      metadata: { slack: { thread_ts: "1700000000.000100", channel_type: "im", event: { channel: "D123" } } },
    }));

    expect(fake.chatPostCalls[0].thread_ts).toBe("1700000000.000100");
    expect(fake.fileUploadCalls[0].thread_ts).toBe("1700000000.000100");
  });

  it("resolves channel names to channel IDs", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    fake.conversationsPages = [{ channels: [{ id: "C999", name: "channel_x" }], response_metadata: { next_cursor: "" } }];
    channel.webClient = fake;

    await channel.send(new OutboundMessage({ channel: "slack", chatId: "#channel_x", content: "hello" }));

    expect(fake.chatPostCalls).toEqual([{ channel: "C999", text: "hello", thread_ts: null }]);
    expect(fake.conversationsListCalls).toHaveLength(1);
  });

  it("resolves user handles to DM channels", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    fake.usersPages = [{ members: [{ id: "U234", name: "alice", profile: { display_name: "Alice" } }], response_metadata: { next_cursor: "" } }];
    fake.openDmResponse = { channel: { id: "D234" } };
    channel.webClient = fake;

    await channel.send(new OutboundMessage({ channel: "slack", chatId: "@alice", content: "hello" }));

    expect(fake.conversationsOpenCalls).toEqual([{ users: "U234" }]);
    expect(fake.chatPostCalls).toEqual([{ channel: "D234", text: "hello", thread_ts: null }]);
  });

  it("updates reactions on the origin channel for cross-channel sends", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true, reactEmoji: "eyes" }), new MessageBus());
    const fake = new FakeSlackWebClient();
    fake.conversationsPages = [{ channels: [{ id: "C999", name: "channel_x" }], response_metadata: { next_cursor: "" } }];
    channel.webClient = fake;

    await channel.send(new OutboundMessage({
      channel: "slack",
      chatId: "channel_x",
      content: "done",
      metadata: { slack: { event: { ts: "1700000000.000100", channel: "D_ORIGIN" }, channel_type: "im" } },
    }));

    expect(fake.chatPostCalls).toEqual([{ channel: "C999", text: "done", thread_ts: null }]);
    expect(fake.reactionsRemoveCalls).toEqual([{ channel: "D_ORIGIN", name: "eyes", timestamp: "1700000000.000100" }]);
    expect(fake.reactionsAddCalls).toEqual([{ channel: "D_ORIGIN", name: "white_check_mark", timestamp: "1700000000.000100" }]);
  });

  it("does not reuse the origin thread_ts for cross-channel sends", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    fake.conversationsPages = [{ channels: [{ id: "C999", name: "channel_x" }], response_metadata: { next_cursor: "" } }];
    channel.webClient = fake;

    await channel.send(new OutboundMessage({
      channel: "slack",
      chatId: "channel_x",
      content: "done",
      metadata: { slack: { event: { ts: "1700000000.000100", channel: "C_ORIGIN" }, thread_ts: "1700000000.000200", channel_type: "channel" } },
    }));

    expect(fake.chatPostCalls).toEqual([{ channel: "C999", text: "done", thread_ts: null }]);
  });

  it("raises when a named target cannot be resolved", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    channel.webClient = new FakeSlackWebClient();

    await expect(channel.send(new OutboundMessage({ channel: "slack", chatId: "#missing-channel", content: "hello" }))).rejects.toThrow(/was not found/);
  });

  it("fetches thread context for DM threads", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    const fake = new FakeSlackWebClient();
    fake.conversationsRepliesResponse = { messages: [{ ts: "211.000", user: "UA", text: "here is the file" }] };
    channel.botUserId = "UBOT";
    channel.webClient = fake;

    const content = await channel.withThreadContext("what did you see?", "D123", "im", "211.000", "211.000", "213.000");

    expect(fake.conversationsRepliesCalls).toEqual([{ channel: "D123", ts: "211.000", limit: 20 }]);
    expect(content).toContain("- <@UA>: here is the file");
  });

  it("keeps root DM socket messages unthreaded and in the default session", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    channel.botUserId = "UBOT";
    channel.webClient = new FakeSlackWebClient();
    const handle = vi.fn(async () => undefined);
    (channel as any).handleMessage = handle;
    const client = { sendSocketModeResponse: vi.fn(async () => undefined) };

    await channel.onSocketRequest(client, {
      type: "events_api",
      envelope_id: "env-dm-root",
      payload: { event: { type: "message", user: "U1", channel: "D123", channel_type: "im", text: "hello", ts: "1700000000.000100" } },
    });

    expect(handle).toHaveBeenCalledTimes(1);
    const call = (handle.mock.calls[0] as any[])[0];
    expect(call.sessionKey).toBeNull();
    expect(call.metadata.slack.thread_ts).toBeNull();
  });

  it("does not let BaseChannel reject Slack messages after channel-aware allow checks", async () => {
    const bus = new MessageBus();
    const channel = new SlackChannel(new SlackConfig({ enabled: true, groupPolicy: "open", allowFrom: [] }), bus);
    channel.botUserId = "UBOT";
    channel.webClient = new FakeSlackWebClient();

    await channel.onSocketRequest({ sendSocketModeResponse: vi.fn(async () => undefined) }, {
      type: "events_api",
      envelope_id: "env-open",
      payload: { event: { type: "message", user: "U1", channel: "C123", channel_type: "channel", text: "hello", ts: "1700000000.000100" } },
    });

    const inbound = await bus.nextInbound();
    expect(inbound.senderId).toBe("U1");
    expect(inbound.chatId).toBe("C123");
    expect(inbound.content).toBe("hello");
  });

  it("handles interactive button clicks from Socket Mode", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true, groupPolicy: "open" }), new MessageBus());
    const handle = vi.fn(async () => undefined);
    (channel as any).handleMessage = handle;
    const client = { sendSocketModeResponse: vi.fn(async () => undefined) };

    await channel.onSocketRequest(client, {
      type: "interactive",
      envelope_id: "env-button",
      payload: {
        actions: [{ value: "Approve" }],
        user: { id: "U1" },
        channel: { id: "C123" },
        message: { ts: "1700000000.000100" },
      },
    });

    expect(client.sendSocketModeResponse).toHaveBeenCalledWith({ envelope_id: "env-button" });
    expect(handle).toHaveBeenCalledWith({
      senderId: "U1",
      chatId: "C123",
      content: "Approve",
      metadata: { slack: { thread_ts: "1700000000.000100", channel_type: "channel" } },
      sessionKey: "slack:C123:1700000000.000100",
    });
  });

  it("keeps DM thread socket messages isolated by thread session", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true }), new MessageBus());
    channel.botUserId = "UBOT";
    channel.webClient = new FakeSlackWebClient();
    const handle = vi.fn(async () => undefined);
    (channel as any).handleMessage = handle;
    (channel as any).withThreadContext = vi.fn(async () => "hello");

    await channel.onSocketRequest({ sendSocketModeResponse: vi.fn(async () => undefined) }, {
      type: "events_api",
      envelope_id: "env-dm-thread",
      payload: { event: { type: "message", user: "U1", channel: "D123", channel_type: "im", text: "hello", ts: "1700000000.000200", thread_ts: "1700000000.000100" } },
    });

    const call = (handle.mock.calls[0] as any[])[0];
    expect(call.sessionKey).toBe("slack:D123:1700000000.000100");
    expect(call.metadata.slack.thread_ts).toBe("1700000000.000100");
  });

  it("skips thread context for Slack slash commands", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true, allowFrom: [] }), new MessageBus());
    channel.botUserId = "UBOT";
    const withContext = vi.fn(async () => "wrapped");
    const handle = vi.fn(async () => undefined);
    (channel as any).withThreadContext = withContext;
    (channel as any).handleMessage = handle;

    await channel.onSocketRequest({ sendSocketModeResponse: vi.fn(async () => undefined) }, {
      type: "events_api",
      envelope_id: "env-1",
      payload: { event: { type: "app_mention", user: "U1", channel: "C123", text: "<@UBOT> /restart", thread_ts: "111.000", ts: "112.000" } },
    });

    expect(withContext).not.toHaveBeenCalled();
    expect((handle.mock.calls[0] as any[])[0].content).toBe("/restart");
  });

  it("downloads file-share media and forwards markers to the agent", async () => {
    const channel = new SlackChannel(new SlackConfig({ enabled: true, botToken: "xoxb-test" }), new MessageBus());
    channel.botUserId = "UBOT";
    channel.webClient = new FakeSlackWebClient();
    const handle = vi.fn(async () => undefined);
    (channel as any).handleMessage = handle;
    (channel as any).downloadSlackFile = vi.fn(async () => ["/tmp/report.pdf", "[file: report.pdf]"]);

    await channel.onSocketRequest({ sendSocketModeResponse: vi.fn(async () => undefined) }, {
      type: "events_api",
      envelope_id: "env-file",
      payload: {
        event: {
          type: "message",
          subtype: "file_share",
          user: "U1",
          channel: "D123",
          channel_type: "im",
          text: "please read this",
          ts: "1700000000.000100",
          files: [{ id: "F123", name: "report.pdf", mimetype: "application/pdf", url_private_download: "https://files.slack.com/report.pdf" }],
        },
      },
    });

    expect((channel as any).downloadSlackFile).toHaveBeenCalledTimes(1);
    const call = (handle.mock.calls[0] as any[])[0];
    expect(call.content).toBe("please read this\n[file: report.pdf]");
    expect(call.media).toEqual(["/tmp/report.pdf"]);
  });

  it("downloads Slack files into the configured media directory", async () => {
    tempDataDir();
    const channel = new SlackChannel(new SlackConfig({ enabled: true, botToken: "xoxb-test" }), new MessageBus());
    const fetchMock = vi.fn(async () => new Response(Buffer.from("hello"), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const [filePath, marker] = await channel.downloadSlackFile({
      id: "F123",
      name: "report.pdf",
      mimetype: "application/pdf",
      url_private_download: "https://files.slack.com/report.pdf",
    });

    expect(fetchMock).toHaveBeenCalledWith("https://files.slack.com/report.pdf", expect.objectContaining({
      headers: { Authorization: "Bearer xoxb-test" },
    }));
    expect(filePath).toBe(path.join(getMediaDir("slack"), "F123_report.pdf"));
    expect(marker).toBe("[file: report.pdf]");
    expect(fs.readFileSync(filePath!, "utf8")).toBe("hello");
  });
});
