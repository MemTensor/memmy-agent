import { z } from "zod";
import { CreditsPlansQuerySchema, CreditsGrantsQuerySchema, CreditsLedgerQuerySchema, CreditsUsageQuerySchema, CreditsUsageExportQuerySchema } from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CreditsService } from "../../../../services/credits-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

export function registerCreditsRoutes(app: FastifyInstance, options: {
  credits: CreditsService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}): void {
  const auth = { preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    return options.authenticateRuntimeToken(request, reply);
  } };
  app.get("/api/credits/plans", auth, withErrorEnvelope(async request =>
    options.credits.plans(CreditsPlansQuerySchema.parse(request.query))));
  app.get("/api/credits/plan-applications/latest", auth, withErrorEnvelope(async request => {
    z.object({}).strict().parse(request.query);
    return options.credits.latestApplication();
  }));
  app.get("/api/credits/usage", auth, withErrorEnvelope(async request =>
    options.credits.usage(CreditsUsageQuerySchema.parse(request.query))));
  app.get("/api/credits/usage/export", auth, withErrorEnvelope(async request =>
    options.credits.usageExport(CreditsUsageExportQuerySchema.parse(request.query))));
  app.get("/api/credits/usage/download", auth, withErrorEnvelope(async request =>
    options.credits.usageDownload(CreditsUsageExportQuerySchema.extend({ token: z.string().max(4096) }).parse(request.query))));
  app.get("/api/credits/usage/:callId", auth, withErrorEnvelope(async request => {
    z.object({}).strict().parse(request.query);
    const { callId } = z.object({ callId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).parse(request.params);
    return options.credits.usageDetail(callId);
  }));
  app.get("/api/credits/summary", auth, withErrorEnvelope(async request => {
    z.object({}).strict().parse(request.query);
    return options.credits.summary();
  }));
  app.get("/api/credits/grants", auth, withErrorEnvelope(async request =>
    options.credits.grants(CreditsGrantsQuerySchema.parse(request.query))));
  app.get("/api/credits/ledger", auth, withErrorEnvelope(async request =>
    options.credits.ledger(CreditsLedgerQuerySchema.parse(request.query))));
}
