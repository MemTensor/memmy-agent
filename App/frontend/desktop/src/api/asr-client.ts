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
      return requestJson({
        config,
        path: "/api/asr/transcriptions",
        schema: AsrTranscriptionResponseSchema,
        body: AsrTranscriptionInputSchema.parse(input)
      });
    }
  };
}
