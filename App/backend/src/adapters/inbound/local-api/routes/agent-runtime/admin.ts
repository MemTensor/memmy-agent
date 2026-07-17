/** Agent Runtime admin routes. */
import { MemoryReloadConfigInputSchema } from "@memmy/local-api-contracts";
import type { FastifyInstance } from "fastify";
import { withErrorEnvelope } from "../../../../../services/error-envelope.js";
import type { AgentRuntimeRouteDeps } from "./index.js";

export function registerAdminRoutes(app: FastifyInstance, deps: AgentRuntimeRouteDeps): void {
  app.post(
    "/api/v1/admin/reload-config",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = MemoryReloadConfigInputSchema.parse(request.body ?? {});
      return reply.send(await deps.services.memoryClient.reloadConfig(input));
    })
  );
}
