/** Asr module. */
import {
  ASR_MAX_REQUEST_BYTES,
  AsrTranscriptionInputSchema,
  AsrTranscriptionResponseSchema
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AsrService } from "../../../../services/asr-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

/** Contract for register asr routes options. */
export interface RegisterAsrRoutesOptions {
  asr: AsrService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers register asr routes. */
export function registerAsrRoutes(app: FastifyInstance, options: RegisterAsrRoutesOptions): void {
  app.post(
    "/api/asr/transcriptions",
    {
      preHandler: options.authenticateRuntimeToken,
      // Fastify defaults to 1 MiB, which only fits a couple of minutes of
      // speech. Raised here rather than server-wide so every other route keeps
      // the tight default.
      bodyLimit: ASR_MAX_REQUEST_BYTES
    },
    withErrorEnvelope(async (request, reply) => {
      const input = AsrTranscriptionInputSchema.parse(request.body);
      const response = AsrTranscriptionResponseSchema.parse(await options.asr.transcribe(input));
      return reply.send(response);
    })
  );
}
