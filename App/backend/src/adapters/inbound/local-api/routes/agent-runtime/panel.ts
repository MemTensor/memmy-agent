import {PanelLogsInputSchema} from "@memmy/local-api-contracts";
import { PanelBrowseInputSchema } from "@memmy/local-api-contracts";
import { PanelTaskDetailInputSchema, PanelTaskFieldInputSchema } from "@memmy/local-api-contracts";
/** Memory Panel runtime routes. */
import { PanelItemsInputSchema, PanelTasksInputSchema } from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { withErrorEnvelope } from "../../../../../services/error-envelope.js";
import { cancellableRuntimeContextFromRequest as panelRequestContext } from "../../../../../services/runtime-context.js";
import type { AgentRuntimeRouteDeps } from "./index.js";

export function registerPanelRoutes(app: FastifyInstance, deps: AgentRuntimeRouteDeps): void {
  app.get("/api/v1/panel/memory/:id",{preHandler:deps.authenticateRuntimeToken},withErrorEnvelope(async(request,reply)=>{
    const {id}=z.object({id:z.string().min(1)}).parse(request.params);
    return reply.send(await deps.services.panel.memory(id,panelRequestContext(request,reply,deps.timeZone)));
  }));
  app.get(
    "/api/v1/panel/overview",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      return reply.send(await deps.services.panel.overview(panelRequestContext(request, reply, deps.timeZone)));
    })
  );

  app.get(
    "/api/v1/panel/analysis",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      return reply.send(await deps.services.panel.analysis(panelRequestContext(request, reply, deps.timeZone)));
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
      return reply.send(await deps.services.panel.items(input, panelRequestContext(request, reply, deps.timeZone)));
    })
  );

  app.get(
    "/api/v1/panel/tasks",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = PanelTasksInputSchema.parse(request.query);
      return reply.send(await deps.services.panel.tasks(input, panelRequestContext(request, reply, deps.timeZone)));
    })
  );

  app.post("/api/v1/panel/logs",{preHandler:deps.authenticateRuntimeToken},withErrorEnvelope(async(request,reply)=>reply.send(await deps.services.panel.logs(PanelLogsInputSchema.parse(request.body),panelRequestContext(request,reply,deps.timeZone)))));
  app.get("/api/v1/panel/logs/:id",{preHandler:deps.authenticateRuntimeToken},withErrorEnvelope(async(request,reply)=>{
    const {id}=z.object({id:z.coerce.number().int().positive()}).parse(request.params);
    return reply.send(await deps.services.panel.logDetail(id,panelRequestContext(request,reply,deps.timeZone)));
  }));
  app.get("/api/v1/panel/stats",{preHandler:deps.authenticateRuntimeToken},withErrorEnvelope(async(request,reply)=>reply.send(await deps.services.panel.stats(panelRequestContext(request,reply,deps.timeZone)))));
  app.get("/api/v1/panel/overview-stats",{preHandler:deps.authenticateRuntimeToken},withErrorEnvelope(async(request,reply)=>reply.send(await deps.services.panel.overviewStats(panelRequestContext(request,reply,deps.timeZone)))));
  app.post("/api/v1/panel/browse", {preHandler:deps.authenticateRuntimeToken},withErrorEnvelope(async(request,reply)=>{
    return reply.send(await deps.services.panel.browse(PanelBrowseInputSchema.parse(request.body),panelRequestContext(request,reply,deps.timeZone)));
  }));
  app.get("/api/v1/panel/task-summaries", {preHandler: deps.authenticateRuntimeToken}, withErrorEnvelope(async (request, reply) => {
    return reply.send(await deps.services.panel.taskSummaries(PanelTasksInputSchema.parse(request.query), panelRequestContext(request, reply, deps.timeZone)));
  }));
  app.get("/api/v1/panel/task-details/:id/check", {preHandler: deps.authenticateRuntimeToken}, withErrorEnvelope(async (request, reply) => {
    const {id} = z.object({id: z.string().min(1)}).parse(request.params);
    return reply.send(await deps.services.panel.taskCheck(id, panelRequestContext(request, reply, deps.timeZone)));
  }));
  app.get("/api/v1/panel/task-details/:id", {preHandler: deps.authenticateRuntimeToken}, withErrorEnvelope(async (request, reply) => {
    const {id} = z.object({id: z.string().min(1)}).parse(request.params);
    return reply.send(await deps.services.panel.taskDetail(id, PanelTaskDetailInputSchema.parse(request.query).cursor, panelRequestContext(request, reply, deps.timeZone)));
  }));
  app.get("/api/v1/panel/task-details/:id/turns/:turnId/field", {preHandler: deps.authenticateRuntimeToken}, withErrorEnvelope(async (request, reply) => {
    const {id, turnId} = z.object({id: z.string().min(1), turnId: z.string().min(1)}).parse(request.params);
    return reply.send(await deps.services.panel.taskField(id, turnId, PanelTaskFieldInputSchema.parse(request.query), panelRequestContext(request, reply, deps.timeZone)));
  }));

  app.delete(
    "/api/v1/panel/tasks/:id",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      return reply.send(await deps.services.panel.deleteTask(id, panelRequestContext(request, reply, deps.timeZone)));
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
