import { AgentTokenStatsResponseSchema } from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AgentTokenStatsService } from "../../../../services/agent-token-stats-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

export interface RegisterAgentTokenStatsRoutesOptions {
  agentTokenStats: AgentTokenStatsService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

export function registerAgentTokenStatsRoutes(
  app: FastifyInstance,
  options: RegisterAgentTokenStatsRoutesOptions
): void {
  app.get(
    "/api/app/agent-token-stats",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = AgentTokenStatsResponseSchema.parse(
        await options.agentTokenStats.getStats()
      );
      return reply.send(response);
    })
  );
}
