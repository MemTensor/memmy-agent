/** Third-party plugin management and capability routes. */
import {
  InstallPluginInputSchema,
  InstalledPluginSchema,
  InvokePluginCapabilityInputSchema,
  PluginInteractionResponseInputSchema,
  UpdatePluginConfigInputSchema,
  UpdatePluginInputSchema,
  UpdatePluginPermissionsInputSchema,
  type CapabilityEvent
} from "@memmy/local-api-contracts";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PluginService } from "../../../../services/plugin-service.js";
import type { ProgressBus } from "../../../../services/progress-bus.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

export interface RegisterPluginRoutesOptions {
  plugins: PluginService;
  progressBus: ProgressBus;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  refreshAgentTools?: () => Promise<void>;
}

const PluginParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const CapabilityParamsSchema = PluginParamsSchema.extend({ capabilityId: z.string().trim().min(1).max(128) });
const CallParamsSchema = PluginParamsSchema.extend({ callId: z.string().trim().min(1) });
const InteractionParamsSchema = CallParamsSchema.extend({ interactionId: z.string().trim().min(1) });

export function registerPluginRoutes(app: FastifyInstance, options: RegisterPluginRoutesOptions): void {
  const protectedRoute = { preHandler: options.authenticateRuntimeToken };

  app.post("/api/v1/plugins/install", protectedRoute, withErrorEnvelope(async (request, reply) => {
    const input = InstallPluginInputSchema.parse(request.body);
    return reply.code(201).send(InstalledPluginSchema.parse(await options.plugins.install(input.pluginId, input.version)));
  }));

  app.get("/api/v1/plugins", protectedRoute, withErrorEnvelope(async (_request, reply) =>
    reply.send(z.array(InstalledPluginSchema).parse(options.plugins.list()))
  ));

  app.get("/api/v1/plugins/:id", protectedRoute, withErrorEnvelope(async (request, reply) => {
    const { id } = PluginParamsSchema.parse(request.params);
    return reply.send(InstalledPluginSchema.parse(options.plugins.get(id)));
  }));

  app.put("/api/v1/plugins/:id/config", protectedRoute, withErrorEnvelope(async (request, reply) => {
    const { id } = PluginParamsSchema.parse(request.params);
    return reply.send(InstalledPluginSchema.parse(options.plugins.configure(id, UpdatePluginConfigInputSchema.parse(request.body))));
  }));

  app.put("/api/v1/plugins/:id/permissions", protectedRoute, withErrorEnvelope(async (request, reply) => {
    const { id } = PluginParamsSchema.parse(request.params);
    const input = UpdatePluginPermissionsInputSchema.parse(request.body);
    const plugin = InstalledPluginSchema.parse(await options.plugins.approvePermissions(id, input.permissions));
    await refreshAgentTools(options);
    return reply.send(plugin);
  }));

  app.post("/api/v1/plugins/:id/enable", protectedRoute, withErrorEnvelope(async (request, reply) => {
    const { id } = PluginParamsSchema.parse(request.params);
    const plugin = InstalledPluginSchema.parse(await options.plugins.enable(id));
    await refreshAgentTools(options);
    return reply.send(plugin);
  }));

  app.post("/api/v1/plugins/:id/disable", protectedRoute, withErrorEnvelope(async (request, reply) => {
    const { id } = PluginParamsSchema.parse(request.params);
    const plugin = InstalledPluginSchema.parse(await options.plugins.disable(id));
    await refreshAgentTools(options);
    return reply.send(plugin);
  }));

  app.post("/api/v1/plugins/:id/update", protectedRoute, withErrorEnvelope(async (request, reply) => {
    const { id } = PluginParamsSchema.parse(request.params);
    const input = UpdatePluginInputSchema.parse(request.body ?? {});
    const plugin = InstalledPluginSchema.parse(await options.plugins.update(id, input.version));
    await refreshAgentTools(options);
    return reply.send(plugin);
  }));

  app.delete("/api/v1/plugins/:id", protectedRoute, withErrorEnvelope(async (request, reply) => {
    const { id } = PluginParamsSchema.parse(request.params);
    await options.plugins.uninstall(id);
    await refreshAgentTools(options);
    return reply.send({ ok: true });
  }));

  app.post("/api/v1/plugins/:id/capabilities/:capabilityId/invoke", protectedRoute,
    withErrorEnvelope(async (request, reply) => {
      const { id, capabilityId } = CapabilityParamsSchema.parse(request.params);
      const input = InvokePluginCapabilityInputSchema.parse(request.body);
      const callId = randomUUID();
      const cancel = () => void options.plugins.cancel(id, callId).catch(() => undefined);
      request.raw.once("aborted", cancel);
      let terminal: CapabilityEvent | undefined;
      try {
        for await (const event of options.plugins.invoke({
          callId,
          pluginId: id,
          capabilityId,
          conversationId: input.conversationId,
          input: input.input,
          deadline: input.deadline
        })) {
          options.progressBus.emit("plugin.capability_event", {
            pluginId: id,
            capabilityId,
            callId,
            conversationId: input.conversationId,
            event
          });
          if (event.type === "result" || event.type === "error") terminal = event;
        }
      } finally {
        request.raw.off("aborted", cancel);
      }
      if (!terminal) throw Object.assign(new Error("Plugin ended without a terminal event"), { code: "plugin_runtime_error" });
      return reply.send({ callId, event: terminal });
    })
  );

  app.post("/api/v1/plugins/:id/calls/:callId/cancel", protectedRoute,
    withErrorEnvelope(async (request, reply) => {
      const { id, callId } = CallParamsSchema.parse(request.params);
      await options.plugins.cancel(id, callId);
      return reply.send({ ok: true });
    })
  );

  app.post("/api/v1/plugins/:id/calls/:callId/interactions/:interactionId", protectedRoute,
    withErrorEnvelope(async (request, reply) => {
      const { id, callId, interactionId } = InteractionParamsSchema.parse(request.params);
      const { response } = PluginInteractionResponseInputSchema.parse(request.body);
      await options.plugins.respond(id, callId, interactionId, response);
      return reply.send({ ok: true });
    })
  );
}

async function refreshAgentTools(options: RegisterPluginRoutesOptions): Promise<void> {
  try {
    await options.refreshAgentTools?.();
  } catch (error) {
    console.warn(`Agent plugin tool reload unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
