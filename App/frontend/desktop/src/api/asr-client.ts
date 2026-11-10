import {
  AsrSessionSchema,
  AsrTranscriptionInputSchema,
  AsrTranscriptionResponseSchema,
  type AsrTranscriptionInput,
  type AsrTranscriptionResponse,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";
import type { StreamSocket } from "../lib/asr-stream-transcription.js";

export interface AsrClient {
  prepare(): Promise<{ sessionId: string }>;
  release(sessionId: string): Promise<void>;
  transcribe(input: AsrTranscriptionInput, signal?: AbortSignal): Promise<AsrTranscriptionResponse>;
  /**
   * Opens the live transcription stream.
   *
   * A browser WebSocket cannot carry the runtime-token header, so the token
   * rides on the query string exactly as the SSE channel's does.
   */
  openStream(sessionId?: string): StreamSocket;
}

export function createHttpAsrClient(config: RuntimeConfig): AsrClient {
  return {
    prepare() {
      return requestJson({ config, path: "/api/asr/sessions", schema: AsrSessionSchema,
        init: { method: "POST", signal: AbortSignal.timeout(5_000) } });
    },
    async release(sessionId) {
      await requestJson({ config, path: `/api/asr/sessions/${encodeURIComponent(sessionId)}`,
        schema: AsrSessionSchema, init: { method: "DELETE", signal: AbortSignal.timeout(5_000) } });
    },
    async transcribe(input, signal) {
      return requestJson({
        config,
        path: "/api/asr/transcriptions",
        schema: AsrTranscriptionResponseSchema,
        init: { signal },
        body: AsrTranscriptionInputSchema.parse(input)
      });
    },
    openStream(sessionId) {
      return new WebSocket(toStreamUrl(config, sessionId));
    }
  };
}

/**
 * Builds the relay's WebSocket URL from the runtime config.
 *
 * @param config Runtime config carrying the local API origin and token.
 * @returns The `ws://` URL with the token as a query parameter.
 */
export function toStreamUrl(config: Pick<RuntimeConfig, "baseUrl" | "localToken">, sessionId?: string): string {
  const url = new URL("/api/asr/stream", config.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", config.localToken);
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  return url.toString();
}
