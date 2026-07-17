/** Local data module. */
import {
  ClearLocalDataInputSchema,
  ExportLocalDataInputSchema,
  LocalDataClearResponseSchema,
  LocalDataExportResponseSchema,
  LocalDataRevealResponseSchema
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import type { LocalDataService } from "../../../../services/local-data-service.js";

/** Contract for register local data routes options. */
export interface RegisterLocalDataRoutesOptions {
  localData: LocalDataService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers register local data routes. */
export function registerLocalDataRoutes(app: FastifyInstance, options: RegisterLocalDataRoutesOptions): void {
  app.post(
    "/api/local-data/reveal",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = LocalDataRevealResponseSchema.parse(await options.localData.reveal());
      return reply.send(response);
    })
  );

  app.post(
    "/api/local-data/export",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = ExportLocalDataInputSchema.parse(request.body ?? {});
      const response = LocalDataExportResponseSchema.parse(await options.localData.export(input));
      return reply.send(response);
    })
  );

  app.delete(
    "/api/local-data",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = ClearLocalDataInputSchema.parse(request.body);
      const response = LocalDataClearResponseSchema.parse(await options.localData.clear(input));
      return reply.send(response);
    })
  );
}
