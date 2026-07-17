import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMediaDir } from "../../../src/config/paths.js";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { WebSocketChannel } from "../../../src/integrations/channels/websocket.js";

const roots: string[] = [];
const oldDataDir = process.env.MEMMY_AGENT_DATA_DIR;

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-ws-media-upload-"));
  roots.push(root);
  process.env.MEMMY_AGENT_DATA_DIR = root;
  return root;
}

function tinyPngBytes(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
}

function tinyPdfBytes(): Buffer {
  return Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "utf8");
}

async function multipartBody(entries: Array<{ name: string; bytes: Buffer; mime: string }>): Promise<{ body: Buffer; contentType: string }> {
  const form = new FormData();
  for (const entry of entries) {
    form.append("files", new Blob([new Uint8Array(entry.bytes)], { type: entry.mime }), entry.name);
  }
  const request = new Request("http://memmy.local/upload", { method: "POST", body: form });
  return {
    body: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get("content-type") ?? ""
  };
}

async function bootstrapToken(channel: WebSocketChannel): Promise<string> {
  const response = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
    path: "/webui/bootstrap",
    method: "GET",
    headers: {}
  });
  const body = JSON.parse(String(response?.body ?? "{}"));
  return body.token;
}

function jsonBody(response: { body: Buffer | string } | null): any {
  return JSON.parse(Buffer.isBuffer(response?.body) ? response.body.toString("utf8") : String(response?.body ?? "{}"));
}

afterEach(() => {
  if (oldDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = oldDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("WebUI media upload route", () => {
  it("requires bearer token", async () => {
    tmpRoot();
    const channel = new WebSocketChannel({}, new MessageBus());
    const { body, contentType } = await multipartBody([{ name: "shot.png", bytes: tinyPngBytes(), mime: "image/png" }]);

    const response = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
      path: "/api/webui/media/upload",
      method: "POST",
      headers: { "content-type": contentType },
      body
    });

    expect(response?.status).toBe(401);
  });

  it("accepts PNG uploads and returns saved signed image metadata", async () => {
    tmpRoot();
    const channel = new WebSocketChannel({}, new MessageBus());
    const token = await bootstrapToken(channel);
    const { body, contentType } = await multipartBody([{ name: "shot.png", bytes: tinyPngBytes(), mime: "image/png" }]);

    const response = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
      path: "/api/webui/media/upload",
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body
    });

    expect(response?.status).toBe(200);
    const responseBody = jsonBody(response);
    const image = responseBody.attachments[0];
    expect(image).toMatchObject({
      name: "shot.png",
      kind: "image",
      mime: "image/png",
      bytes: tinyPngBytes().length
    });
    expect(image.url).toMatch(/^\/api\/media\//);
    expect(responseBody.images).toHaveLength(1);
    expect(fs.existsSync(image.path)).toBe(true);
    expect(path.relative(fs.realpathSync(getMediaDir("websocket")), image.path).startsWith("..")).toBe(false);
  });

  it("accepts PDF and text uploads as file attachments", async () => {
    tmpRoot();
    const channel = new WebSocketChannel({}, new MessageBus());
    const token = await bootstrapToken(channel);
    const { body, contentType } = await multipartBody([
      { name: "report.pdf", bytes: tinyPdfBytes(), mime: "application/pdf" },
      { name: "小短文.pdf", bytes: tinyPdfBytes(), mime: "application/pdf" },
      { name: "notes.md", bytes: Buffer.from("# Notes\nhello", "utf8"), mime: "text/markdown" }
    ]);

    const response = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
      path: "/api/webui/media/upload",
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body
    });

    expect(response?.status).toBe(200);
    const attachments = jsonBody(response).attachments;
    expect(attachments).toEqual([
      expect.objectContaining({ name: "report.pdf", kind: "file", mime: "application/pdf", bytes: tinyPdfBytes().length }),
      expect.objectContaining({ name: "小短文.pdf", kind: "file", mime: "application/pdf", bytes: tinyPdfBytes().length }),
      expect.objectContaining({ name: "notes.md", kind: "file", mime: "text/markdown", bytes: Buffer.byteLength("# Notes\nhello") })
    ]);
    expect(path.basename(attachments[1].path)).toMatch(/^[a-f0-9]{12}-小短文\.pdf$/u);
    expect(jsonBody(response).images).toEqual([]);
  });

  it("rejects videos, SVG, MIME spoofing, old Office, and archives", async () => {
    tmpRoot();
    const channel = new WebSocketChannel({}, new MessageBus());
    const token = await bootstrapToken(channel);
    const cases = [
      { name: "clip.mp4", bytes: Buffer.from("mp4"), mime: "video/mp4" },
      { name: "vector.svg", bytes: Buffer.from("<svg />"), mime: "image/svg+xml" },
      { name: "fake.png", bytes: Buffer.from("not png"), mime: "image/png" },
      { name: "spoof.docx", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), mime: "text/plain" },
      { name: "old.doc", bytes: Buffer.from("doc"), mime: "application/msword" },
      { name: "archive.zip", bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), mime: "application/zip" }
    ];

    for (const entry of cases) {
      const { body, contentType } = await multipartBody([entry]);
      const response = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
        path: "/api/webui/media/upload",
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        body
      });
      expect(response?.status).toBe(415);
    }
  });

  it("rejects more than four attachments and oversize files", async () => {
    tmpRoot();
    const channel = new WebSocketChannel({}, new MessageBus());
    const token = await bootstrapToken(channel);
    const tooMany = await multipartBody(Array.from({ length: 5 }, (_, index) => ({
      name: `shot-${index}.png`,
      bytes: tinyPngBytes(),
      mime: "image/png"
    })));

    const tooManyResponse = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
      path: "/api/webui/media/upload",
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": tooMany.contentType },
      body: tooMany.body
    });
    expect(tooManyResponse?.status).toBe(400);

    const oversize = Buffer.concat([tinyPngBytes(), Buffer.alloc(6 * 1024 * 1024)]);
    const large = await multipartBody([{ name: "large.png", bytes: oversize, mime: "image/png" }]);
    const largeResponse = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
      path: "/api/webui/media/upload",
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": large.contentType },
      body: large.body
    });
    expect(largeResponse?.status).toBe(413);
    expect(String(largeResponse?.body)).toBe("image too large");

    const oversizePdf = Buffer.concat([tinyPdfBytes(), Buffer.alloc(10 * 1024 * 1024)]);
    const bigPdf = await multipartBody([{ name: "large.pdf", bytes: oversizePdf, mime: "application/pdf" }]);
    const bigPdfResponse = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
      path: "/api/webui/media/upload",
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": bigPdf.contentType },
      body: bigPdf.body
    });
    expect(bigPdfResponse?.status).toBe(413);
    expect(String(bigPdfResponse?.body)).toBe("file too large");
  });
});
