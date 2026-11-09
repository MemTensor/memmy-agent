import {
  AsrTranscriptionInputSchema,
  AsrTranscriptionResponseSchema,
  type AsrTranscriptionInput,
  type AsrTranscriptionResponse,
  type RuntimeConfig
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export interface AsrClient {
  transcribe(input: AsrTranscriptionInput): Promise<AsrTranscriptionResponse>;
}

export function createHttpAsrClient(config: RuntimeConfig): AsrClient {
  return {
    async transcribe(input) {
      const result = await requestJson({
        config,
        path: "/api/asr/transcriptions",
        schema: AsrTranscriptionResponseSchema,
        body: AsrTranscriptionInputSchema.parse(input)
      });
      if (result.source === "account" && result.creditSettlement && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("credits.changed", { detail: result.creditSettlement }));
      }
      return result;
    }
  };
}
