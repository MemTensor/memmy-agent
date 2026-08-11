/** Turn runtime routes. */
import { CompleteTurnInputSchema, StartTurnInputSchema } from "@memmy/local-api-contracts";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { withErrorEnvelope } from "../../../../../services/error-envelope.js";
import { runtimeContextFromRequest } from "../../../../../services/runtime-context.js";
import type { AgentRuntimeRouteDeps } from "./index.js";

const TurnParamsSchema = z.object({
  turnId: z.string().min(1)
});

export function registerTurnRoutes(app: FastifyInstance, deps: AgentRuntimeRouteDeps): void {
  app.post(
    "/api/v1/turns/start",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = StartTurnInputSchema.parse(request.body);
      return reply.send(await deps.services.turn.start(input, runtimeContextFromRequest(request, deps.timeZone)));
    })
  );

  app.post(
    "/api/v1/turns/:turnId/complete",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = TurnParamsSchema.parse(request.params);
      const input = CompleteTurnInputSchema.parse(request.body);
      const result = await deps.services.turn.complete(params.turnId, input, runtimeContextFromRequest(request, deps.timeZone));
      return reply.send(result.response);
    })
  );
}
