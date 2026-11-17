/** Agent sources module. */
import {
  AddManualInputSchema,
  AgentSourceAutoInjectResultSchema,
  AgentSourceIdParamsSchema,
  AgentSourceMemoryPluginConflictsResponseSchema,
  AgentSourcePluginActionInputSchema,
  AgentSourceScanInputSchema,
  AgentSourceScanJobResponseSchema,
  AgentSourceScanStatusResponseSchema,
  AgentSourceViewSchema,
  ScanResultPageSchema,
  ManagedAgentSourceImportInputSchema,
  ManagedAgentSourceImportResultSchema,
  ManagedAgentSourceUpdateInputSchema,
  OkResponseSchema,
  ScanControlInputSchema,
  AgentSourceScanControlResponseSchema
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PermissionManager } from "../../../../permission/index.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import type { AgentSourceAutoInjectService } from "../../../../services/agent-source-auto-inject-service.js";
import type { AgentSourceService } from "../../../../services/agent-source-service.js";
import type { ProgressBus } from "../../../../services/progress-bus.js";
import type { AgentSourceScanClient } from "../../../../services/agent-source-scan-bridge.js";
import { createAgentSourceScanBridge } from "../../../../services/agent-source-scan-bridge.js";

/** Contract for register agent source routes options. */
export interface RegisterAgentSourceRoutesOptions {
  agentSources: AgentSourceService;
  agentSourceAutoInject: AgentSourceAutoInjectService;
  progressBus: ProgressBus;
  permissionManager: Pick<PermissionManager, "canScanAgentSource">;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  scanClient?: AgentSourceScanClient;
}

/** Registers register agent source routes. */
export function registerAgentSourceRoutes(app: FastifyInstance, options: RegisterAgentSourceRoutesOptions): void {
  const scans = createAgentSourceScanBridge(options.scanClient, options.progressBus);
  app.addHook("onClose", () => scans.dispose());

  app.get("/api/agent-sources", { preHandler: options.authenticateRuntimeToken }, async (_request, reply) => {
    const response = AgentSourceViewSchema.array().parse(await options.agentSources.list());
    return reply.send(response);
  });

  app.get(
    "/api/agent-sources/memory-plugin-conflicts",
    { preHandler: options.authenticateRuntimeToken },
    async (_request, reply) => {
      const conflicts = await options.agentSources.detectMemoryPluginConflicts();
      return reply.send(AgentSourceMemoryPluginConflictsResponseSchema.parse({ conflicts }));
    }
  );

  app.post(
    "/api/agent-sources/auto-inject/run",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = AgentSourceAutoInjectResultSchema.parse(await options.agentSourceAutoInject.runOnce());
      return reply.send(response);
    })
  );

  app.get("/api/agent-sources/scan/status", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (_request, reply) => {
    return reply.send(AgentSourceScanStatusResponseSchema.parse(await scans.status()));
  }));

  app.get("/api/agent-sources/scan/jobs/:jobId/results", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    const query = request.query as { cursor?: string; limit?: string };
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit ?? "100", 10) || 100));
    return reply.send(ScanResultPageSchema.parse(await scans.results(jobId, query.cursor ?? "0", limit)));
  }));

  app.post("/api/agent-sources/scan", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    const input = AgentSourceScanInputSchema.parse(request.body);
    if (!(await options.permissionManager.canScanAgentSource({ agentSourceId: input.sourceId }))) {
      return reply.code(403).send({ error: { code: "scan_not_permitted", message: "scan not permitted" } });
    }
    return reply.send(AgentSourceScanJobResponseSchema.parse(await scans.start(input)));
  }));

  app.post("/api/agent-sources/scan/stop", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    return reply.send(AgentSourceScanControlResponseSchema.parse(await scans.pause(ScanControlInputSchema.parse(request.body ?? {}))));
  }));

  app.post("/api/agent-sources/scan/cancel", { preHandler: options.authenticateRuntimeToken }, withErrorEnvelope(async (request, reply) => {
    return reply.send(AgentSourceScanControlResponseSchema.parse(await scans.cancel(ScanControlInputSchema.parse(request.body ?? {}))));
  }));

  app.post("/api/agent-sources/manual", { preHandler: options.authenticateRuntimeToken }, async (request, reply) => {
    const input = AddManualInputSchema.parse(request.body);
    const response = AgentSourceViewSchema.parse(await options.agentSources.addManual(input));
    return reply.send(response);
  });

  app.post(
    "/api/agent-sources/:sourceId/managed/import",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const input = ManagedAgentSourceImportInputSchema.parse(request.body);
      const response = await options.agentSources.importManaged(params.sourceId, input);
      return reply.send(ManagedAgentSourceImportResultSchema.parse(response));
    })
  );

  app.post(
    "/api/agent-sources/:sourceId/managed/sync",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      if (!(await options.permissionManager.canScanAgentSource({ agentSourceId: params.sourceId }))) {
        return reply.code(403).send({
          error: {
            code: "scan_not_permitted",
            message: "scan not permitted"
          }
        });
      }
      const response = await options.agentSources.syncManaged(params.sourceId);
      return reply.send(ManagedAgentSourceImportResultSchema.parse(response));
    })
  );

  app.patch(
    "/api/agent-sources/:sourceId/managed",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const input = ManagedAgentSourceUpdateInputSchema.parse(request.body);
      const response = await options.agentSources.updateManaged(params.sourceId, input);
      return reply.send(AgentSourceViewSchema.parse(response));
    })
  );

  app.delete(
    "/api/agent-sources/:sourceId",
    { preHandler: options.authenticateRuntimeToken },
    async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.agentSources.remove(params.sourceId);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    }
  );

  app.post(
    "/api/agent-sources/:sourceId/skill",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.agentSources.installSkill(params.sourceId);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.post(
    "/api/agent-sources/:sourceId/plugin",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const action = AgentSourcePluginActionInputSchema.parse(request.body ?? {});
      await options.agentSources.installPlugin(params.sourceId, action);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.delete(
    "/api/agent-sources/:sourceId/plugin",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const action = AgentSourcePluginActionInputSchema.parse(request.body ?? {});
      await options.agentSources.uninstallPlugin(params.sourceId, action);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.delete(
    "/api/agent-sources/:sourceId/skill",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.agentSources.uninstallSkill(params.sourceId);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

}
