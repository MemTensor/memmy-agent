/** Integration service module. */
import {
  AuthorizeIntegrationResponseSchema,
  IntegrationCapabilitiesResponseSchema,
  IntegrationConnectionsResponseSchema,
  IntegrationToolResultSchema,
  OkResponseSchema,
  type AuthorizeIntegrationResponse,
  type IntegrationCapabilitiesResponse,
  type IntegrationConnectionsResponse,
  type IntegrationToolResult,
  type OkResponse
} from "@memmy/local-api-contracts";
import type { CloudClient } from "../adapters/outbound/cloud-client/index.js";
import type { ComposioMachineTokenRepository } from "../infrastructure/app-state-store/repositories/composio-machine-token-repo.js";
import { requireNonEmptyString } from "../shared/input-validation.js";

/** Contract for integration service. */
export interface IntegrationService {
  listCapabilities(): Promise<IntegrationCapabilitiesResponse>;
  authorize(slug: string): Promise<AuthorizeIntegrationResponse>;
  listConnections(): Promise<IntegrationConnectionsResponse>;
  deleteConnection(id: string): Promise<OkResponse>;
  executeRouterTool(toolSlug: string, toolArguments?: Record<string, unknown>): Promise<IntegrationToolResult>;
}

/** Contract for create integration service options. */
export interface CreateIntegrationServiceOptions {
  cloudClient: Pick<
    CloudClient,
    | "listIntegrationCapabilities"
    | "authorizeIntegration"
    | "listIntegrationConnections"
    | "deleteIntegrationConnection"
    | "executeIntegrationRouterTool"
  >;
  composioMachineTokenRepository: Pick<ComposioMachineTokenRepository, "getOrCreateToken">;
}

/** Creates create integration service. */
export function createIntegrationService(options: CreateIntegrationServiceOptions): IntegrationService {
  return {
    async listCapabilities() {
      const machineComposioToken = options.composioMachineTokenRepository.getOrCreateToken();
      const response = await options.cloudClient.listIntegrationCapabilities({ machineComposioToken });

      return IntegrationCapabilitiesResponseSchema.parse(response);
    },

    async authorize(slug) {
      const machineComposioToken = options.composioMachineTokenRepository.getOrCreateToken();
      const response = await options.cloudClient.authorizeIntegration({
        machineComposioToken,
        slug: requireNonEmptyString(slug, "slug")
      });

      return AuthorizeIntegrationResponseSchema.parse(response);
    },

    async listConnections() {
      const machineComposioToken = options.composioMachineTokenRepository.getOrCreateToken();
      const response = await options.cloudClient.listIntegrationConnections({ machineComposioToken });

      return IntegrationConnectionsResponseSchema.parse(response);
    },

    async deleteConnection(id) {
      const machineComposioToken = options.composioMachineTokenRepository.getOrCreateToken();
      const response = await options.cloudClient.deleteIntegrationConnection({
        machineComposioToken,
        id: requireNonEmptyString(id, "id")
      });

      return OkResponseSchema.parse(response);
    },

    async executeRouterTool(toolSlug, toolArguments) {
      const machineComposioToken = options.composioMachineTokenRepository.getOrCreateToken();
      const response = await options.cloudClient.executeIntegrationRouterTool({
        machineComposioToken,
        toolSlug: requireNonEmptyString(toolSlug, "toolSlug"),
        arguments: toolArguments
      });

      return IntegrationToolResultSchema.parse(response);
    }
  };
}
