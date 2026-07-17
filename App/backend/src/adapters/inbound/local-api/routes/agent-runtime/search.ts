/** Search runtime route. */
import { SearchInputSchema } from "@memmy/local-api-contracts";
import type { FastifyInstance } from "fastify";
import { withErrorEnvelope } from "../../../../../services/error-envelope.js";
import type { RuntimeContext } from "../../../../../services/runtime-context.js";
import type { AgentRuntimeRouteDeps } from "./index.js";

export function registerSearchRoute(app: FastifyInstance, deps: AgentRuntimeRouteDeps): void {
  app.post(
    "/api/v1/memory/search",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = SearchInputSchema.parse(request.body);
      const ctx: RuntimeContext = { adapterId: "runtime" };
      return reply.send(await deps.services.search.search(input, ctx));
    })
  );
}
