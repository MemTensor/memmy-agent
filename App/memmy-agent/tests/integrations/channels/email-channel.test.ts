import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import { EmailChannel, EmailConfig, type EmailEnvelope } from "../../../src/integrations/channels/email.js";

const emailRuntimeMocks = vi.hoisted(() => {
  const api: any = {
    messages: [] as Array<{ uid: number; source: Buffer }>,
    imapInstances: [] as any[],
    transport: null as any,
  };
  const makeTransport = () => {
    api.transport = {
      sendMail: vi.fn(async () => ({ messageId: "smtp-1" })),
      close: vi.fn(),
    };
    return api.transport;
  };
  function MockImapFlow(this: any, opts: any) {
    this.opts = opts;
    this.connect = vi.fn(async () => undefined);
    this.mailboxOpen = vi.fn(async () => undefined);
    this.search = vi.fn(async () => api.messages.map((msg: any) => msg.uid));
    this.messageFlagsAdd = vi.fn(async () => true);
    this.logout = vi.fn(async () => undefined);
    this.fetch = async function* () {
      for (const msg of api.messages) yield { uid: msg.uid, source: msg.source };
    };
    api.imapInstances.push(this);
  }
  api.createTransport = vi.fn(makeTransport);
  api.ImapFlow = vi.fn(MockImapFlow);
  api.reset = () => {
    api.messages = [];
    api.imapInstances = [];
    api.transport = null;
    api.createTransport.mockClear();
    api.createTransport.mockImplementation(makeTransport);
    api.ImapFlow.mockClear();
    api.ImapFlow.mockImplementation(MockImapFlow);
  };
  return api;
});

vi.mock("nodemailer", () => ({ createTransport: emailRuntimeMocks.createTransport }));
vi.mock("imapflow", () => ({ ImapFlow: emailRuntimeMocks.ImapFlow }));

const oldConfig = process.env.MEMMY_CONFIG;
const roots: string[] = [];

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-email-"));
  roots.push(root);
  process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  emailRuntimeMocks.reset();
  process.env.MEMMY_CONFIG = oldConfig;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeConfig(overrides: Record<string, any> = {}): EmailConfig {
  return new EmailConfig({
    enabled: true,
    consentGranted: true,
    imapHost: "imap.example.com",
    imapPort: 993,
    imapUsername: "bot@example.com",
    imapPassword: "secret",
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpUsername: "bot@example.com",
    smtpPassword: "secret",
    markSeen: true,
    allowFrom: ["*"],
    verifyDkim: false,
    verifySpf: false,
    ...overrides,
  });
}

function makeRawEmail({
  from = "alice@example.com",
  subject = "Hello",
  body = "This is the body.",
  authResults = "",
  html = "",
  attachments = [],
}: {
  from?: string;
  subject?: string;
  body?: string;
  authResults?: string;
  html?: string;
  attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
} = {}): Buffer {
  const headers = [
    `From: ${from}`,
    "To: bot@example.com",
    `Subject: ${subject}`,
    "Date: Fri, 06 Feb 2026 12:00:00 +0000",
    "Message-ID: <m1@example.com>",
  ];
  if (authResults) headers.push(`Authentication-Results: ${authResults}`);
  if (!attachments.length) {
    headers.push(`Content-Type: ${html ? "text/html" : "text/plain"}; charset=utf-8`);
    return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${html || body}`, "utf8");
  }

  const boundary = "memmy-boundary";
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
    ...attachments.map((attachment) => {
      const [maintype, subtype] = attachment.contentType.split("/");
      return [
        `--${boundary}`,
        `Content-Type: ${maintype}/${subtype}; name="${attachment.filename}"`,
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        "Content-Transfer-Encoding: base64",
        "",
        attachment.content.toString("base64"),
      ].join("\r\n");
    }),
    `--${boundary}--`,
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`, "utf8");
}

class FakeIMAP {
  raw: Buffer;
  uid: string;
  ids: string[];
  storeCalls: Array<[Buffer, string, string]> = [];
  searchArgs: any[] | null = null;
  seen = false;
  selectError: Error | null = null;
  searchError: Error | null = null;

  constructor(raw: Buffer, uid = "123", ids = ["1"]) {
    this.raw = raw;
    this.uid = uid;
    this.ids = ids;
  }

  login(user: string, password: string): [string, Buffer[]] {
    return ["OK", [Buffer.from("logged in")]];
  }

  select(mailbox: string): [string, Buffer[]] {
    if (this.selectError) throw this.selectError;
    return ["OK", [Buffer.from(String(this.ids.length))]];
  }

  search(...args: any[]): [string, Buffer[]] {
    this.searchArgs = args;
    if (this.searchError) throw this.searchError;
    if (this.seen) return ["OK", [Buffer.from("")]];
    return ["OK", [Buffer.from(this.ids.join(" "))]];
  }

  fetch(imapId: Buffer, parts: string): [string, any[]] {
    return ["OK", [[Buffer.from(`${imapId.toString()} (UID ${this.uid} BODY[] {200})`), this.raw], Buffer.from(")")]];
  }

  store(imapId: Buffer, op: string, flags: string): [string, Buffer[]] {
    this.storeCalls.push([imapId, op, flags]);
    this.seen = true;
    return ["OK", [Buffer.from("")]];
  }

  logout(): [string, Buffer[]] {
    return ["BYE", [Buffer.from("")]];
  }
}

function storeCalls(fake: FakeIMAP): Array<[string, string, string]> {
  return fake.storeCalls.map(([id, op, flags]) => [id.toString(), op, flags]);
}

describe("EmailChannel", () => {
  it("uses nodemailer when no SMTP factory is injected", async () => {
    const channel = new EmailChannel(makeConfig(), new MessageBus());

    await channel.send(new OutboundMessage({ channel: "email", chatId: "alice@example.com", content: "Acknowledged." }));

    expect(emailRuntimeMocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "smtp.example.com", port: 587, secure: false, requireTLS: true }),
    );
    expect(emailRuntimeMocks.transport.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "bot@example.com", to: "alice@example.com", subject: "Re: memmy reply", text: "Acknowledged." }),
    );
  });

  it("uses imapflow when no IMAP factory is injected", async () => {
    tmpRoot();
    emailRuntimeMocks.messages = [{ uid: 123, source: makeRawEmail({ from: "alice@example.com", subject: "Hello", body: "Body from imapflow." }) }];
    const bus = new MessageBus();
    const channel = new EmailChannel(makeConfig(), bus);

    await channel.pollOnce();

    const msg = await bus.consumeInbound();
    expect(emailRuntimeMocks.ImapFlow).toHaveBeenCalledWith(
      expect.objectContaining({ host: "imap.example.com", port: 993, secure: true, auth: { user: "bot@example.com", pass: "secret" } }),
    );
    expect(emailRuntimeMocks.imapInstances[0].messageFlagsAdd).toHaveBeenCalledWith([123], ["\\Seen"], { uid: true });
    expect(msg.senderId).toBe("alice@example.com");
    expect(msg.content).toContain("Body from imapflow.");
  });

  it("parses unseen messages, marks them seen, and dedupes processed UIDs", () => {
    const fake = new FakeIMAP(makeRawEmail({ subject: "Invoice", body: "Please pay" }));
    const channel = new EmailChannel(makeConfig({ imapFactory: () => fake }), new MessageBus());

    const items = channel.fetchNewMessages();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sender: "alice@example.com", subject: "Invoice" });
    expect(items[0].content).toContain("Please pay");
    expect(storeCalls(fake)).toEqual([["1", "+FLAGS", "\\Seen"]]);
    fake.seen = false;
    expect(channel.fetchNewMessages()).toEqual([]);
  });

  it("skips self-sent email and marks it seen", () => {
    const fake = new FakeIMAP(makeRawEmail({ from: "Memmy <bot@example.com>", subject: "Loop test" }));
    const channel = new EmailChannel(makeConfig({ fromAddress: "bot@example.com", imapFactory: () => fake }), new MessageBus());

    expect(channel.fetchNewMessages()).toEqual([]);
    expect(storeCalls(fake)).toEqual([["1", "+FLAGS", "\\Seen"]]);
    fake.seen = false;
    expect(channel.fetchNewMessages()).toEqual([]);
  });

  it("detects self-sent emails across configured identity sources", () => {
    const cases = [
      [{ fromAddress: "", smtpUsername: "bot@example.com", imapUsername: "other@imap.com" }, "bot@example.com"],
      [{ fromAddress: "", smtpUsername: "other@smtp.com", imapUsername: "bot@example.com" }, "bot@example.com"],
      [{ fromAddress: "bot@example.com", smtpUsername: "other@smtp.com", imapUsername: "other@imap.com" }, "BOT@EXAMPLE.COM"],
    ] as const;

    for (const [configOverride, from] of cases) {
      const fake = new FakeIMAP(makeRawEmail({ from, subject: "Loop test" }));
      const channel = new EmailChannel(makeConfig({ ...configOverride, imapFactory: () => fake }), new MessageBus());

      expect(channel.fetchNewMessages()).toEqual([]);
      expect(storeCalls(fake)).toEqual([["1", "+FLAGS", "\\Seen"]]);
    }
  });

  it("retries once when the IMAP connection goes stale", () => {
    const raw = makeRawEmail({ subject: "Invoice", body: "Please pay" });
    const instances: FakeIMAP[] = [];
    let first = true;
    const channel = new EmailChannel(
      makeConfig({
        imapFactory: () => {
          const fake = new FakeIMAP(raw);
          if (first) {
            first = false;
            fake.searchError = new Error("socket error");
          }
          instances.push(fake);
          return fake;
        },
      }),
      new MessageBus(),
    );

    expect(channel.fetchNewMessages()).toHaveLength(1);
    expect(instances).toHaveLength(2);
    expect(instances[0].searchArgs).not.toBeNull();
    expect(instances[1].searchArgs).not.toBeNull();
  });

  it("keeps messages collected before a stale retry", () => {
    const mailboxState: Record<string, { uid: string; raw: Buffer; seen: boolean }> = {
      "1": { uid: "123", raw: makeRawEmail({ subject: "First", body: "First body" }), seen: false },
      "2": { uid: "124", raw: makeRawEmail({ subject: "Second", body: "Second body" }), seen: false },
    };
    let shouldFailSecond = true;
    class FlakyIMAP {
      login() {
        return ["OK", [Buffer.from("logged in")]];
      }
      select() {
        return ["OK", [Buffer.from("2")]];
      }
      search() {
        return ["OK", [Buffer.from(Object.entries(mailboxState).filter(([, item]) => !item.seen).map(([id]) => id).join(" "))]];
      }
      fetch(imapId: Buffer) {
        const id = imapId.toString();
        if (id === "2" && shouldFailSecond) {
          shouldFailSecond = false;
          throw new Error("socket error");
        }
        const item = mailboxState[id];
        return ["OK", [[Buffer.from(`${id} (UID ${item.uid} BODY[] {200})`), item.raw], Buffer.from(")")]];
      }
      store(imapId: Buffer) {
        mailboxState[imapId.toString()].seen = true;
        return ["OK", [Buffer.from("")]];
      }
      logout() {
        return ["BYE", [Buffer.from("")]];
      }
    }
    const channel = new EmailChannel(makeConfig({ imapFactory: () => new FlakyIMAP() }), new MessageBus());

    expect(channel.fetchNewMessages().map((item) => item.subject)).toEqual(["First", "Second"]);
  });

  it("skips missing mailboxes", () => {
    const fake = new FakeIMAP(makeRawEmail());
    fake.selectError = new Error("Mailbox doesn't exist");
    const channel = new EmailChannel(makeConfig({ imapFactory: () => fake }), new MessageBus());

    expect(channel.fetchNewMessages()).toEqual([]);
  });

  it("extracts text from HTML-only bodies", () => {
    const html = makeRawEmail({ subject: "HTML only", html: "<p>Hello<br>world</p>" });

    expect(EmailChannel.extractTextBody(html)).toContain("Hello");
    expect(EmailChannel.extractTextBody(html)).toContain("world");
  });

  it("returns immediately from start without consent", async () => {
    const channel = new EmailChannel(makeConfig({ consentGranted: false }), new MessageBus());
    let called = false;
    channel.fetchNewMessages = () => {
      called = true;
      return [];
    };

    await channel.start();

    expect(channel.isRunning).toBe(false);
    expect(called).toBe(false);
  });

  it("sends replies through SMTP with reply subject and headers", async () => {
    const sent: EmailEnvelope[] = [];
    const channel = new EmailChannel(
      makeConfig({
        smtpFactory: () => ({
          startTls: vi.fn(),
          login: vi.fn(),
          sendMessage: (envelope: EmailEnvelope) => sent.push(envelope),
          quit: vi.fn(),
        }),
      }),
      new MessageBus(),
    );
    channel.lastSubjectByChat["alice@example.com"] = "Invoice #42";
    channel.lastMessageIdByChat["alice@example.com"] = "<m1@example.com>";

    await channel.send(new OutboundMessage({ channel: "email", chatId: "alice@example.com", content: "Acknowledged." }));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "alice@example.com", subject: "Re: Invoice #42", text: "Acknowledged." });
    expect(sent[0].headers).toMatchObject({ "In-Reply-To": "<m1@example.com>", References: "<m1@example.com>" });
  });

  it("skips replies when auto replies are disabled unless force_send is set", async () => {
    const sent: EmailEnvelope[] = [];
    const channel = new EmailChannel(makeConfig({ autoReplyEnabled: false }), new MessageBus());
    channel.lastSubjectByChat["alice@example.com"] = "Previous email";
    channel.smtpSend = async (envelope: EmailEnvelope) => {
      sent.push(envelope);
    };

    await channel.send(new OutboundMessage({ channel: "email", chatId: "alice@example.com", content: "Should not send." }));
    await channel.send(
      new OutboundMessage({ channel: "email", chatId: "alice@example.com", content: "Force send.", metadata: { force_send: true } }),
    );

    expect(sent.map((envelope) => envelope.text)).toEqual(["Force send."]);
  });

  it("sends proactive email when auto replies are disabled", async () => {
    const sent: EmailEnvelope[] = [];
    const channel = new EmailChannel(makeConfig({ autoReplyEnabled: false }), new MessageBus());
    channel.smtpSend = async (envelope: EmailEnvelope) => {
      sent.push(envelope);
    };

    await channel.send(new OutboundMessage({ channel: "email", chatId: "bob@example.com", content: "Hello, proactive email." }));

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("bob@example.com");
  });

  it("skips send when consent is not granted", async () => {
    const channel = new EmailChannel(makeConfig({ consentGranted: false }), new MessageBus());
    const smtpSend = vi.fn();
    channel.smtpSend = smtpSend;

    await channel.send(new OutboundMessage({ channel: "email", chatId: "alice@example.com", content: "Should not send.", metadata: { force_send: true } }));

    expect(smtpSend).not.toHaveBeenCalled();
  });

  it("fetches messages between dates with SINCE and BEFORE without marking seen", () => {
    const fake = new FakeIMAP(makeRawEmail({ subject: "Status", body: "Yesterday update" }), "999", ["5"]);
    const channel = new EmailChannel(makeConfig({ imapFactory: () => fake }), new MessageBus());

    const items = channel.fetchMessagesBetweenDates(new Date(Date.UTC(2026, 1, 6)), new Date(Date.UTC(2026, 1, 7)), 10);

    expect(items).toHaveLength(1);
    expect(items[0].subject).toBe("Status");
    expect(fake.searchArgs?.slice(1)).toEqual(["SINCE", "06-Feb-2026", "BEFORE", "07-Feb-2026"]);
    expect(fake.storeCalls).toEqual([]);
  });

  it("rejects spoofed email when authentication verification is enabled", () => {
    const fake = new FakeIMAP(makeRawEmail({ subject: "Spoofed", body: "Malicious payload" }));
    const channel = new EmailChannel(makeConfig({ verifyDkim: true, verifySpf: true, imapFactory: () => fake }), new MessageBus());

    expect(channel.fetchNewMessages()).toEqual([]);
  });

  it("accepts email with valid authentication results", () => {
    const fake = new FakeIMAP(
      makeRawEmail({
        subject: "Legit",
        body: "Hello from verified sender",
        authResults: "mx.example.com; spf=pass smtp.mailfrom=alice@example.com; dkim=pass header.d=example.com",
      }),
    );
    const channel = new EmailChannel(makeConfig({ verifyDkim: true, verifySpf: true, imapFactory: () => fake }), new MessageBus());

    const items = channel.fetchNewMessages();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sender: "alice@example.com", subject: "Legit" });
  });

  it("rejects partial authentication when DKIM is required", () => {
    const fake = new FakeIMAP(
      makeRawEmail({
        subject: "Partial",
        body: "Only SPF passes",
        authResults: "mx.example.com; spf=pass smtp.mailfrom=alice@example.com; dkim=fail",
      }),
    );
    const channel = new EmailChannel(makeConfig({ verifyDkim: true, verifySpf: true, imapFactory: () => fake }), new MessageBus());

    expect(channel.fetchNewMessages()).toEqual([]);
  });

  it("keeps backward compatibility when authentication checks are disabled", () => {
    const fake = new FakeIMAP(makeRawEmail({ subject: "NoAuth", body: "No auth headers present" }));
    const channel = new EmailChannel(makeConfig({ verifyDkim: false, verifySpf: false, imapFactory: () => fake }), new MessageBus());

    expect(channel.fetchNewMessages()).toHaveLength(1);
  });

  it("tags email content with EMAIL-CONTEXT", () => {
    const fake = new FakeIMAP(makeRawEmail({ subject: "Tagged", body: "Check the tag" }));
    const channel = new EmailChannel(makeConfig({ imapFactory: () => fake }), new MessageBus());

    const items = channel.fetchNewMessages();

    expect(items).toHaveLength(1);
    expect(items[0].content.startsWith("[EMAIL-CONTEXT]")).toBe(true);
  });

  it("checks Authentication-Results headers", () => {
    expect(EmailChannel.checkAuthenticationResults(makeRawEmail())).toEqual([false, false]);
    expect(
      EmailChannel.checkAuthenticationResults(
        makeRawEmail({
          authResults: "mx.google.com; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com",
        }),
      ),
    ).toEqual([true, true]);
    expect(
      EmailChannel.checkAuthenticationResults(
        makeRawEmail({
          authResults: "mx.google.com; spf=pass smtp.mailfrom=example.com; dkim=fail",
        }),
      ),
    ).toEqual([true, false]);
    expect(
      EmailChannel.checkAuthenticationResults(
        makeRawEmail({
          authResults: "mx.google.com; spf=fail smtp.mailfrom=example.com; dkim=pass header.d=example.com",
        }),
      ),
    ).toEqual([false, true]);
  });

  it("ignores unauthorized senders before extracting attachments", () => {
    const fake = new FakeIMAP(
      makeRawEmail({
        from: "blocked@example.com",
        attachments: [{ filename: "doc.pdf", contentType: "application/pdf", content: Buffer.from("%PDF") }],
      }),
    );
    const extract = vi.spyOn(EmailChannel, "extractAttachments");
    const channel = new EmailChannel(
      makeConfig({
        allowFrom: ["allowed@example.com"],
        allowedAttachmentTypes: ["application/pdf"],
        imapFactory: () => fake,
      }),
      new MessageBus(),
    );

    expect(channel.fetchNewMessages()).toEqual([]);
    expect(extract).not.toHaveBeenCalled();
    expect(storeCalls(fake)).toEqual([["1", "+FLAGS", "\\Seen"]]);
  });

  it("saves PDF attachments and reports their media paths", () => {
    const root = tmpRoot();
    const fake = new FakeIMAP(
      makeRawEmail({
        attachments: [{ filename: "doc.pdf", contentType: "application/pdf", content: Buffer.from("%PDF-1.4 fake pdf content") }],
      }),
      "500",
    );
    const channel = new EmailChannel(makeConfig({ allowedAttachmentTypes: ["application/pdf"], imapFactory: () => fake }), new MessageBus());

    const item = channel.fetchNewMessages()[0];
    const saved = item.media[0];

    expect(item.media).toHaveLength(1);
    expect(saved).toBe(path.join(root, "media", "email", "500_doc.pdf"));
    expect(fs.readFileSync(saved)).toEqual(Buffer.from("%PDF-1.4 fake pdf content"));
    expect(item.content).toContain("[attachment:");
  });

  it("does not extract attachments when allowed types are empty by default", () => {
    const fake = new FakeIMAP(
      makeRawEmail({
        attachments: [{ filename: "doc.pdf", contentType: "application/pdf", content: Buffer.from("%PDF") }],
      }),
    );
    const channel = new EmailChannel(makeConfig({ imapFactory: () => fake }), new MessageBus());

    const items = channel.fetchNewMessages();

    expect(items).toHaveLength(1);
    expect(items[0].media).toEqual([]);
    expect(items[0].content).not.toContain("[attachment:");
  });

  it("filters attachments by MIME type", () => {
    tmpRoot();
    const fake = new FakeIMAP(
      makeRawEmail({
        attachments: [{ filename: "image.png", contentType: "image/png", content: Buffer.from("\x89PNG fake", "binary") }],
      }),
    );
    const channel = new EmailChannel(makeConfig({ allowedAttachmentTypes: ["application/pdf"], imapFactory: () => fake }), new MessageBus());

    expect(channel.fetchNewMessages()[0].media).toEqual([]);
  });

  it("rejects all attachments when allowed types is empty", () => {
    tmpRoot();
    const fake = new FakeIMAP(
      makeRawEmail({
        attachments: [{ filename: "image.png", contentType: "image/png", content: Buffer.from("\x89PNG fake", "binary") }],
      }),
    );
    const channel = new EmailChannel(makeConfig({ allowedAttachmentTypes: [], imapFactory: () => fake }), new MessageBus());

    expect(channel.fetchNewMessages()[0].media).toEqual([]);
  });

  it("matches wildcard attachment MIME patterns", () => {
    tmpRoot();
    const fake = new FakeIMAP(
      makeRawEmail({
        attachments: [{ filename: "photo.jpg", contentType: "image/jpeg", content: Buffer.from([0xff, 0xd8, 0xff]) }],
      }),
      "500",
    );
    const channel = new EmailChannel(makeConfig({ allowedAttachmentTypes: ["image/*"], imapFactory: () => fake }), new MessageBus());

    expect(channel.fetchNewMessages()[0].media).toHaveLength(1);
  });

  it("skips attachments exceeding maxAttachmentSize", () => {
    tmpRoot();
    const fake = new FakeIMAP(
      makeRawEmail({
        attachments: [{ filename: "large.pdf", contentType: "application/pdf", content: Buffer.alloc(1000, "x") }],
      }),
    );
    const channel = new EmailChannel(
      makeConfig({ allowedAttachmentTypes: ["*"], maxAttachmentSize: 500, imapFactory: () => fake }),
      new MessageBus(),
    );

    expect(channel.fetchNewMessages()[0].media).toEqual([]);
  });

  it("saves only maxAttachmentsPerEmail attachments", () => {
    tmpRoot();
    const fake = new FakeIMAP(
      makeRawEmail({
        attachments: [
          { filename: "doc0.pdf", contentType: "application/pdf", content: Buffer.from("content 0") },
          { filename: "doc1.pdf", contentType: "application/pdf", content: Buffer.from("content 1") },
          { filename: "doc2.pdf", contentType: "application/pdf", content: Buffer.from("content 2") },
        ],
      }),
    );
    const channel = new EmailChannel(
      makeConfig({ allowedAttachmentTypes: ["*"], maxAttachmentsPerEmail: 2, imapFactory: () => fake }),
      new MessageBus(),
    );

    expect(channel.fetchNewMessages()[0].media).toHaveLength(2);
  });

  it("sanitizes attachment filenames to prevent path traversal", () => {
    const root = tmpRoot();
    const fake = new FakeIMAP(
      makeRawEmail({
        attachments: [{ filename: "../../../etc/passwd", contentType: "application/pdf", content: Buffer.from("%PDF") }],
      }),
      "500",
    );
    const channel = new EmailChannel(makeConfig({ allowedAttachmentTypes: ["*"], imapFactory: () => fake }), new MessageBus());

    const savedPath = channel.fetchNewMessages()[0].media[0];

    expect(path.dirname(savedPath)).toBe(path.join(root, "media", "email"));
    expect(path.basename(savedPath)).toBe("500_passwd");
  });
});
