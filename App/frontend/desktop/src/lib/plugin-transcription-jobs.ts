import type { UploadedAgentMedia } from "../api/memmy-agent-client.js";

/** The text a pending recording produced, as the plugin reads it. */
export interface PluginRecordingTranscript {
  text: string;
  segments: Array<{ text: string; speakerId?: number; startMs?: number; endMs?: number }>;
  transcribedAt: string;
  /** The transcript stored as a text file, when the Host could keep one. */
  transcriptFile?: UploadedAgentMedia;
}

/**
 * Where one stopped recording's transcription has got to.
 *
 * `failed` is only reached after the automatic retries are spent; it is the
 * point at which the user is asked what to do. `skipped` is their answer to go
 * on without it.
 */
export type PluginTranscriptionState =
  | { status: "transcribing"; attempt: number }
  | { status: "ready"; transcript: PluginRecordingTranscript }
  | { status: "failed"; message: string }
  | { status: "skipped" };

/**
 * A transcription running after its recording was handed over.
 *
 * A 30-minute interview takes minutes to transcribe. The recording card hands
 * its audio over the moment the interview stops so the user can move on, which
 * means the card unmounts while ASR is still running — so the job lives here,
 * with the page, and the upload card waits on it by the audio's stored path.
 */
export interface PluginTranscriptionJob {
  state: PluginTranscriptionState;
  /** Resolves with the transcript, or null once the user chose to go on without it. */
  wait(): Promise<PluginRecordingTranscript | null>;
  /** Starts again after the automatic retries were spent. */
  retry(): void;
  /** Proceeds without this transcript; `wait()` resolves with null. */
  skip(): void;
}

/** Automatic attempts before the user is asked; the first one counts. */
export const PLUGIN_TRANSCRIPTION_ATTEMPTS = 3;

/** One transcription attempt; throws when the attempt fails. */
export type TranscribeAttempt = () => Promise<PluginRecordingTranscript>;

/**
 * Runs a recording's transcription with automatic retries.
 *
 * The user is already looking at the next card when this starts, so a
 * transient ASR failure is retried quietly — only after
 * {@link PLUGIN_TRANSCRIPTION_ATTEMPTS} failures does the job stop at `failed`
 * and wait for the user to choose between trying again and going on without
 * the transcript.
 *
 * @param attempt Runs one transcription.
 * @param onChange Called on every state change, so the UI can follow along.
 * @returns The job.
 */
export function createTranscriptionJob(
  attempt: TranscribeAttempt,
  onChange: (state: PluginTranscriptionState) => void
): PluginTranscriptionJob {
  let state: PluginTranscriptionState = { status: "transcribing", attempt: 1 };
  let settle!: (value: PluginRecordingTranscript | null) => void;
  const settled = new Promise<PluginRecordingTranscript | null>((resolve) => { settle = resolve; });
  const set = (next: PluginTranscriptionState) => {
    state = next;
    onChange(next);
  };

  const run = async () => {
    let lastError: unknown;
    for (let index = 1; index <= PLUGIN_TRANSCRIPTION_ATTEMPTS; index++) {
      set({ status: "transcribing", attempt: index });
      try {
        const transcript = await attempt();
        set({ status: "ready", transcript });
        settle(transcript);
        return;
      } catch (caught) {
        lastError = caught;
      }
    }
    set({ status: "failed", message: lastError instanceof Error ? lastError.message : String(lastError ?? "") });
  };
  void run();

  return {
    get state() { return state; },
    wait: () => settled,
    retry() {
      if (state.status === "failed") void run();
    },
    skip() {
      // Only offered once the retries are spent; while an attempt is running
      // there is nothing to skip yet.
      if (state.status !== "failed") return;
      set({ status: "skipped" });
      settle(null);
    }
  };
}
