/** Integrations module. */
import {
  AuthorizeIntegrationResponseSchema,
  IntegrationCapabilitiesResponseSchema,
  IntegrationConnectionsResponseSchema,
  OkResponseSchema
} from "@memmy/local-api-contracts";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IntegrationService } from "../../../../services/integration-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

/** Contract for register integration routes options. */
export interface RegisterIntegrationRoutesOptions {
  integrations: IntegrationService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const IntegrationSlugParamsSchema = z.object({
  slug: z.string().min(1)
});

const IntegrationConnectionParamsSchema = z.object({
  id: z.string().min(1)
});

/** Registers register integration routes. */
export function registerIntegrationRoutes(app: FastifyInstance, options: RegisterIntegrationRoutesOptions): void {
  app.get(
    "/api/v1/integrations/capabilities",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = IntegrationCapabilitiesResponseSchema.parse(await options.integrations.listCapabilities());
      return reply.send(response);
    })
  );

  app.post(
    "/api/v1/integrations/:slug/authorize",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const { slug } = IntegrationSlugParamsSchema.parse(request.params);
      const response = AuthorizeIntegrationResponseSchema.parse(await options.integrations.authorize(slug));
      return reply.send(response);
    })
  );

  app.get(
    "/api/v1/integrations/connections",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = IntegrationConnectionsResponseSchema.parse(await options.integrations.listConnections());
      return reply.send(response);
    })
  );

  app.delete(
    "/api/v1/integrations/connections/:id",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const { id } = IntegrationConnectionParamsSchema.parse(request.params);
      const response = OkResponseSchema.parse(await options.integrations.deleteConnection(id));
      return reply.send(response);
    })
  );
}
