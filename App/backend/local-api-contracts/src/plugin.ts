/** Memmy Plugin Protocol contracts. */
import { z } from "zod";

export const JsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof JsonSchemaSchema>;

const PluginIdentifierSchema = z.string().trim().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/);
const PluginPackagePathSchema = z.string().trim().min(1).max(512).refine((value) => (
  !value.startsWith("/")
  && !value.includes("\\")
  && !value.includes("\0")
  && !/^[A-Za-z]:/.test(value)
  && value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
), "Plugin package path must be a safe relative path");

const PluginNetworkHostSchema = z.string().trim().min(1).max(253).transform((value) => value.toLowerCase()).refine((value) => {
  if (value === "localhost") return true;
  if (value.includes(":") || value.includes("/") || value.includes("*") || value.startsWith(".")) return false;
  return value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}, "Network host must be an exact DNS hostname without a scheme, port, path, or wildcard");

export const PluginRuntimeSchema = z.object({
  adapter: z.enum(["mcp", "http", "command"]),
  config: z.record(z.string(), z.unknown()).optional()
});
export type PluginRuntime = z.infer<typeof PluginRuntimeSchema>;

export const PluginCapabilityControlSchema = z.object({
  action: z.literal("cancel"),
  runIdInput: z.string().trim().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/).default("runId"),
  scopeInput: z.string().trim().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/).default("scope"),
  taskIdInput: z.string().trim().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/).default("taskId")
});
export type PluginCapabilityControl = z.infer<typeof PluginCapabilityControlSchema>;

export const PluginCapabilitySchema = z.object({
  id: PluginIdentifierSchema,
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(2_000),
  inputSchema: JsonSchemaSchema,
  outputSchema: JsonSchemaSchema,
  execution: z.enum(["request", "job"]),
  /** Optional Host-owned execution control performed before invoking this capability. */
  control: PluginCapabilityControlSchema.optional(),
  examples: z.array(z.string().trim().min(1).max(500)).max(20).optional()
});
export type PluginCapability = z.infer<typeof PluginCapabilitySchema>;

export const PluginPermissionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("network"),
    hosts: z.array(PluginNetworkHostSchema).min(1),
    description: z.string().trim().min(1).optional()
  }),
  z.object({
    type: z.literal("filesystem"),
    paths: z.array(z.string().trim().min(1)).min(1),
    access: z.enum(["read", "write", "read-write"]),
    description: z.string().trim().min(1).optional()
  }),
  z.object({
    type: z.literal("secret"),
    keys: z.array(PluginIdentifierSchema).min(1),
    description: z.string().trim().min(1).optional()
  }),
  z.object({
    type: z.literal("host-service"),
    services: z.array(PluginIdentifierSchema).min(1),
    description: z.string().trim().min(1).optional()
  })
]);
export type PluginPermission = z.infer<typeof PluginPermissionSchema>;

export const PluginUiRendererSchema = z.object({
  entry: PluginPackagePathSchema,
  capabilities: z.array(PluginIdentifierSchema).min(1).max(100).optional(),
  height: z.number().int().min(120).max(1_200).optional()
});
export type PluginUiRenderer = z.infer<typeof PluginUiRendererSchema>;

export const PluginUiSchema = z.object({
  renderer: PluginUiRendererSchema.optional(),
  surface: PluginUiRendererSchema.optional()
}).passthrough();
export type PluginUi = z.infer<typeof PluginUiSchema>;

export const PluginSkillContributionSchema = z.object({
  id: PluginIdentifierSchema,
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(500),
  entry: PluginPackagePathSchema
}).superRefine((skill, context) => {
  if (!skill.entry.endsWith("/SKILL.md") && skill.entry !== "SKILL.md") {
    context.addIssue({ code: "custom", path: ["entry"], message: "Plugin skill entry must point to SKILL.md" });
  }
});
export type PluginSkillContribution = z.infer<typeof PluginSkillContributionSchema>;

export const PluginCommandContributionSchema = z.object({
  command: z.string().trim().regex(/^\/[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().min(1).max(500),
  capabilityId: PluginIdentifierSchema,
  agentSkillId: PluginIdentifierSchema.optional(),
  argHint: z.string().trim().max(128).optional(),
  icon: z.string().trim().min(1).max(64).optional(),
  surface: z.boolean().optional()
});
export type PluginCommandContribution = z.infer<typeof PluginCommandContributionSchema>;

export const PluginManifestSchema = z.object({
  apiVersion: z.literal("memmy/v1"),
  id: PluginIdentifierSchema,
  name: z.string().trim().min(1).max(128),
  version: z.string().trim().min(1).max(64),
  runtime: PluginRuntimeSchema,
  capabilities: z.array(PluginCapabilitySchema).min(1),
  permissions: z.array(PluginPermissionSchema),
  configSchema: JsonSchemaSchema.optional(),
  skills: z.array(PluginSkillContributionSchema).max(20).optional(),
  commands: z.array(PluginCommandContributionSchema).max(100).optional(),
  ui: PluginUiSchema.optional()
}).superRefine((manifest, context) => {
  const ids = new Set<string>();
  for (const [index, capability] of manifest.capabilities.entries()) {
    if (ids.has(capability.id)) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", index, "id"],
        message: `Duplicate capability id: ${capability.id}`
      });
    }
    ids.add(capability.id);
    if (capability.control) {
      const properties = capability.inputSchema.properties;
      const declared = properties && typeof properties === "object" && !Array.isArray(properties)
        ? properties as Record<string, unknown>
        : {};
      for (const field of [capability.control.runIdInput, capability.control.scopeInput, capability.control.taskIdInput]) {
        if (!Object.hasOwn(declared, field)) {
          context.addIssue({
            code: "custom",
            path: ["capabilities", index, "control"],
            message: `Cancellation control input field is not declared by the capability schema: ${field}`
          });
        }
      }
    }
  }
  for (const slot of ["renderer", "surface"] as const) {
    for (const [index, capabilityId] of (manifest.ui?.[slot]?.capabilities ?? []).entries()) {
      if (!ids.has(capabilityId)) {
        context.addIssue({
          code: "custom",
          path: ["ui", slot, "capabilities", index],
          message: `Unknown ${slot} capability id: ${capabilityId}`
        });
      }
    }
  }
  const skills = new Set<string>();
  for (const [index, skill] of (manifest.skills ?? []).entries()) {
    if (skills.has(skill.id)) {
      context.addIssue({ code: "custom", path: ["skills", index, "id"], message: `Duplicate plugin skill id: ${skill.id}` });
    }
    skills.add(skill.id);
  }
  const commands = new Set<string>();
  for (const [index, command] of (manifest.commands ?? []).entries()) {
    if (!ids.has(command.capabilityId)) {
      context.addIssue({ code: "custom", path: ["commands", index, "capabilityId"], message: `Unknown command capability id: ${command.capabilityId}` });
    }
    if (commands.has(command.command)) {
      context.addIssue({ code: "custom", path: ["commands", index, "command"], message: `Duplicate plugin command: ${command.command}` });
    }
    if (command.agentSkillId && !skills.has(command.agentSkillId)) {
      context.addIssue({ code: "custom", path: ["commands", index, "agentSkillId"], message: `Unknown command Agent skill id: ${command.agentSkillId}` });
    }
    if (command.agentSkillId && command.surface) {
      context.addIssue({ code: "custom", path: ["commands", index, "surface"], message: "Agent-routed plugin commands cannot open a direct plugin surface" });
    }
    commands.add(command.command);
  }
});
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export const CapabilityCallSchema = z.object({
  callId: z.string().trim().min(1),
  pluginId: PluginIdentifierSchema,
  capabilityId: PluginIdentifierSchema,
  conversationId: z.string().trim().min(1),
  input: z.unknown(),
  deadline: z.string().datetime().optional()
});
export type CapabilityCall = z.infer<typeof CapabilityCallSchema>;

export const PluginInteractionRequestSchema = z.object({
  interactionId: z.string().trim().min(1),
  type: z.enum(["question", "approval", "file-input", "custom"]),
  payload: z.unknown(),
  responseSchema: JsonSchemaSchema.optional()
});
export type PluginInteractionRequest = z.infer<typeof PluginInteractionRequestSchema>;

export const PluginTaskSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  status: z.enum(["pending", "running", "completed", "failed"])
});
export type PluginTask = z.infer<typeof PluginTaskSchema>;

export const PluginArtifactRefSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  mediaType: z.string().trim().min(1),
  uri: z.string().trim().min(1),
  downloadUri: z.string().trim().min(1).optional()
});
export type PluginArtifactRef = z.infer<typeof PluginArtifactRefSchema>;

/** Private command-adapter message requesting a Host-owned service. Never forwarded to plugin API consumers. */
export const PluginHostServiceRequestSchema = z.object({
  type: z.literal("host-service-request"),
  requestId: z.string().trim().min(1),
  service: PluginIdentifierSchema,
  input: z.unknown()
});
export type PluginHostServiceRequest = z.infer<typeof PluginHostServiceRequestSchema>;

export const PluginHostServiceResponseSchema = z.object({
  type: z.literal("host-service-response"),
  callId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  response: z.unknown().optional(),
  error: z.object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    retryable: z.boolean()
  }).optional()
}).refine((value) => value.response !== undefined || value.error !== undefined, {
  message: "Host service response requires response or error"
});
export type PluginHostServiceResponse = z.infer<typeof PluginHostServiceResponseSchema>;

export const CapabilityEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    current: z.number().nonnegative(),
    total: z.number().positive().optional(),
    message: z.string().optional(),
    cancellable: z.boolean().optional()
  }),
  z.object({ type: z.literal("task-list"), tasks: z.array(PluginTaskSchema) }),
  z.object({ type: z.literal("interaction"), request: PluginInteractionRequestSchema }),
  z.object({ type: z.literal("artifact"), artifact: PluginArtifactRefSchema }),
  z.object({ type: z.literal("result"), output: z.unknown() }),
  z.object({
    type: z.literal("error"),
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
    retryable: z.boolean()
  })
]);
export type CapabilityEvent = z.infer<typeof CapabilityEventSchema>;

export const PluginStateSchema = z.enum([
  "installed",
  "pending_approval",
  "enabling",
  "active",
  "disabling",
  "disabled",
  "failed"
]);
export type PluginState = z.infer<typeof PluginStateSchema>;

export const InstalledPluginSchema = z.object({
  id: PluginIdentifierSchema,
  version: z.string().min(1),
  manifest: PluginManifestSchema,
  state: PluginStateSchema,
  approvedPermissions: z.array(PluginPermissionSchema),
  config: z.record(z.string(), z.unknown()),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;
export const InstalledPluginsSchema = z.array(InstalledPluginSchema);

export const InstallPluginInputSchema = z.object({
  pluginId: PluginIdentifierSchema,
  version: z.string().trim().min(1).max(64).optional()
});
export type InstallPluginInput = z.infer<typeof InstallPluginInputSchema>;

export const UpdatePluginConfigInputSchema = z.object({
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(PluginIdentifierSchema, z.string()).optional()
});
export type UpdatePluginConfigInput = z.infer<typeof UpdatePluginConfigInputSchema>;

export const UpdatePluginPermissionsInputSchema = z.object({
  permissions: z.array(PluginPermissionSchema)
});
export type UpdatePluginPermissionsInput = z.infer<typeof UpdatePluginPermissionsInputSchema>;

export const UpdatePluginInputSchema = z.object({
  version: z.string().trim().min(1).max(64).optional()
});
export type UpdatePluginInput = z.infer<typeof UpdatePluginInputSchema>;

export const InvokePluginCapabilityInputSchema = z.object({
  conversationId: z.string().trim().min(1),
  input: z.unknown(),
  deadline: z.string().datetime().optional()
});
export type InvokePluginCapabilityInput = z.infer<typeof InvokePluginCapabilityInputSchema>;

export const InvokePluginCapabilityResponseSchema = z.object({
  callId: z.string().trim().min(1),
  event: CapabilityEventSchema
});
export type InvokePluginCapabilityResponse = z.infer<typeof InvokePluginCapabilityResponseSchema>;

export const PluginInteractionResponseInputSchema = z.object({
  response: z.unknown()
});
export type PluginInteractionResponseInput = z.infer<typeof PluginInteractionResponseInputSchema>;

export const PluginUiRendererResponseSchema = z.object({ html: z.string() });
export type PluginUiRendererResponse = z.infer<typeof PluginUiRendererResponseSchema>;
export const PluginUiSlotSchema = z.enum(["renderer", "surface"]);
export type PluginUiSlot = z.infer<typeof PluginUiSlotSchema>;

export const PluginCapabilityEventPayloadSchema = z.object({
  pluginId: PluginIdentifierSchema,
  capabilityId: PluginIdentifierSchema,
  callId: z.string().min(1),
  conversationId: z.string().min(1),
  event: CapabilityEventSchema
});
export type PluginCapabilityEventPayload = z.infer<typeof PluginCapabilityEventPayloadSchema>;
