import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsrService } from "../asr-service.js";
import { createAsrStreamService } from "../asr-stream-service.js";
import { createStreamLiveTranscriber } from "../../../../frontend/desktop/src/lib/asr-stream-transcription.js";
import { transcribeRecording } from "../../../../frontend/desktop/src/pages/asr-recorder.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllGlobals(); });

// Use real Blob bytes and the production encoder without requiring a browser microphone.
class BlobReader {
  result = ""; onload?: () => void;
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then(bytes => {
      this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
      this.onload?.();
    });
  }
}
function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(pcm.length + 36, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe("recording through frontend stream, backend adapters and same-model HTTP", () => {
  it.each(["success", "handshake-failure", "midstream-failure", "both-fail"] as const)("handles %s without losing recording or switching configuration", async scenario => {
    vi.stubGlobal("FileReader", BlobReader);
    const httpRequests: Array<{ authorization: string | undefined; body: any }> = [];
    const socketRequests: Array<{ authorization: string | undefined; model: string | null }> = [];
    const streamedAudio: Buffer[] = [];
    const upstream = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(request.url).toBe("/v1/chat/completions");
      httpRequests.push({ authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(scenario === "both-fail"
        ? { status_name: "Success", usage: { completion_tokens: 0 } }
        : { choices: [{ message: { content: "完整 HTTP 转写" } }] }));
    });
    const wss = new WebSocketServer({ noServer: true });
    upstream.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url!, "http://localhost");
      socketRequests.push({ authorization: request.headers.authorization, model: url.searchParams.get("model") });
      if (scenario === "handshake-failure" || scenario === "both-fail") {
        socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, client => wss.emit("connection", client));
    });
    wss.on("connection", socket => {
      socket.on("message", raw => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === "session.update") {
          expect(frame.session).toMatchObject({ sample_rate: 16000, input_audio_format: "pcm" });
          socket.send(JSON.stringify({ type: "session.updated" }));
        }
        if (frame.type === "input_audio_buffer.append") {
          streamedAudio.push(Buffer.from(frame.audio, "base64"));
          socket.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.text", item_id: "speech", text: "实时临时文字" }));
          if (scenario === "midstream-failure") socket.close(1011, "interrupted");
        }
        if (frame.type === "session.finish") {
          socket.send(JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: "speech", transcript: "完整实时转写" }));
          socket.send(JSON.stringify({ type: "session.finished" }));
        }
      });
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const apiBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
    cleanups.push(async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    });
    let selected = {
      ok: true as const,
      context: { presetId: "selected-asr", provider: "dashscope", endpointId: "asr", protocol: "dashscope-input-audio-chat",
        model: "qwen3-asr-flash-realtime", source: "byok", ownerAccountId: null, capability: "asr" },
      provider: { provider: "dashscope", endpointId: "asr", protocol: "dashscope-input-audio-chat", apiBase,
        apiKey: "pinned-key", ownerAccountId: null, extraHeaders: {}, extraBody: {} }
    };
    const config = { resolveAssignedModel: vi.fn(async () => selected as any) };
    const settings = { getAppSettings: () => ({ userMode: "byok" as const }) };
    const asr = createAsrService({ bootstrapRepository: settings, memmyConfigWriter: config,
      cloudClient: { transcribeAudio: async () => { throw new Error("must not change to Cloud"); } } });
    const { sessionId } = await asr.prepare();
    const relay = createAsrStreamService({ getSession: asr.getSession, bootstrapRepository: settings,
      accountSessionRepository: { getCloudUuid: () => null }, cloudBaseUrl: "https://unused.invalid" });
    cleanups.push(() => relay.close());
    const local = createServer();
    local.on("upgrade", (request, socket, head) => relay.handleUpgrade(request, socket, head));
    await new Promise<void>(resolve => local.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => local.close(() => resolve())));
    const lines: string[] = []; let liveError: Error | undefined;
    const live = createStreamLiveTranscriber(() => new WebSocket(
      `ws://127.0.0.1:${(local.address() as AddressInfo).port}/api/asr/stream?sessionId=${sessionId}`
    ) as any, { sampleRate: 16000, onLine: line => lines.push(line.text), onError: error => { liveError = error; } });
    cleanups.push(() => live.cancel());
    // Changing the user's assignment after prepare must not change this recording's model/key/base.
    selected = { ...selected, context: { ...selected.context, model: "new-model" },
      provider: { ...selected.provider, apiBase: "https://must-not-be-used.invalid/v1", apiKey: "new-key" } };
    const blocks = [new Int16Array([1, 2, 3]), new Int16Array([4, 5, 6]), new Int16Array([7, 8, 9])];
    live.push(blocks[0]!);
    if (scenario === "success") await vi.waitFor(() => expect(lines).toContain("实时临时文字"));
    else await vi.waitFor(() => expect(liveError).toBeInstanceOf(Error));
    live.push(blocks[1]!); live.push(blocks[2]!);
    const final = await live.finish();
    const pcm = Buffer.concat(blocks.map(block => Buffer.from(block.buffer)));
    const audio = wav(pcm);
    const fullRecording = new Blob([audio], { type: "audio/wav" });
    const client = { prepare: async () => ({ sessionId }), release: async () => asr.release(sessionId),
      openStream: () => { throw new Error("already streamed"); }, transcribe: vi.fn(input => asr.transcribe(input)) };
    const result = transcribeRecording(client, fullRecording, 1, { sessionId, liveText: final?.text, liveError });
    if (scenario === "both-fail") {
      await expect(result).rejects.toThrow(/Realtime ASR:.*HTTP 404\nHTTP ASR:.*missing transcript/);
    } else {
      expect((await result).text).toBe(scenario === "success" ? "完整实时转写" : "完整 HTTP 转写");
    }
    expect(config.resolveAssignedModel).toHaveBeenCalledOnce();
    expect(socketRequests.every(request => request.authorization === "Bearer pinned-key" && request.model === "qwen3-asr-flash-realtime")).toBe(true);
    if (scenario === "success") {
      expect(Buffer.concat(streamedAudio)).toEqual(pcm);
      expect(httpRequests).toHaveLength(0);
    } else {
      expect(httpRequests).toHaveLength(1);
      expect(httpRequests[0]!.authorization).toBe("Bearer pinned-key");
      expect(httpRequests[0]!.body.model).toBe("qwen3-asr-flash-realtime");
      expect(httpRequests[0]!.body.messages[0].content[0].input_audio.data).toBe(`data:audio/wav;base64,${audio.toString("base64")}`);
    }
    asr.release(sessionId);
  });
});
