/** Integration service module. */
import {
  AuthorizeIntegrationResponseSchema,
  IntegrationCapabilitiesResponseSchema,
  IntegrationConnectionsResponseSchema,
  IntegrationToolResultSchema,
  OkResponseSchema,
  ReportIntegrationConnectionEventInputSchema,
  type AuthorizeIntegrationResponse,
  type IntegrationCapabilitiesResponse,
  type IntegrationConnectionsResponse,
  type IntegrationToolResult,
  type OkResponse,
  type ReportIntegrationConnectionEventInput
} from "@memmy/local-api-contracts";
import type { CloudClient } from "../adapters/outbound/cloud-client/index.js";
import {
  createToolConnectionAnalytics,
  type ToolConnectionAnalytics,
} from "../analytics/tool-connection-analytics.js";
import type { ComposioMachineTokenRepository } from "../infrastructure/app-state-store/repositories/composio-machine-token-repo.js";
import { requireNonEmptyString } from "../shared/input-validation.js";

/** Contract for integration service. */
export interface IntegrationService {
  listCapabilities(): Promise<IntegrationCapabilitiesResponse>;
  authorize(slug: string): Promise<AuthorizeIntegrationResponse>;
  listConnections(): Promise<IntegrationConnectionsResponse>;
  deleteConnection(id: string): Promise<OkResponse>;
  reportConnectionEvent(input: ReportIntegrationConnectionEventInput): Promise<OkResponse>;
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
  toolConnectionAnalytics?: ToolConnectionAnalytics;
}

/** Creates create integration service. */
export function createIntegrationService(options: CreateIntegrationServiceOptions): IntegrationService {
  const toolConnectionAnalytics = options.toolConnectionAnalytics ?? createToolConnectionAnalytics();

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
      const connectionId = requireNonEmptyString(id, "id");
      const toolkit = await resolveIntegrationToolkit(options, connectionId);

      try {
        const machineComposioToken = options.composioMachineTokenRepository.getOrCreateToken();
        const response = await options.cloudClient.deleteIntegrationConnection({
          machineComposioToken,
          id: connectionId
        });
        const parsed = OkResponseSchema.parse(response);
        toolConnectionAnalytics.trackConnection({
          surface: "integration",
          toolkit: toolkit ?? connectionId,
          event: "disconnected",
        });
        return parsed;
      } catch (error) {
        toolConnectionAnalytics.trackConnection({
          surface: "integration",
          toolkit: toolkit ?? connectionId,
          event: "failed",
          error,
        });
        throw error;
      }
    },

    async reportConnectionEvent(input) {
      const parsed = ReportIntegrationConnectionEventInputSchema.parse(input);
      if (parsed.surface !== "integration") {
        throw new Error(
          `integration reportConnectionEvent requires surface=integration, got ${parsed.surface}`,
        );
      }
      toolConnectionAnalytics.trackConnection({
        surface: parsed.surface,
        toolkit: parsed.toolkit,
        event: parsed.event,
        errorCode: parsed.errorCode,
      });
      return OkResponseSchema.parse({ ok: true });
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

async function resolveIntegrationToolkit(
  options: CreateIntegrationServiceOptions,
  connectionId: string
): Promise<string | null> {
  try {
    const machineComposioToken = options.composioMachineTokenRepository.getOrCreateToken();
    const response = await options.cloudClient.listIntegrationConnections({ machineComposioToken });
    const parsed = IntegrationConnectionsResponseSchema.parse(response);
    return parsed.connections.find((connection) => connection.id === connectionId)?.toolkit ?? null;
  } catch {
    return null;
  }
}
