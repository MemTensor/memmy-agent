/** Account module. */
import {
  AccountProfileViewSchema,
  AccountSessionViewSchema,
  AvatarOptionSchema,
  OkResponseSchema,
  SendCodeInputSchema,
  SendCodeResponseSchema,
  SetAvatarInputSchema,
  UpdateAccountProfileInputSchema,
  VerifyCodeInputSchema
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AccountService } from "../../../../services/account-service.js";
import type { AppConfigService } from "../../../../services/app-config-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

/** Contract for register account routes options. */
export interface RegisterAccountRoutesOptions {
  account: AccountService;
  appConfig: AppConfigService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers register account routes. */
export function registerAccountRoutes(app: FastifyInstance, options: RegisterAccountRoutesOptions): void {
  app.post(
    "/api/account/send-code",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = SendCodeInputSchema.parse(request.body);
      const response = SendCodeResponseSchema.parse(await options.account.sendCode(input));
      return reply.send(response);
    })
  );

  app.post(
    "/api/account/verify-code",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = VerifyCodeInputSchema.parse(request.body);
      const response = AccountSessionViewSchema.parse(await options.account.verifyCode(input));
      return reply.send(response);
    })
  );

  app.patch(
    "/api/account/profile",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = UpdateAccountProfileInputSchema.parse(request.body);
      const response = AccountProfileViewSchema.parse(await options.account.updateProfile(input));
      return reply.send(response);
    })
  );

  app.post(
    "/api/account/guide-finished",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = OkResponseSchema.parse(await options.account.markGuideFinished());
      return reply.send(response);
    })
  );

  app.post(
    "/api/account/logout",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = OkResponseSchema.parse(await options.account.logout());
      return reply.send(response);
    })
  );

  app.get(
    "/api/account/session",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = AccountSessionViewSchema.parse(await options.account.getSession());
      return reply.send(response);
    })
  );

  app.get(
    "/api/account/avatars",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = AvatarOptionSchema.array().parse(await options.appConfig.listAvatars());
      return reply.send(response);
    })
  );

  app.patch(
    "/api/account/avatar",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = SetAvatarInputSchema.parse(request.body);
      return reply.send(await options.appConfig.setAvatar(input));
    })
  );
}
