/**
 * Raw PCM tap on a live microphone stream.
 *
 * The recording card needs the same audio twice: MediaRecorder compresses it
 * into the file that ships as a deliverable, while live transcription and the
 * waveform need uncompressed samples. Both read the one MediaStream, so the
 * microphone is only opened once.
 */

/** A running tap over a microphone stream. */
export interface PcmTap {
  /** Sample rate the emitted samples are in. */
  readonly sampleRate: number;
  /** Releases the audio graph. Does not stop the underlying stream. */
  close(): Promise<void>;
  setPaused(paused: boolean): void;
}

export interface PcmTapOptions {
  /** Receives captured mono samples in {@link PcmTap.sampleRate}. */
  onSamples: (samples: Int16Array) => void;
  onError?: (error: Error) => void;
  /** Receives a 0..1 loudness reading per captured block, for the waveform. */
  onLevel?: (level: number) => void;
  /** Sample rate to capture at; the browser resamples the source to match. */
  sampleRate?: number;
}

/** Speech sample rate. Upstream ASR models are trained at this rate. */
export const PCM_TAP_SAMPLE_RATE = 16_000;

/** Minimal shape of the constructors this module needs, so tests can stand in for them. */
export interface PcmTapAudioBridge {
  AudioContext: typeof AudioContext;
}

/**
 * Starts capturing PCM from a microphone stream.
 *
 * @param stream The open stream, or a factory called only after the audio graph is ready.
 * @param options Sinks for samples and loudness.
 * @param bridge Audio constructors; defaults to the window's.
 * @returns The running tap.
 */
export async function createPcmTap(
  stream: MediaStream | (() => Promise<MediaStream>),
  options: PcmTapOptions,
  bridge: PcmTapAudioBridge = { AudioContext: window.AudioContext }
): Promise<PcmTap> {
  const sampleRate = options.sampleRate ?? PCM_TAP_SAMPLE_RATE;
  const context = new bridge.AudioContext({ sampleRate });
  const moduleUrl = URL.createObjectURL(new Blob([PCM_WORKLET], { type: "text/javascript" }));
  try {
    if (context.sampleRate !== sampleRate) throw new Error("PCM sample rate is unavailable");
    await audioDeadline(context.audioWorklet.addModule(moduleUrl));
    const processor = new AudioWorkletNode(context, "memmy-asr-pcm");
    let flushed: (() => void) | undefined;
    let closing: Promise<void> | undefined;
    processor.port.onmessage = ({ data }) => {
      if (data === "flushed") { flushed?.(); return; }
      if (!(data instanceof Int16Array)) return;
      options.onSamples(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value) / 32768);
      options.onLevel?.(peak);
    };
    processor.onprocessorerror = () => options.onError?.(new Error("ASR audio worklet failed"));
    const mute = context.createGain();
    mute.gain.value = 0;
    processor.connect(mute);
    mute.connect(context.destination);
    await audioDeadline(context.resume());
    // Prepare the worklet before acquiring the microphone so its opening audio is not discarded.
    const source = context.createMediaStreamSource(typeof stream === "function" ? await stream() : stream);
    source.connect(processor);
    return {
      sampleRate,
      setPaused(paused) { if (!closing) processor.port.postMessage(paused ? "pause" : "resume"); },
      close() {
        return closing ??= (async () => {
          try {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("ASR audio flush timed out")), 1_000);
              flushed = () => { clearTimeout(timer); resolve(); };
              processor.port.postMessage("flush");
            });
          } finally {
            processor.port.onmessage = null;
            processor.port.close();
            source.disconnect(); processor.disconnect(); mute.disconnect();
            await context.close();
          }
        })();
      }
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  } finally { URL.revokeObjectURL(moduleUrl); }
}

// Runs on the audio rendering thread; posts 100 ms mono PCM blocks.
const PCM_WORKLET = `
class MemmyAsrPcm extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Int16Array(1600); this.used = 0; this.stopped = false;
    this.paused = false;
    this.port.onmessage = ({ data }) => {
      if (data === "pause") { this.flush(); this.paused = true; }
      else if (data === "resume") this.paused = false;
      else if (data === "flush") { this.stopped = true; this.flush(); this.port.postMessage("flushed"); }
    };
  }
  flush() {
    if (!this.used) return;
    const block = this.samples.slice(0, this.used);
    this.port.postMessage(block, [block.buffer]); this.used = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    if (this.paused) return true;
    const channels = inputs[0];
    const input = channels?.[0];
    if (input) for (let i = 0; i < input.length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      const sample = Math.max(-1, Math.min(1, value / channels.length));
      this.samples[this.used++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      if (this.used === this.samples.length) this.flush();
    }
    return true;
  }
}
registerProcessor("memmy-asr-pcm", MemmyAsrPcm);
`;

/**
 * Folds a new loudness reading into the bar's waveform.
 *
 * @param levels Readings currently drawn, oldest first.
 * @param level The new reading.
 * @param capacity How many bars the waveform shows.
 * @returns The readings to draw.
 */
export function pushWaveformLevel(levels: readonly number[], level: number, capacity: number): number[] {
  const next = [...levels, Math.max(0, Math.min(1, level))];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

async function audioDeadline(operation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("ASR audio initialization timed out")), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}
