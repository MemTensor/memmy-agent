/** Memory detail runtime routes. */
import {
  AddMemoryInputSchema,
  DeleteMemoryInputSchema,
  MemoryApiLogsInputSchema,
  MemoryProcessingStatusInputSchema
} from "@memmy/local-api-contracts";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { withErrorEnvelope } from "../../../../../services/error-envelope.js";
import type { RuntimeContext } from "../../../../../services/runtime-context.js";
import type { AgentRuntimeRouteDeps } from "./index.js";

const MemoryParamsSchema = z.object({
  id: z.string().min(1)
});

export function registerMemoryRoutes(app: FastifyInstance, deps: AgentRuntimeRouteDeps): void {
  app.post(
    "/api/v1/memory/add",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = AddMemoryInputSchema.parse(request.body);
      return reply.send(await deps.services.memoryDetail.add(input, runtimeContext()));
    })
  );

  app.get(
    "/api/v1/memory/logs",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const rawQuery = request.query as Record<string, unknown>;
      const tools = typeof rawQuery.tools === "string"
        ? rawQuery.tools.split(",").map((tool) => tool.trim()).filter(Boolean)
        : rawQuery.tools;
      const excludedSourceAgents = queryValues(request.raw.url, "excludedSourceAgents");
      const input = MemoryApiLogsInputSchema.parse({
        ...rawQuery,
        tools,
        excludedSourceAgents
      });
      return reply.send(await deps.services.panel.memoryApiLogs(input, runtimeContext()));
    })
  );

  app.post(
    "/api/v1/memory/processing/status",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = MemoryProcessingStatusInputSchema.parse(request.body);
      return reply.send(await deps.services.memoryClient.getMemoryProcessingStatus(input.memoryIds));
    })
  );

  app.post(
    "/api/v1/memory/:id/processing/retry",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = MemoryParamsSchema.parse(request.params);
      await deps.services.memoryClient.reloadConfig({
        reason: "manual_processing_retry",
        restartFailedProcessing: false
      });
      return reply.send(await deps.services.memoryClient.retryMemoryProcessing(params.id));
    })
  );

  app.get(
    "/api/v1/memory/:id",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = MemoryParamsSchema.parse(request.params);
      return reply.send(await deps.services.memoryDetail.getById(params.id, runtimeContext()));
    })
  );

  app.delete(
    "/api/v1/memory/:id",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = MemoryParamsSchema.parse(request.params);
      const input = DeleteMemoryInputSchema.parse(request.body ?? {});
      return reply.send(await deps.services.memoryDetail.delete(params.id, input, runtimeContext()));
    })
  );
}

function runtimeContext(): RuntimeContext {
  return { adapterId: "runtime" };
}

function queryValues(rawUrl: string | undefined, name: string): string[] | undefined {
  const values = new URL(rawUrl ?? "/", "http://localhost").searchParams
    .getAll(name)
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}
