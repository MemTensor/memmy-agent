import { ModelCapabilityCatalogRefreshResultSchema } from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ModelCapabilityCatalogSyncService } from "../../../../services/model-capability-catalog-sync-service.js";

export function registerModelCapabilityCatalogRoutes(app: FastifyInstance, options: {
  modelCapabilityCatalog: ModelCapabilityCatalogSyncService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}): void {
  app.post("/api/app/model-catalog/refresh", { preHandler: options.authenticateRuntimeToken }, async (_request, reply) => {
    const result = await options.modelCapabilityCatalog.sync();
    return reply.send(ModelCapabilityCatalogRefreshResultSchema.parse({
      status: result.status === "failed" ? result.reason : "synced",
      hasValidCatalog: result.catalog !== null,
      ...(result.catalog ? { catalogVersion: result.catalog.catalogVersion } : {})
    }));
  });
}
