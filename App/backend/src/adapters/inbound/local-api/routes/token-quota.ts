/** Local HTTP routes for token quota requests. */
import {
  RequestTokenQuotaInputSchema,
  TokenQuotaApplyResultSchema,
  TokenQuotaEligibilitySchema
} from "@memmy/local-api-contracts";
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
  app.get(
    "/api/token-quota/eligibility",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const result = TokenQuotaEligibilitySchema.parse(await options.tokenQuota.getEligibility());
      return reply.send(result);
    })
  );

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
