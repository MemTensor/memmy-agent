/** One transcribed stretch of an in-progress recording. */
export interface AsrLiveLine {
  /** Stable recognizer identity used to replace revisions of the same sentence. */
  sentenceId: number;
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
  finish(): Promise<AsrLiveTranscriptionResult | null>;
  /** Drops buffered audio and stops reporting lines. */
  cancel(): void;
}

/** A complete transcript confirmed by the realtime provider. */
export interface AsrLiveTranscriptionResult {
  text: string;
}

/**
 * Merges a newly transcribed line into the lines already on screen.
 *
 * A recognizer may revise both text and timestamps while a sentence is still
 * provisional, so only its stable sentence id is safe for replacement.
 *
 * @param lines The lines shown so far.
 * @param line The line just transcribed.
 * @returns The lines to show, ordered by offset.
 */
export function mergeLiveLines(lines: readonly AsrLiveLine[], line: AsrLiveLine): AsrLiveLine[] {
  const next = lines.filter((existing) => existing.sentenceId !== line.sentenceId);
  next.push(line);
  return next.sort((left, right) => left.startMs - right.startMs || left.sentenceId - right.sentenceId);
}
