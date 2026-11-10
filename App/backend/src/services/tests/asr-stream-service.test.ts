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

async function startCloudStub(path = "/api/agentAsr/stream"): Promise<CloudStub> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url!, "http://localhost").pathname !== path) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, client => wss.emit("connection", client, request));
  });
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
  it("closes oversized frames safely while model resolution is still pending", async () => {
    let resolveModel!: (value: any) => void;
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "byok" }) },
      accountSessionRepository: { getCloudUuid: () => null },
      memmyConfigWriter: { resolveAssignedModel: () => new Promise(resolve => { resolveModel = resolve; }) },
      cloudBaseUrl: "http://unused.invalid"
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>(resolve => host.server.close(() => resolve())));
    const renderer = new WebSocket(host.url); cleanups.push(() => renderer.terminate());
    await once(renderer, "open"); const closed = once(renderer, "close");
    renderer.send(Buffer.alloc(70 * 1024));
    expect((await closed)[0]).toBe(1009);
    resolveModel({ ok: false });
  });

  it("uses the recording snapshot after the current configuration changes", async () => {
    const cloud = await startCloudStub(); cleanups.push(() => cloud.close());
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "byok" }) },
      accountSessionRepository: { getCloudUuid: () => "new-credential" },
      memmyConfigWriter: { resolveAssignedModel: async () => { throw new Error("must not re-resolve configuration"); } },
      getSession: id => {
        expect(id).toBe("pinned-recording");
        return { context: { source: "account" }, provider: {}, cloudUuid: "pinned-credential" } as any;
      },
      cloudBaseUrl: cloud.url
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>(resolve => host.server.close(() => resolve())));
    const renderer = new WebSocket(host.url + "?sessionId=pinned-recording");
    cleanups.push(() => renderer.terminate()); await once(renderer, "open");
    await waitFor(() => cloud.connections.length === 1);
    expect(cloud.connections[0]!.headers.authorization).toBe("Bearer pinned-credential");
  });

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

  it("uses a custom ASR selected in account mode instead of the Cloud relay", async () => {
    const dashscope = await startCloudStub("/api-ws/v1/inference");
    cleanups.push(() => dashscope.close());
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "account" }) },
      accountSessionRepository: {
        getCloudUuid: () => "cloud-must-not-be-used",
        get: () => ({ authenticated: true, profile: { userId: "account-1" } }) as any
      },
      memmyConfigWriter: {
        resolveAssignedModel: async (input) => {
          expect(input).toMatchObject({ mode: "account", activeAccountId: "account-1", capability: "asr" });
          return ({
          ok: true,
          context: {
            presetId: "byok-asr", provider: "dashscope", endpointId: "asr",
            protocol: "dashscope-input-audio-chat", model: "fun-asr-realtime",
            source: "byok", ownerAccountId: null, capability: "asr", capabilities: ["asr"]
          },
          provider: {
            provider: "dashscope", endpointId: "asr", protocol: "dashscope-input-audio-chat",
            apiBase: `${dashscope.url}/compatible-mode/v1`, apiKey: "byok-secret", ownerAccountId: null,
            extraHeaders: {}, extraBody: {}
          }
          }) as any;
        }
      },
      cloudBaseUrl: "http://cloud-must-not-be-used.invalid"
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>((resolve) => host.server.close(() => resolve())));

    const renderer = new WebSocket(host.url);
    cleanups.push(() => renderer.terminate());
    await once(renderer, "open");
    renderer.send(JSON.stringify({ type: "start", sampleRate: 16_000 }));
    renderer.send(Buffer.from([1, 0, 2, 0]), { binary: true });
    renderer.send(JSON.stringify({ type: "finish" }));

    await waitFor(() => dashscope.connections[0]?.frames.length === 1);
    const upstream = dashscope.connections[0]!;
    expect(upstream.headers.authorization).toBe("Bearer byok-secret");
    const runTask = JSON.parse(upstream.frames[0]!.data.toString());
    expect(runTask).toMatchObject({
      header: { action: "run-task", streaming: "duplex" },
      payload: { model: "fun-asr-realtime", parameters: { format: "pcm", sample_rate: 16_000 } }
    });

    upstream.socket.send(JSON.stringify({ header: { event: "task-started" } }));
    await waitFor(() => upstream.frames.length === 3);
    expect(upstream.frames[1]?.binary).toBe(true);
    expect([...upstream.frames[1]!.data]).toEqual([1, 0, 2, 0]);
    expect(JSON.parse(upstream.frames[2]!.data.toString())).toMatchObject({ header: { action: "finish-task" } });

    const sentence = nextMessage(renderer);
    upstream.socket.send(JSON.stringify({
      header: { event: "result-generated" },
      payload: { output: { sentence: { sentence_id: 7, text: "你好", begin_time: 0, end_time: 500, sentence_end: true } } }
    }));
    expect(await sentence).toEqual({ type: "sentence", sentenceId: 1, text: "你好", beginMs: 0, endMs: 500 });

    const finished = nextMessage(renderer);
    upstream.socket.send(JSON.stringify({ header: { event: "task-finished" } }));
    expect(await finished).toEqual({ type: "finished" });

    expect(toCloudStreamUrl("http://cloud-must-not-be-used.invalid")).not.toBe(dashscope.url);
  });

  it.each([
    { provider: "dashscope", path: "/api-ws/v1/realtime", basePath: "/compatible-mode/v1" },
    { provider: "dashscope", path: "/v1/realtime", basePath: "/v1" },
    { provider: "custom", path: "/v1/realtime", basePath: "/v1" },
    { provider: "openai", path: "/v1/realtime", basePath: "/v1" }
  ])("adapts Qwen ASR through $provider at $path with its own session protocol", async ({ provider, path, basePath }) => {
    const dashscope = await startCloudStub(path);
    const attemptedUrls: URL[] = [];
    cleanups.push(() => dashscope.close());
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "byok" }) },
      accountSessionRepository: { getCloudUuid: () => null },
      memmyConfigWriter: {
        resolveAssignedModel: async () => ({
          ok: true,
          context: {
            presetId: "byok-asr", provider, endpointId: "asr",
            protocol: "dashscope-input-audio-chat", model: "qwen3-asr-flash-realtime",
            source: "byok", ownerAccountId: null, capability: "asr", capabilities: ["asr"]
          },
          provider: {
            provider, endpointId: "asr", protocol: "dashscope-input-audio-chat",
            apiBase: `${dashscope.url}${basePath}`, apiKey: "realtime-secret", ownerAccountId: null,
            extraHeaders: {}, extraBody: {}
          }
        }) as any
      },
      cloudBaseUrl: "http://cloud-must-not-be-used.invalid",
      connectUpstream: (url, headers) => {
        attemptedUrls.push(new URL(url));
        return new WebSocket(url, { headers });
      }
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>((resolve) => host.server.close(() => resolve())));

    const renderer = new WebSocket(host.url);
    cleanups.push(() => renderer.terminate());
    await once(renderer, "open");
    renderer.send(JSON.stringify({ type: "start", sampleRate: 16_000 }));
    renderer.send(Buffer.from([3, 0, 4, 0]), { binary: true });
    renderer.send(JSON.stringify({ type: "finish" }));

    await waitFor(() => dashscope.connections[0]?.frames.length === 1);
    const upstream = dashscope.connections[0]!;
    expect(upstream.headers.authorization).toBe("Bearer realtime-secret");
    expect(upstream.headers["openai-beta"]).toBe("realtime=v1");
    expect(JSON.parse(upstream.frames[0]!.data.toString())).toMatchObject({
      type: "session.update",
      session: { input_audio_format: "pcm", sample_rate: 16_000, turn_detection: { type: "server_vad" } }
    });

    upstream.socket.send(JSON.stringify({ type: "session.updated" }));
    await waitFor(() => upstream.frames.length === 3);
    const appended = JSON.parse(upstream.frames[1]!.data.toString());
    expect(appended).toMatchObject({ type: "input_audio_buffer.append", audio: Buffer.from([3, 0, 4, 0]).toString("base64") });
    expect(JSON.parse(upstream.frames[2]!.data.toString())).toMatchObject({ type: "session.finish" });

    upstream.socket.send(JSON.stringify({ type: "input_audio_buffer.speech_started", item_id: "item-1", audio_start_ms: 100 }));
    const partial = nextMessage(renderer);
    upstream.socket.send(JSON.stringify({
      type: "conversation.item.input_audio_transcription.text", item_id: "item-1", text: "你好", stash: " Memmy"
    }));
    expect(await partial).toEqual({ type: "partial", sentenceId: 1, text: "你好 Memmy", beginMs: 100 });

    upstream.socket.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped", item_id: "item-1", audio_end_ms: 900 }));
    const sentence = nextMessage(renderer);
    upstream.socket.send(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed", item_id: "item-1", transcript: "你好 Memmy"
    }));
    expect(await sentence).toEqual({ type: "sentence", sentenceId: 1, text: "你好 Memmy", beginMs: 100, endMs: 900 });

    const finished = nextMessage(renderer);
    upstream.socket.send(JSON.stringify({ type: "session.finished" }));
    expect(await finished).toEqual({ type: "finished" });
    expect(attemptedUrls.map(url => url.pathname)).toEqual(path === "/v1/realtime"
      ? ["/api-ws/v1/realtime", "/v1/realtime"] : ["/api-ws/v1/realtime"]);
    expect(attemptedUrls.every(url => url.host === new URL(dashscope.url).host
      && url.searchParams.get("model") === "qwen3-asr-flash-realtime")).toBe(true);
  });

  it("adapts GPT Realtime models to the OpenAI Realtime protocol", async () => {
    const openai = await startCloudStub("/v1/realtime");
    cleanups.push(() => openai.close());
    const relay = createAsrStreamService({
      bootstrapRepository: { getAppSettings: () => ({ userMode: "account" }) },
      accountSessionRepository: {
        getCloudUuid: () => "cloud-must-not-be-used",
        get: () => ({ authenticated: true, profile: { userId: "account-1" } }) as any
      },
      memmyConfigWriter: {
        resolveAssignedModel: async () => ({
          ok: true,
          context: {
            presetId: "openai-asr", provider: "openai", endpointId: "asr",
            protocol: "dashscope-input-audio-chat", model: "gpt-4o-mini-realtime-preview",
            source: "byok", ownerAccountId: null, capability: "asr", capabilities: ["asr"]
          },
          provider: {
            provider: "openai", endpointId: "asr", protocol: "dashscope-input-audio-chat",
            apiBase: `${openai.url}/v1`, apiKey: "openai-secret", ownerAccountId: null,
            extraHeaders: {}, extraBody: {}
          }
        }) as any
      },
      cloudBaseUrl: "http://cloud-must-not-be-used.invalid"
    });
    cleanups.push(() => relay.close());
    const host = await startRelayHost(relay);
    cleanups.push(() => new Promise<void>((resolve) => host.server.close(() => resolve())));

    const renderer = new WebSocket(host.url);
    cleanups.push(() => renderer.terminate());
    await once(renderer, "open");
    renderer.send(JSON.stringify({ type: "start", sampleRate: 16_000 }));
    renderer.send(Buffer.from([5, 0, 6, 0]), { binary: true });
    renderer.send(JSON.stringify({ type: "finish" }));

    await waitFor(() => openai.connections[0]?.frames.length === 1);
    const upstream = openai.connections[0]!;
    expect(upstream.headers.authorization).toBe("Bearer openai-secret");
    expect(upstream.headers["openai-beta"]).toBe("realtime=v1");
    expect(JSON.parse(upstream.frames[0]!.data.toString())).toMatchObject({
      type: "session.update",
      session: {
        modalities: ["text"],
        input_audio_format: "pcm16",
        turn_detection: { type: "server_vad", create_response: false }
      }
    });

    upstream.socket.send(JSON.stringify({ type: "session.updated" }));
    await waitFor(() => upstream.frames.length === 4);
    expect(JSON.parse(upstream.frames[1]!.data.toString())).toMatchObject({
      type: "input_audio_buffer.append",
      audio: Buffer.from([5, 0, 6, 0]).toString("base64")
    });
    expect(JSON.parse(upstream.frames[3]!.data.toString())).toMatchObject({ type: "session.update", session: { turn_detection: null } });
    upstream.socket.send(JSON.stringify({ type: "session.updated", session: { turn_detection: null } }));
    await waitFor(() => upstream.frames.length === 5);
    expect(JSON.parse(upstream.frames[4]!.data.toString())).toMatchObject({ type: "input_audio_buffer.commit" });
    upstream.socket.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: "audio-1" }));
    await waitFor(() => upstream.frames.length === 6);
    expect(JSON.parse(upstream.frames[5]!.data.toString())).toMatchObject({
      type: "response.create",
      response: { modalities: ["text"], conversation: "none", input: [{ type: "item_reference", id: "audio-1" }] }
    });
    upstream.socket.send(JSON.stringify({ type: "response.created", response: { id: "response-1", metadata: { memmy_asr_item: "audio-1" } } }));

    const partial = nextMessage(renderer);
    upstream.socket.send(JSON.stringify({
      type: "response.text.delta", response_id: "response-1", delta: "你好"
    }));
    expect(await partial).toEqual({ type: "partial", sentenceId: 1, text: "你好", beginMs: 0 });

    const sentence = nextMessage(renderer);
    upstream.socket.send(JSON.stringify({
      type: "response.text.done", response_id: "response-1", text: "你好 Memmy"
    }));
    expect(await sentence).toEqual({ type: "partial", sentenceId: 1, text: "你好 Memmy", beginMs: 0 });

    const completed: unknown[] = [];
    renderer.on("message", data => completed.push(JSON.parse(data.toString())));
    upstream.socket.send(JSON.stringify({ type: "response.done", response: { id: "response-1", status: "completed" } }));
    await waitFor(() => completed.length === 2);
    expect(completed).toEqual([
      { type: "sentence", sentenceId: 1, text: "你好 Memmy", beginMs: 0, endMs: 0 },
      { type: "finished" }
    ]);
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
