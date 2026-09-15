import type { UploadAgentMediaInput, UploadedAgentMedia } from "../api/memmy-agent-client.js";
import type { I18nContextValue } from "../i18n/i18n-provider.js";
import type { AsrRecordingTranscription } from "../pages/asr-recorder.js";
import { AGENT_AUDIO_MIME_BY_EXTENSION, type AgentAudioMime } from "./agent-attachment.js";

/**
 * Translator, taken from the calling card.
 *
 * Filenames and speaker labels are user-visible, and this module runs outside
 * React, so the active language has to arrive as an argument.
 */
type Translate = I18nContextValue["t"];

/** Files kept from a finished recording. */
export interface RecordingDeliverables {
  audio?: UploadedAgentMedia;
  transcript?: UploadedAgentMedia;
}

/**
 * Stores a finished recording and its transcript as files.
 *
 * Both are deliverables the user expects to keep, and neither can be recreated
 * afterwards: a plugin never sees the audio, and the transcript only exists in
 * the card's response. Returns nothing when the Host has no upload sink, so a
 * card without one still answers with the text.
 *
 * @param result Transcription result carrying the original recording.
 * @param t Translator for the deliverable filenames.
 * @param uploadFiles Host upload sink.
 * @returns Descriptors for the stored files, when persisted.
 */
export async function persistRecording(
  result: AsrRecordingTranscription,
  t: Translate,
  uploadFiles?: (files: UploadAgentMediaInput[]) => Promise<UploadedAgentMedia[]>
): Promise<RecordingDeliverables> {
  if (!uploadFiles) return {};
  const stamp = recordingStamp(result.transcribedAt);
  const audio = recordingFormat(result.recordingMimeType);
  const uploaded = await uploadFiles([
    {
      blob: result.recording,
      name: `${t("plugin.ui.audio.recordingFile", { stamp })}${audio.extension}`,
      kind: "audio",
      mime: audio.mime
    },
    {
      blob: new Blob([formatTranscript(result, t)], { type: "text/plain" }),
      name: `${t("plugin.ui.audio.transcriptFile", { stamp })}.txt`,
      kind: "file",
      mime: "text/plain"
    }
  ]);
  return { ...(uploaded[0] ? { audio: uploaded[0] } : {}), ...(uploaded[1] ? { transcript: uploaded[1] } : {}) };
}

/**
 * Renders a transcript as text, one speaker turn per line.
 *
 * Speaker numbers only hold within a single transcription, so they are
 * presented as labels rather than as identities that carry across recordings.
 * Falls back to the flat text when the model returned no turns.
 *
 * @param result Transcription result.
 * @param t Translator for the speaker labels.
 * @returns Plain-text transcript.
 */
export function formatTranscript(result: Pick<AsrRecordingTranscription, "text" | "segments">, t: Translate): string {
  const segments = result.segments ?? [];
  if (segments.length === 0) return result.text;
  return segments
    .map((segment) => {
      const speaker = segment.speakerId === undefined
        ? ""
        : t("plugin.ui.audio.speaker", { index: segment.speakerId + 1 });
      const at = segment.startMs === undefined ? "" : `[${formatTimecode(segment.startMs)}] `;
      return `${at}${speaker}${segment.text}`;
    })
    .join("\n");
}

/**
 * Resolves a recording's extension and media type from what the browser reports.
 *
 * Browsers report media types with codec parameters attached, while the upload
 * contract accepts only bare types. Both values come from one lookup so the
 * filename and the declared type cannot disagree.
 *
 * @param mimeType Recording media type as reported by MediaRecorder.
 * @returns Matching extension and accepted media type.
 */
export function recordingFormat(mimeType: string): { extension: string; mime: AgentAudioMime } {
  const base = mimeType.split(";")[0]?.trim().toLowerCase();
  const match = Object.entries(AGENT_AUDIO_MIME_BY_EXTENSION).find(([, mime]) => mime === base);
  return match ? { extension: match[0], mime: match[1] } : { extension: ".webm", mime: "audio/webm" };
}

/**
 * Builds the timestamp used in deliverable filenames.
 *
 * Colons and dots are not safe in filenames on every platform, so they are
 * flattened; an unparseable timestamp falls back to now.
 *
 * @param transcribedAt ISO timestamp from the transcription.
 * @returns Filename-safe stamp.
 */
function recordingStamp(transcribedAt: string): string {
  const parsed = new Date(transcribedAt);
  const at = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return at.toISOString().replace(/[:.]/g, "-");
}

/**
 * Formats an offset into a recording as mm:ss.
 *
 * @param elapsedMs Offset from the start of the recording.
 * @returns Zero-padded timecode.
 */
function formatTimecode(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1_000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
