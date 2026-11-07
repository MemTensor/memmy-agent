import type { AsrClient } from "../api/asr-client.js";
import type { UploadAgentMediaInput, UploadedAgentMedia } from "../api/memmy-agent-client.js";
import type { I18nContextValue } from "../i18n/i18n-provider.js";
import { transcribeRecording, type AsrStoppedRecording } from "../pages/asr-recorder.js";
import type { PluginRecordingTranscript, PluginTranscriptionJob, TranscribeAttempt } from "./plugin-transcription-jobs.js";
import { formatTranscript, recordingFormat, recordingStamp } from "./recording-deliverables.js";

type Translate = I18nContextValue["t"];

/** A stopped recording that has been stored and is being transcribed. */
export interface HandedOverRecording {
  /** The stored audio; its path is the id the whole flow addresses it by. */
  audio: UploadedAgentMedia;
  job: PluginTranscriptionJob;
  /** The name the transcript file will carry, for the row shown while it is written. */
  transcriptName: string;
}

/**
 * Stores a stopped recording now and transcribes it in the background.
 *
 * Transcribing a 30-minute interview takes about three minutes. Holding the
 * upload card until then would leave the lawyer staring at a disabled button,
 * so the audio is stored first — which gives it a durable path the next card
 * can list — and the transcription runs as a page-level job the next card
 * waits on when the user submits.
 *
 * @param input The recording and what is needed to store and transcribe it.
 * @returns The stored audio and its transcription job.
 */
export async function handOverRecording(input: {
  stopped: AsrStoppedRecording;
  asrClient: AsrClient;
  uploadFiles: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>;
  startTranscription(audioPath: string, attempt: TranscribeAttempt): PluginTranscriptionJob;
  t: Translate;
  diarization?: boolean;
  emptyAudioMessage?: string;
}): Promise<HandedOverRecording> {
  const stamp = recordingStamp(new Date().toISOString());
  const format = recordingFormat(input.stopped.recordingMimeType);
  // The interview reaches the plugin as text, so the transcript is what the
  // upload card's row stands for — named now, while the file itself is still
  // minutes away.
  const transcriptName = `${input.t("plugin.ui.audio.transcriptFile", { stamp })}.txt`;
  const [audio] = await input.uploadFiles([{
    blob: input.stopped.recording,
    name: `${input.t("plugin.ui.audio.recordingFile", { stamp })}${format.extension}`,
    kind: "audio",
    mime: format.mime,
    target: "recordings"
  }]);
  if (!audio) throw new Error(input.t("plugin.ui.responseFailed"));

  const job = input.startTranscription(audio.path, async (): Promise<PluginRecordingTranscript> => {
    const result = await transcribeRecording(input.asrClient, input.stopped.recording, input.stopped.durationMs, {
      ...(input.diarization ? { diarization: true } : {}),
      ...(input.emptyAudioMessage ? { emptyAudioMessage: input.emptyAudioMessage } : {})
    });
    const transcript = { text: result.text, segments: result.segments ?? [], transcribedAt: result.transcribedAt };
    // Keeping the text as a file is a convenience for the user, not part of the
    // transcription: failing to store it must not throw away a finished pass
    // and send the job round its retries again.
    let transcriptFile: UploadedAgentMedia | undefined;
    try {
      [transcriptFile] = await input.uploadFiles([{
        blob: new Blob([formatTranscript(result, input.t)], { type: "text/plain" }),
        name: transcriptName,
        kind: "file",
        mime: "text/plain",
        target: "recordings"
      }]);
    } catch { /* The transcript is still delivered as text. */ }
    return transcriptFile ? { ...transcript, transcriptFile } : transcript;
  });
  return { audio, job, transcriptName };
}
