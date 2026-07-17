/** App config module. */
import {
  AppSettingsDtoSchema,
  ModelConfigInputSchema,
  ModelConfigTestInputSchema,
  ModelConfigTestResultSchema,
  ModelConfigViewSchema,
  OnboardingStateDtoSchema,
  PatchAppSettingsInputSchema,
  PatchOnboardingInputSchema,
  PatchPrivacyInputSchema,
  PatchScanPreferencesInputSchema,
  PrivacySettingsDtoSchema,
  ScanPreferencesSchema,
  SetImprovementProgramInputSchema,
  SetImprovementProgramResponseSchema,
  SetSkinInputSchema,
  TokenUsageDtoSchema
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfigService } from "../../../../services/app-config-service.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";

/** Contract for register app config routes options. */
export interface RegisterAppConfigRoutesOptions {
  appConfig: AppConfigService;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/** Registers register app config routes. */
export function registerAppConfigRoutes(app: FastifyInstance, options: RegisterAppConfigRoutesOptions): void {
  app.patch(
    "/api/app/settings",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = PatchAppSettingsInputSchema.parse(request.body);
      const response = AppSettingsDtoSchema.parse(await options.appConfig.updateSettings(input));
      return reply.send(response);
    })
  );

  app.patch(
    "/api/app/privacy",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = PatchPrivacyInputSchema.parse(request.body);
      const response = PrivacySettingsDtoSchema.parse(await options.appConfig.updatePrivacy(input));
      return reply.send(response);
    })
  );

  app.patch(
    "/api/app/scan-preferences",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = PatchScanPreferencesInputSchema.parse(request.body);
      const response = ScanPreferencesSchema.parse(await options.appConfig.updateScanPreferences(input));
      return reply.send(response);
    })
  );

  app.patch(
    "/api/app/onboarding",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = PatchOnboardingInputSchema.parse(request.body);
      const response = OnboardingStateDtoSchema.parse(await options.appConfig.updateOnboarding(input));
      return reply.send(response);
    })
  );

  app.patch(
    "/api/app/improvement-program",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = SetImprovementProgramInputSchema.parse(request.body);
      const response = SetImprovementProgramResponseSchema.parse(await options.appConfig.setImprovementProgram(input));
      return reply.send(response);
    })
  );

  app.get(
    "/api/app/token-usage",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = TokenUsageDtoSchema.parse(await options.appConfig.getTokenUsage());
      return reply.send(response);
    })
  );

  app.put(
    "/api/app/model-config",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = ModelConfigInputSchema.parse(request.body);
      const response = ModelConfigViewSchema.parse(await options.appConfig.setModelConfig(input));
      return reply.send(response);
    })
  );

  app.post(
    "/api/app/model-config/test",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = ModelConfigTestInputSchema.parse(request.body);
      const response = ModelConfigTestResultSchema.parse(await options.appConfig.testModelConfig(input));
      return reply.send(response);
    })
  );

  app.get(
    "/api/app/model-config",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = ModelConfigViewSchema.parse(await options.appConfig.getModelConfig());
      return reply.send(response);
    })
  );

  app.patch(
    "/api/app/skin",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const input = SetSkinInputSchema.parse(request.body);
      return reply.send(await options.appConfig.setSkin(input));
    })
  );
}
