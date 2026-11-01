import {
  AsrTranscriptionInputSchema,
  AsrTranscriptionResponseSchema,
  type AsrTranscriptionInput,
  type AsrTranscriptionResponse,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";
import type { StreamSocket } from "../lib/asr-stream-transcription.js";

export interface AsrClient {
  transcribe(input: AsrTranscriptionInput): Promise<AsrTranscriptionResponse>;
  /**
   * Opens the live transcription stream.
   *
   * A browser WebSocket cannot carry the runtime-token header, so the token
   * rides on the query string exactly as the SSE channel's does.
   */
  openStream(): StreamSocket;
}

export function createHttpAsrClient(config: RuntimeConfig): AsrClient {
  return {
    async transcribe(input) {
      return requestJson({
        config,
        path: "/api/asr/transcriptions",
        schema: AsrTranscriptionResponseSchema,
        body: AsrTranscriptionInputSchema.parse(input)
      });
    },
    openStream() {
      return new WebSocket(toStreamUrl(config));
    }
  };
}

/**
 * Builds the relay's WebSocket URL from the runtime config.
 *
 * @param config Runtime config carrying the local API origin and token.
 * @returns The `ws://` URL with the token as a query parameter.
 */
export function toStreamUrl(config: Pick<RuntimeConfig, "baseUrl" | "localToken">): string {
  const url = new URL("/api/asr/stream", config.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", config.localToken);
  return url.toString();
}
