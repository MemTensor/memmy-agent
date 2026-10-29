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
}

export interface PcmTapOptions {
  /** Receives captured mono samples in {@link PcmTap.sampleRate}. */
  onSamples: (samples: Int16Array) => void;
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
 * @param stream The open microphone stream.
 * @param options Sinks for samples and loudness.
 * @param bridge Audio constructors; defaults to the window's.
 * @returns The running tap.
 */
export function createPcmTap(
  stream: MediaStream,
  options: PcmTapOptions,
  bridge: PcmTapAudioBridge = { AudioContext: window.AudioContext }
): PcmTap {
  const sampleRate = options.sampleRate ?? PCM_TAP_SAMPLE_RATE;
  const context = new bridge.AudioContext({ sampleRate });
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessorNode rather than an AudioWorklet: a worklet has to be loaded
  // from its own module URL, and at one mono channel of 16 kHz the callback is
  // cheap enough that keeping it on this thread costs nothing measurable.
  const BLOCK_SAMPLES = 4_096;
  const processor = context.createScriptProcessor(BLOCK_SAMPLES, 1, 1);

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const samples = new Int16Array(input.length);
    let peak = 0;
    for (let index = 0; index < input.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, input[index] ?? 0));
      samples[index] = Math.round(sample * 0x7fff);
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
    }
    options.onSamples(samples);
    options.onLevel?.(peak);
  };

  source.connect(processor);
  // A ScriptProcessorNode only runs while it is connected to the destination.
  // Routing through a silent gain keeps it running without playing the
  // microphone back through the speakers.
  const mute = context.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(context.destination);

  return {
    sampleRate: context.sampleRate,
    async close() {
      processor.onaudioprocess = null;
      processor.disconnect();
      mute.disconnect();
      source.disconnect();
      await context.close();
    }
  };
}

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
