/** Memory Panel runtime routes. */
import { PanelItemsInputSchema, PanelTasksInputSchema, ProjectContextFocusInputSchema, ProjectContextGoalDecisionInputSchema, ProjectContextProposeGoalInputSchema, ProjectContextWorkItemCreateInputSchema, ProjectContextWorkItemUpdateInputSchema, RuntimeNamespaceSchema } from "@memmy/local-api-contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withErrorEnvelope } from "../../../../../services/error-envelope.js";
import type { RuntimeContext } from "../../../../../services/runtime-context.js";
import type { AgentRuntimeRouteDeps } from "./index.js";

export function registerPanelRoutes(app: FastifyInstance, deps: AgentRuntimeRouteDeps): void {
  app.get(
    "/api/v1/panel/overview",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      return reply.send(await deps.services.panel.overview(runtimeContext()));
    })
  );

  app.get(
    "/api/v1/panel/analysis",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      return reply.send(await deps.services.panel.analysis(runtimeContext()));
    })
  );

  app.get(
    "/api/v1/panel/context-pack",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const { projectId } = z.object({ projectId: z.string().min(1) }).parse(request.query);
      return reply.send(await deps.services.panel.contextPack(projectId, runtimeContext()));
    })
  );

  app.get("/api/v1/project-context/state", { preHandler: deps.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const namespace = typeof query.namespace === "string"
      ? z.string().transform((value, ctx) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          ctx.addIssue({ code: "custom", message: "namespace must be valid JSON" });
          return z.NEVER;
        }
      }).pipe(RuntimeNamespaceSchema).parse(query.namespace)
      : RuntimeNamespaceSchema.parse(query);
    return reply.send(await deps.services.panel.projectContextState(namespace, runtimeContext(request)));
  }));
  app.post("/api/v1/project-context/goals/propose", { preHandler: deps.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const input = ProjectContextProposeGoalInputSchema.parse(request.body);
    return reply.send(await deps.services.panel.proposeProjectGoal(input, runtimeContext(request)));
  }));
  app.post("/api/v1/project-context/goals/:id/approve", { preHandler: deps.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return reply.send(await deps.services.panel.approveProjectGoal(id, ProjectContextGoalDecisionInputSchema.parse(request.body), runtimeContext(request)));
  }));
  app.post("/api/v1/project-context/goals/:id/reject", { preHandler: deps.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return reply.send(await deps.services.panel.rejectProjectGoal(id, ProjectContextGoalDecisionInputSchema.parse(request.body), runtimeContext(request)));
  }));
  app.post("/api/v1/project-context/work-items", { preHandler: deps.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => reply.send(await deps.services.panel.createProjectWorkItem(ProjectContextWorkItemCreateInputSchema.parse(request.body), runtimeContext(request)))));
  app.patch("/api/v1/project-context/work-items/:id", { preHandler: deps.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
    return reply.send(await deps.services.panel.updateProjectWorkItem(id, ProjectContextWorkItemUpdateInputSchema.parse(request.body), runtimeContext(request)));
  }));
  app.put("/api/v1/project-context/focus", { preHandler: deps.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => reply.send(await deps.services.panel.setProjectFocus(ProjectContextFocusInputSchema.parse(request.body), runtimeContext(request)))));

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
      return reply.send(await deps.services.panel.items(input, runtimeContext()));
    })
  );

  app.get(
    "/api/v1/panel/tasks",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = PanelTasksInputSchema.parse(request.query);
      return reply.send(await deps.services.panel.tasks(input, runtimeContext()));
    })
  );

  app.delete(
    "/api/v1/panel/tasks/:id",
    { preHandler: deps.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(request.params);
      return reply.send(await deps.services.panel.deleteTask(id, runtimeContext()));
    })
  );

}

function runtimeContext(request?: { headers?: Record<string, unknown>; body?: unknown }): RuntimeContext {
  const body = request?.body as { requestId?: unknown } | undefined;
  const header = request?.headers?.["x-request-id"];
  const requestId = typeof body?.requestId === "string" ? body.requestId : typeof header === "string" ? header : undefined;
  return { adapterId: "runtime", requestId };
}

function queryValues(rawUrl: string | undefined, name: string): string[] | undefined {
  const values = new URL(rawUrl ?? "/", "http://localhost").searchParams
    .getAll(name)
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}
