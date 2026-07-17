/** Channels module. */
import {
  ChannelConnectionsResponseSchema,
  ChannelDefinitionsResponseSchema,
  ChannelProviderSchema,
  ConnectChannelInputSchema,
  ConnectChannelResponseSchema,
  OkResponseSchema
} from "@memmy/local-api-contracts";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ChannelService } from "../../../../services/channel-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

export interface RegisterChannelRoutesOptions {
  /** Channels. */
  channels: ChannelService;
  /** Runtime-token Fastify preHandler. */
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

const ChannelProviderParamsSchema = z.object({
  provider: ChannelProviderSchema
});

const ChannelPollParamsSchema = ChannelProviderParamsSchema.extend({
  pollToken: z.string().min(1)
});

/** Registers register channel routes. */
export function registerChannelRoutes(app: FastifyInstance, options: RegisterChannelRoutesOptions): void {
  app.get(
    "/api/v1/channels/definitions",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = ChannelDefinitionsResponseSchema.parse(await options.channels.listDefinitions());
      return reply.send(response);
    })
  );

  app.get(
    "/api/v1/channels/connections",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = ChannelConnectionsResponseSchema.parse(await options.channels.listConnections());
      return reply.send(response);
    })
  );

  app.post(
    "/api/v1/channels/:provider/connect",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const { provider } = ChannelProviderParamsSchema.parse(request.params);
      const input = ConnectChannelInputSchema.parse(request.body ?? {});
      const response = ConnectChannelResponseSchema.parse(await options.channels.connect(provider, input));
      return reply.send(response);
    })
  );

  app.get(
    "/api/v1/channels/:provider/connect/:pollToken",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const { provider, pollToken } = ChannelPollParamsSchema.parse(request.params);
      const response = ConnectChannelResponseSchema.parse(await options.channels.pollConnect(provider, pollToken));
      return reply.send(response);
    })
  );

  app.post(
    "/api/v1/channels/:provider/disconnect",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const { provider } = ChannelProviderParamsSchema.parse(request.params);
      const response = OkResponseSchema.parse(await options.channels.disconnect(provider));
      return reply.send(response);
    })
  );
}
