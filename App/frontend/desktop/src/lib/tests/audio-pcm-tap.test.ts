import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPcmTap } from "../audio-pcm-tap.js";

// Execute the shipped processor module, including its message handling and PCM buffer.
function audioGraph() {
  let module: Blob;
  let Processor: any;
  let processor: any;
  const close = vi.fn(async () => {});
  const disconnect = vi.fn();
  const addModule = vi.fn(async () => {
    runInNewContext(await module.text(), {
      Int16Array,
      AudioWorkletProcessor: class { port = { onmessage: null, postMessage: null }; },
      registerProcessor(_name: string, ctor: any) { Processor = ctor; }
    });
  });
  vi.spyOn(URL, "createObjectURL").mockImplementation(blob => { module = blob as Blob; return "blob:pcm"; });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.stubGlobal("AudioWorkletNode", class {
    port = { onmessage: null as any, close: vi.fn(), postMessage: (data: string) => processor.port.onmessage({ data }) };
    constructor() {
      processor = new Processor();
      processor.port.postMessage = (data: unknown) => this.port.onmessage?.({ data });
    }
    connect() {}
    disconnect = disconnect;
  });
  const resume = vi.fn(async () => {});
  class Context {
    sampleRate = 16000;
    audioWorklet = { addModule };
    destination = {};
    close = close;
    resume = resume;
    createMediaStreamSource() { return { connect() {}, disconnect }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect }; }
  }
  return {
    bridge: { AudioContext: Context as unknown as typeof AudioContext }, close, addModule, disconnect, resume,
    process(samples: Float32Array) { return processor.process([[samples]]); },
    processChannels(channels: Float32Array[]) { return processor.process([channels]); }
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PCM capture", () => {
  it("flushes speech before pausing and excludes paused audio after resuming", async () => {
    const graph = audioGraph();
    const blocks: Int16Array[] = [];
    const tap = await createPcmTap({} as MediaStream, { onSamples: block => blocks.push(block) }, graph.bridge);
    graph.process(new Float32Array(1000).fill(0.25));
    tap.setPaused(true);
    graph.process(new Float32Array(2000).fill(-0.5));
    tap.setPaused(false);
    graph.process(new Float32Array(300).fill(0.5));
    await tap.close();
    await tap.close();
    expect(blocks.map(block => block.length)).toEqual([1000, 300]);
    expect([...blocks[0]!].every(sample => sample === 8192)).toBe(true);
    expect([...blocks[1]!].every(sample => sample === 16384)).toBe(true);
    expect(graph.close).toHaveBeenCalledOnce();
    expect(graph.disconnect).toHaveBeenCalledTimes(3);
    expect(graph.process(new Float32Array(128))).toBe(false);
  });

  it("releases the audio context and module URL when initialization fails", async () => {
    const graph = audioGraph();
    graph.addModule.mockRejectedValueOnce(new Error("worklet unavailable"));
    await expect(createPcmTap({} as MediaStream, { onSamples() {} }, graph.bridge)).rejects.toThrow("worklet unavailable");
    expect(graph.close).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:pcm");
  });
});


describe("PCM initialization and mono input", () => {
  it("initializes the graph before acquiring the microphone", async () => {
    const graph = audioGraph();
    const getStream = vi.fn(async () => {
      expect(graph.addModule).toHaveBeenCalledOnce();
      expect(graph.resume).toHaveBeenCalledOnce();
      return {} as MediaStream;
    });
    const tap = await createPcmTap(getStream, { onSamples() {} }, graph.bridge);
    expect(getStream).toHaveBeenCalledOnce();
    await tap.close();
  });
  it("does not open a microphone when the worklet cannot initialize", async () => {
    const graph = audioGraph(); const getStream = vi.fn(async () => ({} as MediaStream));
    graph.addModule.mockRejectedValueOnce(new Error("worklet unavailable"));
    await expect(createPcmTap(getStream, { onSamples() {} }, graph.bridge)).rejects.toThrow("worklet unavailable");
    expect(getStream).not.toHaveBeenCalled();
  });
  it("keeps speech from the right channel of a stereo microphone", async () => {
    const graph = audioGraph(); const blocks: Int16Array[] = [];
    const tap = await createPcmTap({} as MediaStream, { onSamples: block => blocks.push(block) }, graph.bridge);
    graph.processChannels([new Float32Array(200), new Float32Array(200).fill(0.5)]);
    await tap.close();
    expect(blocks).toHaveLength(1);
    expect([...blocks[0]!]).toEqual(Array(200).fill(8192));
  });
});
