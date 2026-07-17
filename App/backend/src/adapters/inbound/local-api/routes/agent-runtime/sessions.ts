/** Session runtime routes. */
import {
  CloseSessionInputSchema,
  OpenSessionInputSchema
} from "@memmy/local-api-contracts";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { withErrorEnvelope } from "../../../../../services/error-envelope.js";
import type { RuntimeContext } from "../../../../../services/runtime-context.js";
import type { AgentRuntimeRouteDeps } from "./index.js";

const SessionParamsSchema = z.object({
  sessionId: z.string().min(1)
});

export function registerSessionRoutes(app: FastifyInstance, deps: AgentRuntimeRouteDeps): void {
  app.post(
    "/api/v1/sessions/open",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = OpenSessionInputSchema.parse(request.body ?? {});
      const result = await deps.services.session.open(input, runtimeContext());
      return reply.send(result.response);
    })
  );

  app.post(
    "/api/v1/sessions/:sessionId/close",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = SessionParamsSchema.parse(request.params);
      const input = CloseSessionInputSchema.parse(request.body ?? {});
      const result = await deps.services.session.close(params.sessionId, input, runtimeContext());
      return reply.send(result.response);
    })
  );

}

function runtimeContext(): RuntimeContext {
  return { adapterId: "runtime" };
}
