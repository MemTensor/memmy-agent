/** Memory Panel runtime routes. */
import { PanelItemsInputSchema, PanelTasksInputSchema } from "@memmy/local-api-contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withErrorEnvelope } from "../../../../../services/error-envelope.js";
import { runtimeContextFromRequest } from "../../../../../services/runtime-context.js";
import type { AgentRuntimeRouteDeps } from "./index.js";

export function registerPanelRoutes(app: FastifyInstance, deps: AgentRuntimeRouteDeps): void {
  app.get(
    "/api/v1/panel/overview",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      return reply.send(await deps.services.panel.overview(runtimeContextFromRequest(request, deps.timeZone)));
    })
  );

  app.get(
    "/api/v1/panel/analysis",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      return reply.send(await deps.services.panel.analysis(runtimeContextFromRequest(request, deps.timeZone)));
    })
  );

  app.get(
    "/api/v1/panel/items",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const rawQuery = request.query as Record<string, unknown>;
      const excludedSourceAgents = queryValues(request.raw.url, "excludedSourceAgents");
      const input = PanelItemsInputSchema.parse({
        ...rawQuery,
        excludedSourceAgents
      });
      return reply.send(await deps.services.panel.items(input, runtimeContextFromRequest(request, deps.timeZone)));
    })
  );

  app.get(
    "/api/v1/panel/tasks",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = PanelTasksInputSchema.parse(request.query);
      return reply.send(await deps.services.panel.tasks(input, runtimeContextFromRequest(request, deps.timeZone)));
    })
  );

  app.delete(
    "/api/v1/panel/tasks/:id",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      return reply.send(await deps.services.panel.deleteTask(id, runtimeContextFromRequest(request, deps.timeZone)));
    })
  );

}

function queryValues(rawUrl: string | undefined, name: string): string[] | undefined {
  const values = new URL(rawUrl ?? "/", "http://localhost").searchParams
    .getAll(name)
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}
