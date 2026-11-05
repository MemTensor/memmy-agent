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

function tinyWavBytes(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(56, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  return bytes;
}

function tinyM4aBytes(): Buffer {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(32, 0);
  bytes.write("ftypM4A ", 4, "ascii");
  return bytes;
}

async function multipartBody(entries: Array<{ name: string; bytes: Buffer; mime: string; target?: string }>): Promise<{ body: Buffer; contentType: string }> {
  const form = new FormData();
  for (const entry of entries) {
    form.append("files", new Blob([new Uint8Array(entry.bytes)], { type: entry.mime }), entry.name);
    if (entries.some((item) => item.target !== undefined)) form.append("targets", entry.target ?? "");
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
  it("deletes confirmed recording files but rejects paths outside the recordings folder", async () => {
    const root = tmpRoot();
    const workspace = path.join(root, "workspace");
    const recordingDir = path.join(workspace, "recordings");
    fs.mkdirSync(recordingDir, { recursive: true });
    const audio = path.join(recordingDir, "interview.wav");
    const transcript = path.join(recordingDir, "interview.txt");
    const unrelated = path.join(workspace, "notes.txt");
    fs.writeFileSync(audio, tinyWavBytes());
    fs.writeFileSync(transcript, "transcript");
    fs.writeFileSync(unrelated, "keep");
    const channel = new WebSocketChannel({}, new MessageBus(), { workspacePath: workspace });
    const token = await bootstrapToken(channel);
    const call = (paths: string[], authorized = true) => channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
      path: "/api/webui/recordings/delete", method: "POST",
      headers: authorized ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify({ paths })
    });

    expect((await call([audio], false))?.status).toBe(401);
    expect((await call([audio, unrelated]))?.status).toBe(403);
    expect(fs.existsSync(audio)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    const linked = path.join(recordingDir, "linked.wav");
    fs.symlinkSync(unrelated, linked);
    expect((await call([linked]))?.status).toBe(403);
    expect(fs.existsSync(unrelated)).toBe(true);

    const deleted = await call([audio, transcript]);
    expect(deleted?.status).toBe(200);
    expect(jsonBody(deleted).deleted).toBe(2);
    expect(fs.existsSync(audio)).toBe(false);
    expect(fs.existsSync(transcript)).toBe(false);
    expect(fs.readFileSync(unrelated, "utf8")).toBe("keep");
  });
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

  it("accepts recordings as audio attachments regardless of the browser's media type", async () => {
    tmpRoot();
    const channel = new WebSocketChannel({}, new MessageBus());
    const token = await bootstrapToken(channel);
    const { body, contentType } = await multipartBody([
      { name: "interview.wav", bytes: tinyWavBytes(), mime: "audio/wav" },
      // Safari labels the same recording audio/x-m4a, Chrome audio/mp4.
      { name: "interview.m4a", bytes: tinyM4aBytes(), mime: "audio/x-m4a" },
      { name: "interview-no-type.wav", bytes: tinyWavBytes(), mime: "" }
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
      expect.objectContaining({ name: "interview.wav", kind: "audio", mime: "audio/wav" }),
      expect.objectContaining({ name: "interview.m4a", kind: "audio", mime: "audio/mp4" }),
      expect.objectContaining({ name: "interview-no-type.wav", kind: "audio", mime: "audio/wav" })
    ]);
    expect(jsonBody(response).images).toEqual([]);
    // The `asr` host service reads audio off disk, so it has to land in the media root.
    for (const attachment of attachments) {
      expect(path.relative(fs.realpathSync(getMediaDir("websocket")), attachment.path).startsWith("..")).toBe(false);
    }
  });

  it("rejects audio whose container does not match its extension", async () => {
    tmpRoot();
    const channel = new WebSocketChannel({}, new MessageBus());
    const token = await bootstrapToken(channel);
    const cases = [
      { name: "payload.wav", bytes: Buffer.from("not a riff header at all"), mime: "audio/wav" },
      { name: "payload.m4a", bytes: tinyWavBytes(), mime: "audio/mp4" },
      { name: "script.wav", bytes: tinyWavBytes(), mime: "text/html" }
    ];

    for (const entry of cases) {
      const { body, contentType } = await multipartBody([entry]);
      const response = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
        path: "/api/webui/media/upload",
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        body
      });
      expect(response?.status, entry.name).toBe(415);
    }
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

  it("accepts more than four attachments and large files without limit", async () => {
    tmpRoot();
    const channel = new WebSocketChannel({}, new MessageBus());
    const token = await bootstrapToken(channel);
    const manyFiles = await multipartBody(Array.from({ length: 5 }, (_, index) => ({
      name: `shot-${index}.png`,
      bytes: tinyPngBytes(),
      mime: "image/png"
    })));

    const manyFilesResponse = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
      path: "/api/webui/media/upload",
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": manyFiles.contentType },
      body: manyFiles.body
    });
    expect(manyFilesResponse?.status).toBe(200);

    const oversize = Buffer.concat([tinyPngBytes(), Buffer.alloc(6 * 1024 * 1024)]);
    const large = await multipartBody([{ name: "large.png", bytes: oversize, mime: "image/png" }]);
    const largeResponse = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
      path: "/api/webui/media/upload",
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": large.contentType },
      body: large.body
    });
    expect(largeResponse?.status).toBe(200);

    const oversizePdf = Buffer.concat([tinyPdfBytes(), Buffer.alloc(10 * 1024 * 1024)]);
    const bigPdf = await multipartBody([{ name: "large.pdf", bytes: oversizePdf, mime: "application/pdf" }]);
    const bigPdfResponse = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
      path: "/api/webui/media/upload",
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": bigPdf.contentType },
      body: bigPdf.body
    });
    expect(bigPdfResponse?.status).toBe(200);
  });

  it("keeps recordings in the default workspace and serves them in place", async () => {
    const root = tmpRoot();
    const workspace = path.join(root, "workspace");
    const channel = new WebSocketChannel({}, new MessageBus(), { workspacePath: workspace });
    const token = await bootstrapToken(channel);
    const upload = async () => {
      const { body, contentType } = await multipartBody([
        { name: "访谈录音-2026.wav", bytes: tinyWavBytes(), mime: "audio/wav", target: "recordings" },
        { name: "访谈转写-2026.txt", bytes: Buffer.from("[00:01] 对。", "utf8"), mime: "text/plain", target: "recordings" },
        { name: "notes.md", bytes: Buffer.from("# Notes", "utf8"), mime: "text/markdown", target: "" }
      ]);
      const response = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, {
        path: "/api/webui/media/upload",
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        body
      });
      expect(response?.status).toBe(200);
      return jsonBody(response).attachments;
    };

    const [audio, transcript, notes] = await upload();
    const recordingsDir = fs.realpathSync(path.join(workspace, "recordings"));
    expect(audio.path).toBe(path.join(recordingsDir, "访谈录音-2026.wav"));
    expect(transcript.path).toBe(path.join(recordingsDir, "访谈转写-2026.txt"));
    expect(audio.url).toMatch(/^\/api\/media\/ws\//);
    expect(path.relative(fs.realpathSync(getMediaDir("websocket")), notes.path).startsWith("..")).toBe(false);

    const fetched = await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, { path: transcript.url, method: "GET", headers: {} });
    expect(fetched?.status).toBe(200);
    expect(String(fetched?.body)).toBe("[00:01] 对。");
    expect(fetched?.headers?.["cache-control"]).toBe("private, no-cache");

    // A media-cache signature must not open the workspace route.
    const forged = notes.url.replace("/api/media/", "/api/media/ws/");
    expect((await channel.dispatchHttp({ remoteAddress: ["127.0.0.1"] }, { path: forged, method: "GET", headers: {} }))?.status).toBe(401);

    // A second recording with the same name does not overwrite the first.
    const [again] = await upload();
    expect(again.path).toBe(path.join(recordingsDir, "访谈录音-2026 (2).wav"));
    expect(fs.readdirSync(recordingsDir).sort()).toEqual(["访谈录音-2026 (2).wav", "访谈录音-2026.wav", "访谈转写-2026 (2).txt", "访谈转写-2026.txt"]);

    // Reopening after a restart resolves to the same file rather than a staged copy.
    expect(channel.resolveOrStageArtifactPath(audio.path, workspace)).toMatchObject({ path: audio.path, mediaUrl: expect.stringMatching(/^\/api\/media\/ws\//) });
  });
});
