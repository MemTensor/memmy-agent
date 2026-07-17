/** Token quota module. */
import { RequestTokenQuotaInputSchema, TokenQuotaApplyResultSchema } from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TokenQuotaService } from "../../../../services/token-quota-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

/** Contract for register token quota routes options. */
export interface RegisterTokenQuotaRoutesOptions {
  tokenQuota: TokenQuotaService;
  /** Runtime-token Fastify preHandler. */
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers register token quota routes. */
export function registerTokenQuotaRoutes(app: FastifyInstance, options: RegisterTokenQuotaRoutesOptions): void {
  app.post(
    "/api/token-quota/request",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = RequestTokenQuotaInputSchema.parse(request.body);
      const result = TokenQuotaApplyResultSchema.parse(await options.tokenQuota.requestQuota(input));
      return reply.send(result);
    })
  );
}
