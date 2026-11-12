/** Asr stream relay tests. */
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createAsrStreamService, toCloudStreamUrl } from "../asr-stream-service.js";

/**
 * A stand-in for the Cloud's `/agentAsr/stream`: records what it was sent
 * and lets each test script what it answers.
 */
interface CloudStub {
  url: string;
  /** Every connection the stub accepted, oldest first. */
  connections: Array<{
    headers: Record<string, string | string[] | undefined>;
    frames: Array<{ data: Buffer; binary: boolean }>;
    socket: WebSocket;
  }>;
  close(): Promise<void>;
}

async function startCloudStub(): Promise<CloudStub> {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/api/agentAsr/stream" });
  const connections: CloudStub["connections"] = [];
  wss.on("connection", (socket, request) => {
    const entry: CloudStub["connections"][number] = { headers: request.headers, frames: [], socket };
    connections.push(entry);
    socket.on("message", (raw, isBinary) => {
      entry.frames.push({ data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer), binary: isBinary });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    connections,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/** A loopback HTTP server that hands its upgrades to the relay, standing in for the local API. */
async function startRelayHost(relay: ReturnType<typeof createAsrStreamService>): Promise<{ url: string; server: Server }> {
  const server = createServer();
  server.on("upgrade", (request, socket, head) => relay.handleUpgrade(request, socket, head));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/asr/stream`, server };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => socket.once("message", (raw) => resolve(JSON.parse(raw.toString()))));
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("toCloudStreamUrl", () => {
  it("maps the Cloud HTTPS base to its wss stream endpoint behind the /api gateway prefix", () => {
    // cloudBaseUrl never carries /api itself (resolveCloudServiceBaseUrl
    // returns the bare origin) — every Cloud call adds the prefix per-path,
    // same as /api/agentAsr/transcriptions and /api/agentUser/login do.
    expect(toCloudStreamUrl("https://test-api.memmy.cn")).toBe("wss://test-api.memmy.cn/api/agentAsr/stream");
    expect(toCloudStreamUrl("https://test-api.memmy.cn/")).toBe("wss://test-api.memmy.cn/api/agentAsr/stream");
  });

  it("keeps plain ws for a loopback stub", () => {
    expect(toCloudStreamUrl("http://127.0.0.1:8080")).toBe("ws://127.0.0.1:8080/api/agentAsr/stream");
  });
});

describe("asr stream relay", () => {
  it("bridges control, audio and events between the renderer and the Cloud with the account credential", async () => {
    const cloud = await startCloudStub();
    cleanups.push(() => cloud.close());
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "account" }) },
      accountSessionRepository: { getCloudUuid: () => "cloud-uuid-1" },
      cloudBaseUrl: cloud.url
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>((resolve) => host.server.close(() => resolve())));

    const renderer = new WebSocket(host.url);
    cleanups.push(() => renderer.terminate());
    await once(renderer, "open");

    renderer.send(JSON.stringify({ type: "start", sampleRate: 16_000 }));
    renderer.send(Buffer.from([1, 0, 2, 0, 3, 0]), { binary: true });
    renderer.send(JSON.stringify({ type: "finish" }));

    await waitFor(() => cloud.connections[0]?.frames.length === 3);
    const upstream = cloud.connections[0]!;
    // The Cloud sees the account bearer, never the local runtime token.
    expect(upstream.headers.authorization).toBe("Bearer cloud-uuid-1");
    expect(upstream.frames.map((frame) => frame.binary)).toEqual([false, true, false]);
    expect(JSON.parse(upstream.frames[0]!.data.toString())).toEqual({ type: "start", sampleRate: 16_000 });
    expect([...upstream.frames[1]!.data]).toEqual([1, 0, 2, 0, 3, 0]);
    expect(JSON.parse(upstream.frames[2]!.data.toString())).toEqual({ type: "finish" });

    // Events flow back down unchanged.
    const eventPromise = nextMessage(renderer);
    upstream.socket.send(JSON.stringify({ type: "sentence", sentenceId: 1, text: "你好", beginMs: 0, endMs: 900 }));
    expect(await eventPromise).toEqual({ type: "sentence", sentenceId: 1, text: "你好", beginMs: 0, endMs: 900 });

    const finished = nextMessage(renderer);
    upstream.socket.send(JSON.stringify({ type: "finished" }));
    expect(await finished).toEqual({ type: "finished" });
  });

  it("holds frames sent before the upstream handshake completes and replays them in order", async () => {
    const cloud = await startCloudStub();
    cleanups.push(() => cloud.close());
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "account" }) },
      accountSessionRepository: { getCloudUuid: () => "cloud-uuid-1" },
      cloudBaseUrl: cloud.url
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>((resolve) => host.server.close(() => resolve())));

    const renderer = new WebSocket(host.url);
    cleanups.push(() => renderer.terminate());
    await once(renderer, "open");
    // Fire everything at once, before the relay could possibly have finished
    // its own handshake with the stub.
    renderer.send(JSON.stringify({ type: "start" }));
    renderer.send(Buffer.from([9, 9]), { binary: true });
    renderer.send(Buffer.from([8, 8]), { binary: true });

    await waitFor(() => cloud.connections[0]?.frames.length === 3);
    const frames = cloud.connections[0]!.frames;
    expect(frames.map((frame) => frame.binary)).toEqual([false, true, true]);
    expect([...frames[1]!.data]).toEqual([9, 9]);
    expect([...frames[2]!.data]).toEqual([8, 8]);
  });

  it("refuses the stream in BYOK mode without contacting the Cloud", async () => {
    const cloud = await startCloudStub();
    cleanups.push(() => cloud.close());
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "byok" }) },
      accountSessionRepository: { getCloudUuid: () => "cloud-uuid-1" },
      cloudBaseUrl: cloud.url
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>((resolve) => host.server.close(() => resolve())));

    const renderer = new WebSocket(host.url);
    cleanups.push(() => renderer.terminate());
    const event = await nextMessage(renderer);
    const [code] = (await once(renderer, "close")) as [number];

    expect(event).toEqual({ type: "error", message: "Live transcription requires account mode" });
    expect(code).toBe(1008);
    expect(cloud.connections).toHaveLength(0);
  });

  it("refuses the stream when no account is signed in", async () => {
    const cloud = await startCloudStub();
    cleanups.push(() => cloud.close());
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "account" }) },
      accountSessionRepository: { getCloudUuid: () => null },
      cloudBaseUrl: cloud.url
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>((resolve) => host.server.close(() => resolve())));

    const renderer = new WebSocket(host.url);
    cleanups.push(() => renderer.terminate());
    const event = await nextMessage(renderer);

    expect(event).toEqual({ type: "error", message: "Cloud account is not authenticated" });
    expect(cloud.connections).toHaveLength(0);
  });

  it("answers a malformed control frame locally and does not forward it", async () => {
    const cloud = await startCloudStub();
    cleanups.push(() => cloud.close());
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "account" }) },
      accountSessionRepository: { getCloudUuid: () => "cloud-uuid-1" },
      cloudBaseUrl: cloud.url
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>((resolve) => host.server.close(() => resolve())));

    const renderer = new WebSocket(host.url);
    cleanups.push(() => renderer.terminate());
    await once(renderer, "open");
    await waitFor(() => cloud.connections.length === 1);

    const errorEvent = nextMessage(renderer);
    renderer.send(JSON.stringify({ type: "teleport" }));
    expect(await errorEvent).toEqual({ type: "error", message: "invalid control frame" });

    renderer.send(JSON.stringify({ type: "finish" }));
    await waitFor(() => cloud.connections[0]?.frames.length === 1);
    expect(JSON.parse(cloud.connections[0]!.frames[0]!.data.toString())).toEqual({ type: "finish" });
  });

  it("closes the upstream task when the renderer goes away", async () => {
    const cloud = await startCloudStub();
    cleanups.push(() => cloud.close());
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "account" }) },
      accountSessionRepository: { getCloudUuid: () => "cloud-uuid-1" },
      cloudBaseUrl: cloud.url
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>((resolve) => host.server.close(() => resolve())));

    const renderer = new WebSocket(host.url);
    await once(renderer, "open");
    await waitFor(() => cloud.connections.length === 1);
    const upstreamClosed = once(cloud.connections[0]!.socket, "close");

    renderer.close(1000, "user stopped");
    const [code, reason] = (await upstreamClosed) as [number, Buffer];

    expect(code).toBe(1000);
    expect(reason.toString()).toBe("user stopped");
  });
});
