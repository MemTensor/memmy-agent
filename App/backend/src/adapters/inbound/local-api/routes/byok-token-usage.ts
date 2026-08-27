import {
  ByokTokenUsageEventSchema,
  ByokTokenUsageSummarySchema
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ByokTokenUsageService } from "../../../../services/byok-token-usage-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

export interface RegisterByokTokenUsageRoutesOptions {
  byokTokenUsage: ByokTokenUsageService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

export function registerByokTokenUsageRoutes(
  app: FastifyInstance,
  options: RegisterByokTokenUsageRoutesOptions
): void {
  app.post(
    "/api/app/byok-token-usage/events",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = ByokTokenUsageEventSchema.parse(request.body);
      await options.byokTokenUsage.recordEvent(input);
      return reply.send({ ok: true });
    })
  );

  app.get(
    "/api/app/byok-token-usage/summary",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = ByokTokenUsageSummarySchema.parse(await options.byokTokenUsage.getSummary());
      return reply.send(response);
    })
  );
}
