import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBus } from "../../../src/core/runtime-messages/index.js";
import { WebSocketChannel, b64urlDecode, b64urlEncode, normalizeConfigPath } from "../../../src/integrations/channels/websocket.js";
import { Session, SessionManager } from "../../../src/core/session/manager.js";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n", "utf8");

const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const tmpDirs: string[] = [];

afterEach(() => {
  if (originalDataDir == null) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDataDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `memmy-${name}-`));
  tmpDirs.push(dir);
  process.env.MEMMY_AGENT_DATA_DIR = dir;
  return dir;
}

describe("WebSocket media route", () => {
  it("keeps media route root stable when users configure trailing slashes", () => {
    expect(normalizeConfigPath("/media/")).toBe("/media");
    expect(normalizeConfigPath("")).toBe("/");
  });

  it("rejects signing paths outside the media root", () => {
    const data = tmpDataDir("ws-media-root");
    const media = path.join(data, "media");
    fs.mkdirSync(media, { recursive: true });
    const outside = path.join(data, "outside.png");
    fs.writeFileSync(outside, PNG_BYTES);

    const channel = new WebSocketChannel({}, new MessageBus());
    expect(channel.signMediaPath(outside)).toBeNull();
    expect(channel.signMediaPath(path.join(media, "..", "outside.png"))).toBeNull();
  });

  it("signs media paths with an HMAC over the relative payload", () => {
    const data = tmpDataDir("ws-media-hmac");
    const media = path.join(data, "media");
    fs.mkdirSync(media, { recursive: true });
    const image = path.join(media, "a.png");
    fs.writeFileSync(image, PNG_BYTES);
    const channel = new WebSocketChannel({}, new MessageBus());

    const url = channel.signMediaPath(image);
    expect(url).toMatch(/^\/api\/media\//);
    const [sig, payload] = url!.slice("/api/media/".length).split("/");
    const expected = crypto.createHmac("sha256", (channel as any).mediaSecret).update(payload).digest().subarray(0, 16);
    expect(b64urlDecode(sig)).toEqual(expected);
    expect(b64urlDecode(payload).toString("utf8")).toBe("a.png");
  });

  it("stages local markdown images from inside the workspace", () => {
    const data = tmpDataDir("ws-media-markdown");
    const workspace = path.join(data, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "diagram.png"), PNG_BYTES);
    const channel = new WebSocketChannel({}, new MessageBus(), { workspacePath: workspace });

    const rewritten = channel.rewriteLocalMarkdownImages("![Diagram](diagram.png)");

    expect(rewritten).toContain("![Diagram](/api/media/");
    const staged = fs.readdirSync(path.join(data, "media", "websocket"));
    expect(staged).toHaveLength(1);
    expect(fs.readFileSync(path.join(data, "media", "websocket", staged[0]))).toEqual(PNG_BYTES);
  });

  it("does not stage local markdown images that escape the workspace", () => {
    const data = tmpDataDir("ws-media-markdown-escape");
    const workspace = path.join(data, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(data, "outside.png"), PNG_BYTES);
    const channel = new WebSocketChannel({}, new MessageBus(), { workspacePath: workspace });

    const rewritten = channel.rewriteLocalMarkdownImages("![Nope](../outside.png)");

    expect(rewritten).toBe("![Nope](../outside.png)");
    expect(fs.existsSync(path.join(data, "media", "websocket"))).toBe(false);
  });

  it("serves signed files with image MIME and cache hardening headers", () => {
    const data = tmpDataDir("ws-media-fetch");
    const media = path.join(data, "media");
    fs.mkdirSync(media, { recursive: true });
    const image = path.join(media, "round-trip.png");
    fs.writeFileSync(image, PNG_BYTES);
    const channel = new WebSocketChannel({}, new MessageBus());
    const url = channel.signMediaPath(image)!;
    const [sig, payload] = url.slice("/api/media/".length).split("/");

    const ok = channel.handleMediaFetch(sig, payload);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.headers["cache-control"]).toContain("immutable");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.body).toEqual(PNG_BYTES);
  });

  it("resolves workspace artifacts and stages local absolute artifacts for media access", () => {
    const data = tmpDataDir("ws-media-artifact-resolve");
    const workspace = path.join(data, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const image = path.join(workspace, "result.png");
    const deck = path.join(workspace, "deck.pptx");
    const outside = path.join(data, "outside.png");
    const outsideDir = path.join(data, "outside-dir");
    fs.writeFileSync(image, PNG_BYTES);
    fs.writeFileSync(deck, "pptx", "utf8");
    fs.writeFileSync(outside, PNG_BYTES);
    fs.mkdirSync(outsideDir);
    const channel = new WebSocketChannel({}, new MessageBus(), { workspacePath: workspace });
    (channel as any).apiTokens.set("api-token", Date.now() / 1000 + 60);
    const headers = { authorization: "Bearer api-token" };

    const resolved = channel.handleArtifactResolve({
      path: "/api/webui/artifacts/resolve",
      method: "POST",
      headers,
      body: JSON.stringify({ path: image }),
    });
    expect(resolved.status).toBe(200);
    const body = JSON.parse(String(resolved.body));
    expect(body).toMatchObject({ ok: true, name: "result.png", kind: "image" });
    expect(body.media_url).toMatch(/^\/api\/media\//);

    const [sig, payload] = String(body.media_url).slice("/api/media/".length).split("/");
    expect(channel.handleMediaFetch(sig, payload).status).toBe(200);

    const resolvedDeck = channel.handleArtifactResolve({
      path: "/api/webui/artifacts/resolve",
      method: "POST",
      headers,
      body: JSON.stringify({ path: deck }),
    });
    expect(resolvedDeck.status).toBe(200);
    const deckBody = JSON.parse(String(resolvedDeck.body));
    expect(deckBody).toMatchObject({ ok: true, name: "deck.pptx", kind: "file", path: fs.realpathSync(deck) });
    expect(deckBody.media_url).toMatch(/^\/api\/media\//);

    const stagedOutside = channel.handleArtifactResolve({
      path: "/api/webui/artifacts/resolve",
      method: "POST",
      headers,
      body: JSON.stringify({ path: outside }),
    });
    expect(stagedOutside.status).toBe(200);
    const outsideBody = JSON.parse(String(stagedOutside.body));
    expect(outsideBody).toMatchObject({ ok: true, name: "outside.png", kind: "image" });
    expect(outsideBody.path).not.toBe(fs.realpathSync(outside));
    expect(outsideBody.path).toContain(`${path.sep}media${path.sep}websocket${path.sep}`);
    expect(outsideBody.media_url).toMatch(/^\/api\/media\//);

    const resolvedDirectory = channel.handleArtifactResolve({
      path: "/api/webui/artifacts/resolve",
      method: "POST",
      headers,
      body: JSON.stringify({ path: outsideDir }),
    });
    expect(resolvedDirectory.status).toBe(200);
    expect(JSON.parse(String(resolvedDirectory.body))).toEqual({
      ok: true,
      path: fs.realpathSync(outsideDir),
      name: "outside-dir",
      kind: "directory",
    });
    expect(channel.webuiMediaAttachmentForPath(outsideDir)).toBeNull();

    const escapedRelative = channel.handleArtifactResolve({
      path: "/api/webui/artifacts/resolve",
      method: "POST",
      headers,
      body: JSON.stringify({ path: "../outside.png" }),
    });
    expect(escapedRelative.status).toBe(404);
    expect(String(escapedRelative.body)).not.toContain(outside);
  });

  it("stages unicode-named local absolute artifacts without dropping extensions", () => {
    const data = tmpDataDir("ws-media-artifact-unicode");
    const workspace = path.join(data, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const outsidePdf = path.join(data, "我爱乌克兰.pdf");
    fs.writeFileSync(outsidePdf, PDF_BYTES);
    const channel = new WebSocketChannel({}, new MessageBus(), { workspacePath: workspace });
    (channel as any).apiTokens.set("api-token", Date.now() / 1000 + 60);

    const resolved = channel.handleArtifactResolve({
      path: "/api/webui/artifacts/resolve",
      method: "POST",
      headers: { authorization: "Bearer api-token" },
      body: JSON.stringify({ path: outsidePdf }),
    });

    expect(resolved.status).toBe(200);
    const body = JSON.parse(String(resolved.body));
    expect(body).toMatchObject({ ok: true, name: "我爱乌克兰.pdf", kind: "file" });
    expect(path.basename(body.path)).toMatch(/^[a-f0-9]{12}-我爱乌克兰\.pdf$/u);
    expect(body.path).not.toBe(fs.realpathSync(outsidePdf));
    expect(path.relative(fs.realpathSync(path.join(data, "media", "websocket")), body.path).startsWith("..")).toBe(false);
    expect(body.media_url).toMatch(/^\/api\/media\//);
    const [sig, payload] = String(body.media_url).slice("/api/media/".length).split("/");
    expect(channel.handleMediaFetch(sig, payload).status).toBe(200);
  });

  it("rejects signed media requests with bad signatures", () => {
    const data = tmpDataDir("ws-media-bad-signature");
    const media = path.join(data, "media");
    fs.mkdirSync(media, { recursive: true });
    const image = path.join(media, "round-trip.png");
    fs.writeFileSync(image, PNG_BYTES);
    const channel = new WebSocketChannel({}, new MessageBus());
    const url = channel.signMediaPath(image)!;
    const [, payload] = url.slice("/api/media/".length).split("/");

    expect(channel.handleMediaFetch("bad", payload).status).toBe(401);
  });

  it("rejects signed media traversal payloads", () => {
    const data = tmpDataDir("ws-media-traversal");
    const media = path.join(data, "media");
    fs.mkdirSync(media, { recursive: true });
    fs.writeFileSync(path.join(data, "secret.txt"), "classified", "utf8");
    const channel = new WebSocketChannel({}, new MessageBus());
    const payload = b64urlEncode("../secret.txt");
    const mac = crypto.createHmac("sha256", (channel as any).mediaSecret).update(payload).digest().subarray(0, 16);

    const response = channel.handleMediaFetch(b64urlEncode(mac), payload);

    expect(response.status).toBe(404);
    expect(Buffer.isBuffer(response.body) ? response.body.toString("utf8") : String(response.body)).not.toContain("classified");
  });

  it("returns 404 when a signed media file has vanished", () => {
    const data = tmpDataDir("ws-media-missing");
    const media = path.join(data, "media");
    fs.mkdirSync(media, { recursive: true });
    const image = path.join(media, "gone.png");
    fs.writeFileSync(image, PNG_BYTES);
    const channel = new WebSocketChannel({}, new MessageBus());
    const url = channel.signMediaPath(image)!;
    const [sig, payload] = url.slice("/api/media/".length).split("/");
    fs.unlinkSync(image);

    expect(channel.handleMediaFetch(sig, payload).status).toBe(404);
  });

  it("serves non-preview media as octet-stream with nosniff", () => {
    const data = tmpDataDir("ws-media-non-image");
    const media = path.join(data, "media");
    fs.mkdirSync(media, { recursive: true });
    const deck = path.join(media, "deck.pptx");
    fs.writeFileSync(deck, "pptx", "utf8");
    const channel = new WebSocketChannel({}, new MessageBus());
    const url = channel.signMediaPath(deck)!;
    const [sig, payload] = url.slice("/api/media/".length).split("/");

    const response = channel.handleMediaFetch(sig, payload);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("exposes signed media urls when replaying websocket session messages", () => {
    const data = tmpDataDir("ws-media-session");
    const media = path.join(data, "media");
    fs.mkdirSync(media, { recursive: true });
    const image = path.join(media, "saved.png");
    fs.writeFileSync(image, PNG_BYTES);
    const manager = new SessionManager(path.join(data, "sessions"));
    const session = new Session({ key: "websocket:abc" });
    session.addMessage("user", "see image", { media: [image] });
    manager.save(session);
    const channel = new WebSocketChannel({}, new MessageBus(), { sessionManager: manager });
    (channel as any).apiTokens.set("api-token", Date.now() / 1000 + 60);

    const response = channel.handleSessionMessages({ path: "/api/sessions/websocket%3Aabc/messages?token=api-token", headers: {} }, "websocket%3Aabc");
    expect(response.status).toBe(200);
    const body = JSON.parse(String(response.body));
    expect(body.messages[0].media).toBeUndefined();
    expect(body.messages[0].media_urls[0]).toMatchObject({ name: "saved.png" });
    expect(body.messages[0].media_urls[0].url).toMatch(/^\/api\/media\//);
  });

  it("keeps vanished session media hidden while exposing a 404 signed URL", () => {
    const data = tmpDataDir("ws-media-vanished");
    const media = path.join(data, "media");
    fs.mkdirSync(media, { recursive: true });
    const manager = new SessionManager(path.join(data, "sessions"));
    const session = new Session({ key: "websocket:vanished" });
    session.addMessage("user", "missing pic", { media: [path.join(media, "absent.png")] });
    manager.save(session);
    const channel = new WebSocketChannel({}, new MessageBus(), { sessionManager: manager });
    (channel as any).apiTokens.set("api-token", Date.now() / 1000 + 60);

    const response = channel.handleSessionMessages({ path: "/api/sessions/websocket%3Avanished/messages?token=api-token", headers: {} }, "websocket%3Avanished");
    const body = JSON.parse(String(response.body));
    const userMessage = body.messages.find((message: any) => message.role === "user");
    const url = userMessage.media_urls[0].url as string;
    const [sig, payload] = url.slice("/api/media/".length).split("/");

    expect(userMessage.media).toBeUndefined();
    expect(channel.handleMediaFetch(sig, payload).status).toBe(404);
  });
});
