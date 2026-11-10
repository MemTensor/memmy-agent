import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiRealtimeAsrStreamAdapter, createPcm16Resampler } from "../openai-realtime-asr-stream-adapter.js";
import { createDashScopeAsrStreamAdapter } from "../dashscope-asr-stream-adapter.js";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];
  send(data: string | Buffer) { this.sent.push(typeof data === "string" ? JSON.parse(data) : data); }
  close() { this.readyState = 3; }
  terminate() { this.close(); this.emit("close", 1006); }
  receive(frame: unknown) { this.emit("message", Buffer.from(JSON.stringify(frame)), false); }
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.useRealTimers(); });
function setup(dashscope = false, extraHeaders: Record<string, string> = {}, model?: string) {
  const socket = new Socket(); const events: any[] = []; let headers: Record<string, string> = {};
  const adapter = (dashscope ? createDashScopeAsrStreamAdapter : createOpenAiRealtimeAsrStreamAdapter)({
    context: { model: model ?? (dashscope ? "qwen3-asr-flash-realtime" : "gpt-4o-mini-realtime-preview") } as any,
    provider: { apiBase: "https://provider.invalid/v1", apiKey: "default-credential", extraHeaders } as any,
    connect: (_url, auth) => { headers = auth; return socket as any; }, emit: event => events.push(event), done() {}
  });
  cleanups.push(() => adapter.close()); socket.emit("open");
  return { socket, events, adapter, headers };
}
describe("ASR adapter completion", () => {
  it.each(["Authorization", "authorization", "AUTHORIZATION"])("matches HTTP authentication with a configured %s header", headerName => {
    for (const dashscope of [false, true]) {
      const { headers } = setup(dashscope, { [headerName]: "Bearer explicit-credential" });
      expect(Object.keys(headers).filter(key => key.toLowerCase() === "authorization")).toEqual([headerName]);
      expect(new Headers(headers).get("authorization")).toBe("Bearer explicit-credential");
    }
  });
  it("resamples one second to 24000 samples independent of chunk boundaries", () => {
    const input = Buffer.alloc(32000);
    for (let i = 0; i < 16000; i++) input.writeInt16LE(Math.round(Math.sin(i / 20) * 10000), i * 2);
    const full = createPcm16Resampler(16000, 24000);
    const expected = Buffer.concat([full.push(input), full.finish()]);
    const split = createPcm16Resampler(16000, 24000); const output: Buffer[] = [];
    for (let i = 0; i < input.length; i += 262) output.push(split.push(input.subarray(i, i + 262)));
    output.push(split.finish());
    expect(expected.length).toBe(48000);
    expect(Buffer.concat(output)).toEqual(expected);
  });
  function commit(socket: Socket, item: string, response: string) {
    socket.receive({ type: "input_audio_buffer.committed", item_id: item });
    socket.receive({ type: "response.created", response: { id: response, metadata: { memmy_asr_item: item } } });
  }
  function finishBarrier(socket: Socket, adapter: ReturnType<typeof setup>["adapter"]) {
    adapter.control({ type: "finish" });
    socket.receive({ type: "session.updated", session: { turn_detection: null } });
    return (socket.sent as any[]).findLast(frame => frame.type === "input_audio_buffer.commit").event_id;
  }
  function complete(socket: Socket, id: string, text: string) {
    socket.receive({ type: "response.text.done", response_id: id, text });
    socket.receive({ type: "response.done", response: { id, status: "completed" } });
  }
  it("rejects a failed terminal response even after an earlier successful sentence", () => {
    const { socket, events, adapter } = setup();
    socket.receive({ type: "session.updated" });
    commit(socket, "audio-1", "first"); complete(socket, "first", "first sentence");
    finishBarrier(socket, adapter); commit(socket, "audio-2", "last");
    socket.receive({ type: "response.done", response: { id: "last", status: "failed" } });
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.some(event => event.type === "finished")).toBe(false);
  });
  it("finishes a VAD-committed utterance after its acknowledged empty tail without another response", () => {
    const { socket, events, adapter } = setup();
    expect(socket.sent[0]).toMatchObject({ session: { turn_detection: { create_response: false, interrupt_response: false } } });
    socket.receive({ type: "session.updated" });
    commit(socket, "audio-1", "first");
    const finalCommit = finishBarrier(socket, adapter);
    socket.receive({ type: "error", error: { code: "input_audio_buffer_commit_empty_audio", event_id: finalCommit } });
    expect(events.some(event => event.type === "finished")).toBe(false);
    complete(socket, "first", "full sentence");
    expect(events.at(-1)).toEqual({ type: "finished" });
    expect((socket.sent as any[]).filter(frame => frame.type === "response.create")).toEqual([
      expect.objectContaining({ response: expect.objectContaining({ conversation: "none", input: [{ type: "item_reference", id: "audio-1" }] }) })
    ]);
  });
  it("rejects an unrelated empty-commit error and does not mask uncommitted speech", () => {
    for (const pendingSpeech of [false, true]) {
      const { socket, events, adapter } = setup(); socket.receive({ type: "session.updated" });
      commit(socket, "audio-1", "first"); complete(socket, "first", "first sentence");
      if (pendingSpeech) socket.receive({ type: "input_audio_buffer.speech_started", item_id: "tail" });
      const finalCommit = finishBarrier(socket, adapter);
      socket.receive({ type: "error", error: { code: "input_audio_buffer_commit_empty_audio", event_id: pendingSpeech ? finalCommit : "unrelated" } });
      expect(events.at(-1)).toMatchObject({ type: "error" });
    }
  });
  it("orders parallel transcripts by audio and waits for every final response", () => {
    const { socket, events, adapter } = setup(); socket.receive({ type: "session.updated" });
    commit(socket, "audio-1", "first"); finishBarrier(socket, adapter); commit(socket, "audio-2", "last");
    complete(socket, "last", "second");
    expect(events.some(event => event.type === "finished")).toBe(false);
    complete(socket, "first", "first");
    expect(events.filter(event => event.type === "sentence").map(event => [event.sentenceId, event.text])).toEqual([[2, "second"], [1, "first"]]);
    expect(events.at(-1)).toEqual({ type: "finished" });
  });
  it("does not accept a completed response without transcript text", () => {
    const { socket, events, adapter } = setup(); socket.receive({ type: "session.updated" });
    finishBarrier(socket, adapter); commit(socket, "audio", "last");
    socket.receive({ type: "response.done", response: { id: "last", status: "completed" } });
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
  it("uses the GA session shape and waits for VAD-off acknowledgement before final commit", () => {
    const { socket, events, adapter } = setup(false, {}, "gpt-realtime");
    expect(socket.sent[0]).toMatchObject({ session: { type: "realtime", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: { create_response: false } } } } });
    socket.receive({ type: "session.updated" }); adapter.control({ type: "finish" });
    expect((socket.sent as any[]).some(frame => frame.type === "input_audio_buffer.commit")).toBe(false);
    socket.receive({ type: "session.updated", session: { audio: { input: { turn_detection: null } } } });
    commit(socket, "audio", "last");
    expect(socket.sent.at(-1)).toMatchObject({ type: "response.create", response: { output_modalities: ["text"] } });
    socket.receive({ type: "response.output_text.delta", response_id: "last", delta: "transcript" });
    socket.receive({ type: "response.output_text.done", response_id: "last", text: "transcript" });
    socket.receive({ type: "response.done", response: { id: "last", status: "completed" } });
    expect(events.at(-1)).toEqual({ type: "finished" });
  });
  it.each([false, true])("times out model acceptance for adapter %s", async (dashscope) => {
    vi.useFakeTimers(); const { events } = setup(dashscope);
    await vi.advanceTimersByTimeAsync(3000);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.some(event => event.type === "ready")).toBe(false);
  });
  it.each([false, true])("does not grow the send queue for adapter %s", (dashscope) => {
    const { socket, events, adapter } = setup(dashscope);
    socket.receive({ type: "session.updated" }); socket.bufferedAmount = 300000;
    adapter.audio(Buffer.alloc(3200));
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });
});


describe("Qwen realtime proxy routes", () => {
  function proxy(apiBase = "https://proxy.invalid/tenant/v1") {
    const sockets: Socket[] = [];
    const urls: URL[] = [];
    const events: any[] = [];
    const done = vi.fn();
    const adapter = createDashScopeAsrStreamAdapter({
      context: { model: "qwen3-asr-flash-realtime" } as any,
      provider: { apiBase, apiKey: "secret", extraHeaders: {} } as any,
      connect(url) { urls.push(new URL(url)); const socket = new Socket(); sockets.push(socket); return socket as any; },
      emit: event => events.push(event), done
    });
    cleanups.push(() => adapter.close());
    return { adapter, sockets, urls, events, done };
  }
  function reject(socket: Socket, statusCode: number) {
    socket.emit("unexpected-response", {}, { statusCode, resume() {} });
  }
  it("keeps buffered PCM and an early finish until the second route accepts the same model", () => {
    const { adapter, sockets, urls, events } = proxy();
    adapter.audio(Buffer.from([1, 0, 2, 0]));
    adapter.control({ type: "finish" });
    reject(sockets[0]!, 404);
    expect(urls.map(url => url.pathname)).toEqual(["/tenant/api-ws/v1/realtime", "/tenant/v1/realtime"]);
    expect(urls.every(url => url.origin === "wss://proxy.invalid" && url.searchParams.get("model") === "qwen3-asr-flash-realtime")).toBe(true);
    expect(events).toEqual([]);
    sockets[0]!.receive({ type: "session.updated" });
    expect(events).toEqual([]);
    sockets[1]!.emit("open");
    expect(sockets[1]!.sent).toHaveLength(1);
    sockets[1]!.receive({ type: "session.updated" });
    expect(sockets[1]!.sent).toEqual([
      expect.objectContaining({ type: "session.update", session: expect.objectContaining({ sample_rate: 16000, input_audio_format: "pcm" }) }),
      expect.objectContaining({ type: "input_audio_buffer.append", audio: Buffer.from([1, 0, 2, 0]).toString("base64") }),
      expect.objectContaining({ type: "session.finish" })
    ]);
  });
  it.each([401, 403, 429, 500])("does not retry a rejected credential or service failure (%s)", status => {
    const { sockets, events, done } = proxy();
    reject(sockets[0]!, status);
    expect(sockets).toHaveLength(1);
    expect(events).toEqual([expect.objectContaining({ type: "error", message: expect.stringContaining(`HTTP ${status}`) })]);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it.each(["https://dashscope.aliyuncs.com/compatible-mode/v1", "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"])("does not invent a compatible proxy route for the official endpoint %s", base => {
    const { sockets } = proxy(base);
    reject(sockets[0]!, 404);
    expect(sockets).toHaveLength(1);
  });
  it("reports both failed routes once and never treats websocket open as acceptance", () => {
    const { sockets, events, done } = proxy();
    reject(sockets[0]!, 405);
    sockets[1]!.emit("open");
    sockets[1]!.terminate();
    expect(sockets).toHaveLength(2);
    expect(events).toEqual([{ type: "error", message: "/tenant/api-ws/v1/realtime: HTTP 405; /tenant/v1/realtime: closed (1006) before session acceptance" }]);
    expect(done).toHaveBeenCalledTimes(1);
  });
  it("does not replay audio after an accepted session disconnects", () => {
    const { sockets, adapter, events } = proxy();
    sockets[0]!.emit("open");
    sockets[0]!.receive({ type: "session.updated" });
    adapter.audio(Buffer.from([1, 0]));
    sockets[0]!.terminate();
    expect(sockets).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("before completion") });
  });
  it("does not create another upstream after cancellation", () => {
    const { sockets, adapter, events } = proxy();
    adapter.close();
    reject(sockets[0]!, 404);
    expect(sockets).toHaveLength(1);
    expect(events).toEqual([]);
  });
});


describe("Qwen final transcript completeness", () => {
  it("keeps audio order when final transcripts arrive out of order", () => {
    const { socket, events } = setup(true); socket.receive({ type: "session.updated" });
    for (const item_id of ["first", "last"]) socket.receive({ type: "input_audio_buffer.speech_started", item_id });
    for (const item_id of ["last", "first"]) socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id, transcript: item_id });
    expect(events.filter(event => event.type === "sentence").map(event => [event.sentenceId, event.text])).toEqual([[2, "last"], [1, "first"]]);
  });

  it.each(["input_audio_buffer.speech_started", "input_audio_buffer.committed"])("rejects finished when a %s item never returned a final transcript", eventType => {
    const { adapter, socket, events } = setup(true);
    socket.receive({ type: "session.updated" });
    socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "first", transcript: "first sentence" });
    socket.receive({ type: eventType, item_id: "tail", audio_start_ms: 1000 });
    adapter.control({ type: "finish" });
    socket.receive({ type: "session.finished" });
    expect(events.at(-1)).toEqual({ type: "error", message: "upstream ASR finished with missing final transcripts" });
    expect(events.some(event => event.type === "finished")).toBe(false);
  });
  it("finishes only after all announced utterances return their final transcripts", () => {
    const { adapter, socket, events } = setup(true);
    socket.receive({ type: "session.updated" });
    socket.receive({ type: "input_audio_buffer.speech_started", item_id: "last", audio_start_ms: 0 });
    socket.receive({ type: "input_audio_buffer.committed", item_id: "last" });
    adapter.control({ type: "finish" });
    socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "last", transcript: "complete tail" });
    socket.receive({ type: "session.finished" });
    expect(events.at(-1)).toEqual({ type: "finished" });
  });
});


describe("DashScope task protocol integrity", () => {
  it("keeps distinct sentences when the vendor omits sentence_id", () => {
    const { socket, events, adapter } = setup(true, {}, "paraformer-realtime-v2");
    socket.receive({ header: { event: "task-started" } });
    for (const [begin_time, text, sentence_end] of [[0, "first", true], [1000, "sec", false], [1000, "second", true]]) {
      socket.receive({ header: { event: "result-generated" }, payload: { output: { sentence: { begin_time, text, sentence_end } } } });
    }
    const lines = events.filter(event => event.type === "sentence" || event.type === "partial");
    expect(lines[0].sentenceId).not.toBe(lines[1].sentenceId);
    expect(lines[1].sentenceId).toBe(lines[2].sentenceId);
    adapter.control({ type: "finish" }); socket.receive({ header: { event: "task-finished" } });
    expect(events.at(-1)).toEqual({ type: "finished" });
  });
  it("rejects task-finished when the last sentence is still provisional", () => {
    const { socket, events, adapter } = setup(true, {}, "paraformer-realtime-v2");
    socket.receive({ header: { event: "task-started" } });
    socket.receive({ header: { event: "result-generated" }, payload: { output: { sentence: { begin_time: 0, text: "unfinished", sentence_end: false } } } });
    adapter.control({ type: "finish" }); socket.receive({ header: { event: "task-finished" } });
    expect(events.at(-1).type).toBe("error");
  });
  it("rejects a task that finishes before stop", () => {
    const { socket, events } = setup(true, {}, "paraformer-realtime-v2");
    socket.receive({ header: { event: "task-started" } }); socket.receive({ header: { event: "task-finished" } });
    expect(events.at(-1).type).toBe("error");
  });
});
