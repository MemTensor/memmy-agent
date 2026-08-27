import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutboundMessage } from "../../../src/core/runtime-messages/events.js";
import { MessageBus } from "../../../src/core/runtime-messages/queue.js";
import {
  QQChannel,
  QQConfig,
  QQ_FILE_TYPE_FILE,
  QQ_FILE_TYPE_IMAGE,
  guessSendFileType,
  isImageName,
  sanitizeFilename,
} from "../../../src/integrations/channels/qq.js";

const roots: string[] = [];

function tmpFile(suffix: string, content: Buffer): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-qq-media-"));
  roots.push(root);
  const file = path.join(root, `file${suffix}`);
  fs.writeFileSync(file, content);
  return file;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

class FakeApi {
  c2cCalls: Record<string, any>[] = [];
  groupCalls: Record<string, any>[] = [];
  http: FakeHttp;

  constructor(httpReturn: Record<string, any> = {}) {
    this.http = new FakeHttp(httpReturn);
  }

  async postC2cMessage(payload: Record<string, any>): Promise<void> {
    this.c2cCalls.push(payload);
  }

  async postGroupMessage(payload: Record<string, any>): Promise<void> {
    this.groupCalls.push(payload);
  }
}

class FakeHttp {
  calls: Array<[any, any]> = [];
  constructor(public returnValue: Record<string, any> = {}) {}

  async request(route: any, kwargs: any): Promise<Record<string, any>> {
    this.calls.push([route, kwargs]);
    return this.returnValue;
  }
}

class FakeClient {
  api: FakeApi;
  constructor(httpReturn: Record<string, any> = {}) {
    this.api = new FakeApi(httpReturn);
  }
}

function makeChannel(config: Partial<QQConfig> = {}, httpReturn: Record<string, any> = {}): QQChannel {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-qq-media-root-"));
  roots.push(root);
  const channel = new QQChannel(new QQConfig({ appId: "app", secret: "secret", allowFrom: ["*"], mediaDir: root, ...config }), new MessageBus());
  channel.client = new FakeClient(httpReturn);
  return channel;
}

describe("QQ media helpers", () => {
  it("strips path traversal from filenames", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
  });

  it("keeps Chinese filename characters", () => {
    expect(sanitizeFilename("文件（1）.jpg")).toBe("文件（1）.jpg");
  });

  it("strips unsafe filename characters", () => {
    const result = sanitizeFilename('file<>:"|?*.txt');

    expect(result.startsWith("file")).toBe(true);
    expect(result.endsWith(".txt")).toBe(true);
    expect(result).not.toMatch(/[<>"|?]/);
  });

  it("returns an empty string for empty filenames", () => {
    expect(sanitizeFilename("")).toBe("");
  });

  it("detects known image extensions", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff", ".ico", ".svg"]) {
      expect(isImageName(`photo${ext}`)).toBe(true);
    }
  });

  it("rejects unknown image extensions", () => {
    for (const ext of [".pdf", ".txt", ".mp3", ".mp4"]) {
      expect(isImageName(`doc${ext}`)).toBe(false);
    }
  });

  it("guesses image file type from image filenames", () => {
    expect(guessSendFileType("photo.png")).toBe(QQ_FILE_TYPE_IMAGE);
    expect(guessSendFileType("pic.jpg")).toBe(QQ_FILE_TYPE_IMAGE);
  });

  it("guesses generic file type for non-image filenames", () => {
    expect(guessSendFileType("doc.pdf")).toBe(QQ_FILE_TYPE_FILE);
  });

  it("does not guess image type from MIME-like filename text", () => {
    expect(guessSendFileType("photo.xyz_image_test")).toBe(QQ_FILE_TYPE_FILE);
  });
});

describe("QQ media send", () => {
  it("catches send exceptions without propagating", async () => {
    const channel = makeChannel();
    vi.spyOn(channel, "sendTextOnly").mockRejectedValue(new Error("boom"));

    await expect(channel.send(new OutboundMessage({ channel: "qq", chatId: "user1", content: "hello" }))).resolves.toBeUndefined();
  });

  it("sends media before text when both are present", async () => {
    const channel = makeChannel();
    const order: string[] = [];
    vi.spyOn(channel, "sendMedia").mockImplementation(async () => {
      order.push("media");
      return true;
    });
    vi.spyOn(channel, "sendTextOnly").mockImplementation(async (chatId, isGroup, msgId, content) => {
      order.push(`text:${content}`);
    });

    await channel.send(new OutboundMessage({ channel: "qq", chatId: "user1", content: "text after image", media: ["image.png"], metadata: { messageId: "m1" } }));

    expect(order).toEqual(["media", "text:text after image"]);
  });

  it("falls back to text when media send fails", async () => {
    const channel = makeChannel();
    vi.spyOn(channel, "sendMedia").mockResolvedValue(false);

    await channel.send(
      new OutboundMessage({
        channel: "qq",
        chatId: "user1",
        content: "hello",
        media: ["https://example.com/bad.png"],
        metadata: { messageId: "m1" },
      }),
    );

    const failureCalls = (channel.client as FakeClient).api.c2cCalls.filter((call) => String(call.content ?? "").includes("Attachment send failed"));
    expect(failureCalls).toHaveLength(1);
    expect(failureCalls[0].content).toContain("bad.png");
  });
});

describe("QQ inbound media", () => {
  it("ignores unauthorized senders before attachments and ack", async () => {
    const channel = makeChannel({ allowFrom: ["allowed-user"], ackMessage: "Processing..." });
    const handleAttachments = vi.spyOn(channel, "handleAttachments");
    const handleMessage = vi.spyOn(channel as any, "handleMessage");
    const sendText = vi.spyOn(channel, "sendTextOnly");
    const data = {
      id: "msg-blocked",
      content: "hello",
      author: { user_openid: "blocked-user" },
      attachments: [{ filename: "a.png" }],
    };

    await channel.onMessage(data, false);

    expect(handleAttachments).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("catches malformed inbound messages without raising", async () => {
    const channel = makeChannel();

    await expect(channel.onMessage({ id: "x1", content: "hi" }, false)).resolves.toBeUndefined();
  });

  it("formats inbound attachments as media paths and received-file content", async () => {
    const savedPath = tmpFile(".png", Buffer.from("\x89PNG\r\n", "binary"));
    const channel = makeChannel();
    vi.spyOn(channel, "downloadToMediaDirChunked").mockResolvedValue(savedPath);

    await channel.onMessage(
      {
        id: "att1",
        content: "look at this",
        author: { user_openid: "u1" },
        attachments: [{ url: "", filename: "screenshot.png", content_type: "image/png" }],
      },
      false,
    );

    const msg = await channel.bus.consumeInbound();
    expect(msg.content).toContain("look at this");
    expect(msg.content).toContain("screenshot.png");
    expect(msg.content).toContain("Received files:");
    expect(msg.media).toEqual([savedPath]);
  });
});

describe("QQ base64 upload", () => {
  it("omits file_name for image uploads", async () => {
    const channel = makeChannel({}, { file_info: "img_abc" });

    await channel.postBase64File("user1", false, QQ_FILE_TYPE_IMAGE, "ZmFrZQ==", "photo.png");

    const payload = (channel.client as FakeClient).api.http.calls[0][1].json;
    expect(payload).not.toHaveProperty("file_name");
    expect(payload.file_type).toBe(QQ_FILE_TYPE_IMAGE);
  });

  it("includes file_name for file uploads", async () => {
    const channel = makeChannel({}, { file_info: "file_abc" });

    await channel.postBase64File("user1", false, QQ_FILE_TYPE_FILE, "ZmFrZQ==", "report.pdf");

    const payload = (channel.client as FakeClient).api.http.calls[0][1].json;
    expect(payload.file_name).toBe("report.pdf");
    expect(payload.file_type).toBe(QQ_FILE_TYPE_FILE);
  });

  it("filters upload responses to file_info", async () => {
    const channel = makeChannel({}, { file_info: "fi_123", file_uuid: "uuid_xxx", ttl: 3600 });

    const result = await channel.postBase64File("user1", false, QQ_FILE_TYPE_FILE, "ZmFrZQ==", "doc.pdf");

    expect(result).toEqual({ file_info: "fi_123" });
  });
});
