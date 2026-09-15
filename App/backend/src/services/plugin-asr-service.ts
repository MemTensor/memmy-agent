/** Host-owned `asr` service letting plugins transcribe audio the user has uploaded. */
import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  ASR_MAX_AUDIO_BYTES,
  AsrTranscriptionResponseSchema,
  type AsrTranscriptionResponse
} from "@memmy/local-api-contracts";
import type { PluginHostServiceInvoker } from "../adapters/outbound/plugin-runtime/index.js";
import type { AsrService } from "./asr-service.js";
import { z } from "zod";

const PluginAsrInputSchema = z.object({
  /** Path to an audio file inside a Host-owned upload root. */
  path: z.string().trim().min(1),
  mimeType: z.string().trim().min(1).max(128).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  /** Requests speaker separation. Honoured only by upstream models that support it. */
  diarization: z.boolean().optional()
});

const MIME_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".webm": "audio/webm"
};

export interface CreatePluginAsrServiceOptions {
  asr: AsrService;
  /** Host-owned upload roots a plugin may read audio from. */
  audioRoots: readonly string[];
}

/**
 * Transcribes an uploaded audio file on behalf of a plugin.
 *
 * The plugin passes a path rather than audio bytes: recordings run to hundreds
 * of megabytes, which the line-delimited command runtime protocol cannot carry.
 * Only paths inside a Host-owned upload root are accepted so a plugin cannot
 * read arbitrary user audio through this service.
 */
export function createPluginAsrService(options: CreatePluginAsrServiceOptions): PluginHostServiceInvoker {
  const audioRoots = options.audioRoots.map((root) => resolve(root));

  return {
    async invoke(call) {
      if (call.service !== "asr") {
        throw serviceError("host_service_unavailable", `Unknown Host service: ${call.service}`, false);
      }
      const input = PluginAsrInputSchema.parse(call.input);
      const path = await resolveAudioPath(input.path, audioRoots);
      const info = await stat(path);
      if (!info.isFile()) throw serviceError("invalid_argument", "ASR input must be a regular file", false);
      if (info.size === 0) throw serviceError("invalid_argument", "ASR input file is empty", false);
      if (info.size > ASR_MAX_AUDIO_BYTES) {
        // Rejected here so an oversized upload fails with a clear reason rather
        // than as an opaque error from the upstream transcription API.
        throw serviceError("invalid_argument", "ASR input file exceeded the size limit", false);
      }

      const response: AsrTranscriptionResponse = await options.asr.transcribe({
        audioBase64: (await readFile(path)).toString("base64"),
        mimeType: input.mimeType ?? guessMimeType(path),
        durationMs: input.durationMs,
        diarization: input.diarization
      });
      return AsrTranscriptionResponseSchema.parse(response);
    }
  };
}

/**
 * Resolves a plugin-supplied audio path inside the Host-owned upload roots.
 *
 * The path is canonicalised before the containment check so a symlink planted
 * inside an upload root cannot point at an unrelated file.
 *
 * @param candidate the plugin-supplied path.
 * @param audioRoots the resolved Host-owned upload roots.
 * @returns the canonical path.
 */
async function resolveAudioPath(candidate: string, audioRoots: readonly string[]): Promise<string> {
  if (!audioRoots.length) {
    throw serviceError("host_service_unavailable", "No Host-owned audio root is configured", false);
  }

  let canonical: string;
  try {
    canonical = await realpath(resolve(candidate));
  } catch {
    throw serviceError("invalid_argument", "ASR input file was not found", false);
  }

  for (const root of audioRoots) {
    const canonicalRoot = await realpath(root).catch(() => null);
    if (!canonicalRoot) continue;
    const offset = relative(canonicalRoot, canonical);
    if (offset && !offset.startsWith(`..${sep}`) && offset !== ".." && !offset.startsWith(sep)) {
      return canonical;
    }
  }

  throw serviceError("forbidden", "ASR input file is outside the Host-owned audio roots", false);
}

/**
 * Infers the media type from the file extension.
 *
 * @param path the canonical audio path.
 * @returns the media type; falls back to a generic audio type.
 */
function guessMimeType(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return MIME_TYPE_BY_EXTENSION[extension] ?? "audio/mpeg";
}

function serviceError(code: string, message: string, retryable: boolean): Error {
  return Object.assign(new Error(message), { code, retryable });
}
