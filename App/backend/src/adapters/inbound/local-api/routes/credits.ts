import { z } from "zod";
import { CreditsGrantsQuerySchema, CreditsLedgerQuerySchema } from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CreditsService } from "../../../../services/credits-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

export function registerCreditsRoutes(app: FastifyInstance, options: {
  credits: CreditsService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}): void {
  const auth = { preHandler: options.authenticateRuntimeToken };
  app.get("/api/credits/summary", auth, withErrorEnvelope(async request => {
    z.object({}).strict().parse(request.query);
    return options.credits.summary();
  }));
  app.get("/api/credits/grants", auth, withErrorEnvelope(async request =>
    options.credits.grants(CreditsGrantsQuerySchema.parse(request.query))));
  app.get("/api/credits/ledger", auth, withErrorEnvelope(async request =>
    options.credits.ledger(CreditsLedgerQuerySchema.parse(request.query))));
}
