/** Agent Runtime health route. */
import type { FastifyInstance } from "fastify";
import { cancellableRuntimeContextFromRequest } from "../../../../../services/runtime-context.js";
import { withErrorEnvelope } from "../../../../../services/error-envelope.js";
import type { AgentRuntimeRouteDeps } from "./index.js";

export function registerHealthRoute(app: FastifyInstance, deps: AgentRuntimeRouteDeps): void {
  app.get(
    "/api/v1/health",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => reply.send(await deps.services.memoryClient.health(cancellableRuntimeContextFromRequest(request, reply, deps.timeZone))))
  );
}
