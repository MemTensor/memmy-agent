/**
 * Live transcription of an in-progress recording.
 *
 * The recording card shows transcript lines while the microphone is still open,
 * so the audio has to be transcribed before it is finished. This module cuts the
 * captured PCM into self-contained segments and transcribes each one as it is
 * filled, which keeps the transport to the plain request/response ASR endpoint.
 *
 * Segments are WAV rather than a slice of the browser recording: only the first
 * chunk a MediaRecorder emits carries a container header, so a later chunk is
 * not decodable on its own. Raw PCM wrapped in a fresh WAV header always is.
 *
 * Speaker attribution deliberately does not happen here. Speaker numbering is
 * assigned per transcription, so numbering a segment says nothing about the
 * recording as a whole; the diarized pass over the finished recording is what
 * produces speaker labels.
 */
import type { AsrClient } from "../api/asr-client.js";

/** One transcribed stretch of an in-progress recording. */
export interface AsrLiveLine {
  /** Offset from the start of the recording. */
  startMs: number;
  endMs: number;
  text: string;
}

/** Sink that accepts captured audio and reports transcript lines. */
export interface AsrLiveTranscriber {
  /** Feeds newly captured mono samples. */
  push(samples: Int16Array): void;
  /** Transcribes whatever is still buffered, then settles. */
  finish(): Promise<void>;
  /** Drops buffered audio and stops reporting lines. */
  cancel(): void;
}

export interface AsrLiveTranscriberOptions {
  sampleRate: number;
  /** Target segment length. Longer segments read better; shorter ones appear sooner. */
  segmentMs?: number;
  onLine: (line: AsrLiveLine) => void;
  onError?: (error: Error) => void;
}

/** Segment length that balances how soon a line appears against how much context the model gets. */
export const ASR_LIVE_SEGMENT_MS = 6_000;

/**
 * How far from the target boundary a quieter cut point is accepted.
 *
 * Cutting mid-word costs both halves of the word, so the boundary is nudged
 * onto the quietest nearby moment instead of landing on a fixed timestamp.
 */
const CUT_SEARCH_MS = 700;

/** Window the cut search scores, short enough to sit inside a pause between words. */
const CUT_WINDOW_MS = 120;

/**
 * Transcribes an in-progress recording one segment at a time.
 *
 * @param asrClient Transport used for each segment.
 * @param options Sample rate, segment length and the line sink.
 * @returns A transcriber fed by the recorder's PCM tap.
 */
export function createChunkedLiveTranscriber(
  asrClient: AsrClient,
  options: AsrLiveTranscriberOptions
): AsrLiveTranscriber {
  const segmentMs = options.segmentMs ?? ASR_LIVE_SEGMENT_MS;
  const segmentSamples = Math.max(1, Math.round((options.sampleRate * segmentMs) / 1_000));
  const buffer = createSampleBuffer();
  let consumedSamples = 0;
  let cancelled = false;
  // Segments are transcribed one at a time so lines cannot arrive out of order,
  // and so a long interview cannot open an unbounded number of requests.
  let pending: Promise<void> = Promise.resolve();

  const transcribe = (samples: Int16Array, startSample: number): void => {
    pending = pending.then(async () => {
      if (cancelled || samples.length === 0) return;
      const startMs = Math.round((startSample / options.sampleRate) * 1_000);
      const endMs = Math.round(((startSample + samples.length) / options.sampleRate) * 1_000);
      try {
        const result = await asrClient.transcribe({
          audioBase64: bytesToBase64(encodeWav(samples, options.sampleRate)),
          mimeType: "audio/wav",
          durationMs: endMs - startMs
        });
        const text = result.text.trim();
        if (!cancelled && text) options.onLine({ startMs, endMs, text });
      } catch (caught) {
        // A dropped segment must not stop the recording; the finished recording
        // is transcribed again in full, so nothing is permanently lost here.
        if (!cancelled) options.onError?.(caught instanceof Error ? caught : new Error(String(caught)));
      }
    });
  };

  return {
    push(samples) {
      if (cancelled || samples.length === 0) return;
      buffer.append(samples);
      while (buffer.length >= segmentSamples) {
        const cut = findQuietestCut(buffer.peek(), segmentSamples, options.sampleRate);
        transcribe(buffer.take(cut), consumedSamples);
        consumedSamples += cut;
      }
    },

    async finish() {
      if (!cancelled && buffer.length > 0) transcribe(buffer.take(buffer.length), consumedSamples);
      await pending;
    },

    cancel() {
      cancelled = true;
      buffer.take(buffer.length);
    }
  };
}

/** Growable mono sample buffer that hands out exact-length segments. */
interface SampleBuffer {
  readonly length: number;
  append(samples: Int16Array): void;
  /** Returns the buffered samples without consuming them. */
  peek(): Int16Array;
  /** Removes and returns the first `count` samples. */
  take(count: number): Int16Array;
}

function createSampleBuffer(): SampleBuffer {
  let samples = new Int16Array(0);
  return {
    get length() {
      return samples.length;
    },
    append(next) {
      const merged = new Int16Array(samples.length + next.length);
      merged.set(samples, 0);
      merged.set(next, samples.length);
      samples = merged;
    },
    peek() {
      return samples;
    },
    take(count) {
      const taken = samples.slice(0, count);
      samples = samples.slice(count);
      return taken;
    }
  };
}

/**
 * Picks the cut point nearest the target that falls on the quietest audio.
 *
 * Only positions the buffer actually holds are considered, so a cut never runs
 * past the captured audio.
 *
 * @param samples The buffered samples.
 * @param targetSamples Preferred segment length.
 * @param sampleRate Samples per second.
 * @returns A sample count to cut, always between 1 and `samples.length`.
 */
export function findQuietestCut(samples: Int16Array, targetSamples: number, sampleRate: number): number {
  const searchSamples = Math.round((sampleRate * CUT_SEARCH_MS) / 1_000);
  const windowSamples = Math.max(1, Math.round((sampleRate * CUT_WINDOW_MS) / 1_000));
  const earliest = Math.max(1, targetSamples - searchSamples);
  const latest = Math.min(samples.length, targetSamples + searchSamples);
  const target = Math.min(targetSamples, samples.length);
  if (latest <= earliest) return target;

  const meanMagnitude = (cut: number): number => {
    const from = Math.max(0, cut - Math.floor(windowSamples / 2));
    const to = Math.min(samples.length, from + windowSamples);
    if (to <= from) return Number.POSITIVE_INFINITY;
    let energy = 0;
    for (let index = from; index < to; index += 1) energy += Math.abs(samples[index] ?? 0);
    return energy / (to - from);
  };

  // The target is the candidate to beat, so audio with no pause in it — or a
  // pause no quieter than everything else — keeps its segments evenly sized
  // instead of drifting to one end of the search range.
  let bestCut = target;
  let bestMagnitude = meanMagnitude(target);
  // Step a fraction of the window so the scan stays cheap on long buffers.
  const step = Math.max(1, Math.floor(windowSamples / 4));
  for (let cut = earliest; cut <= latest; cut += step) {
    const magnitude = meanMagnitude(cut);
    const closerToTarget = Math.abs(cut - target) < Math.abs(bestCut - target);
    if (magnitude < bestMagnitude || (magnitude === bestMagnitude && closerToTarget)) {
      bestMagnitude = magnitude;
      bestCut = cut;
    }
  }
  return bestCut;
}

/**
 * Wraps mono PCM in a WAV container.
 *
 * @param samples Signed 16-bit mono samples.
 * @param sampleRate Samples per second.
 * @returns The complete WAV file.
 */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const HEADER_BYTES = 44;
  const dataBytes = samples.length * 2;
  const bytes = new Uint8Array(HEADER_BYTES + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
  };

  ascii(0, "RIFF");
  view.setUint32(4, HEADER_BYTES - 8 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(HEADER_BYTES + index * 2, samples[index] ?? 0, true);
  }
  return bytes;
}

/**
 * Base64-encodes bytes without routing them through a Blob.
 *
 * @param bytes The bytes to encode.
 * @returns The base64 text.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked so a long segment cannot overflow the argument limit of apply().
  const CHUNK = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/**
 * Merges a newly transcribed line into the lines already on screen.
 *
 * Segments are transcribed in order, so a line that repeats an offset is a
 * retry of that segment and replaces the earlier text rather than appending.
 *
 * @param lines The lines shown so far.
 * @param line The line just transcribed.
 * @returns The lines to show, ordered by offset.
 */
export function mergeLiveLines(lines: readonly AsrLiveLine[], line: AsrLiveLine): AsrLiveLine[] {
  const next = lines.filter((existing) => existing.startMs !== line.startMs);
  next.push(line);
  return next.sort((left, right) => left.startMs - right.startMs);
}
